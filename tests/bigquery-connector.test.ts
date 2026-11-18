import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExceptionPort, Signal } from '../packages/contracts/src/index';
import { migrateModule, provisionModule } from '../packages/platform/src/index';
import {
  SyncService, bigQueryConnector, checkBigQueryText, compileJob, compileOverlay, fixtureBigQuery, googleBigQuery, loadBigQueryFixture, plain, resolveJob,
} from '../packages/connectors/src/index';

const root = join(import.meta.dirname, '..');
const fixture = () => loadBigQueryFixture(join(root, 'sync/fixtures/bigquery/servicenow.json'));
// S2 tests the connector's incremental read, so it uses its own incremental job text: the shipped ServiceNow job reads in full since S6 (see tests/sync-servicenow.test.ts).
const JOB = `
job: servicenow-applications-bq
connection: bq-servicenow
schedule: "30 2 * * *"
source:
  query: "SELECT sys_id, name, owned_by, criticality, install_status, country, sys_updated_on FROM \`\${project}.\${dataset}.applications\` WHERE @since IS NULL OR sys_updated_on > @since"
  mode: incremental
  cursor: sys_updated_on
  page_size: 1000
target:
  type: Application
  key: sys_id
  source: servicenow
  map: { name: name, owner: owned_by, criticality: criticality, status: install_status, hosting_country: country }
  on_missing: ignore
retries: { max: 2, backoff_seconds: 5 }
`;
const SECRET = 'S3CRET-KEY-MATERIAL';

const overlay = (project: string, dataset: string, extra = '') => compileOverlay(`
connections:
  bq-servicenow: { type: bigquery, project: ${project}, dataset: ${dataset}, secret: sm/bq ${extra} }
jobs: {}
`);
const connConfig = (project: string, dataset: string, extra: Record<string, unknown> = {}) => ({ project, dataset, secretRef: 'sm/bq', ...extra });
const secrets = { async resolveSecret(ref: string) { if (ref !== 'sm/bq') throw new Error('no such secret'); return SECRET; } };

const readAll = async (bq: ReturnType<typeof fixtureBigQuery>, config: Record<string, unknown>, text: string, pageSize = 2, since: string | null = null, cursorField = 'sys_updated_on', logs: unknown[] = []) => {
  const c = bigQueryConnector({ clientFor: bq.clientFor, log: (m, f) => logs.push([m, f]) });
  const ids: unknown[] = []; let cursor: string | null = null; let pages = 0; let high: string | null = null;
  for (;;) {
    const p = await c.read(config, { text, pageSize, cursorField }, cursor, since); pages++;
    ids.push(...p.records.map((r) => r.sys_id)); high = p.highWater && (!high || p.highWater > high) ? p.highWater : high;
    if (p.done) break;
    cursor = p.nextCursor;
  }
  return { ids, pages, high };
};

