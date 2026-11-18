import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExceptionPort, Signal } from '../packages/contracts/src/index';
import { loadRegistry, migrateModule, provisionModule } from '../packages/platform/src/index';
import { CatalogStore } from '../packages/catalog/src/index';
import {
  SyncService, bigQueryConnector, checkJobAgainstMetamodel, compileJob, compileOverlay, fixtureBigQuery, loadBigQueryFixture, resolveJob, singleWriterProblems,
} from '../packages/connectors/src/index';
import { CatalogIngest, PersonRefResolver } from '../apps/worker/src/index';

/**
 * S6: ServiceNow applications and integrations over the BigQuery connector (CAT-1, CAT-2, CAT-9 owners). The recorded tables are INVENTED (sync/fixtures/bigquery/servicenow.json):
 * the real project, dataset, table and column names come from the data platform team. Never a real project.
 */
const root = join(import.meta.dirname, '..');
const PORT = 54550;
const registry = loadRegistry(join(root, 'metamodel/types'));
const store = new CatalogStore(registry);
const local = compileOverlay(readFileSync(join(root, 'sync/overlays/local.yaml'), 'utf8'));
const read = (f: string) => readFileSync(join(root, 'sync/jobs', f), 'utf8');
const BQ_JOBS = ['servicenow-applications-bq', 'servicenow-application-owners-bq', 'servicenow-integrations-bq', 'servicenow-integration-source-bq', 'servicenow-integration-target-bq'];
const data = loadBigQueryFixture(join(root, 'sync/fixtures/bigquery/servicenow.json'));
const T = data['local-fixture.servicenow']!;
const bq = fixtureBigQuery(data);
const person = { kind: 'sync', source: 'idp' } as const;

let server: EmbeddedPostgres; let admin: pg.Client; let cdb: pg.Client; let sdb: pg.Client; let svc: SyncService;
const rejected: { key: string; reason: string }[] = []; const signals: Signal[] = [];
const run = (j: string) => svc.run(sdb, j, 'local');
const out = async (qn: string, name: string) => (await store.namedEdgesOf(cdb, qn, { name, direction: 'out' })).map((e) => e.toQn).sort();
const attrs = async (qn: string) => (await store.getNode(cdb, qn))?.attributes;

