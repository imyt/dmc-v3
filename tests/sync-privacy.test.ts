import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExceptionPort, Signal } from '../packages/contracts/src/index';
import { loadRegistry, migrateModule, provisionModule } from '../packages/platform/src/index';
import { CatalogStore } from '../packages/catalog/src/index';
import { ActionService } from '../packages/actions/src/index';
import {
  SyncService, bigQueryConnector, checkJobAgainstMetamodel, compileJob, compileOverlay, fixtureBigQuery, loadBigQueryFixture, resolveJob, restConnector,
  type ResolvedJob,
} from '../packages/connectors/src/index';
import { CatalogIngest, Derivations, catalogWritePort, confirmLinked } from '../apps/worker/src/index';

/**
 * S10: classification tool (REST) and DataVisa tool (BigQuery) jobs, over recorded fixtures with an INVENTED source shape.
 * Real endpoints, auth, table and column names must come from the owning teams. Never a real project.
 */
const root = join(import.meta.dirname, '..');
const PORT = 54520;
const registry = loadRegistry(join(root, 'metamodel/types'));
const store = new CatalogStore(registry);
const local = compileOverlay(readFileSync(join(root, 'sync/overlays/local.yaml'), 'utf8'));
const read = (f: string) => readFileSync(join(root, 'sync/jobs', f), 'utf8');
const JOBS = ['classification-tool-classes', 'classification-tool-column-classes', 'datavisa-assessments', 'datavisa-assessment-integrations', 'datavisa-visas'];
const jobOf = (name: string): ResolvedJob => resolveJob(compileJob(read(`${name}.yaml`)), local, 'local');
const json = (f: string) => JSON.parse(readFileSync(join(root, 'sync/fixtures', f), 'utf8')) as { records: Record<string, unknown>[] };

// the data-value traps: they sit in the fixtures in fields no job maps
const TRAPS = ['jane.doe@example.com', '4929 1234 5678 9012', 'Jane Doe', '4111 1111 1111 1111', 'J. Smith'];

let classes = json('classification-tool/classes.json').records;
let assignments = json('classification-tool/column-classifications.json').records;
const bqData = loadBigQueryFixture(join(root, 'sync/fixtures/bigquery/datavisa.json'));
const bq = fixtureBigQuery(bqData);
const logs: unknown[] = [];

let http: Server; let base = '';
let server: EmbeddedPostgres; let admin: pg.Client;
const db: Record<string, pg.Client> = {};
let sdb: pg.Client; let cdb: pg.Client;
let svc: SyncService; let actions: ActionService; let derive: Derivations;
const forwarded: Signal[] = []; const rejected: { key: string; reason: string }[] = []; const sent: Signal[] = [];
const tasks: { route: string; attribute: string; expected: unknown }[] = [];
const exceptions: ExceptionPort = { async raise() { return { id: 'x', created: true }; }, async withdraw() { return true; } };
const git = { kind: 'sync', source: 'git-json' } as const;
const node = (type: string, qn: string, attributes: Record<string, unknown>, source: string) =>
  store.tx(cdb, () => store.applyNode(cdb, { type, qualifiedName: qn, attributes, writer: source === 'user' ? { kind: 'user' } : { kind: 'sync', source }, actor: 't' }));
const link = (name: string, from: string, to: string, source: string, attributes?: Record<string, unknown>) =>
  store.tx(cdb, () => store.link(cdb, { name, fromQn: from, toQn: to, source, actor: 't', ...(attributes ? { attributes } : {}) }));
const run = (name: string) => svc.run(sdb, name, 'local');
const classesOf = async (col: string) => (await store.namedEdgesOf(cdb, col, { name: 'classified_as', direction: 'out' })).map((e) => ({ to: e.toQn, source: e.source }));
const COL = (t: string, c: string, s = 'staging') => `analytics-prod/${s}/${t}/${c}`;
const E = COL('stg_customers', 'email'); const N = COL('stg_customers', 'customer_name'); const A = COL('fct_orders', 'amount', 'marts');
const M = COL('fct_customers', 'email', 'marts'); const P = COL('fct_customers', 'phone', 'marts');