describe('S2: BigQuery connector', () => {
  const sql = (job = JOB) => resolveJob(compileJob(job), overlay('local-fixture', 'servicenow'), 'local').query;

  it('S2: reads the whole fixture table across pages, once each', async () => {
    const r = await readAll(fixtureBigQuery(fixture()), connConfig('local-fixture', 'servicenow'), sql());
    expect(r).toMatchObject({ ids: ['app-payments-hub', 'app-core-banking', 'app-risk-engine', 'app-data-lake', 'app-legacy-ledger'], pages: 3, high: '2026-03-05T08:00:00.000Z' });
  });

  it('S2: incremental reads bind @since and return only newer rows with the new watermark', async () => {
    const bq = fixtureBigQuery(fixture());
    const r = await readAll(bq, connConfig('local-fixture', 'servicenow'), sql(), 10, '2026-03-03T08:00:00.000Z');
    expect(r).toMatchObject({ ids: ['app-data-lake', 'app-legacy-ledger'], high: '2026-03-05T08:00:00.000Z' });
    expect(bq.requests[0]!.params).toEqual({ since: { type: 'TIMESTAMP', value: '2026-03-03T08:00:00.000Z' } });
    // the value is bound, never part of the query text
    expect(bq.requests[0]!.query).not.toContain('2026-03-03');
    const first = fixtureBigQuery(fixture());
    await readAll(first, connConfig('local-fixture', 'servicenow'), sql(), 10, null);
    expect(first.requests[0]!.params).toEqual({ since: { type: 'TIMESTAMP', value: null } });
  });

  it('S2: project and dataset come from the overlay of each environment', async () => {
    const bq = fixtureBigQuery(fixture());
    const envs = [
      { env: 'local', project: 'local-fixture', dataset: 'servicenow', ids: 5 },
      { env: 'uat', project: 'dmc-uat-servicenow', dataset: 'sn_uat', ids: 2 },
      { env: 'prod', project: 'dmc-prod-servicenow', dataset: 'sn_prod', ids: 1 },
    ];
    for (const e of envs) {
      const job = resolveJob(compileJob(JOB), overlay(e.project, e.dataset), e.env);
      expect(job.query).toContain(`\`${e.project}.${e.dataset}.applications\``);
      expect((await readAll(bq, connConfig(e.project, e.dataset), job.query)).ids).toHaveLength(e.ids);
    }
    // a job-level overlay parameter overrides the connection's; the connector then refuses it, because the connection only reaches its own dataset
    const moved = resolveJob(compileJob(JOB), compileOverlay('connections: { bq-servicenow: { secret: s, project: dmc-uat-servicenow, dataset: sn_uat } }\njobs: { servicenow-applications-bq: { dataset: sn_prod } }'), 'uat');
    await expect(readAll(bq, connConfig('dmc-uat-servicenow', 'sn_uat'), moved.query)).rejects.toThrow(/outside dmc-uat-servicenow\.sn_uat/);
    // a missing parameter fails when the job is resolved
    expect(() => resolveJob(compileJob(JOB), compileOverlay('connections: { bq-servicenow: { secret: s } }'), 'prod')).toThrow(/does not set it/);
  });

  it('S2: refuses anything but one read-only SELECT over the configured project.dataset', () => {
    const cfg = { project: 'local-fixture', dataset: 'servicenow' };
    const ok = (q: string) => expect(checkBigQueryText(q, cfg)).toEqual([]);
    const bad = (q: string, re: RegExp) => expect(checkBigQueryText(q, cfg).join('; ')).toMatch(re);
    ok('SELECT a FROM `local-fixture.servicenow.apps`');
    ok('select a from `local-fixture.servicenow.apps` where b > @since;');
    ok('WITH x AS (SELECT a FROM `local-fixture.servicenow.apps`) SELECT a FROM x');
    ok("SELECT 'DROP TABLE; --' AS note, updated_at, created_by FROM `local-fixture.servicenow.apps`");
    bad('SELECT a FROM `local-fixture.servicenow.apps`; DELETE FROM `local-fixture.servicenow.apps` WHERE true', /only one statement/);
    bad('SELECT 1; SELECT 2', /only one statement/);
    bad('DELETE FROM `local-fixture.servicenow.apps` WHERE true', /must be a SELECT|DELETE/);
    bad('INSERT `local-fixture.servicenow.apps` (a) VALUES (1)', /INSERT/);
    bad('MERGE `local-fixture.servicenow.apps` T USING x ON true WHEN MATCHED THEN DELETE', /MERGE/);
    bad('CREATE TABLE `local-fixture.servicenow.t` AS SELECT 1', /CREATE/);
    bad('EXPORT DATA OPTIONS(uri="gs://x/*") AS SELECT 1', /EXPORT|must be a SELECT/);
    bad('CALL `local-fixture.servicenow.p`()', /CALL|must be a SELECT/);
    bad('SELECT * FROM `other-project.servicenow.apps`', /outside local-fixture\.servicenow/);
    bad('SELECT * FROM `local-fixture.other_ds.apps`', /outside local-fixture\.servicenow/);
    bad('SELECT * FROM `local-fixture.servicenow.apps` a JOIN `local-fixture.other.t` b ON true', /outside/);
    bad('SELECT * FROM other-project.servicenow.apps', /backticks/);
    bad('SELECT * FROM apps', /backticks/);
    bad('SELECT * FROM `local-fixture.servicenow.apps` WHERE a = @other', /unknown parameter @other/);
    bad('SELECT * FROM `local-fixture.servicenow.apps` WHERE a = ?', /positional/);
    bad('SELECT @@project_id', /system variables/);
    bad('SELECT * FROM `local-fixture.servicenow.apps` -- hi', /comments/);
    bad('SELECT * FROM EXTERNAL_QUERY("c", "select 1")', /EXTERNAL_QUERY/);
    bad('', /empty/);
  });

  it('S2: read() refuses a bad query before any request is made, and says why', async () => {
    const bq = fixtureBigQuery(fixture());
    await expect(readAll(bq, connConfig('local-fixture', 'servicenow'), 'DROP TABLE `local-fixture.servicenow.applications`')).rejects.toThrow(/Job query refused/);
    await expect(readAll(bq, connConfig('local-fixture', 'servicenow'), 'SELECT 1; SELECT 2')).rejects.toThrow(/only one statement/);
    expect(bq.requests).toEqual([]);
  });

  it('S2: refuses a bad connection config', async () => {
    const bq = fixtureBigQuery(fixture());
    for (const cfg of [{ dataset: 'x' }, { project: 'p', dataset: 'x' }, { project: 'local-fixture', dataset: 'a;b' }, { project: 'local-fixture', dataset: 'x', auth: 'key' }, { project: 'local-fixture', dataset: 'x', auth: 'pw' }])
      await expect(readAll(bq, cfg, 'SELECT 1')).rejects.toThrow(/BigQuery/);
  });

  it('S2: test() dry-runs against the dataset without reading rows', async () => {
    const bq = fixtureBigQuery(fixture());
    const c = bigQueryConnector({ clientFor: bq.clientFor });
    expect(await c.test(connConfig('local-fixture', 'servicenow'))).toEqual({ ok: true });
    expect(bq.requests).toHaveLength(1);
    expect(bq.requests[0]!.query).toContain('INFORMATION_SCHEMA');
    const no = await c.test(connConfig('dmc-nowhere-123', 'nope'));
    expect(no.ok).toBe(false);
    expect(no.message).toMatch(/Not found/);
    expect((await c.test({ dataset: 'x' })).ok).toBe(false);
  });

  it('S2: no secret appears in errors or logs; a key connection resolves its secret only through the store', async () => {
    const bq = fixtureBigQuery(fixture(), secrets);
    const logs: unknown[] = [];
    const cfg = connConfig('local-fixture', 'servicenow', { auth: 'key' });
    await readAll(bq, cfg, sql(), 2, null, 'sys_updated_on', logs);
    expect(logs.length).toBeGreaterThan(0);
    const failing = bigQueryConnector({ clientFor: bq.clientFor, log: (m, f) => logs.push([m, f]) });
    const errs: string[] = [];
    for (const [c, q] of [[connConfig('local-fixture', 'servicenow', { auth: 'key', secretRef: 'sm/missing' }), sql()], [cfg, 'SELECT * FROM `local-fixture.servicenow.nope`'], [cfg, 'DROP TABLE x']] as const)
      await failing.read(c, { text: q, pageSize: 5 }, null, null).catch((e: Error) => errs.push(e.message));
    expect(errs).toHaveLength(3);
    for (const text of [JSON.stringify(logs), errs.join('\n'), JSON.stringify(bq.requests)]) expect(text).not.toContain(SECRET);
    // an error message from the library that contains the key is redacted by the real adapter
    const leaky = googleBigQuery({
      ...secrets,
      load: async () => ({ BigQuery: class { createQueryJob() { return Promise.reject(new Error(`bad credentials ${SECRET}`)); } job() { throw new Error('unused'); } } as never }),
    });
    const client = await leaky.clientFor({ project: 'local-fixture', dataset: 'servicenow', auth: 'key', secretRef: 'sm/bq' }).catch((e: Error) => e);
    expect((client as Error).message).toMatch(/not a service-account key/); // the secret above is not JSON: refused, and never echoed
    expect((client as Error).message).not.toContain(SECRET);
    const keyed = googleBigQuery({
      resolveSecret: async () => JSON.stringify({ private_key: SECRET }),
      load: async () => ({ BigQuery: class { createQueryJob() { return Promise.reject(new Error(`bad credentials ${JSON.stringify({ private_key: SECRET })}`)); } job() { throw new Error('unused'); } } as never }),
    });
    const k = await keyed.clientFor({ project: 'local-fixture', dataset: 'servicenow', auth: 'key', secretRef: 'sm/bq' });
    const e = await k.runQuery({ query: 'SELECT 1', params: {}, pageSize: 1, pageToken: null }).catch((x: Error) => x);
    expect((e as Error).message).toContain('[redacted]');
    expect((e as Error).message).not.toContain(SECRET);
  });

  it('S2: the real adapter loads the installed library lazily and builds a client without calling Google', async () => {
    const real = googleBigQuery({ resolveSecret: secrets.resolveSecret });
    const client = await real.clientFor({ project: 'local-fixture', dataset: 'servicenow', auth: 'adc' });
    expect(typeof client.runQuery).toBe('function');
    expect(typeof client.dryRun).toBe('function');
  });

  it('S2: the real adapter turns library values into plain rows', () => {
    expect(plain({ at: { value: '2026-03-01T08:00:00.000Z' }, n: { toFixed: () => '1', toString: () => '12.50' }, d: new Date('2026-03-01T00:00:00Z'), l: [{ value: 'x' }], z: null, big: 5n }))
      .toEqual({ at: '2026-03-01T08:00:00.000Z', n: '12.50', d: '2026-03-01T00:00:00.000Z', l: ['x'], z: null, big: '5' });
  });

  it('S2: the real adapter pages through a job and passes bound, typed parameters (library stubbed)', async () => {
    const calls: { create?: Record<string, unknown>; pages: unknown[] } = { pages: [] };
    const job = { id: 'job_1', location: 'EU', async getQueryResults(o: { pageToken?: string }) { calls.pages.push(o); return o.pageToken ? [[{ sys_id: 'b' }], null, {}] : [[{ sys_id: 'a' }], { pageToken: 'T2' }, {}]; } };
    const lib = { BigQuery: class { createQueryJob(o: Record<string, unknown>) { calls.create = o; return Promise.resolve([job, {}]); } job(id: string, o: unknown) { calls.pages.push({ id, o }); return job; } } as never };
    const client = await googleBigQuery({ ...secrets, load: async () => lib }).clientFor({ project: 'local-fixture', dataset: 'servicenow', auth: 'adc', location: 'EU', maxBytesBilled: 1000 });
    const p1 = await client.runQuery({ query: 'SELECT 1 WHERE @since IS NULL', params: { since: { type: 'TIMESTAMP', value: null } }, pageSize: 1, pageToken: null, location: 'EU', maxBytesBilled: 1000 });
    expect(calls.create).toMatchObject({ useLegacySql: false, params: { since: null }, types: { since: 'TIMESTAMP' }, location: 'EU', maximumBytesBilled: '1000' });
    expect(p1.nextPageToken).toBe('job_1|EU|T2');
    const p2 = await client.runQuery({ query: 'x', params: {}, pageSize: 1, pageToken: p1.nextPageToken });
    expect(p2).toEqual({ rows: [{ sys_id: 'b' }], nextPageToken: null });
    expect(calls.pages).toContainEqual({ id: 'job_1', o: { location: 'EU' } });
  });
});

