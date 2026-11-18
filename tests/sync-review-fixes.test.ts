import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Connector, ExceptionPort, ReadPage, Signal, SignalSink, SourceRecord } from '../packages/contracts/src/index';
import { loadRegistry, migrateModule, provisionModule } from '../packages/platform/src/index';
import { CatalogStore } from '../packages/catalog/src/index';
import { SyncService, compileJob, emailIndex, mapRecord, resolveJob } from '../packages/connectors/src/index';
import { CatalogIngest, PersonRefResolver } from '../apps/worker/src/index';

// Review findings 1 to 6 (ADR 0027): null clears, cursor and limit rules, unlink before link, deprecated persons, source check on sync.missing
const root = join(import.meta.dirname, '..');
const PORT = 54580;
const registry = loadRegistry(join(root, 'metamodel/types'));
const store = new CatalogStore(registry);
const idp = { kind: 'sync', source: 'idp' } as const;
const sn = { kind: 'sync', source: 'servicenow' } as const;

const job = (name: string, body: string, mode = 'full') => `
job: ${name}
connection: fake
schedule: "0 3 * * *"
source: { query: "${name}", mode: ${mode} }
${body}`;
const APPS = job('rf-apps', `target:
  type: Application
  key: id
  source: servicenow
  map: { name: name, owner: owner, delegates: delegates, hosting_country: country }
  on_missing: ignore`);
const SCOPES = job('rf-scopes', `target:
  type: Scope
  key: id
  source: scope-sources
  map: { name: name, owner: owner, kind: kind }
  on_missing: ignore`);
const HOLDS = job('rf-holds', `target:
  type: LegalHold
  key: id
  source: legal-hold-tools
  map: { start: start, end: end }
  on_missing: ignore`);
const INCR = job('rf-incr', `target:
  type: Application
  key: id
  source: servicenow
  map: { name: name, owner: owner, hosting_country: country, status: { from: state, values: { Active: live } } }
  on_missing: ignore`, 'incremental, cursor: updated');
const EDGES = job('rf-edges', `target:
  type: Column
  source: dbt
  edge: { name: derives_from, qualified_name: "git.{t}/{c}", from: derived, to: upstream }
  map: { job: job }
  on_missing: deprecate
limits: { max_changes_pct: 100 }`);
const OWNERS = job('rf-owners', `target:
  type: Application
  source: servicenow
  edge: { name: owned_by, qualified_name: "{id}", from: app, to: owner }
  map: { job: job }
  on_missing: deprecate`);

let table: Record<string, SourceRecord[]> = {};
const connector: Connector = {
  async test() { return { ok: true }; },
  async read(_c, q): Promise<ReadPage> {
    const all = table[q.text] ?? [];
    return { records: all, nextCursor: null, done: true, highWater: q.cursorField ? all.map((r) => String(r[q.cursorField!])).sort().pop() ?? null : null };
  },
};
const rejected: { key: string; reason: string }[] = [];
const exceptions: ExceptionPort = { async raise() { return { id: 'x', created: true }; }, async withdraw() { return true; } };

let server: EmbeddedPostgres; let admin: pg.Client; let cdb: pg.Client; let sdb: pg.Client; let svc: SyncService;
const catalogConn = () => ({ query: (q: string, p?: unknown[]) => cdb.query(q, p) as never, release() {} });
const run = (j: string) => svc.run(sdb, j, 'local');
const node = async (qn: string) => store.getNode(cdb, qn);
const colEdges = async (name: string) => (await admin.query(`select f.qualified_name as f, t.qualified_name as t from catalog.edge e join catalog.node f on f.id = e.from_id join catalog.node t on t.id = e.to_id where e.name = $1 and e.valid_to is null and e.recorded_to is null order by 1, 2`, [name])).rows as { f: string; t: string }[];
const cursor = async (j: string) => (await admin.query('select value from connectors.cursor where job = $1', [j])).rows[0]?.value as string | undefined;
const person = (id: string, email: string) => store.tx(cdb, () => store.applyNode(cdb, { type: 'Person', qualifiedName: id, attributes: { email }, writer: idp, actor: 'idp' }));
const addColumn = (c: string) => store.tx(cdb, () => store.applyNode(cdb, { type: 'Column', qualifiedName: `git.t/${c}`, attributes: { name: c }, writer: { kind: 'sync', source: 'git-json' }, actor: 'sync/git' }));
const edge = (from: string, to: string): SourceRecord => ({ derived: { t: 't', c: from }, upstream: { t: 't', c: to }, job: 'j' });

