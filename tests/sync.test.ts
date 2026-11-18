import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { PgBoss } from 'pg-boss';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Connector, ExceptionPort, RaiseExceptionRequest, ReadPage, Signal, SignalSink, SourceRecord } from '../packages/contracts/src/index';
import { provisionModule, migrateModule } from '../packages/platform/src/index';
import { SyncDefError, SyncService, compileJob, compileOverlay, mapRecord, registerSchedules, resolveJob, runNow, startSyncWorker, SYNC_QUEUE } from '../packages/connectors/src/index';

const JOB = `
job: apps
connection: snow
schedule: "0 3 * * *"
source: { query: "SELECT * FROM \${project}.\${dataset}.apps", mode: full, page_size: 2 }
target:
  type: Application
  key: sys_id
  map: { name: name, owner: owned_by.email, status: install_status }
  on_missing: deprecate
limits: { max_changes_pct: 30 }
retries: { max: 2, backoff_seconds: 1 }
`;
const INCR = JOB.replace('mode: full', 'mode: incremental, cursor: updated').replace('job: apps', 'job: apps-inc').replace(/limits:.*\n/, '');
const OVERLAY = `
connections:
  snow: { project: p-uat, secret: sm/uat }
jobs:
  apps: { dataset: cmdb }
  apps-inc: { dataset: cmdb }
`;

let server: EmbeddedPostgres; let admin: pg.Client; let db: pg.Client;
let table: SourceRecord[] = [];
let failReads = 0;
let readCalls = 0;
const signals: Signal[] = [];
const raised: RaiseExceptionRequest[] = [];
const sink: SignalSink = { async submit(s) { signals.push(...s); } };
const exceptions: ExceptionPort = { async raise(r) { raised.push(r); return { id: 'x', created: true }; }, async withdraw() { return true; } };

/** pages the in-memory table; the cursor is an offset; `since` filters by the `updated` field */
const connector: Connector = {
  async test() { return { ok: true }; },
  async read(_cfg, q, pageCursor, since): Promise<ReadPage> {
    readCalls++;
    if (failReads > 0) { failReads--; throw new Error('503 from source'); }
    const rows = since ? table.filter((r) => String(r.updated) > since) : table;
    const off = Number(pageCursor ?? 0);
    const records = rows.slice(off, off + q.pageSize);
    const done = off + q.pageSize >= rows.length;
    return { records, nextCursor: String(off + q.pageSize), done, highWater: records.reduce<string | null>((m, r) => (m === null || String(r.updated) > m ? String(r.updated) : m), null) };
  },
};
const svc = new SyncService({ connectors: { fake: connector }, signals: sink, exceptions, sleep: async () => {} });

const app = (id: string, over: Record<string, unknown> = {}): SourceRecord => ({ sys_id: id, name: `App ${id}`, owned_by: { email: `${id}@x.com` }, install_status: 'live', updated: '2026-01-01', ...over });
const seed = (n: number) => { table = Array.from({ length: n }, (_, i) => app(`a${i}`)); };
const state = async (job = 'apps') => (await admin.query('select key, state from connectors.record_state where job=$1 order by key', [job])).rows as { key: string; state: string }[];

beforeAll(async () => {
  server = new EmbeddedPostgres({ databaseDir: mkdtempSync(join(tmpdir(), 'dmc-sync-')), user: 'postgres', password: 'pw', port: 54340, persistent: false });
  await server.initialise(); await server.start();
  admin = new pg.Client({ host: 'localhost', port: 54340, user: 'postgres', password: 'pw', database: 'postgres' });
  await admin.connect();
  await provisionModule(admin, 'connectors', { password: 'cn' });
  await migrateModule(admin, 'connectors', join(import.meta.dirname, '../packages/connectors/migrations'));
  await admin.query('grant all on all tables in schema connectors to dmc_connectors');
  db = new pg.Client({ host: 'localhost', port: 54340, user: 'dmc_connectors', password: 'cn', database: 'postgres' });
  await db.connect();
  await svc.upsertConnection(db, { name: 'snow', environment: 'uat', type: 'fake', config: {}, secretRef: 'sm/uat' });
  const overlay = compileOverlay(OVERLAY);
  await svc.installJob(db, resolveJob(compileJob(JOB), overlay, 'uat'));
  await svc.installJob(db, resolveJob(compileJob(INCR), overlay, 'uat'));
}, 120_000);
afterAll(async () => { try { await db?.end(); await admin?.end(); } finally { await server?.stop(); } });

