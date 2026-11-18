import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigError, loadConfig, secretFromEnv } from '../packages/platform/src/index';
import { migrateAll, startWorkerProcess, type StartedWorker } from '../apps/worker/src/index';
import { startApi, type StartedApi } from '../apps/api/src/index';

const root = join(import.meta.dirname, '..');
const PORT = 54348; const HTTP = 18480;
const env = { DMC_ENVIRONMENT: 'local', DMC_DB_HOST: 'localhost', DMC_DB_PORT: String(PORT), DMC_DB_NAME: 'postgres', DMC_DB_ADMIN_USER: 'postgres', DMC_DB_ADMIN_PASSWORD: 'pw', DMC_ROOT: root, DMC_HTTP_HOST: '127.0.0.1', DMC_HTTP_PORT: String(HTTP) };
let server: EmbeddedPostgres; let admin: pg.Client; let worker: StartedWorker; let api: StartedApi;
const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const as = (user: string, groups = '') => ({ 'x-dmc-user': user, 'x-dmc-groups': groups });
const call = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) => fetch(`${api.url}${path}`, init);

describe('configuration', () => {
  it('local needs nothing but the host defaults; anywhere else names what is missing', () => {
    expect(loadConfig({}).environment).toBe('local');
    expect(() => loadConfig({ DMC_ENVIRONMENT: 'prod' })).toThrow(/DMC_DB_HOST is required/);
    expect(() => loadConfig({ DMC_ENVIRONMENT: 'staging' })).toThrow(ConfigError);
    expect(() => loadConfig({ DMC_HTTP_PORT: 'abc' })).toThrow(/must be a port number/);
    const prod = loadConfig({ DMC_ENVIRONMENT: 'prod', DMC_DB_HOST: 'db' });
    expect(prod.db.passwords.catalog).toBeUndefined(); // no guessed passwords outside local
  });
  it('connector secrets come from DMC_SECRET_<REF> and a missing one is named', async () => {
    const s = secretFromEnv({ DMC_SECRET_SNOW_TOKEN: 't0k' });
    expect(await s('snow-token')).toBe('t0k');
    await expect(s('other')).rejects.toThrow(/DMC_SECRET_OTHER is not set/);
  });
  it('the API will not start outside local without a sign-in implementation', async () => {
    await expect(startApi(loadConfig({ ...env, DMC_ENVIRONMENT: 'uat', DMC_DB_PASSWORD_CATALOG: 'x' }))).rejects.toThrow(/DMC_SECRET_SESSION/);
  });
});

describe('bootstrap: migrate, worker and API from configuration', () => {
  beforeAll(async () => {
    server = new EmbeddedPostgres({ databaseDir: mkdtempSync(join(tmpdir(), 'dmc-boot-')), user: 'postgres', password: 'pw', port: PORT, persistent: false });
    await server.initialise(); await server.start();
    admin = new pg.Client({ host: 'localhost', port: PORT, user: 'postgres', password: 'pw', database: 'postgres' });
    await admin.connect();
  }, 120_000);
  afterAll(async () => { try { await api?.close(); await worker?.close(); await admin?.end(); } finally { await server?.stop(); } });

  it('migrates every module, and a second run changes nothing', async () => {
    const cfg = loadConfig(env);
    const first = await migrateAll(cfg);
    expect(first.map((r) => r.module)).toEqual(['catalog', 'decision', 'workflow', 'policy', 'actions', 'connectors', 'evidence', 'trust']);
    expect(first.every((r) => r.applied.length > 0)).toBe(true);
    expect((await migrateAll(cfg)).every((r) => r.applied.length === 0)).toBe(true);
  }, 60_000);

  it('starts the worker and the API', async () => {
    const cfg = loadConfig(env);
    worker = await startWorkerProcess(cfg, { log: quiet });
    api = await startApi(cfg, { log: quiet });
    const r = await call('/v1/health');
    expect(r.status).toBe(200);
    expect((await call('/v1/inbox')).status).toBe(401);
  }, 60_000);

  it('an edit through the API is stored, recorded as a signal, and idempotent on retry', async () => {
    const c = worker.composition;
    const db = (await import('pg')).default;
    const conn = new db.Client({ host: 'localhost', port: PORT, user: 'dmc_catalog', password: 'catalog', database: 'postgres' });
    await conn.connect();
    try {
      await c.store.tx(conn, () => c.store.applyNode(conn, { type: 'Application', qualifiedName: 'boot-app', attributes: { name: 'Boot app', owner: 'alice', hosting_country: 'GB', criticality: 'low' }, writer: { kind: 'sync', source: 'servicenow' }, actor: 'sync/sn' }));
    } finally { await conn.end(); }
    const g = await call('/v1/nodes/boot-app', { headers: as('alice', 'dmc-app-owner') });
    expect(g.status).toBe(200);
    const send = () => call('/v1/nodes/boot-app', { method: 'PATCH', headers: { ...as('alice', 'dmc-app-owner'), 'content-type': 'application/json', 'if-match': g.headers.get('etag')!, 'idempotency-key': 'boot-key-1' }, body: JSON.stringify({ attributes: { description: 'Booted' } }) });
    const first = await send();
    expect(first.status).toBe(200);
    expect((await first.json()).attributes.description).toBe('Booted');
    const again = await send();          // the stored answer, even though the version has moved on
    expect(again.status).toBe(200);
    expect((await admin.query("select count(*)::int as n from decision.signal where source = 'api'")).rows[0].n).toBe(1);
    expect((await admin.query("select actor from decision.signal where source = 'api'")).rows[0].actor).toBe('alice');
  });

  it('an exception raised by a policy in the worker appears in the right person’s inbox, and they can decide it', async () => {
    await worker.composition.decide.submit([{ source: 'test', key: 'k-noowner', kind: 'write.applied', subjectRef: 'Application:no-owner', subjectType: 'Application', asset: { name: 'No owner', owner: '' }, actor: 'sync/sn' }]);
    const mine = await (await call('/v1/inbox', { headers: as('gina', 'platform-governance') })).json();
    expect(mine.count).toBe(1);
    expect(mine.items[0]).toMatchObject({ message: 'Every application needs an owner', subject_ref: 'Application:no-owner' });
    expect((await (await call('/v1/inbox', { headers: as('hank') })).json()).count).toBe(0);
    const d = await call(`/v1/inbox/${mine.items[0].id}/decision`, { method: 'POST', headers: { ...as('gina', 'dmc-platform-admin,platform-governance'), 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'resolve' }) });
    expect(d.status).toBe(200);
    expect((await (await call('/v1/inbox', { headers: as('gina', 'platform-governance') })).json()).count).toBe(0);
  });

  it('housekeeping runs and the ledger verifies', async () => {
    await worker.composition.tick();
    expect((await worker.composition.verify()).ok).toBe(true);
    expect((await admin.query('select count(*)::int as n from evidence.ledger_entry')).rows[0].n).toBeGreaterThan(0);
  });
});