beforeAll(async () => {
  http = createServer((req, res) => {
    const u = new URL(req.url!, 'http://x');
    const rows = u.pathname === '/v1/classes' ? classes : u.pathname === '/v1/column-classifications' ? assignments : undefined;
    if (!rows) { res.writeHead(404); res.end('{}'); return; }
    const o = Number(u.searchParams.get('offset') ?? 0); const l = Number(u.searchParams.get('limit') ?? 100);
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ records: rows.slice(o, o + l) }));
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;

  server = new EmbeddedPostgres({ databaseDir: mkdtempSync(join(tmpdir(), 'dmc-s10-')), user: 'postgres', password: 'pw', port: PORT, persistent: false });
  await server.initialise(); await server.start();
  admin = new pg.Client({ host: 'localhost', port: PORT, user: 'postgres', password: 'pw', database: 'postgres' }); await admin.connect();
  for (const m of ['catalog', 'connectors', 'trust', 'workflow', 'actions']) {
    await provisionModule(admin, m, { password: m });
    await migrateModule(admin, m, join(root, `packages/${m}/migrations`));
    await admin.query(`grant all on all tables in schema ${m} to dmc_${m}`); await admin.query(`grant all on all sequences in schema ${m} to dmc_${m}`);
    db[m] = new pg.Client({ host: 'localhost', port: PORT, user: `dmc_${m}`, password: m, database: 'postgres' }); await db[m]!.connect();
  }
  cdb = db.catalog!; sdb = db.connectors!;

  actions = new ActionService(db.actions!, {
    catalog: catalogWritePort(cdb, store, registry),
    exceptions,
    notify: { async send() {} },
    tasks: { async create(r) { tasks.push({ route: r.route, attribute: r.attribute, expected: r.expected }); return { id: `t${tasks.length}` }; } },
  });
  const ingest = new CatalogIngest({
    store, connect: async () => ({ query: (q: string, p?: unknown[]) => cdb.query(q, p) as never, release() {} }),
    sourceOf: (job) => svc.writerSource(sdb, job),
    next: { async submit(s) { forwarded.push(...s); } },
    onReject: (s, reason) => { rejected.push({ key: s.subjectRef, reason }); },
    linked: confirmLinked(actions, (job) => svc.writerSource(sdb, job)),
  });
  svc = new SyncService({
    connectors: { rest: restConnector({ resolveSecret: async () => 'unused' }), bigquery: bigQueryConnector({ clientFor: bq.clientFor, log: (m, f) => logs.push([m, f]) }) },
    signals: ingest, exceptions, sleep: async () => {},
  });
  await svc.upsertConnection(sdb, { name: 'classification-tool', environment: 'local', type: 'rest', config: { baseUrl: base, allowInsecure: true, recordsPath: 'records', paging: { style: 'offset' } }, secretRef: 'local/none' });
  await svc.upsertConnection(sdb, { name: 'bq-datavisa', environment: 'local', type: 'bigquery', config: { project: 'local-fixture', dataset: 'datavisa' }, secretRef: 'local/none' });
  // the jobs are off in the local overlay; this test turns them on
  const on = { ...local, jobs: { ...local.jobs, ...Object.fromEntries(JOBS.map((j) => [j, { enabled: true }])) } };
  // the shipped change limits (30%) suit a catalogue of thousands, not three fixture rows: the limit itself is covered by the sync tests
  for (const j of JOBS) { const def = compileJob(read(`${j}.yaml`)); delete def.limits; await svc.installJob(sdb, resolveJob(def, on, 'local')); }

  // what the S7 and S6 jobs would have created
  for (const c of [E, N, A, M, P]) await node('Column', c, { name: c.split('/').pop()! }, 'git-json');
  void git;
  await link('derives_from', M, E, 'dbt'); await link('derives_from', P, N, 'dbt'); await link('derives_from', N, E, 'dbt');
  for (const [a, c] of [['app-gb', 'GB'], ['app-hk', 'HK'], ['app-sg', 'SG']] as const) await node('Application', a, { name: a, owner: 'amy', hosting_country: c }, 'servicenow');
  await node('DataCategory', 'gl:pii', { name: 'Personal data' }, 'collibra');
  for (const [i, from, to] of [['int-ok', 'app-gb', 'app-hk'], ['int-noassess', 'app-gb', 'app-hk'], ['int-novisa', 'app-gb', 'app-sg'], ['int-notreq', 'app-gb', 'app-hk']] as const) {
    await node('Integration', i, { status: 'live' }, 'servicenow');
    await link('source_of', from, i, 'servicenow'); await link('target_of', to, i, 'servicenow');
    await node('Dataset', `${i}--data`, { name: `${i} data` }, 'user');
    await link('transfers', i, `${i}--data`, 'dmc'); await link('in_category', `${i}--data`, 'gl:pii', 'dmc');
  }
  derive = new Derivations(store, db as never, { async submit(s) { sent.push(...s); } }, () => new Date('2026-11-18T09:00:00Z'));
}, 180_000);
afterAll(async () => {
  try {
    for (const c of [...Object.values(db), admin]) await c?.end().catch(() => undefined);
  } finally {
    try { await server?.stop(); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EBUSY') throw e; }
  }
  await new Promise((r) => http?.close(r));
});

describe('S10: the jobs follow the metamodel and the overlay', () => {
  it('S10: every job loads, resolves against the local overlay, is disabled there, and its value maps are values of the metamodel enums', () => {
    for (const j of JOBS) {
      const r = jobOf(j);
      expect(r.enabled).toBe(false);
      expect(checkJobAgainstMetamodel(r.def, registry)).toEqual([]);
    }
    expect(jobOf('datavisa-visas').query).toContain('`local-fixture.datavisa.datavisas`');
    expect(local.connections!['classification-tool']).toMatchObject({ type: 'rest', secret: 'local/none' });
    expect(local.connections!['bq-datavisa']).toMatchObject({ type: 'bigquery', secret: 'local/none' });
  });
});

describe('S10: classes on columns (PRV-1, SEN-3)', () => {
  it('S10 PRV-1: the classes arrive as Classification nodes, labels renamed by the value map', async () => {
    const r = await run('classification-tool-classes');
    expect(r).toMatchObject({ status: 'succeeded', complete: true, errors: 0, created: 3 });
    expect((await store.getNode(cdb, 'pii:email'))!.attributes).toEqual({ code: 'email', name: 'Email address', scheme: 'pii', level: 'high' });
    expect((await store.getNode(cdb, 'isr:restricted'))!.attributes).toMatchObject({ scheme: 'isr' });
  });

  it('S10: a class label with no entry in the value map is an error for that record, the run is incomplete and nothing is guessed', async () => {
    classes = [...classes, { class_id: 'x:new', code: 'new', name: 'New', scheme: 'SECRET-LABEL', level: '1' }];
    const r = await run('classification-tool-classes');
    classes = json('classification-tool/classes.json').records;
    expect(r).toMatchObject({ status: 'succeeded', complete: false, errors: 1, deprecated: 0 });
    expect(await store.getNode(cdb, 'x:new')).toBeUndefined();
  });

  it('S10 D3: a classification arriving through the sync confirms the pending change waiting for it, and only a matching one', async () => {
    const ask = (col: string, cls: string) => actions.dispatch({ idempotencyKey: `k-${col}-${cls}`, decisionId: 'd', policyId: 'p-class', subjectRef: `Column:${col}`, effect: { action: 'classify', attribute: 'classified_as', value: cls }, notify: false, route: 'classification-admins', escalateAfter: '10d' });
    const hit = await ask(E, 'pii:email'); const other = await ask(N, 'pii:email'); const hitN = await ask(N, 'pii:name');
    expect(tasks.map((t) => [t.route, t.attribute, t.expected])).toEqual([['classification-admins', 'classified_as', 'pii:email'], ['classification-admins', 'classified_as', 'pii:email'], ['classification-admins', 'classified_as', 'pii:name']]);
    const state = async (id: string) => (await admin.query('select p.state from actions.pending_change p where p.action_id = $1', [id])).rows[0].state;
    expect(await state(hit.id)).toBe('pending');

    const r = await run('classification-tool-column-classes');
    expect(r).toMatchObject({ status: 'succeeded', complete: true, errors: 0, created: 3 });
    expect(await state(hit.id)).toBe('confirmed');
    expect(await state(hitN.id)).toBe('confirmed');
    expect(await state(other.id)).toBe('pending'); // the tool did not give that class to that column
    expect((await admin.query("select 1 from actions.action where id = $1 and status = 'done'", [hit.id])).rowCount).toBe(1);
    expect((await admin.query("select 1 from actions.outbox where event_type = 'action.confirmed'")).rowCount).toBe(2);
  });

  it('S10: the classes are on the columns, owned by the classification tool', async () => {
    expect(await classesOf(E)).toEqual([{ to: 'pii:email', source: 'classification-tool' }]);
    expect(await classesOf(N)).toEqual([{ to: 'pii:name', source: 'classification-tool' }]);
    expect(await classesOf(A)).toEqual([{ to: 'isr:restricted', source: 'classification-tool' }]);
    expect(await classesOf(M)).toEqual([]);
    expect(await run('classification-tool-column-classes')).toMatchObject({ created: 0, updated: 0, unchanged: 3 }); // idempotent
  });

  it('S10 L2: lineage proposes to untouched downstream columns and never overrides a tool-classified one', async () => {
    await derive.classifications();
    const props = (qn: string) => store.getNode(cdb, qn).then((n) => n!.attributes.proposed_classification);
    expect(await props(M)).toEqual(['pii:email']);          // untouched, downstream of the tool-classified E
    expect(await props(N)).toBeUndefined();                 // tool-classified (pii:name): the tool has its say on that scheme
    expect(await props(P)).toEqual(expect.arrayContaining(['pii:name']));  // untouched, downstream of the tool-classified N
    expect(await classesOf(N)).toEqual([{ to: 'pii:name', source: 'classification-tool' }]);
  });

  it('S10 L2: when the tool later classifies a column, its value replaces the proposal and a class a steward accepted in DMC', async () => {
    await link('classified_as', M, 'pii:email', 'dmc', { accepted_by: 'user:sam', accepted_at: '2026-11-17T10:00:00Z' }); // a steward accepted the proposal
    expect(await classesOf(M)).toEqual([{ to: 'pii:email', source: 'dmc' }]);
    assignments = [...assignments, { assignment_id: 'cc-4', column: { database: 'analytics-prod', schema: 'marts', table: 'fct_customers', column: 'email' }, class: { class_id: 'pii:email' }, classified_at: '2026-03-04T08:00:00.000Z' }];
    expect(await run('classification-tool-column-classes')).toMatchObject({ status: 'succeeded', created: 1 });
    expect(await classesOf(M)).toEqual([{ to: 'pii:email', source: 'classification-tool' }]);
    await derive.classifications();
    expect((await store.getNode(cdb, M))!.attributes.proposed_classification).toEqual([]);
  });

  it('S10: a complete run that no longer lists an assignment ends it (the tool declassified the column)', async () => {
    assignments = assignments.filter((a) => a.assignment_id !== 'cc-3');
    expect(await run('classification-tool-column-classes')).toMatchObject({ complete: true, deprecated: 1 });
    expect(await classesOf(A)).toEqual([]);
  });

  it('S10: an edge to a class that is not in the catalog is refused and reported, and sent again next run', async () => {
    rejected.length = 0;
    assignments = [...assignments, { assignment_id: 'cc-9', column: { database: 'analytics-prod', schema: 'staging', table: 'stg_customers', column: 'email' }, class: { class_id: 'pii:unknown' }, classified_at: 't' }];
    const r = await run('classification-tool-column-classes');
    expect(r.note).toMatch(/1 record refused by the catalog/);
    expect(rejected.map((x) => x.reason)[0]).toMatch(/Both ends must exist/);
    assignments = assignments.filter((a) => a.assignment_id !== 'cc-9');
  });
});

describe('S10: assessments and DataVisas, and the cross-border check (PRV-3, PRV-4, L4)', () => {
  it('S10 PRV-3: assessments land on integrations, the current one only; values are renamed by the value map', async () => {
    expect(await run('datavisa-assessments')).toMatchObject({ status: 'succeeded', created: 4, errors: 0 });
    expect(await run('datavisa-visas')).toMatchObject({ status: 'succeeded', created: 2, errors: 0 });
    expect(await run('datavisa-assessment-integrations')).toMatchObject({ status: 'succeeded', created: 3, errors: 0 });
    expect((await store.getNode(cdb, 'as-ok'))!.attributes).toEqual({ outcome: 'datavisa-required', assessed_on: '2026-02-01', review_due: '2027-02-01' });
    expect((await store.getNode(cdb, 'as-old'))!.attributes.outcome).toBe('datavisa-not-required');
    const by = async (i: string) => (await store.namedEdgesOf(cdb, i, { name: 'assessed_by', direction: 'out' })).map((e) => [e.toQn, e.source]);
    expect(await by('int-ok')).toEqual([['as-ok', 'datavisa-tool']]); // not as-old: the view holds only the current one
    expect(await by('int-novisa')).toEqual([['as-novisa', 'datavisa-tool']]);
    expect(await by('int-noassess')).toEqual([]);
    expect((await store.getNode(cdb, 'dv-gb-hk'))!.attributes).toMatchObject({ source_country: 'GB', target_country: 'HK', data_categories: ['Personal data'], valid_from: '2026-01-01', valid_to: '2027-12-31', status: 'active' });
  });

  it('S10 L4: a missing assessment and a missing DataVisa each still raise their exception; a covered transfer raises none', async () => {
    sent.length = 0;
    expect(await derive.crossBorder()).toMatchObject({ transfers: 3 });
    const status = (i: string, to: string) => store.getNode(cdb, `${i}--gb-${to}`).then((n) => n?.attributes);
    expect(await status('int-ok', 'hk')).toMatchObject({ status: 'covered' });
    expect(await status('int-noassess', 'hk')).toMatchObject({ status: 'missing', problem: 'no_assessment' });
    expect(await status('int-novisa', 'sg')).toMatchObject({ status: 'missing', problem: 'no_datavisa' });
    expect(await status('int-notreq', 'hk')).toBeUndefined(); // the assessment says no DataVisa is required
    const bad = sent.filter((s) => (s.asset as { status: string }).status !== 'covered').map((s) => [s.subjectRef, (s.asset as { problem: string }).problem]).sort();
    expect(bad).toEqual([['CrossBorderTransfer:int-noassess--gb-hk', 'no_assessment'], ['CrossBorderTransfer:int-novisa--gb-sg', 'no_datavisa']]);
  });

  it('S10 L4: with complete data (the assessment and the DataVisa now synced) every transfer is covered and none is raised', async () => {
    const t = '2026-03-10T08:00:00.000Z';
    bqData['local-fixture.datavisa']!.assessments!.push({ assessment_id: 'as-noassess', outcome: 'REQUIRED', assessed_on: '2026-03-10', review_due: '2027-03-10', updated_at: t });
    bqData['local-fixture.datavisa']!.current_assessments!.push({ integration: { id: 'int-noassess' }, assessment: { id: 'as-noassess' }, updated_at: t });
    bqData['local-fixture.datavisa']!.datavisas!.push({ visa_id: 'dv-gb-sg', source_country: 'GB', target_country: 'SG', data_categories: ['Personal data'], valid_from: '2026-03-01', status: 'active', updated_at: t });
    expect(await run('datavisa-assessments')).toMatchObject({ created: 1, updated: 0 });   // incremental: only the new row
    expect(await run('datavisa-visas')).toMatchObject({ created: 1 });
    expect(await run('datavisa-assessment-integrations')).toMatchObject({ created: 1, unchanged: 3 });
    sent.length = 0;
    await derive.crossBorder();
    expect(sent.every((s) => (s.asset as { status: string }).status === 'covered')).toBe(true);
    for (const [i, to] of [['int-ok', 'hk'], ['int-noassess', 'hk'], ['int-novisa', 'sg']]) expect((await store.getNode(cdb, `${i}--gb-${to}`))!.attributes.status).toBe('covered');
    expect((await derive.crossBorder()).changed).toBe(0);
  });

  it('S10: a newer assessment replaces the current one on the integration (the old edge ends); an unknown outcome label is refused', async () => {
    const d = bqData['local-fixture.datavisa']!;
    d.assessments!.push({ assessment_id: 'as-ok-2', outcome: 'NOT_REQUIRED', assessed_on: '2026-04-01', updated_at: '2026-04-01T08:00:00.000Z' }, { assessment_id: 'as-bad', outcome: 'MAYBE', assessed_on: '2026-04-01', updated_at: '2026-04-02T08:00:00.000Z' });
    const r = await run('datavisa-assessments');
    expect(r).toMatchObject({ created: 1, errors: 1, complete: false });
    expect(await store.getNode(cdb, 'as-bad')).toBeUndefined();
    d.current_assessments = d.current_assessments!.map((c) => (c.integration as { id: string }).id === 'int-ok' ? { integration: { id: 'int-ok' }, assessment: { id: 'as-ok-2' }, updated_at: '2026-04-01T08:00:00.000Z' } : c);
    expect(await run('datavisa-assessment-integrations')).toMatchObject({ created: 1, deprecated: 1 });
    expect((await store.namedEdgesOf(cdb, 'int-ok', { name: 'assessed_by', direction: 'out' })).map((e) => e.toQn)).toEqual(['as-ok-2']);
  });
});

describe('S10: metadata only (rule 8)', () => {
  it('S10 rule 8: a fixture field that looks like a data value reaches no signal, attribute, log, run note or table', async () => {
    // the traps really are in what the sources serve
    expect(JSON.stringify(assignments)).toContain(TRAPS[0]!);
    expect(JSON.stringify(bqData)).toContain(TRAPS[3]!);
    // every table of every module, as text
    const dump: string[] = [];
    for (const schema of ['catalog', 'connectors', 'actions', 'workflow']) {
      const t = await admin.query<{ table_name: string }>('select table_name from information_schema.tables where table_schema = $1 and table_type = $2', [schema, 'BASE TABLE']);
      for (const { table_name } of t.rows) for (const r of (await admin.query<{ j: string }>(`select row_to_json(x)::text as j from ${schema}."${table_name}" x`)).rows) dump.push(r.j);
    }
    expect(dump.length).toBeGreaterThan(50);
    const all = [dump.join('\n'), JSON.stringify(forwarded), JSON.stringify(sent), JSON.stringify(rejected), JSON.stringify(logs), JSON.stringify(tasks), JSON.stringify(bq.requests)].join('\n');
    for (const trap of TRAPS) expect(all).not.toContain(trap);
    expect(logs.length).toBeGreaterThan(0); // the BigQuery connector did log, with counts only
  });
});
