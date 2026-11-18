import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Connector, ExceptionPort, ReadPage, Signal } from '../packages/contracts/src/index';
import { loadRegistry, migrateModule, provisionModule } from '../packages/platform/src/index';
import { CatalogLineage, CatalogStore } from '../packages/catalog/src/index';
import { SyncService, compileJob, compileOverlay, manifestConnector, resolveJob, type ResolvedJob } from '../packages/connectors/src/index';
import { CatalogIngest } from '../apps/worker/src/index';

const root = join(import.meta.dirname, '..');
const PORT = 54410;
const store = new CatalogStore(loadRegistry(join(root, 'metamodel/types')));
const overlay = compileOverlay(readFileSync(join(root, 'sync/overlays/local.yaml'), 'utf8'));
const jobOf = (f: string): ResolvedJob => resolveJob(compileJob(readFileSync(join(root, 'sync/jobs', f), 'utf8')), overlay, 'local');
const DBT = jobOf('dbt-column-lineage.yaml');
const AIRFLOW = jobOf('airflow-column-lineage.yaml');
const git = { kind: 'sync', source: 'git-json' } as const;
const qn = (e: { database?: string; schema?: string; table?: string; column?: string }) => `${e.database}/${e.schema}/${e.table}/${e.column}`;

// the real connector over the fixture files, but a test can swap what it reads to make a partial or changed run
const real = manifestConnector();
let override: ReadPage['records'] | null = null;
let failWith: string | null = null;
const connector: Connector = {
  test: (c) => real.test(c),
  async read(cfg, q, cur, since) {
    if (failWith) throw new Error(failWith);
    const p = await real.read(cfg, q, cur, since);
    return override ? { ...p, records: override } : p;
  },
};

let server: EmbeddedPostgres; let admin: pg.Client; let cdb: pg.Client; let sdb: pg.Client; let svc: SyncService; let lineage: CatalogLineage;
const rejected: { key: string; reason: string }[] = [];
const forwarded: Signal[] = [];
const exceptions: ExceptionPort = { async raise() { return { id: 'x', created: true }; }, async withdraw() { return true; } };
const edges = async () => (await admin.query(`select f.qualified_name as f, t.qualified_name as t, e.source, e.attributes, e.valid_to is not null as ended
  from catalog.edge e join catalog.node f on f.id = e.from_id join catalog.node t on t.id = e.to_id
  where e.name = 'derives_from' and e.recorded_to is null order by f.qualified_name, t.qualified_name`)).rows as { f: string; t: string; source: string; attributes: Record<string, unknown>; ended: boolean }[];
const live = async () => (await edges()).filter((e) => !e.ended);
const run = (j: ResolvedJob) => svc.run(sdb, j.def.job, 'local');
const fixtureRecords = async (j: ResolvedJob) => (await connector.read({ root: join(root, 'sync/fixtures') }, { text: j.query, pageSize: 1000 }, null, null)).records;

