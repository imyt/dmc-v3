import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Connector, ReadPage, SourceRecord } from '../packages/contracts/src/index';
import { loadRegistry, migrateModule, provisionModule } from '../packages/platform/src/index';
import { PolicyIndex, compilePolicy } from '../packages/policy/src/index';
import { MemoryScheduler, WorkflowEngine } from '../packages/workflow/src/index';
import { compileJob, resolveJob } from '../packages/connectors/src/index';
import { PgBoss } from 'pg-boss';
import { grantRelay } from '../packages/evidence/src/index';
import { compose, startWorker, TICK_QUEUE, VERIFY_RECENT_QUEUE, OUTBOX_MODULES, type Composition } from '../apps/worker/src/index';

const root = join(import.meta.dirname, '..');
const registry = loadRegistry(join(root, 'metamodel/types'));
const PORT = 54343;
let server: EmbeddedPostgres; let admin: pg.Client; const clients: pg.Client[] = []; let c: Composition; let db: Record<string, pg.Client>;

const JOB = `
job: apps
connection: snow
schedule: "0 3 * * *"
source: { query: "select * from apps", mode: full }
target:
  type: Application
  key: sys_id
  source: servicenow
  map: { name: name, owner: owner, hosting_country: country, status: status, criticality: crit }
`;
let table: SourceRecord[] = [];
const connector: Connector = { async test() { return { ok: true }; }, async read(): Promise<ReadPage> { return { records: table, nextCursor: null, done: true, highWater: null }; } };
const rec = (id: string, over: Record<string, unknown> = {}): SourceRecord => ({ sys_id: id, name: `App ${id}`, owner: '43000001', country: 'GB', status: 'live', crit: 'high', ...over });
const sent: string[] = [];

// every live application gets a DMC-side note, automatically
const policy = compilePolicy(`policy: note-live-apps
control: c
mode: enforced
scope: { type: Application }
when: "application.status == 'live'"
effect: { action: set_attribute, attribute: description, value: Reviewed by DMC }
route: application-owner
autonomy: act
`, registry, 'note-live-apps.yaml');

beforeAll(async () => {
  server = new EmbeddedPostgres({ databaseDir: mkdtempSync(join(tmpdir(), 'dmc-wrk-')), user: 'postgres', password: 'pw', port: PORT, persistent: false });
  await server.initialise(); await server.start();
  const client = (user: string, pw: string) => new pg.Client({ host: 'localhost', port: PORT, user, password: pw, database: 'postgres' });
  admin = client('postgres', 'pw'); await admin.connect();
  db = {};
  for (const m of [...OUTBOX_MODULES, 'evidence']) {
    await provisionModule(admin, m, { password: m });
    await migrateModule(admin, m, join(root, `packages/${m}/migrations`));
    await admin.query(`grant all on all tables in schema ${m} to dmc_${m}`);
    await admin.query(`grant all on all sequences in schema ${m} to dmc_${m}`);
    db[m] = client(`dmc_${m}`, m); await db[m]!.connect(); clients.push(db[m]!);
  }
  await grantRelay(admin, OUTBOX_MODULES);
  const engine = new WorkflowEngine(new MemoryScheduler(), { resolve: async (rule, { context }) => `role:${rule === 'route' ? context.route : rule}` });
  c = compose({ db: db as never, registry, policies: new PolicyIndex([policy]), engine, connectors: { fake: connector }, notify: { async send(r) { sent.push(`${r.route}:${r.subjectRef}`); } }, sleep: async () => {} });
  await c.exceptions.install(db.workflow!);
  await c.sync.upsertConnection(db.connectors!, { name: 'snow', environment: 'local', type: 'fake', config: {}, secretRef: 'x' });
  await c.sync.installJob(db.connectors!, resolveJob(compileJob(JOB), { connections: { snow: { secret: 'x' } }, jobs: {} }, 'local'));
}, 150_000);
afterAll(async () => { try { await Promise.all(clients.map((x) => x.end())); await admin?.end(); } finally { await server?.stop(); } });
const run = () => c.sync.run(db.connectors!, 'apps', 'local');
const node = (qn: string) => c.store.getNode(db.catalog!, qn);

