import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { SourceRecord } from '@dmc/contracts';

/**
 * Git JSON technical metadata (S7), read from repo checkouts on disk until the real Git connector (S3) is approved.
 * Metadata only (rule 8): names, types, tags and descriptions. The reader copies a fixed list of fields, so anything else a file carries (sample values, examples) is never read on.
 *
 * Repos are found from the application list: one repo per application, in the directory named by the application's qualified name (its ServiceNow sys_id)
 * under the repos directory. An application with no directory has no repo and adds nothing. The repo naming convention is not confirmed yet (docs/implementation-plan.md, open items).
 * Each repo holds `dmc-metadata.json`:
 *   { "systems": [ { "name", "platform"?, "environment"?, "schemas": [ { "name", "tables": [ { "name", "kind"?, "description"?, "tags"?, "columns": [ { "name", "data_type"?, "nullable"?, "description"?, "tags"? } ] } ] } ] } ] }
 * Qualified names (docs/metamodel.md, Identity): `system`, `system/schema`, `system/schema/table`, `system/schema/table/column`, as written in the file. Names cannot contain "/".
 *
 * A job query is `git-json <reposDir> <applicationsFile> <kind>`, and each kind is one page of records:
 *   systems | schemas | tables | columns   node records `{ qualified_name, name, ... }`
 *   owns                                   edge records `{ from: {qn: application}, to: {qn: system}, repo }`
 *   contains-schemas | contains-tables | contains-columns   edge records System→Schema, Schema→Table, Table→Column
 * Anything the reader cannot trust (unreadable repo file, wrong type, bad or duplicate name, a system claimed by two repos) becomes a record with no key, so the sync run counts an error and deprecates nothing.
 */
export const GIT_JSON_FILE = 'dmc-metadata.json';
export const GIT_JSON_KINDS = ['systems', 'schemas', 'tables', 'columns', 'owns', 'contains-schemas', 'contains-tables', 'contains-columns'] as const;
export type GitJsonKind = (typeof GIT_JSON_KINDS)[number];

type Json = Record<string, any>;
const bad = (msg: string): never => { throw new Error(msg); };

function inside(root: string, rel: string): string {
  const base = resolve(root);
  const p = resolve(base, rel);
  if (p !== base && !p.startsWith(base + sep)) throw new Error('The job query points outside the connection root');
  return p;
}

function readJson(root: string, rel: string): unknown {
  const f = inside(root, rel);
  if (!existsSync(f) || !statSync(f).isFile()) throw new Error(`File not found under the connection root: ${rel}`);
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch { throw new Error(`File is not valid JSON: ${rel}`); }
}

const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };

function name(v: unknown, what: string): string {
  if (typeof v !== 'string' || !v.trim()) return bad(`${what} needs a name`);
  if (v.includes('/')) return bad(`${what} name "${v}" contains "/"`);
  return v;
}
const optStr = (v: unknown, what: string): string | undefined => v === undefined || v === null ? undefined : typeof v === 'string' ? v : bad(`${what} must be text`);
const optBool = (v: unknown, what: string): boolean | undefined => v === undefined || v === null ? undefined : typeof v === 'boolean' ? v : bad(`${what} must be true or false`);
const optTags = (v: unknown, what: string): string[] | undefined => v === undefined || v === null ? undefined : Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : bad(`${what} must be a list of text`);
const list = (v: unknown, what: string): Json[] => v === undefined || v === null ? [] : Array.isArray(v) && v.every((x) => x && typeof x === 'object') ? (v as Json[]) : bad(`${what} must be a list`);
const clean = <T extends Json>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

const edge = (repo: string, from: string, to: string): SourceRecord => ({ from: { qn: from }, to: { qn: to }, repo });

