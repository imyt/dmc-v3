import { readFileSync } from 'node:fs';
import type { Queryable } from '@dmc/platform';
import type { VerifyResult } from './ledger.js';

export const AUDIT_ROLE = 'dmc_audit_writer';
export const ANCHOR_EVERY = { entries: 5000, seconds: 5 } as const;

/**
 * Creates the audit database's table and its insert-only role. Run as the audit database's admin, on every deploy; safe to repeat.
 * `sqlFile` is packages/evidence/audit/0001_anchor.sql.
 */
export async function provisionAudit(admin: Queryable, opts: { writerPassword: string; sqlFile: string }): Promise<void> {
  const exists = await admin.query('select 1 from pg_roles where rolname = $1', [AUDIT_ROLE]);
  if (exists.rowCount === 0) await admin.query(`create role ${AUDIT_ROLE} login password '${opts.writerPassword.replace(/'/g, "''")}'`);
  await admin.query(readFileSync(opts.sqlFile, 'utf8'));
  await admin.query(`revoke all on chain_anchor from public`);
  await admin.query(`grant select, insert on chain_anchor to ${AUDIT_ROLE}`);
  await admin.query(`revoke update, delete, truncate on chain_anchor from ${AUDIT_ROLE}`);
}

export interface AnchorResult { anchored: boolean; seq?: number }

/**
 * Copies the ledger's head hash to the audit database, when it is due: 5 seconds since the last copy, or 5,000 entries since it.
 * Nothing is copied while the ledger has not grown. The audit database is written by this role only, and only ever inserted into.
 */
export async function anchorIfDue(evidence: Queryable, audit: Queryable, now: Date = new Date(), every: { entries: number; seconds: number } = ANCHOR_EVERY): Promise<AnchorResult> {
  const head = (await evidence.query<{ seq: string; hash: string }>('select seq, hash from evidence.ledger_entry order by seq desc limit 1')).rows[0];
  if (!head) return { anchored: false };
  const last = (await audit.query<{ seq: string; anchored_at: Date }>('select seq, anchored_at from chain_anchor order by seq desc limit 1')).rows[0];
  const seq = Number(head.seq);
  if (last) {
    const grown = seq - Number(last.seq);
    if (grown <= 0) return { anchored: false };
    const waited = (now.getTime() - last.anchored_at.getTime()) / 1000;
    if (grown < every.entries && waited < every.seconds) return { anchored: false };
  }
  await audit.query('insert into chain_anchor (seq, hash, anchored_at) values ($1, $2, $3) on conflict (seq) do nothing', [seq, head.hash, now]);
  return { anchored: true, seq };
}

/**
 * Compares every anchor with the ledger entry at the same seq. A chain that is internally consistent but was rewritten after an anchor
 * was taken is caught here, because the anchor sits where the ledger's own role cannot reach it.
 */
export async function checkAnchors(evidence: Queryable, audit: Queryable, opts: { sinceSeq?: number } = {}): Promise<VerifyResult> {
  const anchors = await audit.query<{ seq: string; hash: string }>('select seq, hash from chain_anchor where seq > $1 order by seq', [opts.sinceSeq ?? 0]);
  let checked = 0;
  for (const a of anchors.rows) {
    const e = (await evidence.query<{ hash: string }>('select hash from evidence.ledger_entry where seq = $1', [Number(a.seq)])).rows[0];
    if (!e) return { ok: false, checked, firstBadSeq: Number(a.seq), reason: 'the audit database holds an anchor for an entry the ledger no longer has' };
    if (e.hash !== a.hash) return { ok: false, checked, firstBadSeq: Number(a.seq), reason: 'the ledger entry differs from the hash copied to the audit database' };
    checked++;
  }
  return { ok: true, checked };
}