describe('worker composition: sense → decide → enforce', () => {
  it('a sync run creates the node, a policy sets a DMC field through the action module, and every step is evidenced', async () => {
    table = [rec('a1')];
    await run();
    const n = await node('a1');
    expect(n!.attributes).toMatchObject({ name: 'App a1', status: 'live', description: 'Reviewed by DMC' });
    expect(n!.provenance.description!.by).toBe('dmc');
    expect(n!.provenance.name!.by).toBe('servicenow');
    const act = await admin.query("select status, kind, policy_id from actions.action where subject_ref = 'Application:a1'");
    expect(act.rows).toEqual([{ status: 'done', kind: 'dmc_change', policy_id: 'note-live-apps' }]);
    const events = async (m: string) => (await admin.query(`select event_type from ${m}.outbox`)).rows.map((x) => x.event_type);
    expect(await events('decision')).toEqual(expect.arrayContaining(['signal.received', 'decision.made', 'decision.applied']));
    expect(await events('actions')).toContain('action.done');
    expect(await events('catalog')).toEqual(expect.arrayContaining(['node.created', 'node.updated']));
  });

  it('a second identical run changes nothing and decides nothing new', async () => {
    const before = (await admin.query('select count(*)::int as n from decision.signal')).rows[0].n;
    await run();
    expect((await admin.query('select count(*)::int as n from decision.signal')).rows[0].n).toBe(before);
  });

  it('a change that was asked of the owning tool is confirmed when the next sync shows it', async () => {
    await c.actions.dispatch({ idempotencyKey: 'k-classify', decisionId: 'd-x', policyId: 'p-x', subjectRef: 'Application:a1', notify: false, route: 'app-owners',
      effect: { action: 'classify', attribute: 'criticality', value: 'critical', message: 'Raise criticality in ServiceNow' } });
    expect((await admin.query("select state from actions.pending_change where subject_ref = 'Application:a1'")).rows).toEqual([{ state: 'pending' }]);
    table = [rec('a1', { crit: 'critical' })];
    await run();
    expect((await admin.query("select state from actions.pending_change where subject_ref = 'Application:a1'")).rows).toEqual([{ state: 'confirmed' }]);
  });

  it('a record that disappears is deprecated, and policies see the lifecycle', async () => {
    table = [rec('a2')];
    await run();
    expect((await node('a1'))!.lifecycle).toBe('deprecated');
    expect((await node('a2'))!.lifecycle).toBe('discovered');
  });

  it('tick finishes unfinished work and reports what it did', async () => {
    expect(await c.tick()).toEqual({ resumed: 0, retried: 0, escalated: 0, delegationsEnded: 0, remindersRaised: 0, linkTasksOpened: 0 });
  });

  it('delegations: the owner is reminded once before one expires, and one ends when the source changes the scope owner', async () => {
    const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
    const cat = db.catalog!;
    await c.store.tx(cat, () => c.store.applyNode(cat, { type: 'Scope', qualifiedName: 'scope-w', attributes: { name: 'W', owner: 'olive', kind: 'report' }, writer: { kind: 'sync', source: 'scope-sources' }, actor: 'sync/rris' }));
    const d = await c.delegations.create(cat, { owner: 'olive', delegate: 'dee', covers: 'one-scope', scopeQn: 'scope-w', validTo: day(5), actor: 'olive' });
    expect(await c.tick()).toMatchObject({ remindersRaised: 1, delegationsEnded: 0 });
    const open = async () => (await admin.query("select route, message, kind from workflow.exception_view where subject_ref = $1 and status in ('open','escalated')", [`Delegation:${d.qualifiedName}`])).rows;
    expect(await open()).toEqual([{ route: 'olive', kind: 'delegation.expiring', message: expect.stringContaining('dee') }]);
    expect(await c.tick()).toMatchObject({ remindersRaised: 0 });                       // not again on the next minute
    const ex = (await c.exceptions.list(db.workflow!, { subjectRef: `Delegation:${d.qualifiedName}` }))[0]!;
    await c.exceptions.decide(db.workflow!, { id: ex.id, decision: 'dismiss', actor: 'role:olive' });
    expect(await c.tick()).toMatchObject({ remindersRaised: 0 });                       // and not after they dismissed it
    await c.store.tx(cat, () => c.store.applyNode(cat, { type: 'Scope', qualifiedName: 'scope-w', attributes: { owner: 'ozzy' }, writer: { kind: 'sync', source: 'scope-sources' }, actor: 'sync/rris' }));
    expect(await c.tick()).toMatchObject({ delegationsEnded: 1 });
    expect((await c.delegations.all(cat)).filter((x) => x.scopeQn === 'scope-w')).toEqual([]);
    expect(await c.tick()).toEqual({ resumed: 0, retried: 0, escalated: 0, delegationsEnded: 0, remindersRaised: 0, linkTasksOpened: 0 });
  });

  it('the clock: startWorker runs a sync on demand and the housekeeping tick', async () => {
    const boss = new PgBoss(`postgres://postgres:pw@localhost:${PORT}/postgres`);
    boss.on('error', () => {});
    await boss.start();
    try {
      const ticks: unknown[] = [];
      const job = resolveJob(compileJob(JOB), { connections: { snow: { secret: 'x' } }, jobs: {} }, 'local');
      await startWorker(boss, c, [job], async () => ({ db: db.connectors!, release() {} }), (r) => ticks.push(r));
      table = [rec('a9')];
      await boss.send('sync.run', { job: 'apps', environment: 'local', trigger: 'manual' });
      await boss.send(TICK_QUEUE, {});
      for (let i = 0; i < 40 && !(ticks.length && (await node('a9'))); i++) await new Promise((r) => setTimeout(r, 500));
      expect(await node('a9')).toBeTruthy();
      expect(ticks[0]).toEqual({ resumed: 0, retried: 0, escalated: 0, delegationsEnded: 0, remindersRaised: 0, linkTasksOpened: 0 });
    } finally { await boss.stop({ graceful: false }); }
  });
});