beforeEach(async () => {
  signals.length = 0; raised.length = 0; failReads = 0; readCalls = 0;
  await admin.query('truncate connectors.run, connectors.record_state, connectors.cursor cascade');
  await admin.query('update connectors.job set paused = false, enabled = true');
});

describe('definitions and overlays', () => {
  it('fills query parameters from the environment overlay', () => {
    const r = resolveJob(compileJob(JOB), compileOverlay(OVERLAY), 'uat');
    expect(r.query).toBe('SELECT * FROM p-uat.cmdb.apps');
  });
  it('lets an overlay change schedule and switch a job off', () => {
    const o = compileOverlay(`${OVERLAY.replace('apps: { dataset: cmdb }', 'apps: { dataset: cmdb, schedule: "0 5 * * 1", enabled: false }')}`);
    const r = resolveJob(compileJob(JOB), o, 'uat');
    expect(r).toMatchObject({ schedule: '0 5 * * 1', enabled: false });
  });
  it('rejects a query parameter the environment does not set, and unknown connections', () => {
    expect(() => resolveJob(compileJob(JOB), compileOverlay('connections: { snow: { project: p, secret: s } }'), 'uat')).toThrow(/dataset/);
    expect(() => resolveJob(compileJob(JOB), compileOverlay('connections: {}'), 'uat')).toThrow(SyncDefError);
  });
  it('rejects incremental jobs without a cursor and bad cron', () => {
    expect(() => compileJob(JOB.replace('mode: full', 'mode: incremental'))).toThrow(/cursor/);
    expect(() => compileJob(JOB.replace('"0 3 * * *"', '"daily"'))).toThrow(SyncDefError);
  });
  it('maps nested fields and hashes stably', () => {
    const a = mapRecord(app('1'), compileJob(JOB).target);
    const b = mapRecord({ ...app('1') }, compileJob(JOB).target);
    expect(a).toMatchObject({ key: '1', attrs: { name: 'App 1', owner: '1@x.com', status: 'live' } });
    expect('hash' in a && 'hash' in b && a.hash === b.hash).toBe(true);
    expect(mapRecord({ name: 'no key' }, compileJob(JOB).target)).toHaveProperty('error');
  });
});

describe('S1: change detection', () => {
  it('first run creates everything, a rerun sends nothing, a change sends one signal', async () => {
    seed(5);
    const r1 = await svc.run(db, 'apps', 'uat');
    expect(r1).toMatchObject({ status: 'succeeded', created: 5, complete: true });
    expect(signals).toHaveLength(5);
    expect(signals[0]).toMatchObject({ source: 'apps', kind: 'sync.upsert', subjectType: 'Application', subjectRef: 'Application:a0', asset: { name: 'App a0', owner: 'a0@x.com' } });

    signals.length = 0;
    expect(await svc.run(db, 'apps', 'uat')).toMatchObject({ status: 'succeeded', unchanged: 5, created: 0, updated: 0 });
    expect(signals).toHaveLength(0);

    table[2] = app('a2', { owned_by: { email: 'new@x.com' } });
    expect(await svc.run(db, 'apps', 'uat')).toMatchObject({ updated: 1, unchanged: 4 });
    expect(signals).toHaveLength(1);
    expect(signals[0]!.asset).toMatchObject({ owner: 'new@x.com' });
  });

  it('delivering the same change twice yields the same signal key', async () => {
    seed(1); await svc.run(db, 'apps', 'uat');
    const k1 = signals[0]!.key;
    await admin.query('truncate connectors.record_state'); signals.length = 0;
    await svc.run(db, 'apps', 'uat');
    expect(signals[0]!.key).toBe(k1);
  });
});