beforeAll(async () => {
  server = new EmbeddedPostgres({ databaseDir: mkdtempSync(join(tmpdir(), 'dmc-rfix-')), user: 'postgres', password: 'pw', port: PORT, persistent: false });
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
  const onReject = (s: Signal, reason: string) => { rejected.push({ key: s.subjectRef, reason }); };
  const ingest = new CatalogIngest({ store, connect: async () => catalogConn(), sourceOf: (j) => svc.writerSource(sdb, j), onReject });
  const front = new PersonRefResolver({ store, registry, connect: async () => catalogConn(), next: ingest, onReject });
  svc = new SyncService({ connectors: { fake: connector }, signals: front, exceptions, sleep: async () => {} });
  await svc.upsertConnection(sdb, { name: 'fake', environment: 'local', type: 'fake', config: {}, secretRef: 'x' });
  for (const j of [APPS, SCOPES, HOLDS, INCR, EDGES, OWNERS]) await svc.installJob(sdb, resolveJob(compileJob(j), { connections: { fake: { secret: 'x' } }, jobs: {} }, 'local'));
  await person('00000001', 'one@example.org'); await person('00000002', 'two@example.org'); await person('00000003', 'three@example.org');
}, 150_000);
afterAll(async () => {
  try {
    await sdb?.end(); await cdb?.end(); await admin?.end();
  } finally {
    try { await server?.stop(); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EBUSY') throw e; }
  }
});

describe('finding 1: a value the source clears is cleared in the catalog', () => {
  it('F1 mapping: a NULL is an explicit null in the record and its hash; a field the record lacks is still skipped; a blank string is a clear too', () => {
    const t = compileJob(APPS).target;
    const absent = mapRecord({ id: 'x', name: 'n' }, t) as { attrs: Record<string, unknown>; hash: string };
    const nul = mapRecord({ id: 'x', name: 'n', delegates: null }, t) as { attrs: Record<string, unknown>; hash: string };
    expect(absent.attrs).toEqual({ name: 'n' });
    expect(nul.attrs).toEqual({ name: 'n', delegates: null });
    expect(nul.hash).not.toBe(absent.hash);
    expect((mapRecord({ id: 'x', name: 'n', owner: '  ' }, t) as { attrs: Record<string, unknown> }).attrs).toEqual({ name: 'n', owner: null });
  });

  it('F1 a delegate removed in ServiceNow (delegates NULL) no longer appears in the catalog', async () => {
    table['rf-apps'] = [{ id: 'app1', name: 'A1', owner: '00000001', delegates: ['00000002'], country: 'GB' }];
    expect(await run('rf-apps')).toMatchObject({ status: 'succeeded', created: 1 });
    expect((await node('app1'))!.attributes.delegates).toEqual(['00000002']);
    table['rf-apps'] = [{ id: 'app1', name: 'A1', owner: '00000001', delegates: null, country: 'GB' }];
    expect(await run('rf-apps')).toMatchObject({ status: 'succeeded', updated: 1 });
    const n = (await node('app1'))!;
    expect(n.attributes.delegates).toBeUndefined();
    expect(n.provenance.delegates).toBeUndefined();
    expect(n.attributes.owner).toBe('00000001');
  });

  it('F1 a scope whose owner is blanked (NULL, or an empty string) loses its owner', async () => {
    table['rf-scopes'] = [{ id: 'sc1', name: 'S1', owner: '00000001', kind: 'report' }, { id: 'sc2', name: 'S2', owner: '00000002', kind: 'report' }];
    await run('rf-scopes');
    expect((await node('sc1'))!.attributes.owner).toBe('00000001');
    table['rf-scopes'] = [{ id: 'sc1', name: 'S1', owner: null, kind: 'report' }, { id: 'sc2', name: 'S2', owner: '', kind: 'report' }];
    expect(await run('rf-scopes')).toMatchObject({ status: 'succeeded', updated: 2 });
    expect((await node('sc1'))!.attributes.owner).toBeUndefined();
    expect((await node('sc2'))!.attributes.owner).toBeUndefined();
  });

  it('F1 a NULL on a never-set optional attribute is a no-op (an open legal hold has no end date); it can be set and cleared later', async () => {
    table['rf-holds'] = [{ id: 'h1', start: '2026-01-01', end: null }];
    rejected.length = 0;
    expect(await run('rf-holds')).toMatchObject({ status: 'succeeded', created: 1 });
    expect(rejected).toEqual([]);
    expect((await node('h1'))!.attributes).toEqual({ start: '2026-01-01' });
    const versions = async () => (await admin.query('select count(*)::int as n from catalog.node_version')).rows[0].n as number;
    // a second NULL-carrying record that changes nothing in the catalog writes nothing
    await store.tx(cdb, () => store.applyNode(cdb, { type: 'LegalHold', qualifiedName: 'h1', attributes: { end: null }, writer: { kind: 'sync', source: 'legal-hold-tools' }, actor: 'x' }));
    const v = await versions();
    await store.tx(cdb, () => store.applyNode(cdb, { type: 'LegalHold', qualifiedName: 'h1', attributes: { end: null }, writer: { kind: 'sync', source: 'legal-hold-tools' }, actor: 'x' }));
    expect(await versions()).toBe(v);
    table['rf-holds'] = [{ id: 'h1', start: '2026-01-01', end: '2026-02-01' }];
    await run('rf-holds');
    expect((await node('h1'))!.attributes.end).toBe('2026-02-01');
    table['rf-holds'] = [{ id: 'h1', start: '2026-01-01', end: null }];
    await run('rf-holds');
    expect((await node('h1'))!.attributes.end).toBeUndefined();
  });

  it('F1 a NULL on a required attribute refuses the record (create and update); the node keeps its value', async () => {
    table['rf-apps'] = [{ id: 'app1', name: 'A1', owner: null, delegates: null, country: 'GB' }, { id: 'app9', name: 'A9', owner: null, country: 'GB' }];
    rejected.length = 0;
    const r = await run('rf-apps');
    expect(r.note).toMatch(/2 records refused/);
    expect(rejected.map((x) => x.key).sort()).toEqual(['Application:app1', 'Application:app9']);
    expect((await node('app1'))!.attributes.owner).toBe('00000001');
    expect(await node('app9')).toBeUndefined();
  });
});

describe('finding 2: a row that fails to map is not skipped past by the cursor', () => {
  it('F2 an incremental job keeps its cursor while a record is not mapped, and moves it once the row maps', async () => {
    table['rf-incr'] = [{ id: 'i1', name: 'I1', owner: '00000001', country: 'GB', state: 'Active', updated: '2026-01-01' }, { id: 'i2', name: 'I2', owner: '00000001', country: 'GB', state: 'Weird', updated: '2026-03-01' }];
    expect(await run('rf-incr')).toMatchObject({ status: 'succeeded', created: 1, errors: 1 });
    expect(await cursor('rf-incr')).toBeUndefined();
    table['rf-incr'] = [{ id: 'i1', name: 'I1', owner: '00000001', country: 'GB', state: 'Active', updated: '2026-01-01' }, { id: 'i2', name: 'I2', owner: '00000001', country: 'GB', state: 'Active', updated: '2026-03-01' }];
    expect(await run('rf-incr')).toMatchObject({ created: 1, errors: 0 });
    expect(await cursor('rf-incr')).toBe('2026-03-01');
  });
});

describe('finding 3: refused records are not counted as changes again', () => {
  it('F3 a first load with refused edges does not pause the next run; a real mass change still does', async () => {
    for (const c of ['c0', 'c1', 'c2', 'c3', 'c4', 'c5']) await addColumn(c);
    const ok = [edge('c0', 'c1'), edge('c1', 'c2'), edge('c2', 'c3'), edge('c3', 'c4'), edge('c4', 'c5')];
    const bad = ['x1', 'x2', 'x3', 'x4', 'x5', 'x6'].map((x) => edge('c0', x));
    table['rf-edges'] = [...ok, ...bad];
    expect(await run('rf-edges')).toMatchObject({ status: 'succeeded', created: 11 }); // first load is never limited
    expect(await colEdges('derives_from')).toHaveLength(5);
    // 6 refused / 5 active would be 120% of a 100% limit
    const again = await run('rf-edges');
    expect(again).toMatchObject({ status: 'succeeded' });
    expect(again.note).toMatch(/6 records refused/);
    // six real new edges on 5 active are still a mass change
    table['rf-edges'] = [...ok, ...bad, edge('c1', 'c0'), edge('c2', 'c0'), edge('c3', 'c0'), edge('c4', 'c0'), edge('c5', 'c0'), edge('c2', 'c1')];
    const big = await run('rf-edges');
    expect(big.status).toBe('paused_limit');
    await svc.discard(sdb, big.runId, 'test');
  });
});

describe('finding 4: an owner transfer on a many-to-one edge takes one run', () => {
  it('F4 unlink of the old owner goes before the link of the new one', async () => {
    await store.tx(cdb, () => store.applyNode(cdb, { type: 'Application', qualifiedName: 'own1', attributes: { name: 'O', owner: '00000001', hosting_country: 'GB' }, writer: sn, actor: 'x' }));
    table['rf-owners'] = [{ app: { id: 'own1' }, owner: { id: '00000001' } }];
    rejected.length = 0;
    expect(await run('rf-owners')).toMatchObject({ status: 'succeeded', created: 1 });
    expect(await colEdges('owned_by')).toEqual([{ f: 'own1', t: '00000001' }]);
    table['rf-owners'] = [{ app: { id: 'own1' }, owner: { id: '00000002' } }];
    const r = await run('rf-owners');
    expect(r).toMatchObject({ status: 'succeeded', created: 1, deprecated: 1 });
    expect(r.note).toBeUndefined();
    expect(rejected).toEqual([]);
    expect(await colEdges('owned_by')).toEqual([{ f: 'own1', t: '00000002' }]);
  });
});

describe('finding 5: a deprecated Person does not block or confuse email lookups', () => {
  const capture = () => { const got: Signal[] = []; const next: SignalSink = { async submit(s) { got.push(...s); } }; return { got, next }; };
  const resolver = (next: SignalSink) => new PersonRefResolver({ store, registry, connect: async () => catalogConn(), next });
  const upsert = (type: string, key: string, asset: Record<string, unknown>): Signal => ({ source: 'j', key: `${key}@h`, kind: 'sync.upsert', subjectRef: `${type}:${key}`, subjectType: type, asset, actor: 'a' });

  it('F5 emailIndex: active holders win, a deprecated holder is the fallback, ambiguity is per group', () => {
    const idx = emailIndex([{ qualifiedName: '1', email: 'a@x', lifecycle: 'deprecated' }, { qualifiedName: '2', email: 'a@x', lifecycle: 'discovered' }, { qualifiedName: '3', email: 'b@x', lifecycle: 'deprecated' }, { qualifiedName: '4', email: 'c@x', lifecycle: 'deprecated' }, { qualifiedName: '5', email: 'c@x', lifecycle: 'deprecated' }]);
    expect(idx.get('a@x')).toBe('2'); expect(idx.get('b@x')).toBe('3'); expect(idx.get('c@x')).toBeNull();
  });

  it('F5 a new hire may reuse the email of a leaver (deprecated Person); an active holder still blocks', async () => {
    await person('00000010', 'leaver@example.org'); await person('00000011', 'active@example.org');
    await store.tx(cdb, () => store.setLifecycle(cdb, '00000010', 'deprecated', 'idp'));
    const { got, next } = capture();
    const r = await resolver(next).submit([upsert('Person', '00000012', { email: 'leaver@example.org' }), upsert('Person', '00000013', { email: 'active@example.org' })]);
    expect(r.rejected).toEqual(['00000013@h']);
    expect(got.map((s) => s.subjectRef)).toEqual(['Person:00000012']);
  });

  it('F5 an email resolves to the active Person; to a deprecated one only when no active one matches', async () => {
    await person('00000020', 'dup@example.org'); await person('00000021', 'gone@example.org');
    await store.tx(cdb, () => store.setLifecycle(cdb, '00000020', 'deprecated', 'idp'));
    await store.tx(cdb, () => store.setLifecycle(cdb, '00000021', 'deprecated', 'idp'));
    await person('00000022', 'dup@example.org');
    const { got, next } = capture();
    const r = await resolver(next).submit([upsert('Scope', 's-a', { name: 'A', kind: 'report', owner: 'dup@example.org' }), upsert('Scope', 's-b', { name: 'B', kind: 'report', owner: 'gone@example.org' })]);
    expect(r.rejected).toBeUndefined();
    expect(got.map((s) => s.asset.owner)).toEqual(['00000022', '00000021']);
  });
});

describe('finding 6: sync.missing respects the source of truth', () => {
  it('F6 a Collibra job does not deprecate a node of a type switched to dmc; a type still owned by Collibra is deprecated', async () => {
    const col = { kind: 'sync', source: 'collibra' } as const;
    await store.tx(cdb, () => store.applyNode(cdb, { type: 'DataDomain', qualifiedName: 'dd-a', attributes: { name: 'A' }, writer: col, actor: 'x' }));
    const missing: Signal = { source: 'collibra-data-domains', key: 'dd-a@missing:r', kind: 'sync.missing', subjectRef: 'DataDomain:dd-a', subjectType: 'DataDomain', asset: { lifecycle: 'deprecated' }, actor: 'a' };
    const reasons: string[] = [];
    const mk = (s: CatalogStore) => new CatalogIngest({ store: s, connect: async () => catalogConn(), sourceOf: async () => 'collibra', onReject: (_s, why) => { reasons.push(why); } });
    const switched = new CatalogStore(registry.withSourceOfTruth({ DataDomain: 'dmc' }));
    expect(await mk(switched).submit([missing])).toEqual({ rejected: ['dd-a@missing:r'] });
    expect(reasons[0]).toMatch(/maintained in DMC now/);
    expect((await node('dd-a'))!.lifecycle).toBe('discovered');
    expect(await mk(store).submit([missing])).toEqual({});
    expect((await node('dd-a'))!.lifecycle).toBe('deprecated');
  });
});
