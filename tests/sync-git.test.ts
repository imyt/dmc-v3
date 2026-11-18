import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExceptionPort, Signal } from '../packages/contracts/src/index';
import { loadRegistry, migrateModule, provisionModule } from '../packages/platform/src/index';
import { CatalogStore } from '../packages/catalog/src/index';
import { SyncService, compileJob, compileOverlay, gitJsonRecords, manifestConnector, resolveJob, type ResolvedJob, type RunResult } from '../packages/connectors/src/index';
import { CatalogIngest } from '../apps/worker/src/index';

const root = join(import.meta.dirname, '..');
const PORT = 54470;
const store = new CatalogStore(loadRegistry(join(root, 'metamodel/types')));
const overlay = compileOverlay(readFileSync(join(root, 'sync/overlays/local.yaml'), 'utf8'));
const jobOf = (f: string): ResolvedJob => resolveJob(compileJob(readFileSync(join(root, 'sync/jobs', f), 'utf8')), overlay, 'local');
// S7 in the order they must run: nodes first, then the edges that need both ends
const S7 = ['git-systems', 'git-schemas', 'git-tables', 'git-columns', 'git-owns', 'git-contains-schemas', 'git-contains-tables', 'git-contains-columns'].map((n) => jobOf(`${n}.yaml`));
const DBT = jobOf('dbt-column-lineage.yaml');
const AIRFLOW = jobOf('airflow-column-lineage.yaml');
const sn = { kind: 'sync', source: 'servicenow' } as const;

// the fixture checkouts are copied, so a test can remove a repo or break a file without touching the fixtures
const work = mkdtempSync(join(tmpdir(), 'dmc-sg-fx-'));
const fx = join(work, 'fixtures');
const repoFile = (app: string) => join(fx, 'git', app, 'dmc-metadata.json');
const readRepo = (app: string) => JSON.parse(readFileSync(repoFile(app), 'utf8'));

let server: EmbeddedPostgres; let admin: pg.Client; let cdb: pg.Client; let sdb: pg.Client; let svc: SyncService;
const rejected: { key: string; reason: string }[] = [];
const forwarded: Signal[] = [];
const exceptions: ExceptionPort = { async raise() { return { id: 'x', created: true }; }, async withdraw() { return true; } };
const run = (j: ResolvedJob) => svc.run(sdb, j.def.job, 'local');
/** runs the eight S7 jobs in order; `approve` accepts a run the change limit paused (a whole repo going or coming back is a big change on a three-system fixture) */
const runS7 = async (approve = false): Promise<Record<string, RunResult>> => {
  const out: Record<string, RunResult> = {};
  for (const j of S7) {
    let r = await run(j);
    if (approve && r.status === 'paused_limit') r = await svc.approve(sdb, r.runId, 'admin');
    out[j.def.job] = r;
  }
  return out;
};
const lifecycle = async (qn: string) => (await store.getNode(cdb, qn))?.lifecycle;
const edgesOf = async (name: string) => (await admin.query(`select f.qualified_name as f, t.qualified_name as t, e.source, e.attributes, e.valid_to is not null as ended
  from catalog.edge e join catalog.node f on f.id = e.from_id join catalog.node t on t.id = e.to_id
  where e.name = $1 and e.recorded_to is null order by f.qualified_name, t.qualified_name`, [name])).rows as { f: string; t: string; source: string; attributes: Record<string, unknown>; ended: boolean }[];
const liveEdges = async (name: string) => (await edgesOf(name)).filter((e) => !e.ended);
const countType = async (type: string) => (await admin.query('select count(*)::int as n from catalog.node where type = $1', [type])).rows[0].n as number;

