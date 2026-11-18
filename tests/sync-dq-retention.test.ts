import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExceptionPort, Signal } from '../packages/contracts/src/index';
import { loadRegistry, migrateModule, provisionModule } from '../packages/platform/src/index';
import { CatalogStore } from '../packages/catalog/src/index';
import { SyncService, bigQueryConnector, checkJobAgainstMetamodel, compileJob, compileOverlay, fixtureBigQuery, loadBigQueryFixture, resolveJob, type ResolvedJob } from '../packages/connectors/src/index';
import { CatalogIngest } from '../apps/worker/src/index';

// S9: DQ Hub rules and column results, DSTORM record classes, retention schedules and legal holds, read through the BigQuery fixture client.
// The tables are an INVENTED schema; the real names come from the data platform team.
const root = join(import.meta.dirname, '..');
const PORT = 54510;
const registry = loadRegistry(join(root, 'metamodel/types'));
const store = new CatalogStore(registry);
const overlay = compileOverlay(readFileSync(join(root, 'sync/overlays/local.yaml'), 'utf8'));
const JOBS = ['dq-hub-rules', 'dq-hub-column-checks', 'dq-hub-table-checks', 'dstorm-record-classes', 'dstorm-retention-schedules', 'dstorm-retained-under', 'dstorm-legal-holds', 'dstorm-held-by'];
const jobText = (n: string) => readFileSync(join(root, `sync/jobs/${n}.yaml`), 'utf8');
const jobOf = (n: string): ResolvedJob => resolveJob(compileJob(jobText(n)), overlay, 'local');
const git = { kind: 'sync', source: 'git-json' } as const;
const CANARY = /CANARY/;

const data = { ...loadBigQueryFixture(join(root, 'sync/fixtures/bigquery/dq-hub.json')), ...loadBigQueryFixture(join(root, 'sync/fixtures/bigquery/dstorm.json')) };
const bq = fixtureBigQuery(data);
const logs: unknown[] = []; const signals: Signal[] = []; const rejected: { key: string; reason: string }[] = []; const forwarded: Signal[] = [];
const exceptions: ExceptionPort = { async raise() { return { id: 'x', created: true }; }, async withdraw() { return true; } };

let server: EmbeddedPostgres; let admin: pg.Client; let cdb: pg.Client; let sdb: pg.Client; let svc: SyncService;
const run = (n: string) => svc.run(sdb, n, 'local');
const edgesOf = async (name: string) => (await admin.query(`select f.qualified_name as f, t.qualified_name as t, e.source, e.attributes from catalog.edge e join catalog.node f on f.id = e.from_id join catalog.node t on t.id = e.to_id
  where e.name = $1 and e.recorded_to is null and e.valid_to is null order by f.qualified_name, t.qualified_name`, [name])).rows as { f: string; t: string; source: string; attributes: Record<string, any> }[];
const node = async (qn: string) => store.getNode(cdb, qn);