describe('S1: deprecation only on complete full runs', () => {
  it('a complete full run deprecates records that went missing', async () => {
    seed(10); await svc.run(db, 'apps', 'uat'); signals.length = 0;
    table = table.slice(0, 9); // 10% of records disappear, under the 30% limit
    const r = await svc.run(db, 'apps', 'uat');
    expect(r).toMatchObject({ status: 'succeeded', deprecated: 1, complete: true });
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({ kind: 'sync.missing', subjectRef: 'Application:a9', asset: { lifecycle: 'deprecated' } });
    expect((await state()).find((s) => s.key === 'a9')!.state).toBe('deprecated');
  });

  it('a run that fails part way deprecates nothing and changes nothing', async () => {
    seed(10); await svc.run(db, 'apps', 'uat'); signals.length = 0;
    table = table.slice(0, 5);
    failReads = 99; readCalls = 0; // every read fails, including retries
    const r = await svc.run(db, 'apps', 'uat');
    expect(r).toMatchObject({ status: 'failed', complete: false, deprecated: 0 });
    expect(readCalls).toBe(3); // first try plus two retries
    expect(signals).toHaveLength(0);
    expect((await state()).every((s) => s.state === 'active')).toBe(true);
  });

  it('a run with unreadable records is partial: it deprecates nothing', async () => {
    seed(10); await svc.run(db, 'apps', 'uat'); signals.length = 0;
    table = [...table.slice(0, 9), { name: 'broken, no key' }];
    const r = await svc.run(db, 'apps', 'uat');
    expect(r).toMatchObject({ status: 'succeeded', complete: false, errors: 1, deprecated: 0 });
    expect((await state()).every((s) => s.state === 'active')).toBe(true);
  });

  it('on_missing: ignore never deprecates', async () => {
    const ignore = compileJob(JOB.replace('job: apps', 'job: apps-ign').replace('on_missing: deprecate', 'on_missing: ignore'));
    await svc.installJob(db, resolveJob(ignore, compileOverlay(OVERLAY.replace('apps:', 'apps-ign:')), 'uat'));
    seed(4); await svc.run(db, 'apps-ign', 'uat');
    table = table.slice(0, 3);
    expect(await svc.run(db, 'apps-ign', 'uat')).toMatchObject({ deprecated: 0 });
  });

  it('a record that comes back after deprecation is updated to active', async () => {
    seed(10); await svc.run(db, 'apps', 'uat');
    const gone = table.pop()!; await svc.run(db, 'apps', 'uat');
    table.push(gone); signals.length = 0;
    expect(await svc.run(db, 'apps', 'uat')).toMatchObject({ updated: 1 });
    expect(signals[0]).toMatchObject({ kind: 'sync.upsert' });
    expect((await state()).find((s) => s.key === 'a9')!.state).toBe('active');
  });
});

describe('S1: change-limit pause', () => {
  it('pauses a run that would change too much, raises an exception and sends nothing', async () => {
    seed(10); await svc.run(db, 'apps', 'uat'); signals.length = 0;
    table = table.slice(0, 5); // half the records vanish; the limit is 30%
    const r = await svc.run(db, 'apps', 'uat');
    expect(r).toMatchObject({ status: 'paused_limit', deprecated: 5 });
    expect(r.note).toMatch(/5 of 10/);
    expect(signals).toHaveLength(0);
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({ kind: 'sync.change_limit', route: 'platform-admin', subjectRef: 'sync/uat/apps' });
    expect((await state()).every((s) => s.state === 'active')).toBe(true);
    expect((await admin.query('select count(*)::int n from connectors.staging')).rows[0].n).toBe(5);
  });

  it('the first load is not limited, and a paused job skips later runs until reviewed', async () => {
    seed(10); expect((await svc.run(db, 'apps', 'uat')).status).toBe('succeeded');
    table = table.slice(0, 5);
    const paused = await svc.run(db, 'apps', 'uat');
    const again = await svc.run(db, 'apps', 'uat');
    expect(again).toMatchObject({ status: 'skipped', note: 'a run is waiting for review' });
    await svc.discard(db, paused.runId, 'admin');
    expect((await state()).every((s) => s.state === 'active')).toBe(true);
    expect((await svc.run(db, 'apps', 'uat')).status).toBe('paused_limit'); // still over the limit, so it pauses again
  });

  it('approving a paused run sends its held signals', async () => {
    seed(10); await svc.run(db, 'apps', 'uat'); signals.length = 0;
    table = table.slice(0, 5);
    const paused = await svc.run(db, 'apps', 'uat');
    const done = await svc.approve(db, paused.runId, 'admin');
    expect(done.status).toBe('succeeded');
    expect(signals.filter((s) => s.kind === 'sync.missing')).toHaveLength(5);
    expect((await state()).filter((s) => s.state === 'deprecated')).toHaveLength(5);
    await expect(svc.approve(db, paused.runId, 'admin')).rejects.toThrow(/not waiting/);
  });
});

