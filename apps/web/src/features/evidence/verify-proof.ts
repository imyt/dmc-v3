import type { ApiProof } from '@/lib/data';

/**
 * Checks a proof bundle in the browser, with no call to DMC (ADR 0017: whoever holds a proof can run this). It mirrors `verifyProof` in
 * `@dmc/evidence`: every entry hashes to what it says, every chain link recomputes from the one before, and every entry sits on that chain.
 * The bundle's `head` still has to be compared with the audit database copy; this shows internal consistency only.
 */
export interface ProofCheck { ok: boolean; entries: number; links: number; reason?: string; badSeq?: number }

const GENESIS = '0'.repeat(64);
async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
/** JSON with object keys sorted at every level (the same rule the ledger hashes with). */
export function canonical(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().filter((k) => o[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(',')}}`;
}

interface Entry { seq: number; kind: string; subjectRef: string; actor: string; sourceModule: string; sourceId: number; occurredAt: string; payload: unknown; payloadHash: string; hash: string }

export async function verifyProofBundle(b: ApiProof): Promise<ProofCheck> {
  const entries = b.entries as unknown as Entry[];
  const fail = (reason: string, badSeq?: number): ProofCheck => ({ ok: false, entries: entries.length, links: b.chain.length, reason, ...(badSeq !== undefined ? { badSeq } : {}) });
  if (b.version !== 1) return fail('unknown proof version');
  if (entries.length === 0) return b.chain.length === 0 ? { ok: true, entries: 0, links: 0 } : fail('chain without entries');
  const bySeq = new Map(b.chain.map((c) => [c.seq, c]));
  if (b.chain[0]?.seq !== entries[0]!.seq || b.chain.at(-1)?.seq !== entries.at(-1)!.seq) return fail('chain does not span the entries');
  let prev = b.anchorPrev || GENESIS; let expected = b.chain[0]!.seq;
  for (const c of b.chain) {
    if (c.seq !== expected) return fail('gap in the chain', expected);
    if (await sha256(`${prev}|${c.payloadHash}|${c.seq}`) !== c.hash) return fail('chain link does not recompute', c.seq);
    prev = c.hash; expected += 1;
  }
  for (const e of entries) {
    const link = bySeq.get(e.seq);
    if (!link) return fail('entry is not on the chain', e.seq);
    const ph = await sha256(canonical({ kind: e.kind, subjectRef: e.subjectRef, actor: e.actor, sourceModule: e.sourceModule, sourceId: e.sourceId, occurredAt: e.occurredAt, payload: e.payload }));
    if (ph !== e.payloadHash || ph !== link.payloadHash) return fail('entry content does not match its hash', e.seq);
    if (e.hash !== link.hash) return fail('entry hash differs from the chain', e.seq);
  }
  const last = b.chain.at(-1)!;
  const head = b.head as { seq: number; hash: string } | null;
  if (head && head.seq === last.seq && head.hash !== last.hash) return fail('head does not match the chain', last.seq);
  return { ok: true, entries: entries.length, links: b.chain.length };
}