beforeAll(async () => {
  server = new EmbeddedPostgres({ databaseDir: mkdtempSync(join(tmpdir(), 'dmc-s9-')), user: 'postgres', password: 'pw', port: PORT, persistent: false });
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
  svc = new SyncService({
    connectors: { bigquery: bigQueryConnector({ clientFor: bq.clientFor, log: (m, f) => logs.push([m, f]) }) },
    signals: { async submit(s) { signals.push(...s); return ingest.submit(s); } }, exceptions, sleep: async () => {},
  });
  for (const [name, dataset] of [['bq-dq-hub', 'dq_hub'], ['bq-dstorm', 'dstorm']]) await svc.upsertConnection(sdb, { name, environment: 'local', type: 'bigquery', config: { project: 'local-fixture', dataset }, secretRef: 'local/none' });
  for (const j of JOBS) await svc.installJob(sdb, { ...jobOf(j), enabled: true });
  // the Git JSON sync (S7) makes the tables and columns; here they are made from what the fixtures cover
  await store.tx(cdb, async () => {
    for (const t of ['shop-oltp/public/orders', 'shop-oltp/public/customers']) await store.applyNode(cdb, { type: 'Table', qualifiedName: t, attributes: { name: t.split('/').pop()! }, writer: git, actor: 'sync/git' });
    for (const c of ['shop-oltp/public/orders/id', 'shop-oltp/public/orders/total', 'shop-oltp/public/customers/first_name']) await store.applyNode(cdb, { type: 'Column', qualifiedName: c, attributes: { name: c.split('/').pop()! }, writer: git, actor: 'sync/git' });
  });
}, 150_000);
afterAll(async () => {
  await sdb?.end(); await cdb?.end(); await admin?.end();
  try { await server?.stop(); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EBUSY') throw e; }
});

describe('S9: the shipped jobs', () => {
  it('S9: resolve against the local overlay, are disabled there, and pass the metamodel check', () => {
    for (const n of JOBS) {
      const j = jobOf(n);
      expect(j.enabled, n).toBe(false);
      expect(checkJobAgainstMetamodel(j.def, registry), n).toEqual([]);
      expect(j.query).toMatch(/`local-fixture\.(dq_hub|dstorm)\./);
    }
  });

  it('S9 SEN-4 PRV-4: every query lists its columns and names no sample or profiled value column (rule 8)', () => {
    for (const n of JOBS) {
      const q = jobOf(n).query;
      expect(q, n).not.toMatch(/\*/);
      expect(q, n).not.toMatch(/sample|profil|example|failing_value|\bvalues?\b/i);
      expect(q, n).toMatch(/^SELECT [a-z_]+/i);
    }
  });
});

describe('S9: DQ Hub rules and results (SEN-4)', () => {
  it('S9 SEN-4: rules become DQRule nodes with the severity mapped to criticality', async () => {
    expect(await run('dq-hub-rules')).toMatchObject({ status: 'succeeded', created: 4, errors: 0 });
    const n = (await node('DQ-0002'))!;
    expect(n.type).toBe('DQRule');
    expect(n.attributes).toMatchObject({ name: 'Order total is positive', dimension: 'validity', criticality: 'high' });
    expect((await node('DQ-0001'))!.attributes.criticality).toBe('critical');
  });

  it('S9 SEN-4: column results attach to the columns the rules cover, as aggregates on the checked_by edge', async () => {
    expect(await run('dq-hub-column-checks')).toMatchObject({ status: 'succeeded', created: 3, errors: 0 });
    const e = await edgesOf('checked_by');
    const col = e.filter((x) => x.f.split('/').length === 4);
    expect(col.map((x) => `${x.f}->${x.t}`)).toEqual(['shop-oltp/public/customers/first_name->DQ-0003', 'shop-oltp/public/orders/id->DQ-0001', 'shop-oltp/public/orders/total->DQ-0002']);
    expect(col.every((x) => x.source === 'dq-hub')).toBe(true);
    expect(col.find((x) => x.t === 'DQ-0002')!.attributes).toEqual({ threshold: 0.99, pass_rate: 0.962, rows_checked: 1200345, rows_failed: 45613, last_run_at: '2026-11-17T02:00:00.000Z', status: 'failed' });
  });

  it('S9 SEN-4: table-level rules and results attach to the table', async () => {
    expect(await run('dq-hub-table-checks')).toMatchObject({ status: 'succeeded', created: 1 });
    const t = (await edgesOf('checked_by')).filter((x) => x.f.split('/').length === 3);
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ f: 'shop-oltp/public/orders', t: 'DQ-0004', attributes: { status: 'passed', pass_rate: 1 } });
  });

  it('S9: a new result updates the edge only; an unchanged rerun writes nothing; a dropped result ends the edge', async () => {
    const rows = data['local-fixture.dq_hub']!.column_results_latest!;
    const outbox = async () => (await admin.query("select count(*)::int as n from catalog.outbox where event_type like 'edge.%'")).rows[0].n as number;
    const before = await outbox();
    expect(await run('dq-hub-column-checks')).toMatchObject({ created: 0, updated: 0, unchanged: 3 });
    expect(await outbox()).toBe(before);
    rows[1]!.pass_rate = 0.995; rows[1]!.run_status = 'PASSED';
    expect(await run('dq-hub-column-checks')).toMatchObject({ updated: 1, created: 0 });
    expect((await edgesOf('checked_by')).find((x) => x.t === 'DQ-0002')!.attributes).toMatchObject({ pass_rate: 0.995, status: 'passed' });
    const dropped = rows.pop()!;
    expect(await run('dq-hub-column-checks')).toMatchObject({ deprecated: 1 });
    expect((await edgesOf('checked_by')).some((x) => x.t === 'DQ-0003')).toBe(false);
    rows.push(dropped);
    await run('dq-hub-column-checks');
    expect((await edgesOf('checked_by')).some((x) => x.t === 'DQ-0003')).toBe(true);
  });

  it('S9: a status the value map does not list is refused and reported, and the run cannot deprecate', async () => {
    const rows = data['local-fixture.dq_hub']!.column_results_latest!;
    rows[0]!.run_status = 'SKIPPED';
    const r = await run('dq-hub-column-checks');
    expect(r.errors).toBe(1); expect(r.complete).toBe(false); expect(r.deprecated).toBe(0);
    expect(r.note).toMatch(/no mapping for status/);
    rows[0]!.run_status = 'PASSED';
  });
});

describe('S9: DSTORM record classes, schedules and legal holds (PRV-4)', () => {
  it('S9 PRV-4: record classes, schedules and the retained_under links', async () => {
    expect(await run('dstorm-record-classes')).toMatchObject({ status: 'succeeded', created: 3 });
    expect(await run('dstorm-retention-schedules')).toMatchObject({ status: 'succeeded', created: 2 });
    expect(await run('dstorm-retained-under')).toMatchObject({ status: 'succeeded', created: 2, errors: 0 });
    expect((await node('dstorm:RC-TRADE'))!.attributes).toMatchObject({ code: 'RC-TRADE', name: 'Trade records' });
    expect((await node('RS-7Y'))!.attributes).toMatchObject({ period: 'P7Y', trigger_event: 'end of trade', disposal_action: 'destroy' });
    const e = await edgesOf('retained_under');
    expect(e.map((x) => `${x.f}->${x.t}`)).toEqual(['dstorm:RC-CUST->RS-6Y', 'dstorm:RC-TRADE->RS-7Y']);
    expect(e.every((x) => x.source === 'dstorm')).toBe(true); // RC-MISC has no schedule and no edge
  });

  it('S9 PRV-4: legal holds are nodes owned by legal-hold-tools and attach to the tables they cover', async () => {
    const lh = await run('dstorm-legal-holds'); expect(lh, JSON.stringify([lh.note, rejected])).toMatchObject({ status: 'succeeded', created: 2, errors: 0 });
    expect(rejected.filter((x) => x.key.startsWith('LegalHold')), String(lh.note)).toEqual([]); expect((await node('LH-2026-014'))!.attributes).toMatchObject({ start: '2026-09-01' });
    expect((await node('LH-2025-003'))!.attributes).toMatchObject({ start: '2025-02-01', end: '2026-03-31' });
    expect(await run('dstorm-held-by')).toMatchObject({ status: 'succeeded', created: 2, errors: 0 });
    const e = await edgesOf('held_by');
    expect(e.map((x) => `${x.f}->${x.t}`)).toEqual(['shop-oltp/public/customers->LH-2026-014', 'shop-oltp/public/orders->LH-2026-014']);
    expect(e.every((x) => x.source === 'legal-hold-tools')).toBe(true);
  });

  it('S9: an edge whose end is not in the catalog is refused and reported, and retried next run (ADR 0024)', async () => {
    data['local-fixture.dstorm']!.legal_hold_scope!.push({ hold_id: 'LH-2026-014', scope_type: 'TABLE', system_name: 'shop-oltp', schema_name: 'public', table_name: 'ghost', added_on: '2026-10-01' });
    const held = jobOf('dstorm-held-by');
    const small = await run('dstorm-held-by');
    expect(small.status).toBe('paused_limit'); // 1 new edge on 2 is above the job's 30% change limit: held for an admin
    await svc.discard(sdb, small.runId, 'test');
    await svc.installJob(sdb, { ...held, enabled: true, def: { ...held.def, limits: undefined } }); // this test is about the refusal, not the limit
    const r = await run('dstorm-held-by');
    expect(r).toMatchObject({ status: 'succeeded', created: 1 });
    expect(r.note).toMatch(/refused by the catalog/);
    expect(rejected.some((x) => x.key.includes('ghost'))).toBe(true);
    data['local-fixture.dstorm']!.legal_hold_scope!.pop();
    await svc.installJob(sdb, { ...held, enabled: true });
  });
});

describe('S9 rule 8: sample values never leave the source', () => {
  it('S9 rule 8: the fixture rows do carry sample-value columns, yet no signal, edge attribute, log line, catalog row or outbox event holds one', async () => {
    expect(JSON.stringify(data)).toMatch(CANARY); // the source tables really hold them
    expect(bq.requests.length).toBeGreaterThan(0);
    for (const r of bq.requests) expect(r.query).not.toMatch(/sample|profil|example/i);
    expect(signals.length).toBeGreaterThan(10);
    const all = async (sql: string) => JSON.stringify((await admin.query(sql)).rows);
    const surfaces: Record<string, string> = {
      signals: JSON.stringify(signals), forwarded: JSON.stringify(forwarded), logs: JSON.stringify(logs), rejected: JSON.stringify(rejected),
      requests: JSON.stringify(bq.requests),
      nodes: await all('select * from catalog.node_version'), edges: await all('select * from catalog.edge'), outbox: await all('select * from catalog.outbox'),
      runs: await all('select * from connectors.run'), state: await all('select * from connectors.record_state'), staging: await all('select * from connectors.staging'),
    };
    for (const [k, text] of Object.entries(surfaces)) { if (k !== 'staging') expect(text.length, k).toBeGreaterThan(2); expect(text, k).not.toMatch(CANARY); }
  });
});