describe('S2: a job over the BigQuery connector', () => {
  it('S2: syncs the fixture dataset into signals, then only what changed since the watermark', async () => {
    const pgServer = new EmbeddedPostgres({ databaseDir: mkdtempSync(join(tmpdir(), 'dmc-bq-')), user: 'postgres', password: 'pw', port: 54500, persistent: false });
    await pgServer.initialise(); await pgServer.start();
    const admin = new pg.Client({ host: 'localhost', port: 54500, user: 'postgres', password: 'pw', database: 'postgres' });
    let db: pg.Client | undefined;
    try {
      await admin.connect();
      await provisionModule(admin, 'connectors', { password: 'con' });
      await migrateModule(admin, 'connectors', join(root, 'packages/connectors/migrations'));
      await admin.query('grant all on all tables in schema connectors to dmc_connectors');
      await admin.query('grant all on all sequences in schema connectors to dmc_connectors');
      db = new pg.Client({ host: 'localhost', port: 54500, user: 'dmc_connectors', password: 'con', database: 'postgres' }); await db.connect();
      const data = fixture();
      const bq = fixtureBigQuery(data, secrets);
      const signals: Signal[] = []; const logs: unknown[] = [];
      const exceptions: ExceptionPort = { async raise() { return { id: 'x', created: true }; }, async withdraw() { return true; } };
      const svc = new SyncService({ connectors: { bigquery: bigQueryConnector({ clientFor: bq.clientFor, log: (m, f) => logs.push([m, f]) }) }, signals: { async submit(x) { signals.push(...x); } }, exceptions, sleep: async () => {} });
      const job = resolveJob(compileJob(JOB), overlay('local-fixture', 'servicenow', ', auth: key'), 'local');
      // as the worker does: the connection's type is split off, the rest is its config
      await svc.upsertConnection(db, { name: 'bq-servicenow', environment: 'local', type: 'bigquery', secretRef: 'sm/bq', config: { project: 'local-fixture', dataset: 'servicenow', auth: 'key' } });
      await svc.installJob(db, job);

      const r1 = await svc.run(db, 'servicenow-applications-bq', 'local');
      expect(r1).toMatchObject({ status: 'succeeded' });
      expect(signals.map((s) => s.subjectRef).sort()).toEqual(['Application:app-core-banking', 'Application:app-data-lake', 'Application:app-legacy-ledger', 'Application:app-payments-hub', 'Application:app-risk-engine']);
      expect(signals.find((s) => s.subjectRef === 'Application:app-payments-hub')!.asset).toMatchObject({ name: 'Payments Hub', hosting_country: 'GB', criticality: 'critical' });

      // a later run sends the stored watermark as @since and sees only the new row
      data['local-fixture.servicenow']!.applications!.push({ sys_id: 'app-new', name: 'New App', owned_by: '43000001', criticality: 'low', install_status: 'planned', country: 'GB', sys_updated_on: '2026-03-09T08:00:00.000Z' });
      const before = signals.length;
      const r2 = await svc.run(db, 'servicenow-applications-bq', 'local');
      expect(r2).toMatchObject({ status: 'succeeded' });
      expect(signals.slice(before).map((s) => s.subjectRef)).toEqual(['Application:app-new']);
      expect(bq.requests.at(-1)!.params.since!.value).toBe('2026-03-05T08:00:00.000Z');

      for (const text of [JSON.stringify(signals), JSON.stringify(logs), JSON.stringify(bq.requests)]) expect(text).not.toContain(SECRET);
    } finally { try { await db?.end(); await admin.end(); } finally { await pgServer.stop(); } }
  }, 120_000);
});

describe('S2: the shipped job and local overlay', () => {
  it('S2: the example job resolves against sync/overlays/local.yaml and is disabled there', () => {
    const local = compileOverlay(readFileSync(join(root, 'sync/overlays/local.yaml'), 'utf8'));
    const job = resolveJob(compileJob(JOB), local, 'local');
    expect(job.enabled).toBe(false);
    expect(job.query).toContain('`local-fixture.servicenow.applications`');
    expect(local.connections!['bq-servicenow']).toMatchObject({ type: 'bigquery', secret: 'local/none' });
  });
});