beforeAll(async () => {
  server = new EmbeddedPostgres({ databaseDir: mkdtempSync(join(tmpdir(), 'dmc-sl-')), user: 'postgres', password: 'pw', port: PORT, persistent: false });
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
  lineage = new CatalogLineage(cdb);
  const ingest = new CatalogIngest({
    store, connect: async () => ({ query: (q: string, p?: unknown[]) => cdb.query(q, p) as never, release() {} }),
    sourceOf: (job) => svc.writerSource(sdb, job),
    next: { async submit(s) { forwarded.push(...s); } },
    onReject: (s, reason) => { rejected.push({ key: s.subjectRef, reason }); },
  });
  svc = new SyncService({ connectors: { manifest: connector }, signals: ingest, exceptions, sleep: async () => {} });
  await svc.upsertConnection(sdb, { name: 'lineage-files', environment: 'local', type: 'manifest', config: { root: join(root, 'sync/fixtures') }, secretRef: 'local/none' });
  for (const j of [DBT, AIRFLOW]) await svc.installJob(sdb, j);

  // the columns come from the Git JSON sync (S7); here they are made from every end the fixtures name
  const ends = new Set<string>();
  for (const j of [DBT, AIRFLOW]) for (const r of await fixtureRecords(j)) for (const e of [r.derived, r.upstream] as { database?: string }[]) ends.add(qn(e as never));
  ends.add('analytics-prod/marts/orders_preview/order_id'); // a column nothing in the fixtures points at
  await store.tx(cdb, async () => {
    for (const c of ends) await store.applyNode(cdb, { type: 'Column', qualifiedName: c, attributes: { name: c.split('/').pop()! }, writer: git, actor: 'sync/git' });
  });
}, 150_000);
afterAll(async () => {
  try {
    await sdb?.end(); await cdb?.end(); await admin?.end();
  } finally {
    try { await server?.stop(); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EBUSY') throw e; }
  }
});

describe('S8: dbt column lineage (SEN-1, SEN-5, CAT-8)', () => {
  it('S8 SEN-5: a run over the fixture manifest and catalog creates column edges, owned by dbt, with the model as job name', async () => {
    const r = await run(DBT);
    expect(r).toMatchObject({ status: 'succeeded', complete: true, errors: 0 });
    const e = await live();
    expect(e.every((x) => x.source === 'dbt')).toBe(true);
    // an edge is "derived derives_from upstream": f is the derived column, t its upstream
    const find = (up: string, down: string) => e.find((x) => x.f === `analytics-prod/${down}` && x.t === `analytics-prod/${up}`);
    // declared in the manifest: full confidence, job is the model that builds the column
    expect(find('raw/orders/amount_cents', 'staging/stg_orders/amount')!.attributes).toEqual({ job: 'shop.stg_orders', confidence: 1, origin: 'declared' });
    expect(find('raw/customers/full_name', 'staging/stg_customers/customer_name')!.attributes).toMatchObject({ job: 'shop.stg_customers', origin: 'declared' });
    expect(find('staging/stg_customers/customer_name', 'marts/fct_orders/customer_name')!.attributes).toMatchObject({ job: 'shop.fct_orders', confidence: 1 });
    // not declared: same column name in a parent, a guess with lower confidence
    expect(find('raw/orders/order_id', 'staging/stg_orders/order_id')!.attributes).toEqual({ job: 'shop.stg_orders', confidence: 0.6, origin: 'name-match' });
    // a declared column is not also guessed from a same-named column elsewhere
    expect(find('staging/stg_orders/amount', 'marts/fct_orders/amount')!.attributes.origin).toBe('declared');
    expect(e.some((x) => x.t.includes('orders_preview') || x.f.includes('orders_preview'))).toBe(false); // not built: not in catalog.json
    expect(e.length).toBe(11);
  });

  it('S8 CAT-8: the edges are walked by the lineage store, with the job name on each edge', async () => {
    const r = (await lineage.traverse('analytics-prod/marts/fct_orders/amount', { direction: 'upstream' }))!;
    expect(r.nodes.map((n) => n.qualifiedName)).toEqual(expect.arrayContaining(['analytics-prod/staging/stg_orders/amount', 'analytics-prod/raw/orders/amount_cents']));
    expect(r.edges.map((x) => x.job).sort()).toEqual(['shop.fct_orders', 'shop.stg_orders']);
    expect(r.edges.every((x) => x.source === 'dbt')).toBe(true);
    const down = (await lineage.traverse('analytics-prod/raw/orders/amount_cents', { direction: 'downstream' }))!;
    expect(down.nodes.map((n) => n.qualifiedName)).toContain('analytics-prod/marts/fct_orders/amount');
  });

  it('S8 SEN-1: a second run is idempotent: no edge is created, changed or ended, no catalog write', async () => {
    const before = (await admin.query('select count(*)::int as n from catalog.edge')).rows[0].n;
    const outbox = (await admin.query("select count(*)::int as n from catalog.outbox where event_type like 'edge.%'")).rows[0].n;
    const r = await run(DBT);
    expect(r).toMatchObject({ status: 'succeeded', created: 0, updated: 0, deprecated: 0, unchanged: 11 });
    expect((await admin.query('select count(*)::int as n from catalog.edge')).rows[0].n).toBe(before);
    expect((await admin.query("select count(*)::int as n from catalog.outbox where event_type like 'edge.%'")).rows[0].n).toBe(outbox);
  });

  it('S8: every edge write is evidenced in the catalog outbox in the same transaction (rule 6)', async () => {
    const o = (await admin.query("select count(*)::int as n from catalog.outbox where event_type = 'edge.created'")).rows[0].n;
    expect(o).toBeGreaterThanOrEqual(11);
  });

  it('S8 SEN-5: a changed job name or confidence re-describes the edge and keeps history', async () => {
    const recs = (await fixtureRecords(DBT)).map((r) => (r.derived as { column: string; table: string }).table === 'stg_orders' && (r.derived as { column: string }).column === 'order_id' ? { ...r, job: 'shop.stg_orders_v2', confidence: 0.9 } : r);
    override = recs;
    const r = await run(DBT);
    override = null;
    expect(r).toMatchObject({ status: 'succeeded', updated: 1, created: 0, deprecated: 0 });
    const now = (await live()).find((x) => x.f.endsWith('stg_orders/order_id'))!;
    expect(now.attributes).toMatchObject({ job: 'shop.stg_orders_v2', confidence: 0.9 });
    expect((await admin.query("select count(*)::int as n from catalog.edge where name='derives_from' and from_id = (select id from catalog.node where qualified_name = 'analytics-prod/staging/stg_orders/order_id')")).rows[0].n).toBe(2);
    await run(DBT); // back to the fixture
    expect((await live()).find((x) => x.f.endsWith('stg_orders/order_id'))!.attributes).toMatchObject({ job: 'shop.stg_orders', confidence: 0.6 });
  });

  it('S8: a partial run deprecates nothing: an unresolved reference makes the run incomplete and no edge ends', async () => {
    const all = await fixtureRecords(DBT);
    const kept = all.filter((r) => !(r.derived as { table: string }).table.startsWith('fct_orders')); // fct_orders edges missing from this read ...
    override = [...kept, { upstream: {}, derived: { database: 'analytics-prod', schema: 'marts', table: 'fct_orders', column: 'amount' }, job: 'shop.fct_orders', confidence: 1, origin: 'declared' }]; // ... and one that did not resolve
    const r = await run(DBT);
    override = null;
    expect(r).toMatchObject({ status: 'succeeded', complete: false, errors: 1, deprecated: 0 });
    expect((await live()).length).toBe(11);
  });

  it('S8: a failed read changes nothing and reports the failure', async () => {
    failWith = 'File not found under the connection root: dbt/target/catalog.json';
    const r = await run(DBT);
    failWith = null;
    expect(r.status).toBe('failed');
    expect(r.note).toMatch(/catalog\.json/);
    expect((await live()).length).toBe(11);
  });

  it('S8: a complete full run that no longer finds an edge ends it; the edge returns when it reappears', async () => {
    const all = await fixtureRecords(DBT);
    const drop = (r: Record<string, unknown>) => (r.upstream as { table?: string }).table === 'stg_orders' && (r.derived as { table: string }).table === 'fct_orders' && (r.derived as { column: string }).column === 'order_id';
    override = all.filter((r) => !drop(r));
    const r = await run(DBT);
    expect(r).toMatchObject({ status: 'succeeded', complete: true, deprecated: 1 });
    expect((await live()).length).toBe(10);
    expect((await lineage.traverse('analytics-prod/marts/fct_orders/order_id', { direction: 'upstream' }))!.edges.some((x) => x.to.endsWith('stg_orders/order_id'))).toBe(false);
    override = null;
    await run(DBT);
    expect((await live()).length).toBe(11);
  });

  it('S8: the change limit still applies: a manifest that loses most edges pauses the run and ends nothing', async () => {
    override = (await fixtureRecords(DBT)).slice(0, 4);
    const r = await run(DBT);
    override = null;
    expect(r.status).toBe('paused_limit');
    expect((await live()).length).toBe(11);
    await svc.discard(sdb, r.runId, 'admin');
  });
});

describe('S8: Airflow column lineage (SEN-1, SEN-5)', () => {
  it('S8 SEN-5: COMPLETE events with column lineage become edges owned by airflow, with dag.task as the job name', async () => {
    const r = await run(AIRFLOW);
    expect(r).toMatchObject({ status: 'succeeded', complete: true, errors: 0 });
    const e = (await live()).filter((x) => x.source === 'airflow');
    expect(e.length).toBe(7); // the FAIL event and the START event add nothing; full_name has two inputs
    const into = (t: string) => e.filter((x) => x.f === `analytics-prod/raw/${t}`);
    expect(into('orders/amount_cents').map((x) => [x.t, x.attributes])).toEqual([['shop-oltp/public/orders/total', { job: 'orders_ingest.load_raw_orders', confidence: 1, origin: 'openlineage' }]]);
    expect(into('orders/status')[0]!.attributes.confidence).toBe(0.5); // INDIRECT (filter) only
    expect(into('customers/full_name').map((x) => x.t)).toEqual(['shop-oltp/public/customers/first_name', 'shop-oltp/public/customers/last_name']);
    expect(e.every((x) => x.attributes.job === 'orders_ingest.load_raw_orders' || x.attributes.job === 'orders_ingest.load_raw_customers')).toBe(true);
  });

  it('S8 CAT-8: dbt and Airflow edges join into one lineage path from the OLTP column to the mart column', async () => {
    const r = (await lineage.traverse('analytics-prod/marts/fct_orders/amount', { direction: 'upstream' }))!;
    expect(r.nodes.map((n) => n.qualifiedName)).toContain('shop-oltp/public/orders/total');
    expect(new Set(r.edges.map((x) => x.source))).toEqual(new Set(['dbt', 'airflow']));
    expect(r.edges.map((x) => x.job)).toEqual(expect.arrayContaining(['orders_ingest.load_raw_orders', 'shop.stg_orders', 'shop.fct_orders']));
  });

  it('S8: re-running is idempotent, and an edge missing from the event window is not ended', async () => {
    expect(await run(AIRFLOW)).toMatchObject({ created: 0, updated: 0, deprecated: 0, unchanged: 7 });
    override = (await fixtureRecords(AIRFLOW)).slice(0, 2);
    const r = await run(AIRFLOW);
    override = null;
    expect(r).toMatchObject({ status: 'succeeded', deprecated: 0 });
    expect((await live()).filter((x) => x.source === 'airflow').length).toBe(7);
  });

  it('S8: a dataset name that is not project.dataset.table is an error, so the run is incomplete', async () => {
    override = [{ upstream: { database: 'x' }, derived: { database: 'analytics-prod', schema: 'raw', table: 'orders', column: 'status' }, job: 'j', confidence: 1, origin: 'openlineage' }];
    const r = await run(AIRFLOW);
    override = null;
    expect(r).toMatchObject({ complete: false, errors: 1 });
  });
});

describe('S8: ends and the metamodel', () => {
  it('S8: an edge whose column is not in the catalog yet is refused and reported; the others still go through', async () => {
    rejected.length = 0;
    const base = (await fixtureRecords(DBT));
    override = [...base, { upstream: { database: 'analytics-prod', schema: 'raw', table: 'orders', column: 'order_id' }, derived: { database: 'analytics-prod', schema: 'marts', table: 'fct_orders', column: 'new_column' }, job: 'shop.fct_orders', confidence: 0.6, origin: 'name-match' }];
    const r = await run(DBT);
    override = null;
    expect(r).toMatchObject({ status: 'succeeded', created: 1 });
    expect(rejected.map((x) => x.key)).toEqual(['Column:analytics-prod/marts/fct_orders/new_column->analytics-prod/raw/orders/order_id']);
    expect(rejected[0]!.reason).toMatch(/Both ends must exist/);
    expect((await live()).length).toBe(18);
  });

  it('S8: edge jobs never reach the decision path as asset changes', () => {
    expect(forwarded.filter((s) => s.kind === 'sync.link' || s.kind === 'sync.unlink')).toEqual([]);
  });

  it('S8: the connector refuses a path outside its root and an unknown format', async () => {
    await expect(real.read({ root: join(root, 'sync/fixtures') }, { text: 'openlineage ../jobs/dbt-column-lineage.yaml', pageSize: 10 }, null, null)).rejects.toThrow(/outside the connection root/);
    await expect(real.read({ root: join(root, 'sync/fixtures') }, { text: 'sql x', pageSize: 10 }, null, null)).rejects.toThrow(/Unknown manifest format/);
    expect(await real.test({ root: join(root, 'sync/fixtures') })).toEqual({ ok: true });
    expect((await real.test({ root: join(root, 'nope') })).ok).toBe(false);
  });
});