describe('S1: cursors, retries, pause, evidence', () => {
  it('incremental runs read only what changed since the cursor and never deprecate', async () => {
    seed(3); await svc.run(db, 'apps-inc', 'uat');
    expect((await admin.query("select value from connectors.cursor where job='apps-inc'")).rows[0].value).toBe('2026-01-01');
    signals.length = 0;
    table = [app('a0', { updated: '2026-02-01', name: 'Renamed' }), app('a1'), app('a2')];
    const r = await svc.run(db, 'apps-inc', 'uat');
    expect(r).toMatchObject({ read: 1, updated: 1, deprecated: 0 });
    expect(signals).toHaveLength(1);
    expect((await admin.query("select value from connectors.cursor where job='apps-inc'")).rows[0].value).toBe('2026-02-01');
  });

  it('a failed incremental run leaves the cursor where it was', async () => {
    seed(3); await svc.run(db, 'apps-inc', 'uat');
    table = [app('a0', { updated: '2026-03-01', name: 'X' })]; failReads = 99;
    expect((await svc.run(db, 'apps-inc', 'uat')).status).toBe('failed');
    expect((await admin.query("select value from connectors.cursor where job='apps-inc'")).rows[0].value).toBe('2026-01-01');
  });

  it('retries a flaky read and still succeeds', async () => {
    seed(3); failReads = 2;
    expect(await svc.run(db, 'apps', 'uat')).toMatchObject({ status: 'succeeded', created: 3 });
  });

  it('pages through large sources', async () => {
    seed(7); const r = await svc.run(db, 'apps', 'uat');
    expect(r.created).toBe(7); expect(readCalls).toBe(4); // page size 2
  });

  it('a paused or disabled job does not run; every state change is evidenced', async () => {
    seed(2);
    await svc.setPaused(db, 'apps', 'uat', true, 'admin');
    expect(await svc.run(db, 'apps', 'uat')).toMatchObject({ status: 'skipped', note: 'job is paused' });
    await svc.setPaused(db, 'apps', 'uat', false, 'admin');
    await admin.query("update connectors.job set enabled=false where name='apps'");
    expect(await svc.run(db, 'apps', 'uat')).toMatchObject({ status: 'skipped', note: 'job is disabled' });
    const types = (await admin.query('select event_type from connectors.outbox order by id')).rows.map((r) => r.event_type);
    expect(types).toEqual(expect.arrayContaining(['sync.job.paused', 'sync.job.resumed']));
  });

  it('runs write outbox events with counts', async () => {
    seed(2); await svc.run(db, 'apps', 'uat');
    const e = (await admin.query("select payload from connectors.outbox where event_type='sync.run.succeeded' order by id desc limit 1")).rows[0].payload;
    expect(e).toMatchObject({ created: 2, complete: true });
  });

  it('lists jobs with no successful run in 24 hours', async () => {
    seed(2); await svc.run(db, 'apps', 'uat');
    const stale = await svc.stale(db);
    expect(stale.find((s) => s.job === 'apps')).toBeUndefined();
    const later = new SyncService({ connectors: {}, signals: sink, exceptions, now: () => new Date(Date.now() + 25 * 3_600_000) });
    expect((await later.stale(db)).map((s) => s.job)).toContain('apps');
  });
});

describe('S1: schedules and run now (pg-boss)', () => {
  it('registers one schedule per enabled job and runs a queued job', async () => {
    const boss = new PgBoss('postgres://postgres:pw@localhost:54340/postgres');
    boss.on('error', () => {});
    await boss.start();
    try {
      const overlay = compileOverlay(OVERLAY.replace('apps-inc: { dataset: cmdb }', 'apps-inc: { dataset: cmdb, enabled: false }'));
      await registerSchedules(boss, [resolveJob(compileJob(JOB), overlay, 'uat'), resolveJob(compileJob(INCR), overlay, 'uat')]);
      const sch = await boss.getSchedules(SYNC_QUEUE);
      expect(sch.map((s) => s.key).sort()).toEqual(['uat/apps']);
      expect(sch[0]).toMatchObject({ cron: '0 3 * * *' });

      seed(3);
      const pool = new pg.Pool({ host: 'localhost', port: 54340, user: 'dmc_connectors', password: 'cn', database: 'postgres', max: 2 });
      await startSyncWorker(boss, svc, async () => { const c = await pool.connect(); return { db: c, release: () => c.release() }; });
      await runNow(boss, 'apps', 'uat', 'admin');
      await expect.poll(async () => (await admin.query("select status from connectors.run where job='apps' and trigger='manual'")).rows[0]?.status, { timeout: 30_000, interval: 500 }).toBe('succeeded');
      await pool.end();
    } finally { await boss.stop({ graceful: false }); }
  }, 60_000);
});