describe('E3: verifier', () => {
  const head = async () => Number((await admin.query('select max(seq) as s from evidence.ledger_entry')).rows[0].s);

  it('the relay moves events into the ledger and the verifier passes on an intact chain', async () => {
    await c.relay();
    expect(await head()).toBeGreaterThan(10);
    expect(await c.verify()).toMatchObject({ ok: true });
    expect(await c.verify({ recent: 5 })).toMatchObject({ ok: true, checked: 5 });
    expect(await c.actions.switches()).toEqual([]);
  });

  it('a divergence pauses all automatic actions, raises a critical exception and notifies', async () => {
    // inject: change a stored entry behind the writer's back (as a superuser, with the guard trigger off)
    await admin.query('alter table evidence.ledger_entry disable trigger ledger_no_row_change');
    await admin.query("update evidence.ledger_entry set actor = 'forged' where seq = 3");
    await admin.query('alter table evidence.ledger_entry enable trigger ledger_no_row_change');
    sent.length = 0;
    const r = await c.verify();
    expect(r).toMatchObject({ ok: false, firstBadSeq: 3 });
    expect(await c.actions.switches()).toMatchObject([{ scope: 'all', set_by: 'system/verifier' }]);
    expect((await admin.query("select kind, severity from workflow.exception where kind = 'ledger.divergence'")).rows).toEqual([{ kind: 'ledger.divergence', severity: 'critical' }]);
    expect(sent).toContain('platform-governance:ledger/main');
    // and an action now does not run
    const { id } = await c.actions.dispatch({ idempotencyKey: 'k-after', decisionId: 'd', policyId: 'p', subjectRef: 'Application:a2', notify: false, route: 'r', effect: { action: 'set_attribute', attribute: 'description', value: 'x' } });
    expect((await admin.query('select status from actions.action where id = $1', [id])).rows[0].status).toBe('blocked');
  });

  it('the schedule runs the verifier too', async () => {
    const boss = new PgBoss(`postgres://postgres:pw@localhost:${PORT}/postgres`);
    boss.on('error', () => {});
    await boss.start();
    try {
      const job = resolveJob(compileJob(JOB), { connections: { snow: { secret: 'x' } }, jobs: {} }, 'local');
      await startWorker(boss, c, [job], async () => ({ db: db.connectors!, release() {} }));
      const before = (await admin.query("select count(*)::int as n from workflow.exception where kind = 'ledger.divergence'")).rows[0].n;
      const stamp = async () => (await admin.query("select set_at from actions.kill_switch where scope = 'all'")).rows[0].set_at.getTime();
      const was = await stamp();
      await boss.send(VERIFY_RECENT_QUEUE, {});
      for (let i = 0; i < 40 && (await stamp()) === was; i++) await new Promise((r) => setTimeout(r, 500)); // the verifier ran: it found the forged entry and set the switch again
      expect(await stamp()).toBeGreaterThan(was);
      // the window still covers the forged entry, so it fails again: the exception is not raised twice
      expect((await admin.query("select count(*)::int as n from workflow.exception where kind = 'ledger.divergence'")).rows[0].n).toBe(before);
    } finally { await boss.stop({ graceful: false }); }
  }, 30_000);
});
