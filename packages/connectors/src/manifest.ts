import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import type { Connector, ConnectorQuery, ReadPage, SourceRecord } from '@dmc/contracts';
import { gitJsonRecords } from './git-json.js';

/**
 * Reads lineage metadata files (S8). Metadata only: names of models, tables and columns, never data values (rule 8).
 * Connection config: `{ root }`, a directory; a job query names the format and a path under it:
 *   `dbt <dir>`          reads `<dir>/manifest.json` and `<dir>/catalog.json` (dbt artifacts)
 *   `openlineage <file>` reads an Airflow OpenLineage event export (a JSON array of run events)
 * Each record is one column-to-column edge: `{ derived, upstream, job, confidence, origin }` (the edge is derived derives_from upstream) where both are `{ database, schema, table, column }`.
 * An edge the file names but this reader cannot resolve is still emitted, with an incomplete end, so the sync run counts it as an error and does not deprecate anything.
 */
export interface ManifestConfig { root: string }
export interface LineageEnd { database?: string; schema?: string; table?: string; column?: string }
export interface LineageRecord extends SourceRecord { derived: LineageEnd; upstream: LineageEnd; job: string; confidence: number; origin: string }

/** a name-match edge (same column name in a parent) is a guess, so it carries less confidence than a declared one */
export const NAME_MATCH_CONFIDENCE = 0.6;
const DIRECT = 1; const INDIRECT = 0.5;

type Json = Record<string, any>;

function readJson(root: string, rel: string): Json {
  const base = resolve(root);
  const file = resolve(base, rel);
  if (file !== base && !file.startsWith(base + sep)) throw new Error('The job query points outside the connection root');
  if (!existsSync(file) || !statSync(file).isFile()) throw new Error(`File not found under the connection root: ${rel}`);
  try { return JSON.parse(readFileSync(file, 'utf8')) as Json; } catch { throw new Error(`File is not valid JSON: ${rel}`); }
}

interface Rel { id: string; name: string; database: string; schema: string; table: string; columns: string[]; parents: string[]; declared: Map<string, { node?: string; column?: string }[]>; job: string; model: boolean }

const lc = (s: string) => s.toLowerCase();

/** dbt: manifest.json says what depends on what and what the project declared; catalog.json says which columns each relation really has. */
export function dbtEdges(manifest: Json, catalog: Json): LineageRecord[] {
  const cat: Json = { ...(catalog.sources ?? {}), ...(catalog.nodes ?? {}) };
  const rels = new Map<string, Rel>();
  const add = (id: string, n: Json, source: boolean) => {
    const c = cat[id];
    if (!c || !c.columns) return; // not built in the warehouse: no columns to link
    const declared = new Map<string, { node?: string; column?: string }[]>();
    for (const [cn, def] of Object.entries<Json>(n.columns ?? {})) { const d = def?.meta?.derives_from; if (Array.isArray(d)) declared.set(lc(def.name ?? cn), d); }
    rels.set(id, {
      id, name: n.name, database: n.database ?? c.metadata?.database, schema: n.schema ?? c.metadata?.schema,
      table: (source ? n.identifier : n.alias) ?? n.name, columns: Object.values<Json>(c.columns).sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((x) => String(x.name)),
      parents: n.depends_on?.nodes ?? [], declared, job: `${n.package_name ?? manifest.metadata?.project_name ?? 'dbt'}.${n.name}`, model: !source,
    });
  };
  for (const [id, n] of Object.entries<Json>(manifest.sources ?? {})) add(id, n, true);
  for (const [id, n] of Object.entries<Json>(manifest.nodes ?? {})) if (['model', 'snapshot', 'seed'].includes(n.resource_type)) add(id, n, false);

  const end = (r: Rel, column: string): LineageEnd => ({ database: r.database, schema: r.schema, table: r.table, column });
  const out: LineageRecord[] = [];
  for (const r of [...rels.values()].filter((x) => x.model).sort((a, b) => a.id.localeCompare(b.id))) {
    for (const col of r.columns) {
      const decl = r.declared.get(lc(col));
      if (decl?.length) {
        for (const d of decl) {
          const p = d.node ? rels.get(d.node) : undefined;
          const pc = p?.columns.find((x) => lc(x) === lc(d.column ?? ''));
          out.push({ upstream: p && pc ? end(p, pc) : {}, derived: end(r, col), job: r.job, confidence: DIRECT, origin: 'declared' });
        }
        continue;
      }
      for (const pid of r.parents) {
        const p = rels.get(pid);
        const pc = p?.columns.find((x) => lc(x) === lc(col));
        if (p && pc) out.push({ upstream: end(p, pc), derived: end(r, col), job: r.job, confidence: NAME_MATCH_CONFIDENCE, origin: 'name-match' });
      }
    }
  }
  return out;
}

