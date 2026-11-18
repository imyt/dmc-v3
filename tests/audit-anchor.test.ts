import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { provisionModule, migrateModule } from '../packages/platform/src/index';
import { anchorIfDue, appendBatch, checkAnchors, provisionAudit, type EntryFields } from '../packages/evidence/src/index';

let server: EmbeddedPostgres; let admin: pg.Client; let ev: pg.Client; let auditAdmin: pg.Client; let audit: pg.Client;
const root = join(import.meta.dirname, '..');
const entry = (i: number): EntryFields => ({ kind: 'node.updated', subjectRef: `node/${i}`, actor: 'svc', sourceModule: 'catalog', sourceId: i, occurredAt: new Date(1_700_000_000_000 + i).toISOString(), payload: { i } });
const t0 = new Date('2026-11-18T10:00:00Z');
const at = (s: number) => new Date(t0.getTime() + s * 1000);

beforeAll(async () => {
  server = new EmbeddedPostgres({ databaseDir: mkdtempSync(join(tmpdir(), 'dmc-aud-')), user: 'postgres', password: 'pw', port: 54383, persistent: false });
  await server.initialise(); await server.start();
  admin = new pg.Client({ host: 'localhost', port: 54383, user: 'postgres', password: 'pw', database: 'postgres' }); await admin.connect();
  await admin.query('create database audit');
  await provisionModule(admin, 'evidence', { password: 'ev' }); await migrateModule(admin, 'evidence', join(root, 'packages/evidence/migrations'));
  ev = new pg.Client({ host: 'localhost', port: 54383, user: 'dmc_evidence', password: 'ev', database: 'postgres' }); await ev.connect();
  auditAdmin = new pg.Client({ host: 'localhost', port: 54383, user: 'postgres', password: 'pw', database: 'audit' }); await auditAdmin.connect();
  const sqlFile = join(root, 'packages/evidence/audit/0001_anchor.sql');
  await provisionAudit(auditAdmin, { writerPassword: 'aw', sqlFile }); await provisionAudit(auditAdmin, { writerPassword: 'aw', sqlFile });   // twice: safe to repeat
  audit = new pg.Client({ host: 'localhost', port: 54383, user: 'dmc_audit_writer', password: 'aw', database: 'audit' }); await audit.connect();
}, 120_000);
afterAll(async () => { try { await audit?.end(); await auditAdmin?.end(); await ev?.end(); await admin?.end(); } finally { await server?.stop(); } });

describe('E2: audit database copy', () => {
  it('copies nothing from an empty ledger, then the head hash when due, then waits', async () => {
    expect(await anchorIfDue(ev, audit, at(0))).toEqual({ anchored: false });
    await appendBatch(ev, [entry(1), entry(2), entry(3)]);
    expect(await anchorIfDue(ev, audit, at(0))).toEqual({ anchored: true, seq: 3 });
    await appendBatch(ev, [entry(4)]);
    expect(await anchorIfDue(ev, audit, at(2))).toEqual({ anchored: false });       // grew, but not 5 s and not 5,000 entries
    expect(await anchorIfDue(ev, audit, at(6))).toEqual({ anchored: true, seq: 4 });  // 5 s on
    expect(await anchorIfDue(ev, audit, at(60))).toEqual({ anchored: false });       // not grown
    await appendBatch(ev, [entry(5)]);
    expect(await anchorIfDue(ev, audit, at(61), { entries: 1, seconds: 5 })).toEqual({ anchored: true, seq: 5 });   // entry count reached before the time
  });

  it('DMC’s role cannot update, delete or truncate in the audit database', async () => {
    await expect(audit.query("update chain_anchor set hash = 'x'")).rejects.toThrow();
    await expect(audit.query('delete from chain_anchor')).rejects.toThrow();
    await expect(audit.query('truncate chain_anchor')).rejects.toThrow();
  });

  it('anchors agree with an intact ledger, and a rewritten entry is caught even if the chain is consistent', async () => {
    expect(await checkAnchors(ev, audit)).toMatchObject({ ok: true, checked: 3 });
    await admin.query('set session_replication_role = replica');
    await admin.query("update evidence.ledger_entry set hash = 'f' || substr(hash, 2) where seq = 4");
    await admin.query('set session_replication_role = origin');
    const r = await checkAnchors(ev, audit);
    expect(r).toMatchObject({ ok: false, firstBadSeq: 4 });
  });
});