/** Reads every repo and returns the records of one kind. Deterministic: applications and repo contents are walked in sorted order. */
export function gitJsonRecords(root: string, reposDir: string, applicationsFile: string, kind: string): SourceRecord[] {
  if (!(GIT_JSON_KINDS as readonly string[]).includes(kind)) throw new Error(`Unknown git-json kind "${kind}"; use one of ${GIT_JSON_KINDS.join(', ')}`);
  const doc = readJson(root, applicationsFile) as Json;
  const rows: unknown[] = Array.isArray(doc) ? doc : Array.isArray(doc?.records) ? doc.records : bad(`${applicationsFile} has no application list`);
  const apps = [...new Set(rows.map((r) => (r as Json)?.sys_id).filter((x): x is string => typeof x === 'string' && /^[A-Za-z0-9][\w.-]*$/.test(x)))].sort();

  const out: Record<GitJsonKind, SourceRecord[]> = { systems: [], schemas: [], tables: [], columns: [], owns: [], 'contains-schemas': [], 'contains-tables': [], 'contains-columns': [] };
  const error = (repo: string, msg: string) => { for (const k of GIT_JSON_KINDS) out[k].push({ repo, error: msg }); };
  const claimed = new Map<string, string>(); // qualified name -> repo that claimed it

  for (const app of apps) {
    const dir = inside(root, `${reposDir}/${app}`);
    if (!isDir(dir)) continue; // no repo for this application
    let meta: Json;
    try { const m = readJson(root, `${reposDir}/${app}/${GIT_JSON_FILE}`); if (!m || typeof m !== 'object' || Array.isArray(m)) bad(`${GIT_JSON_FILE} must be an object`); meta = m as Json; }
    catch (e) { error(app, `repo ${app}: ${(e as Error).message}`); continue; }

    const claim = (qn: string): void => { const by = claimed.get(qn); if (by !== undefined) bad(by === app ? `${qn} appears twice in ${app}` : `${qn} is claimed by repos ${by} and ${app}`); };
    // each item is built whole before anything is added, so a bad item adds nothing but one error
    const guard = (what: string, f: () => void) => { try { f(); } catch (e) { error(app, `repo ${app}: ${what}: ${(e as Error).message}`); } };
    try { list(meta.systems, 'systems'); } catch (e) { error(app, `repo ${app}: ${(e as Error).message}`); continue; }

    for (const s of list(meta.systems, 'systems')) {
      guard(`system ${String(s.name)}`, () => {
        const sn = name(s.name, 'system');
        const sys = clean({ qualified_name: sn, name: sn, platform: optStr(s.platform, 'platform'), environment: optStr(s.environment, 'environment') });
        const sch: { qn: string; rec: Json; tabs: { qn: string; rec: Json; cols: { qn: string; rec: Json }[] }[] }[] = [];
        const seenHere = new Set<string>([sn]);
        const take = (qn: string) => { if (seenHere.has(qn)) bad(`${qn} appears twice in ${app}`); seenHere.add(qn); };
        for (const sc of list(s.schemas, 'schemas')) {
          const scn = name(sc.name, 'schema'); const scq = `${sn}/${scn}`; take(scq);
          const tabs: (typeof sch)[number]['tabs'] = [];
          for (const t of list(sc.tables, 'tables')) {
            const tn = name(t.name, 'table'); const tq = `${scq}/${tn}`; take(tq);
            const cols: (typeof tabs)[number]['cols'] = [];
            for (const c of list(t.columns, 'columns')) {
              const cn = name(c.name, 'column'); const cq = `${tq}/${cn}`; take(cq);
              cols.push({ qn: cq, rec: clean({ qualified_name: cq, name: cn, data_type: optStr(c.data_type, 'data_type'), nullable: optBool(c.nullable, 'nullable'), description: optStr(c.description, 'description'), tags: optTags(c.tags, 'tags') }) });
            }
            tabs.push({ qn: tq, rec: clean({ qualified_name: tq, name: tn, kind: optStr(t.kind, 'kind'), description: optStr(t.description, 'description'), tags: optTags(t.tags, 'tags') }), cols });
          }
          sch.push({ qn: scq, rec: { qualified_name: scq, name: scn }, tabs });
        }
        claim(sn); // a system another repo already has is refused whole; the first repo (by application id) keeps it
        claimed.set(sn, app);
        out.systems.push(sys); out.owns.push(edge(app, app, sn));
        for (const sc of sch) {
          out.schemas.push(sc.rec); out['contains-schemas'].push(edge(app, sn, sc.qn));
          for (const t of sc.tabs) {
            out.tables.push(t.rec); out['contains-tables'].push(edge(app, sc.qn, t.qn));
            for (const c of t.cols) { out.columns.push(c.rec); out['contains-columns'].push(edge(app, t.qn, c.qn)); }
          }
        }
      });
    }
  }
  return out[kind as GitJsonKind];
}
