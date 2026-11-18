import type { Queryable } from '@dmc/platform';
import { ident } from '@dmc/platform';
import { GENESIS_HASH, entryHash, payloadHash, type EntryFields } from './hash.js';

const LOCK_KEY = 'evidence.ledger';

export interface Appended { seq: number; hash: string }

/**
 * Appends entries to the chain. Caller must be inside a transaction; the advisory lock makes
 * this the single writer even if two workers start at once.
 */
export async function appendBatch(tx: Queryable, entries: EntryFields[]): Promise<Appended | undefined> {
  if (entries.length === 0) return undefined;
  await tx.query('select pg_advisory_xact_lock(hashtext($1))', [LOCK_KEY]);
  const head = await tx.query<{ seq: string; hash: string }>('select seq, hash from evidence.ledger_entry order by seq desc limit 1');
  let seq = head.rows[0] ? Number(head.rows[0].seq) : 0;
  let prev = head.rows[0]?.hash ?? GENESIS_HASH;

  const cols = { seq: [] as number[], kind: [] as string[], subject: [] as string[], actor: [] as string[], mod: [] as string[], src: [] as number[],
    payload: [] as string[], at: [] as string[], ph: [] as string[], prev: [] as string[], hash: [] as string[] };
  for (const e of entries) {
    seq += 1;
    const ph = payloadHash(e);
    const h = entryHash(prev, ph, seq);
    cols.seq.push(seq); cols.kind.push(e.kind); cols.subject.push(e.subjectRef); cols.actor.push(e.actor);
    cols.mod.push(e.sourceModule); cols.src.push(e.sourceId); cols.payload.push(JSON.stringify(e.payload));
    cols.at.push(e.occurredAt); cols.ph.push(ph); cols.prev.push(prev); cols.hash.push(h);
    prev = h;
  }
  await tx.query(
    `insert into evidence.ledger_entry (seq, kind, subject_ref, actor, source_module, source_id, payload, occurred_at, payload_hash, prev_hash, hash)
     select * from unnest($1::bigint[], $2::text[], $3::text[], $4::text[], $5::text[], $6::bigint[], $7::text[]::jsonb[], $8::timestamptz[], $9::text[], $10::text[], $11::text[])`,
    [cols.seq, cols.kind, cols.subject, cols.actor, cols.mod, cols.src, cols.payload, cols.at, cols.ph, cols.prev, cols.hash],
  );
  return { seq, hash: prev };
}

/**
 * Moves unpublished outbox rows from the given modules into the ledger, in one transaction:
 * either the entries are chained and the rows marked published, or nothing changes.
 * Needs a connection that can read and mark those outbox tables (see grantRelay).
 */
export async function relayOutbox(db: Queryable, modules: string[], opts: { batch?: number } = {}): Promise<number> {
  const limit = opts.batch ?? 1000;
  await db.query('begin');
  try {
    const rows: (EntryFields & { createdAt: Date })[] = [];
    const taken = new Map<string, number[]>();
    for (const m of modules) {
      const r = await db.query<{ id: string; event_type: string; subject_ref: string; actor: string; payload: unknown; created_at: Date }>(
        `select id, event_type, subject_ref, actor, payload, created_at from ${ident(m)}.outbox
         where published_at is null order by id limit $1 for update skip locked`, [limit]);
      for (const x of r.rows) {
        rows.push({ kind: x.event_type, subjectRef: x.subject_ref, actor: x.actor, sourceModule: m, sourceId: Number(x.id),
          payload: x.payload, occurredAt: x.created_at.toISOString(), createdAt: x.created_at });
      }
      taken.set(m, r.rows.map((x) => Number(x.id)));
    }
    rows.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.sourceModule.localeCompare(b.sourceModule) || a.sourceId - b.sourceId);
    await appendBatch(db, rows.slice(0, rows.length).map(({ createdAt: _c, ...e }) => e));
    for (const [m, ids] of taken) {
      if (ids.length) await db.query(`update ${ident(m)}.outbox set published_at = now() where id = any($1::bigint[])`, [ids]);
    }
    await db.query('commit');
    return rows.length;
  } catch (e) {
    await db.query('rollback');
    throw e;
  }
}

/** Admin-run: lets the evidence role read and mark each module's outbox (the one cross-schema exception; ADR 0005). */
export async function grantRelay(admin: Queryable, modules: string[]): Promise<void> {
  for (const m of modules) {
    await admin.query(`grant usage on schema ${ident(m)} to dmc_evidence`);
    await admin.query(`grant select, update (published_at) on ${ident(m)}.outbox to dmc_evidence`);
  }
}

export interface VerifyResult { ok: boolean; checked: number; firstBadSeq?: number; reason?: string }

/** Recomputes every hash in [fromSeq, toSeq] and checks seq continuity and chain links. */
export async function verifyChain(db: Queryable, opts: { fromSeq?: number; toSeq?: number } = {}): Promise<VerifyResult> {
  const from = opts.fromSeq ?? 1;
  const to = opts.toSeq ?? Number.MAX_SAFE_INTEGER;
  let prev = GENESIS_HASH;
  if (from > 1) {
    const p = await db.query<{ hash: string }>('select hash from evidence.ledger_entry where seq = $1', [from - 1]);
    if (!p.rows[0]) return { ok: false, checked: 0, firstBadSeq: from - 1, reason: 'missing entry before range' };
    prev = p.rows[0].hash;
  }
  let expected = from;
  let checked = 0;
  let cursor = from - 1;
  for (;;) {
    const page = await db.query<{ seq: string; kind: string; subject_ref: string; actor: string; source_module: string; source_id: string;
      payload: unknown; occurred_at: Date; payload_hash: string; prev_hash: string; hash: string }>(
      'select * from evidence.ledger_entry where seq > $1 and seq <= $2 order by seq limit 5000', [cursor, to]);
    if (page.rows.length === 0) break;
    for (const r of page.rows) {
      const seq = Number(r.seq);
      const bad = (reason: string): VerifyResult => ({ ok: false, checked, firstBadSeq: seq, reason });
      if (seq !== expected) return { ok: false, checked, firstBadSeq: expected, reason: 'entry missing (gap in seq)' };
      if (r.prev_hash !== prev) return bad('prev_hash does not match the previous entry');
      const ph = payloadHash({ kind: r.kind, subjectRef: r.subject_ref, actor: r.actor, sourceModule: r.source_module,
        sourceId: Number(r.source_id), occurredAt: r.occurred_at.toISOString(), payload: r.payload });
      if (ph !== r.payload_hash) return bad('payload_hash does not match the stored fields');
      if (entryHash(prev, ph, seq) !== r.hash) return bad('hash does not match');
      prev = r.hash; expected += 1; checked += 1; cursor = seq;
    }
  }
  return { ok: true, checked };
}