beforeAll(async () => {
  server = new EmbeddedPostgres({ databaseDir: mkdtempSync(join(tmpdir(), 'dmc-s6-')), user: 'postgres', password: 'pw', port: PORT, persistent: false });
  await server.initialise(); await server.start();
  admin = new pg.Client({ host: 'localhost', port: PORT, user: 'postgres', password: 'pw', database: 'postgres' }); await admin.connect();
  for (const [m, pw] of [['catalog', 'cat'], ['connectors', 'con']] as const) {
    await provisionModule(admin, m, { password: pw });
    await migrateModule(admin, m, join(root, `packages/${m}/migrations`));
    await admin.query(`grant all on all tables in schema ${m} to dmc_${m}`);
    await admin.query(`grant all on all sequences in schema ${m} to dmc_${m}`);
  }
  cdb = new pg.Client({ host: 'localhost', port: PORT, user: 'dmc_catalog', password: 'cat', database: 'postgres' }); await cdb.connect();
  sdb = new pg.Client({ host: 'localhost', port: PORT, user: 'dmc_connectors', password: 'con', database: 'postgres' }); await sdb.connect();
  const connect = async () => ({ query: (q: string, p?: unknown[]) => cdb.query(q, p) as never, release() {} });
  const onReject = (s: Signal, reason: string) => { rejected.push({ key: s.subjectRef, reason }); };
  const ingest = new CatalogIngest({ store, connect, sourceOf: (job) => svc.writerSource(sdb, job), onReject });
  // as the worker composes it: owners given by email are resolved to the staff ID in front of the ingest (ADR 0026)
  const resolver = new PersonRefResolver({ store, registry, connect, next: ingest, onReject });
  svc = new SyncService({
    connectors: { bigquery: bigQueryConnector({ clientFor: bq.clientFor }) },
    signals: { async submit(s) { signals.push(...s); return resolver.submit(s); } },
    exceptions: { async raise() { return { id: 'x', created: true }; }, async withdraw() { return true; } } as ExceptionPort, sleep: async () => {},
  });
  await svc.upsertConnection(sdb, { name: 'bq-servicenow', environment: 'local', type: 'bigquery', config: { project: 'local-fixture', dataset: 'servicenow' }, secretRef: 'local/none' });
  const on = { ...local, jobs: { ...local.jobs, ...Object.fromEntries(BQ_JOBS.map((j) => [j, { enabled: true }])) } };
  // the shipped change limit (30%) suits thousands of rows, not five fixture rows; the limit itself is covered by the sync tests
  for (const j of BQ_JOBS) { const def = compileJob(read(`${j}.yaml`)); delete def.limits; await svc.installJob(sdb, resolveJob(def, on, 'local')); }
  // the Person nodes the IdP job creates (ADR 0026: staff ID keys, text, leading zeros kept)
  for (const id of ['43000001', '43000002', '43000003', '43000004', '04300004']) await store.tx(cdb, () => store.applyNode(cdb, { type: 'Person', qualifiedName: id, attributes: { email: `${id}@example.test`, staff_id: id, name: `P ${id}` }, writer: person, actor: 't' }));
}, 150_000);
afterAll(async () => {
  try { await sdb?.end(); await cdb?.end(); await admin?.end(); } finally { try { await server?.stop(); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EBUSY') throw e; } }
});

describe('S6: the jobs and the one-writer rule', () => {
  it('S6: every ServiceNow BigQuery job loads, follows the metamodel, resolves locally, and is off there', () => {
    for (const j of BQ_JOBS) {
      const r = resolveJob(compileJob(read(`${j}.yaml`)), local, 'local');
      expect(r.enabled).toBe(false);
      expect(checkJobAgainstMetamodel(r.def, registry)).toEqual([]);
      expect(r.query).toContain('`local-fixture.servicenow.');
      expect(r.def.source.mode).toBe('full');            // only a full run can see that a row is gone
      expect(r.def.target.on_missing).toBe('deprecate');
    }
    // the edges are the ones the metamodel defines: source_of / target_of run Application -> Integration; delegates are a list on the node, never an edge
    expect(registry.canLink('Application', 'source_of', 'Integration')).toBe(true);
    expect(registry.canLink('Application', 'target_of', 'Integration')).toBe(true);
    expect(registry.get('Application').attributes.delegates).toMatchObject({ type: 'string-list' });
    expect(compileJob(read('servicenow-applications-bq.yaml')).target.map.delegates).toBe('delegates');
  });

  it('S6: the REST stand-in and the BigQuery job never write the same source in one environment (local overlay: only the REST job is on)', () => {
    const jobs = readdirSync(join(root, 'sync/jobs')).filter((f) => /\.ya?ml$/.test(f)).map((f) => resolveJob(compileJob(read(f)), local, 'local'));
    expect(singleWriterProblems(jobs)).toEqual([]);
    const sn = jobs.filter((j) => j.def.target.source === 'servicenow' && !j.def.target.edge && j.def.target.type === 'Application');
    expect(sn.map((j) => [j.def.job, j.enabled]).sort()).toEqual([['servicenow-applications', true], ['servicenow-applications-bq', false]]);
    expect(jobs.filter((j) => j.def.target.source === 'servicenow' && j.enabled).map((j) => j.def.job)).toEqual(['servicenow-applications']);
    // the check itself: switching the BigQuery job on too is reported
    const both = jobs.map((j) => (j.def.job === 'servicenow-applications-bq' ? { ...j, enabled: true } : j));
    expect(singleWriterProblems(both)).toEqual([expect.stringMatching(/servicenow-applications-bq and servicenow-applications both write Application \/ servicenow/)]);
  });
});

describe('S6: applications first, then integrations whose ends exist (CAT-1, CAT-2)', () => {
  it('S6: integrations before their applications are refused, not recorded, and nothing is half written', async () => {
    expect(await run('servicenow-integrations-bq')).toMatchObject({ status: 'succeeded', complete: true, created: 4, errors: 0 });
    rejected.length = 0;
    const r = await run('servicenow-integration-source-bq');
    expect(r.note).toMatch(/4 records refused by the catalog/);
    expect(rejected.every((x) => /Both ends must exist/.test(x.reason))).toBe(true);
    expect((await admin.query("select 1 from connectors.record_state where job = 'servicenow-integration-source-bq'")).rowCount).toBe(0);
  });

  it('S6 CAT-1: applications arrive with owner, two delegates (a string list, leading zeros kept), hosting country, criticality and status', async () => {
    expect(await run('servicenow-applications-bq')).toMatchObject({ status: 'succeeded', complete: true, created: 5, errors: 0 });
    expect(await attrs('app-payments-hub')).toEqual({ name: 'Payments Hub', owner: '43000001', delegates: ['43000003', '04300004'], criticality: 'critical', status: 'live', hosting_country: 'GB' });
    expect((await attrs('app-legacy-ledger'))).toMatchObject({ status: 'retiring', hosting_country: 'SG', delegates: ['43000002', '43000004'] });
    expect((await attrs('app-data-lake'))!.delegates).toEqual([]);
    expect(await out('app-payments-hub', 'delegates')).toEqual([]);   // no invented edge
  });

  it('S6 CAT-9: owners are linked to their Person nodes by staff ID; an owner that is not a person yet is refused and retried', async () => {
    expect(await run('servicenow-application-owners-bq')).toMatchObject({ status: 'succeeded', complete: true, created: 5, errors: 0 });
    expect(await out('app-payments-hub', 'owned_by')).toEqual(['43000001']);
    expect(await out('app-core-banking', 'owned_by')).toEqual(['43000002']);
    expect(await out('app-legacy-ledger', 'owned_by')).toEqual(['43000003']);

    T.applications!.push({ sys_id: 'app-new', name: 'New', owned_by: '43009999', delegates: [], criticality: 'low', install_status: 'planned', country: 'GB' });
    expect(await run('servicenow-applications-bq')).toMatchObject({ created: 1 });
    rejected.length = 0;
    const r = await run('servicenow-application-owners-bq');
    expect(r.note).toMatch(/1 record refused by the catalog/);
    expect(await out('app-new', 'owned_by')).toEqual([]);
    await store.tx(cdb, () => store.applyNode(cdb, { type: 'Person', qualifiedName: '43009999', attributes: { email: 'late@example.test' }, writer: person, actor: 't' }));
    expect(await run('servicenow-application-owners-bq')).toMatchObject({ created: 1, unchanged: 5 });
    expect(await out('app-new', 'owned_by')).toEqual(['43009999']);
  });

  it('S6: an owner whose staff ID lost its zeros is refused and reported (never padded); an email owner is resolved to the staff ID', async () => {
    T.applications!.push({ sys_id: 'app-short', name: 'Short', owned_by: '4300001', delegates: [], criticality: 'low', install_status: 'planned', country: 'GB' },
      { sys_id: 'app-mail', name: 'Mail', owned_by: '43000002@example.test', delegates: [], criticality: 'low', install_status: 'planned', country: 'GB' });
    rejected.length = 0;
    const r = await run('servicenow-applications-bq');
    expect(r.note).toMatch(/1 record refused by the catalog/);
    expect(rejected.map((x) => x.key)).toEqual(['Application:app-short']);
    expect(await store.getNode(cdb, 'app-short')).toBeUndefined();
    expect((await attrs('app-mail'))!.owner).toBe('43000002');
    T.applications = T.applications!.filter((a) => a.sys_id !== 'app-short' && a.sys_id !== 'app-mail' && a.sys_id !== 'app-new');
    expect(await run('servicenow-applications-bq')).toMatchObject({ status: 'succeeded', complete: true, deprecated: 2 });
  });

  it('S6 CAT-2: integrations land with their attributes and an edge from each end; one to an unknown application is refused and retried', async () => {
    expect(await attrs('int-payments-to-ledger')).toEqual({ mechanism: 'api', frequency: 'real-time', status: 'live' });
    expect(await run('servicenow-integration-source-bq')).toMatchObject({ status: 'succeeded', complete: true, created: 4, errors: 0 });
    rejected.length = 0;
    const r = await run('servicenow-integration-target-bq');
    expect(r.note).toMatch(/1 record refused by the catalog/);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatch(/Both ends must exist/);
    const into = async (i: string, name: string) => (await store.namedEdgesOf(cdb, i, { name, direction: 'in' })).map((e) => e.fromQn);
    expect(await into('int-payments-to-ledger', 'source_of')).toEqual(['app-payments-hub']);
    expect(await into('int-payments-to-ledger', 'target_of')).toEqual(['app-core-banking']);
    expect(await into('int-lake-to-fx', 'source_of')).toEqual(['app-data-lake']);
    expect(await into('int-lake-to-fx', 'target_of')).toEqual([]);       // app-fx-gateway is unknown
    // the refused one is sent again each run, and lands once the application exists
    expect((await run('servicenow-integration-target-bq')).note).toMatch(/1 record refused/);
    T.applications!.push({ sys_id: 'app-fx-gateway', name: 'FX Gateway', owned_by: '43000004', delegates: [], criticality: 'medium', install_status: 'planned', country: 'GB' });
    await run('servicenow-applications-bq');
    expect(await run('servicenow-integration-target-bq')).toMatchObject({ created: 1, unchanged: 3 });
    expect(await into('int-lake-to-fx', 'target_of')).toEqual(['app-fx-gateway']);
  });
});

describe('S6: deleted source rows deprecate only on complete full runs (ADR 0013)', () => {
  it('S6: an incomplete run (a row with no key) deprecates nothing; the next complete run deprecates the application and ends its integration edges', async () => {
    const gone = T.applications!.find((a) => a.sys_id === 'app-legacy-ledger')!;
    T.applications = T.applications!.filter((a) => a !== gone).concat({ sys_id: null, name: 'Broken' });
    expect(await run('servicenow-applications-bq')).toMatchObject({ complete: false, errors: 1, deprecated: 0 });
    expect((await store.getNode(cdb, 'app-legacy-ledger'))!.lifecycle).not.toBe('deprecated');

    T.applications = T.applications!.filter((a) => a.sys_id !== null);
    expect(await run('servicenow-applications-bq')).toMatchObject({ complete: true, errors: 0, deprecated: 1 });
    expect((await store.getNode(cdb, 'app-legacy-ledger'))!.lifecycle).toBe('deprecated');
    expect(await run('servicenow-applications-bq')).toMatchObject({ created: 0, updated: 0, deprecated: 0 }); // idempotent
  });

  it('S6: a deleted integration is deprecated and its edges end, on the complete runs', async () => {
    T.integrations = T.integrations!.filter((i) => i.sys_id !== 'int-ledger-to-lake');
    expect(await run('servicenow-integrations-bq')).toMatchObject({ complete: true, deprecated: 1 });
    expect((await store.getNode(cdb, 'int-ledger-to-lake'))!.lifecycle).toBe('deprecated');
    expect(await run('servicenow-integration-source-bq')).toMatchObject({ complete: true, deprecated: 1 });
    expect(await run('servicenow-integration-target-bq')).toMatchObject({ complete: true, deprecated: 1 });
    expect(await out('app-core-banking', 'source_of')).toEqual(['int-ledger-to-risk']);
  });

  it('S6 rule 8: only the metadata columns are ever asked for, and no query selects everything', () => {
    expect(bq.requests.length).toBeGreaterThan(5);
    for (const r of bq.requests) { expect(r.query).not.toMatch(/SELECT\s+\*/i); expect(r.query).not.toMatch(/sys_updated_on/); }
  });
});