const dataset = (name: unknown, column: unknown): LineageEnd => {
  const parts = typeof name === 'string' ? name.split('.') : [];
  return parts.length === 3 && parts.every(Boolean) && typeof column === 'string' && column ? { database: parts[0], schema: parts[1], table: parts[2], column } : {};
};

/** Airflow through OpenLineage: a COMPLETE event's output dataset carries column lineage facets; the job name is `dag.task`. */
export function openLineageEdges(events: unknown): LineageRecord[] {
  const list: Json[] = Array.isArray(events) ? events : Array.isArray((events as Json)?.events) ? (events as Json).events : [];
  const out: LineageRecord[] = [];
  for (const ev of [...list].filter((e) => e?.eventType === 'COMPLETE').sort((a, b) => String(a.eventTime).localeCompare(String(b.eventTime)))) {
    const job = String(ev.job?.name ?? '');
    for (const o of ev.outputs ?? []) {
      for (const [col, f] of Object.entries<Json>(o.facets?.columnLineage?.fields ?? {})) {
        for (const i of f.inputFields ?? []) {
          const indirect = (i.transformations ?? []).length > 0 && (i.transformations as Json[]).every((t) => t.type === 'INDIRECT');
          out.push({ upstream: dataset(i.name, i.field), derived: dataset(o.name, col), job, confidence: indirect ? INDIRECT : DIRECT, origin: 'openlineage' });
        }
      }
    }
  }
  return out;
}

/** One edge once per pair of ends: the most confident (then the latest) description wins. */
function dedupe(rs: LineageRecord[]): LineageRecord[] {
  const by = new Map<string, LineageRecord>(); const keep: LineageRecord[] = [];
  const id = (e: LineageEnd) => [e.database, e.schema, e.table, e.column].join('/');
  for (const r of rs) {
    if (!(r.upstream.column && r.derived.column && r.upstream.table && r.derived.table)) { keep.push(r); continue; }
    const k = `${id(r.derived)}->${id(r.upstream)}`; const c = by.get(k);
    if (!c || r.confidence >= c.confidence) by.set(k, r);
  }
  return [...by.values(), ...keep];
}

export function manifestConnector(): Connector {
  const rootOf = (config: Record<string, unknown>): string => {
    const root = (config as unknown as Partial<ManifestConfig>).root;
    if (typeof root !== 'string' || !root) throw new Error('Manifest connection needs root');
    return root;
  };
  return {
    async test(config) {
      try { const r = resolve(rootOf(config)); return existsSync(r) && statSync(r).isDirectory() ? { ok: true } : { ok: false, message: 'The connection root is not a directory' }; }
      catch (e) { return { ok: false, message: (e as Error).message }; }
    },
    async read(config, q: ConnectorQuery): Promise<ReadPage> {
      const root = rootOf(config);
      const [format, target, ...rest] = q.text.trim().split(/\s+/);
      if (!target) throw new Error('A manifest job query is "dbt <dir>", "openlineage <file>" or "git-json <reposDir> <applicationsFile> <kind>"');
      // S7: technical metadata from application repo checkouts (see git-json.ts); one page, for the same reason as below
      if (format === 'git-json') {
        if (rest.length !== 2) throw new Error('A git-json job query is "git-json <reposDir> <applicationsFile> <kind>"');
        return { records: gitJsonRecords(root, target, rest[0]!, rest[1]!), nextCursor: null, done: true, highWater: null };
      }
      let records: LineageRecord[];
      if (format === 'dbt') records = dbtEdges(readJson(root, `${target}/manifest.json`), readJson(root, `${target}/catalog.json`));
      else if (format === 'openlineage') records = openLineageEdges(readJson(root, target));
      else throw new Error(`Unknown manifest format "${format}"`);
      // a whole run is one page: the files are small and a partial read could not tell a missing edge from an unread one
      return { records: dedupe(records), nextCursor: null, done: true, highWater: null };
    },
  };
}
