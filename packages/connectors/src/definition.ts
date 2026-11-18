import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { parse } from 'yaml';
import type { Registry } from '@dmc/platform';

/** A mapped attribute that renames the source's values: `{ from: type, values: { ProcessX: business-process } }`. A value with no entry is refused and reported. */
export interface MapRule { from: string; values: Record<string, string> }

export interface JobDef {
  job: string; connection: string; schedule: string;
  source: { query: string; mode: 'incremental' | 'full'; cursor?: string; page_size?: number };
  target: {
    type: string; key?: string; source?: string; map: Record<string, string | MapRule>; on_missing?: 'deprecate' | 'ignore';
    /** an edge job: each record is one edge between two nodes of `type`, named in the metamodel (S8) */
    edge?: { name: string; qualified_name: string; to_qualified_name?: string; from: string; to: string };
  };
  limits?: { max_changes_pct?: number };
  retries?: { max?: number; backoff_seconds?: number };
}
export interface Overlay {
  connections?: Record<string, { secret: string; [param: string]: unknown }>;
  jobs?: Record<string, { connection?: string; schedule?: string; enabled?: boolean; [param: string]: unknown }>;
}
export interface ResolvedJob {
  def: JobDef; environment: string; connection: string; schedule: string; enabled: boolean;
  /** the query with ${params} filled in from the overlay */
  query: string; params: Record<string, string>;
}

export class SyncDefError extends Error {
  constructor(readonly problems: string[]) { super(`Invalid sync definition:\n - ${problems.join('\n - ')}`); }
}

const load = (f: string) => JSON.parse(readFileSync(new URL(`../schema/${f}`, import.meta.url), 'utf8')) as object;
const ajv = new Ajv2020({ allErrors: true, strict: false });
const checkJob = ajv.compile(load('job.schema.json'));
const checkOverlay = ajv.compile(load('overlay.schema.json'));

function parseYaml(text: string): unknown {
  try { return parse(text); } catch (e) { throw new SyncDefError([`not valid YAML: ${(e as Error).message}`]); }
}

export function compileJob(yamlText: string): JobDef {
  const doc = parseYaml(yamlText);
  if (!checkJob(doc)) throw new SyncDefError((checkJob.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`));
  const d = doc as JobDef;
  const problems: string[] = [];
  if (d.source.mode === 'incremental' && !d.source.cursor) problems.push('/source: incremental jobs need a cursor field');
  if (!d.target.key && !d.target.edge) problems.push('/target: needs a key field, or an edge');
  if (d.target.key && d.target.edge) problems.push('/target: key and edge are exclusive');
  if (!Object.values(d.target.map).length || !Object.keys(d.target.map).length) problems.push('/target/map is empty');
  if (problems.length) throw new SyncDefError(problems);
  return d;
}

export function compileOverlay(yamlText: string): Overlay {
  const doc = parseYaml(yamlText) ?? {};
  if (!checkOverlay(doc)) throw new SyncDefError((checkOverlay.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`));
  return doc as Overlay;
}

const PLACEHOLDER = /REPLACE_ME/;

/** Applies one environment's overlay to a job: connection, schedule, enabled flag, and the parameters the query refers to. */
export function resolveJob(def: JobDef, overlay: Overlay, environment: string): ResolvedJob {
  const o = overlay.jobs?.[def.job] ?? {};
  const connection = o.connection ?? def.connection;
  const conn = overlay.connections?.[connection];
  const problems: string[] = [];
  if (!conn) problems.push(`connection "${connection}" is not defined for ${environment}`);
  const { connection: _c, schedule: _s, enabled: _e, ...jobParams } = o;
  const { secret: _secret, ...connParams } = conn ?? { secret: '' };
  const params: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...connParams, ...jobParams })) if (typeof v === 'string' || typeof v === 'number') params[k] = String(v);
  const fill = (text: string, where: string) => text.replace(/\$\{([a-zA-Z_][\w]*)\}/g, (_m, name: string) => {
    if (!(name in params)) { problems.push(`${where} uses \${${name}} but ${environment} does not set it`); return ''; }
    return params[name]!;
  });
  const query = fill(def.source.query, 'query');
  // An environment overlay may carry REPLACE_ME placeholders for values another team has not supplied yet. They are fine on a job that is off and never pass as real values on a job that is on.
  if (o.enabled ?? true) {
    const open = [...Object.entries({ ...connParams, ...jobParams }).filter(([, v]) => PLACEHOLDER.test(JSON.stringify(v))).map(([k]) => k), ...(conn && PLACEHOLDER.test(conn.secret) ? ['secret'] : [])];
    if (open.length) problems.push(`${environment} still has placeholder (REPLACE_ME) values for ${open.join(', ')}: set them before enabling ${def.job}`);
  }
  // ADR 0026: an edge job names the field that identifies the person (the staff ID, or an email) as a parameter: to_qualified_name: "{${ownerKeyField}}"
  const edge = def.target.edge;
  if (edge) def = { ...def, target: { ...def.target, edge: { ...edge, qualified_name: fill(edge.qualified_name, 'edge qualified_name'), ...(edge.to_qualified_name ? { to_qualified_name: fill(edge.to_qualified_name, 'edge to_qualified_name') } : {}) } } };
  if (problems.length) throw new SyncDefError(problems);
  return { def, environment, connection, schedule: o.schedule ?? def.schedule, enabled: o.enabled ?? true, query, params };
}

/**
 * Checks a job against the metamodel (ADR 0024): the target type exists and every value of a value map is a value of the attribute's enum.
 * Returns the problems; the worker refuses to load a job that has any. Edge jobs are not checked here (their attributes belong to the edge).
 */
export function checkJobAgainstMetamodel(def: JobDef, registry: Registry): string[] {
  const problems: string[] = [];
  const rules = Object.entries(def.target.map).filter((e): e is [string, MapRule] => typeof e[1] !== 'string');
  if (!rules.length || def.target.edge) return problems;
  if (!registry.has(def.target.type)) return [`/target/type: unknown type ${def.target.type}`];
  const attrs = registry.get(def.target.type).attributes;
  for (const [attr, rule] of rules) {
    const a = attrs[attr];
    if (!a) { problems.push(`/target/map/${attr}: ${def.target.type} has no attribute ${attr}`); continue; }
    if (a.type !== 'enum') continue;
    for (const to of Object.values(rule.values)) if (!a.values?.includes(to)) problems.push(`/target/map/${attr}: "${to}" is not a value of ${def.target.type}.${attr} (${(a.values ?? []).join(', ')})`);
  }
  return problems;
}
