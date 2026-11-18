import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRegistry, migrateModule, provisionModule } from '../packages/platform/src/index';
import { PolicyIndex } from '../packages/policy/src/index';
import { MemoryScheduler, WorkflowEngine } from '../packages/workflow/src/index';
import { entryHash, grantRelay, payloadHash, provisionAudit } from '../packages/evidence/src/index';
import { compose, OUTBOX_MODULES, type Composition } from '../apps/worker/src/index';

// E3: the verifier checks the chain against the audit database anchors (E2); a divergence pauses automatic actions.
const root = join(import.meta.dirname, '..');
const PORT = 54391;
let server: EmbeddedPostgres; let admin: pg.Client; let auditAdmin: pg.Client; let audit: pg.Client;
const clients: pg.Client[] = []; let db: Record<string, pg.Client>; let c: Composition;
const sent: string[] = [];
const conn = (user: string, pw: string, database = 'postgres') => new pg.Client({ host: 'localhost', port: PORT, user, password: pw, database });
const dispatch = (key: string) => c.actions.dispatch({ idempotencyKey: key, decisionId: 'd', policyId: 'p', subjectRef: 'Application:a1', notify: false, route: 'r', effect: { action: 'notify', message: 'hi' } });

beforeAll(async () => {
  server = new EmbeddedPostgres({ databaseDir: mkdtempSync(join(tmpdir(), 'dmc-ver-')), user: 'postgres', password: 'pw', port: PORT, persistent: false });
  await server.initialise(); await server.start();
  admin = conn('postgres', 'pw'); await admin.connect();
  await admin.query('create database audit');
  db = {};
  for (const m of [...OUTBOX_MODULES, 'evidence']) {
    await provisionModule(admin, m, { password: m });
    await migrateModule(admin, m, join(root, `packages/${m}/migrations`));
    await admin.query(`grant all on all tables in schema ${m} to dmc_${m}`);
    await admin.query(`grant all on all sequences in schema ${m} to dmc_${m}`);
    db[m] = conn(`dmc_${m}`, m); await db[m]!.connect(); clients.push(db[m]!);
  }
  await grantRelay(admin, OUTBOX_MODULES);
  auditAdmin = conn('postgres', 'pw', 'audit'); await auditAdmin.connect();
  await provisionAudit(auditAdmin, { writerPassword: 'aw', sqlFile: join(root, 'packages/evidence/audit/0001_anchor.sql') });
  audit = conn('dmc_audit_writer', 'aw', 'audit'); await audit.connect();
  const engine = new WorkflowEngine(new MemoryScheduler(), { resolve: async (rule) => `role:${rule}` });
  c = compose({ db: db as never, audit: audit as never, registry: loadRegistry(join(root, 'metamodel/types')), policies: new PolicyIndex([]), engine, connectors: {},
    notify: { async send(r) { sent.push(`${r.route}:${r.subjectRef}`); } }, sleep: async () => {} });
  await c.exceptions.install(db.workflow!);
}, 150_000);
afterAll(async () => { try { await audit?.end(); await auditAdmin?.end(); await Promise.all(clients.map((x) => x.end())); await admin?.end(); } finally { await server?.stop(); } });

describe('E3: verifier against the audit database anchors', () => {
  it('E3 an intact ledger that matches its anchors passes and leaves actions running', async () => {
    await dispatch('k-1');
    await c.actions.pause('policy:seed', 'seed the ledger', 'test'); await c.actions.release('policy:seed', 'test');
    expect(await c.relay()).toBeGreaterThan(1);
    expect(await c.anchor()).toBe(true);
    expect(await c.verify()).toMatchObject({ ok: true });
    expect(await c.actions.switches()).toEqual([]);
    expect((await admin.query('select status from actions.action where idempotency_key = $1', ['k-1'])).rows[0].status).not.toBe('blocked');
  });

  it('E3 a rewrite that keeps the chain consistent is caught by the anchor: actions pause, a critical exception is raised, the on-call is notified, and the pause is evidenced', async () => {
    // rewrite the anchored head entry and recompute its hashes, so the chain alone looks fine
    const head = (await admin.query('select * from evidence.ledger_entry order by seq desc limit 1')).rows[0];
    const ph = payloadHash({ kind: head.kind, subjectRef: head.subject_ref, actor: 'forged', sourceModule: head.source_module, sourceId: Number(head.source_id), occurredAt: head.occurred_at.toISOString(), payload: head.payload });
    const h = entryHash(head.prev_hash, ph, Number(head.seq));
    await admin.query('alter table evidence.ledger_entry disable trigger ledger_no_row_change');
    await admin.query("update evidence.ledger_entry set actor = 'forged', payload_hash = $2, hash = $3 where seq = $1", [head.seq, ph, h]);
    await admin.query('alter table evidence.ledger_entry enable trigger ledger_no_row_change');
    sent.length = 0;
    const r = await c.verify({ recent: 5 });
    expect(r).toMatchObject({ ok: false, firstBadSeq: Number(head.seq), reason: expect.stringContaining('audit database') });
    expect(await c.actions.switches()).toMatchObject([{ scope: 'all', set_by: 'system/verifier' }]);
    expect((await admin.query("select kind, severity from workflow.exception where kind = 'ledger.divergence'")).rows).toEqual([{ kind: 'ledger.divergence', severity: 'critical' }]);
    expect(sent).toContain('platform-governance:ledger/main');
    const { id } = await dispatch('k-after');
    expect((await admin.query('select status from actions.action where id = $1', [id])).rows[0].status).toBe('blocked');
    // rule 6: the pause itself reaches the ledger
    await c.relay();
    expect((await admin.query("select count(*)::int n from evidence.ledger_entry where kind = 'switch.paused' and subject_ref = 'switch/all'")).rows[0].n).toBe(1);
  });

  it('E3 fails closed: if the audit database cannot be reached, anchors cannot be checked, so actions pause and the on-call is notified', async () => {
    await c.actions.release('all', 'test');
    expect(await c.actions.switches()).toEqual([]);
    const down = { async query() { throw new Error('connection refused'); } };
    const engine = new WorkflowEngine(new MemoryScheduler(), { resolve: async (rule) => `role:${rule}` });
    const c2 = compose({ db: db as never, audit: down as never, registry: loadRegistry(join(root, 'metamodel/types')), policies: new PolicyIndex([]), engine, connectors: {},
      notify: { async send(r) { sent.push(`${r.route}:${r.subjectRef}`); } }, sleep: async () => {} });
    sent.length = 0;
    const r = await c2.verify({ recent: 5 });
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining('audit database unreachable') });
    expect(await c2.actions.switches()).toMatchObject([{ scope: 'all', set_by: 'system/verifier', reason: expect.stringContaining('could not be verified') }]);
    expect(sent).toContain('platform-governance:ledger/main');
    const { id } = await dispatch('k-unreachable');
    expect((await admin.query('select status from actions.action where id = $1', [id])).rows[0].status).toBe('blocked');
  });
});
