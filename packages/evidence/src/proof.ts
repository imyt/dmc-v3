import type { Queryable } from '@dmc/platform';
import { GENESIS_HASH, entryHash, payloadHash } from './hash.js';

export interface TraceEntry {
  seq: number; kind: string; subjectRef: string; actor: string; sourceModule: string; sourceId: number;
  occurredAt: string; payload: unknown; payloadHash: string; prevHash: string; hash: string;
}
type Row = { seq: string; kind: string; subject_ref: string; actor: string; source_module: string; source_id: string; payload: unknown; occurred_at: Date; payload_hash: string; prev_hash: string; hash: string };
const toEntry = (r: Row): TraceEntry => ({ seq: Number(r.seq), kind: r.kind, subjectRef: r.subject_ref, actor: r.actor, sourceModule: r.source_module, sourceId: Number(r.source_id),
  occurredAt: r.occurred_at.toISOString(), payload: r.payload, payloadHash: r.payload_hash, prevHash: r.prev_hash, hash: r.hash });

/** Entries about any of these subjects, oldest first, one page at a time (`afterSeq` is the cursor). */
export async function trace(db: Queryable, subjects: string[], opts: { afterSeq?: number; limit?: number; kind?: string } = {}): Promise<TraceEntry[]> {
  const r = await db.query<Row>(
    `select * from evidence.ledger_entry where subject_ref = any($1) and seq > $2 and ($4::text is null or kind = $4) order by seq limit $3`,
    [subjects, opts.afterSeq ?? 0, opts.limit ?? 50, opts.kind ?? null]);
  return r.rows.map(toEntry);
}

/** A self-contained proof: the entries about a subject, plus every link of the chain between the first and the last. */
export interface ProofBundle {
  version: 1;
  subjects: string[];
  exportedAt: string;
  entries: TraceEntry[];
  /** `payloadHash` and `hash` of every ledger entry from the first to the last of `entries`, in order */
  chain: { seq: number; payloadHash: string; hash: string }[];
  /** the hash that precedes `chain[0]` */
  anchorPrev: string;
  /** the ledger head when the proof was made: compare it with the audit database copy */
  head: { seq: number; hash: string } | null;
}

export class ProofTooLarge extends Error {}

export async function exportProof(db: Queryable, subjects: string[], opts: { maxChain?: number; now?: Date } = {}): Promise<ProofBundle> {
  const rows = await db.query<Row>('select * from evidence.ledger_entry where subject_ref = any($1) order by seq', [subjects]);
  const entries = rows.rows.map(toEntry);
  const headRow = await db.query<{ seq: string; hash: string }>('select seq, hash from evidence.ledger_entry order by seq desc limit 1');
  const head = headRow.rows[0] ? { seq: Number(headRow.rows[0].seq), hash: headRow.rows[0].hash } : null;
  const base = { version: 1 as const, subjects, exportedAt: (opts.now ?? new Date()).toISOString(), head };
  if (entries.length === 0) return { ...base, entries, chain: [], anchorPrev: GENESIS_HASH };
  const first = entries[0]!.seq; const last = entries.at(-1)!.seq;
  const max = opts.maxChain ?? 200_000;
  if (last - first + 1 > max) throw new ProofTooLarge(`These entries span ${last - first + 1} ledger entries; export is limited to ${max}`);
  const chain = await db.query<{ seq: string; payload_hash: string; hash: string }>('select seq, payload_hash, hash from evidence.ledger_entry where seq between $1 and $2 order by seq', [first, last]);
  return { ...base, entries, chain: chain.rows.map((c) => ({ seq: Number(c.seq), payloadHash: c.payload_hash, hash: c.hash })), anchorPrev: entries[0]!.prevHash };
}

export interface ProofResult { ok: boolean; entries: number; links: number; reason?: string; badSeq?: number }

/**
 * Checks a proof with no database: every entry hashes to what it says, every link of the chain recomputes from the one before,
 * and every entry sits on that chain. Whoever holds the proof can run this; compare `head` with the audit copy separately.
 */
export function verifyProof(b: ProofBundle): ProofResult {
  const fail = (reason: string, badSeq?: number): ProofResult => ({ ok: false, entries: b.entries.length, links: b.chain.length, reason, badSeq });
  if (b.version !== 1) return fail('unknown proof version');
  if (b.entries.length === 0) return b.chain.length === 0 ? { ok: true, entries: 0, links: 0 } : fail('chain without entries');
  const bySeq = new Map(b.chain.map((c) => [c.seq, c]));
  if (b.chain[0]?.seq !== b.entries[0]!.seq || b.chain.at(-1)?.seq !== b.entries.at(-1)!.seq) return fail('chain does not span the entries');
  let prev = b.anchorPrev; let expected = b.chain[0]!.seq;
  for (const c of b.chain) {
    if (c.seq !== expected) return fail('gap in the chain', expected);
    if (entryHash(prev, c.payloadHash, c.seq) !== c.hash) return fail('chain link does not recompute', c.seq);
    prev = c.hash; expected += 1;
  }
  for (const e of b.entries) {
    const link = bySeq.get(e.seq);
    if (!link) return fail('entry is not on the chain', e.seq);
    const ph = payloadHash({ kind: e.kind, subjectRef: e.subjectRef, actor: e.actor, sourceModule: e.sourceModule, sourceId: e.sourceId, occurredAt: e.occurredAt, payload: e.payload });
    if (ph !== e.payloadHash || ph !== link.payloadHash) return fail('entry content does not match its hash', e.seq);
    if (e.hash !== link.hash) return fail('entry hash differs from the chain', e.seq);
  }
  if (b.head && b.head.seq === b.chain.at(-1)!.seq && b.head.hash !== b.chain.at(-1)!.hash) return fail('head does not match the chain', b.head.seq);
  return { ok: true, entries: b.entries.length, links: b.chain.length };
}
