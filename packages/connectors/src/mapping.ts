import { createHash } from 'node:crypto';
import type { JobDef } from './definition.js';
import type { SourceRecord } from '@dmc/contracts';

/** Follows "a.b.c" through nested objects. "." is the record itself (a flat source row whose edge ends are columns of the same row, S9). */
export function pick(rec: SourceRecord, path: string): unknown {
  if (path === '.') return rec;
  let cur: unknown = rec;
  for (const part of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
}

/** an edge record's key is "<from qualified name>-><to qualified name>" */
export const EDGE_KEY_SEP = '->';
export const splitEdgeKey = (key: string): [string, string] => { const i = key.indexOf(EDGE_KEY_SEP); return [key.slice(0, i), key.slice(i + EDGE_KEY_SEP.length)]; };

function endName(ref: unknown, template: string): string | undefined {
  if (ref === null || typeof ref !== 'object') return undefined;
  let ok = true;
  const qn = template.replace(/\{(\w+)\}/g, (_m, k: string) => { const v = (ref as Record<string, unknown>)[k]; if (v === undefined || v === null || String(v).trim() === '') ok = false; return String(v); });
  return ok ? qn : undefined;
}

/** An edge record: both ends must resolve to a qualified name. The attributes are `from`, `to` and what the job maps (for lineage: job, confidence, origin). */
function mapEdge(rec: SourceRecord, target: JobDef['target'], e: NonNullable<JobDef['target']['edge']>): Mapped | { error: string } {
  const from = endName(pick(rec, e.from), e.qualified_name);
  const to = endName(pick(rec, e.to), e.to_qualified_name ?? e.qualified_name);
  if (!from) return { error: `edge end "${e.from}" is incomplete` };
  if (!to) return { error: `edge end "${e.to}" is incomplete` };
  if (from === to) return { error: 'edge runs from a node to itself' };
  const attrs: Record<string, unknown> = { from, to };
  const bad = mapAttributes(rec, target.map, attrs);
  if (bad) return { error: bad };
  return { key: `${from}${EDGE_KEY_SEP}${to}`, attrs, hash: createHash('sha256').update(stableStringify(attrs)).digest('hex') };
}

/**
 * Copies the mapped fields into `attrs`. A field with a value map renames the source's value; a value the map does not list is an error (returned), never dropped silently.
 * A NULL column (and, for a plain field, a blank string) is an explicit null: the source says the value is gone, so the sync clears it (ADR 0027). A field the record does not have at all is skipped.
 */
function mapAttributes(rec: SourceRecord, map: JobDef['target']['map'], attrs: Record<string, unknown>): string | undefined {
  for (const [to, rule] of Object.entries(map)) {
    const path = typeof rule === 'string' ? rule : rule.from;
    const v = pick(rec, path);
    if (v === undefined) continue;
    if (v === null) { attrs[to] = null; continue; } // part of the hash, so a cleared value is a change
    if (typeof rule === 'string') { attrs[to] = typeof v === 'string' && v.trim() === '' ? null : v; continue; }
    const key = String(v);
    if (!Object.hasOwn(rule.values, key)) return `value "${key}" of "${path}" has no mapping for ${to}`;
    attrs[to] = rule.values[key];
  }
  return undefined;
}

export interface Mapped { key: string; attrs: Record<string, unknown>; hash: string }

/** Maps one source record to the target type. Returns an error string when the record has no usable key. */
export function mapRecord(rec: SourceRecord, target: JobDef['target']): Mapped | { error: string } {
  if (target.edge) return mapEdge(rec, target, target.edge);
  if (!target.key) return { error: 'job has no key field' };
  const raw = pick(rec, target.key);
  if (raw === undefined || raw === null || String(raw).trim() === '') return { error: `no value for key field "${target.key}"` };
  const attrs: Record<string, unknown> = {};
  const bad = mapAttributes(rec, target.map, attrs);
  if (bad) return { error: bad };
  return { key: String(raw), attrs, hash: createHash('sha256').update(stableStringify(attrs)).digest('hex') };
}