beforeAll(async () => {
  mkdirSync(fx, { recursive: true });
  for (const p of ['git', 'applications.json', 'dbt', 'airflow']) cpSync(join(root, 'sync/fixtures', p), join(fx, p), { recursive: true });
  server = new EmbeddedPostgres({ databaseDir: mkdtempSync(join(tmpdir(), 'dmc-sg-')), user: 'postgres', password: 'pw', port: PORT, persistent: false });
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
  const ingest = new CatalogIngest({
    store, connect: async () => ({ query: (q: string, p?: unknown[]) => cdb.query(q, p) as never, release() {} }),
    sourceOf: (job) => svc.writerSource(sdb, job),
    next: { async submit(s) { forwarded.push(...s); } },
    onReject: (s, reason) => { rejected.push({ key: s.subjectRef, reason }); },
  });
  svc = new SyncService({ connectors: { manifest: manifestConnector() }, signals: ingest, exceptions, sleep: async () => {} });
  for (const name of ['git-repos', 'lineage-files']) await svc.upsertConnection(sdb, { name, environment: 'local', type: 'manifest', config: { root: fx }, secretRef: 'local/none' });
  for (const j of [...S7, DBT, AIRFLOW]) await svc.installJob(sdb, j);

  // the applications come from the ServiceNow job (S6); here they are made from the same fixture list
  const apps = JSON.parse(readFileSync(join(root, 'sync/fixtures/applications.json'), 'utf8')).records as { sys_id: string; name: string; owned_by: string; country: string }[];
  await store.tx(cdb, async () => {
    for (const a of apps) await store.applyNode(cdb, { type: 'Application', qualifiedName: a.sys_id, attributes: { name: a.name, owner: a.owned_by, hosting_country: a.country }, writer: sn, actor: 'sync/servicenow' });
  });
}, 150_000);
afterAll(async () => {
  try {
    await sdb?.end(); await cdb?.end(); await admin?.end();
  } finally {
    try { await server?.stop(); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EBUSY') throw e; }
  }
  try { rmSync(work, { recursive: true, force: true }); } catch { /* a locked temp directory is not a test failure */ }
});

describe('S7: Git JSON technical metadata (CAT-1, SEN-1)', () => {
  it('S7 CAT-1: the jobs create systems, schemas, tables and columns, named system/schema/table/column, owned by git-json', async () => {
    const r = await runS7();
    for (const j of S7) expect(r[j.def.job], j.def.job).toMatchObject({ status: 'succeeded', complete: true, errors: 0, deprecated: 0 });
    expect([r['git-systems']!.created, r['git-schemas']!.created, r['git-tables']!.created, r['git-columns']!.created]).toEqual([3, 5, 9, 26]);
    expect([r['git-owns']!.created, r['git-contains-schemas']!.created, r['git-contains-tables']!.created, r['git-contains-columns']!.created]).toEqual([3, 5, 9, 26]);
    expect(rejected).toEqual([]);

    expect(await store.getNode(cdb, 'analytics-prod')).toMatchObject({ type: 'System', attributes: { name: 'analytics-prod', platform: 'BigQuery', environment: 'prod' } });
    expect(await store.getNode(cdb, 'analytics-prod/raw')).toMatchObject({ type: 'Schema', attributes: { name: 'raw' } });
    expect(await store.getNode(cdb, 'analytics-prod/marts/fct_orders')).toMatchObject({ type: 'Table', attributes: { name: 'fct_orders', kind: 'table', description: 'One row per order' } });
    const col = await store.getNode(cdb, 'analytics-prod/raw/customers/full_name');
    expect(col).toMatchObject({ type: 'Column', attributes: { name: 'full_name', data_type: 'STRING', nullable: true, description: 'Customer name', tags: ['customer', 'pii-candidate'] } });
    const prov = (await admin.query("select provenance from catalog.node_version v join catalog.node n on n.id = v.node_id where n.qualified_name = 'analytics-prod/raw/customers/full_name' and v.valid_to is null and v.recorded_to is null")).rows[0].provenance;
    expect(prov.data_type.by).toMatch(/git-json/);
  });

  it('S7 CAT-1: every table and column is linked to its application through system, schema and table', async () => {
    expect((await liveEdges('owns')).map((e) => [e.f, e.t, e.source])).toEqual([['app-core-banking', 'shop-oltp', 'git-json'], ['app-data-lake', 'analytics-prod', 'git-json'], ['app-risk-engine', 'risk-calc', 'git-json']]);
    expect((await liveEdges('contains')).length).toBe(5 + 9 + 26);
    const c = await store.edgesOf(cdb, 'analytics-prod/marts/fct_orders', { name: 'contains', direction: 'out' });
    expect(c.length).toBe(4); // fct_orders has four columns
  });

  it('S7: an application with no repo owns nothing; a repo is found by the application id', async () => {
    expect((await liveEdges('owns')).some((e) => e.f === 'app-crm' || e.f === 'app-payments-hub')).toBe(false);
  });

  it('S7 rule 8: only metadata fields are read: a file that carries sample values never lands in the catalog', async () => {
    expect(JSON.stringify(readRepo('app-core-banking'))).toContain('SECRET-1'); // the fixture does hold one
    const all = (await admin.query('select attributes::text as a from catalog.node_version')).rows.map((r) => r.a).join('\n');
    expect(all).not.toContain('SECRET');
    expect(all).not.toContain('sample_values');
  });

  it('S7 SEN-1: a second run is idempotent: no record created, changed or deprecated, no catalog write', async () => {
    const nodes = (await admin.query('select count(*)::int as n from catalog.node_version')).rows[0].n;
    const edges = (await admin.query('select count(*)::int as n from catalog.edge')).rows[0].n;
    const r = await runS7();
    for (const j of S7) expect(r[j.def.job], j.def.job).toMatchObject({ status: 'succeeded', created: 0, updated: 0, deprecated: 0 });
    expect((await admin.query('select count(*)::int as n from catalog.node_version')).rows[0].n).toBe(nodes);
    expect((await admin.query('select count(*)::int as n from catalog.edge')).rows[0].n).toBe(edges);
    expect(forwarded.filter((s) => s.kind === 'sync.link' || s.kind === 'sync.unlink')).toEqual([]);
  });

  it('S7 + S8 SEN-5: run after S7, the dbt and Airflow column edges are all accepted: no column is missing', async () => {
    rejected.length = 0;
    const d = await run(DBT); const a = await run(AIRFLOW);
    expect(d).toMatchObject({ status: 'succeeded', complete: true, errors: 0, created: 11 });
    expect(a).toMatchObject({ status: 'succeeded', complete: true, errors: 0, created: 7 });
    expect(rejected).toEqual([]); // nothing refused for a missing end
    expect((await liveEdges('derives_from')).length).toBe(18);
    // every end the lineage fixtures name is a Column S7 made, under the same name
    const ends = new Set<string>();
    for (const q of [`dbt ${'dbt/target'}`, 'openlineage airflow/lineage-events.json']) {
      const recs = (await manifestConnector().read({ root: fx }, { text: q, pageSize: 1000 }, null, null)).records as { derived: Record<string, string>; upstream: Record<string, string> }[];
      for (const r of recs) for (const e of [r.derived, r.upstream]) ends.add(`${e.database}/${e.schema}/${e.table}/${e.column}`);
    }
    expect(ends.size).toBeGreaterThan(10);
    for (const qn of ends) expect(await store.getNode(cdb, qn), qn).toMatchObject({ type: 'Column', lifecycle: expect.not.stringMatching(/deprecated/) });
  });
});

describe('S7: removed and broken repos (S3 behaviour)', () => {
  it('S7: a removed table deprecates it, its columns and their links on the next complete run', async () => {
    const m = readRepo('app-data-lake');
    m.systems[0].schemas.find((s: { name: string }) => s.name === 'marts').tables.pop(); // orders_preview
    writeFileSync(repoFile('app-data-lake'), JSON.stringify(m));
    const r = await runS7();
    expect(r['git-tables']).toMatchObject({ complete: true, deprecated: 1 });
    expect(r['git-columns']).toMatchObject({ complete: true, deprecated: 1 });
    expect(r['git-contains-tables']).toMatchObject({ deprecated: 1 });
    expect(await lifecycle('analytics-prod/marts/orders_preview')).toBe('deprecated');
    expect(await lifecycle('analytics-prod/marts/orders_preview/order_id')).toBe('deprecated');
    expect(await lifecycle('analytics-prod/marts/fct_orders')).not.toBe('deprecated');
    expect((await liveEdges('contains')).some((e) => e.t.includes('orders_preview'))).toBe(false);
  });

  it('S7: a removed repo deprecates its system, schemas, tables, columns and owner link; it comes back when the repo does', async () => {
    const saved = readFileSync(repoFile('app-risk-engine'), 'utf8');
    rmSync(join(fx, 'git', 'app-risk-engine'), { recursive: true });
    const first = await run(S7[0]!);
    expect(first.status).toBe('paused_limit'); // one of three systems going is above the 30% limit: an admin decides
    await svc.discard(sdb, first.runId, 'admin');
    const r = await runS7(true);
    expect(r['git-systems']).toMatchObject({ deprecated: 1 });
    for (const qn of ['risk-calc', 'risk-calc/exposure', 'risk-calc/exposure/limits', 'risk-calc/exposure/limits/amount']) expect(await lifecycle(qn), qn).toBe('deprecated');
    expect((await liveEdges('owns')).some((e) => e.t === 'risk-calc')).toBe(false);
    expect(await lifecycle('app-risk-engine')).not.toBe('deprecated'); // the application itself is not this job's

    mkdirSync(join(fx, 'git', 'app-risk-engine'));
    writeFileSync(repoFile('app-risk-engine'), saved);
    await runS7(true);
    for (const qn of ['risk-calc', 'risk-calc/exposure/limits/amount']) expect(await lifecycle(qn), qn).toBe('discovered');
    expect((await liveEdges('owns')).some((e) => e.f === 'app-risk-engine' && e.t === 'risk-calc')).toBe(true);
  });

  it('S7: an unreadable repo file makes the runs incomplete and deprecates nothing', async () => {
    const before = await countType('Column');
    const saved = readFileSync(repoFile('app-core-banking'), 'utf8');
    writeFileSync(repoFile('app-core-banking'), '{ not json');
    const r = await runS7();
    writeFileSync(repoFile('app-core-banking'), saved);
    for (const j of S7) expect(r[j.def.job], j.def.job).toMatchObject({ status: 'succeeded', complete: false, errors: 1, deprecated: 0 });
    expect(await lifecycle('shop-oltp')).not.toBe('deprecated');
    expect(await lifecycle('shop-oltp/public/orders/total')).not.toBe('deprecated');
    expect(await countType('Column')).toBe(before);
  });

  it('S7: a system claimed by two repos stays with the first; the second is an error, not a silent steal', async () => {
    const dup = readRepo('app-risk-engine');
    dup.systems.push({ name: 'shop-oltp', schemas: [{ name: 'public', tables: [{ name: 'orders', columns: [{ name: 'id' }] }] }] });
    writeFileSync(repoFile('app-risk-engine'), JSON.stringify(dup));
    const r = await runS7();
    for (const j of S7) expect(r[j.def.job], j.def.job).toMatchObject({ complete: false, errors: 1, deprecated: 0 });
    expect((await liveEdges('owns')).filter((e) => e.t === 'shop-oltp').map((e) => e.f)).toEqual(['app-core-banking']);
    writeFileSync(repoFile('app-risk-engine'), JSON.stringify(readRepo('app-risk-engine'), (k, v) => (k === 'systems' ? v.slice(0, 1) : v)));
    expect((await run(S7[0]!))).toMatchObject({ complete: true, errors: 0 });
  });
});

describe('S7: the reader', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'dmc-sg-unit-'));
  afterAll(() => { rmSync(tmp, { recursive: true, force: true }); });
  const put = (rel: string, body: unknown) => { mkdirSync(join(tmp, rel, '..'), { recursive: true }); writeFileSync(join(tmp, rel), typeof body === 'string' ? body : JSON.stringify(body)); };
  put('apps.json', { records: [{ sys_id: 'a1' }, { sys_id: '../escape' }, { sys_id: 'a2' }, { sys_id: 'a3' }, { sys_id: 'a1' }] });
  put('repos/a1/dmc-metadata.json', { systems: [{ name: 's1', schemas: [{ name: 'p', tables: [{ name: 't', columns: [{ name: 'c', data_type: 'INT', nullable: false, secret_value: 'x' }] }] }] }] });
  put('repos/a2/dmc-metadata.json', { systems: [{ name: 'bad/name' }, { name: 's2', platform: 5 }, { name: 's3' }] });
  mkdirSync(join(tmp, 'repos/a3'), { recursive: true }); // a repo with no metadata file

  it('S7: reads only the listed fields; an application with no repo directory adds nothing; the application list is not trusted as a path', () => {
    const cols = gitJsonRecords(tmp, 'repos', 'apps.json', 'columns');
    expect(cols.filter((r) => !r.error)).toEqual([{ qualified_name: 's1/p/t/c', name: 'c', data_type: 'INT', nullable: false }]);
    expect(gitJsonRecords(tmp, 'repos', 'apps.json', 'owns').filter((r) => !r.error)).toEqual([{ from: { qn: 'a1' }, to: { qn: 's1' }, repo: 'a1' }, { from: { qn: 'a2' }, to: { qn: 's3' }, repo: 'a2' }]);
  });

  it('S7: a bad name, a wrong-typed field and a repo without its file are errors (records with no key), never guesses', () => {
    const errs = gitJsonRecords(tmp, 'repos', 'apps.json', 'systems').filter((r) => r.error).map((r) => String(r.error));
    expect(errs).toHaveLength(3);
    expect(errs.join('\n')).toMatch(/bad\/name/);
    expect(errs.join('\n')).toMatch(/platform must be text/);
    expect(errs.join('\n')).toMatch(/repo a3: File not found/);
    expect(gitJsonRecords(tmp, 'repos', 'apps.json', 'systems').filter((r) => r.error).every((r) => !('qualified_name' in r))).toBe(true);
  });

  it('S7: the connector refuses a path outside its root, an unknown kind and a malformed query', async () => {
    const c = manifestConnector();
    await expect(c.read({ root: tmp }, { text: 'git-json ../x apps.json systems', pageSize: 10 }, null, null)).rejects.toThrow(/outside the connection root/);
    await expect(c.read({ root: tmp }, { text: 'git-json repos apps.json nodes', pageSize: 10 }, null, null)).rejects.toThrow(/Unknown git-json kind/);
    await expect(c.read({ root: tmp }, { text: 'git-json repos apps.json', pageSize: 10 }, null, null)).rejects.toThrow(/git-json <reposDir>/);
    await expect(c.read({ root: tmp }, { text: 'git-json repos missing.json systems', pageSize: 10 }, null, null)).rejects.toThrow(/File not found/);
  });
});
