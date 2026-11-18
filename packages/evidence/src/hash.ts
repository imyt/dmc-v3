import { createHash } from 'node:crypto';

export const GENESIS_HASH = '0'.repeat(64);
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** JSON with object keys sorted at every level, so the same data always hashes the same. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}

export interface EntryFields {
  kind: string;
  subjectRef: string;
  actor: string;
  sourceModule: string;
  sourceId: number;
  occurredAt: string; // ISO, millisecond precision
  payload: unknown;
}

export const payloadHash = (e: EntryFields): string => sha256(canonical(e));

/** hash = H(prev_hash ‖ payload_hash ‖ seq) */
export const entryHash = (prev: string, payloadH: string, seq: number): string => sha256(`${prev}|${payloadH}|${seq}`);
