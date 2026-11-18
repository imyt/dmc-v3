import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Connector, ExceptionPort, ReadPage, Signal, SourceRecord } from '../packages/contracts/src/index';
import { loadRegistry, migrateModule, provisionModule } from '../packages/platform/src/index';
import { CatalogStore } from '../packages/catalog/src/index';
import { SyncService, compileJob, resolveJob } from '../packages/connectors/src/index';
import { CatalogIngest } from '../apps/worker/src/index';

// ADR 0024: a record the catalog refuses is not recorded as seen, so the next run sends it again; value maps on node jobs
const root = join(import.meta.dirname, '..');
const PORT = 54480;
const store = new CatalogStore(loadRegistry(join(root, 'metamodel/types')));
const git = { kind: 'sync', source: 'git-json' } as const;

const EDGES = `
job: retry-edges
connection: fake
schedule: "0 3 * * *"
source: { query: "edges", mode: full }
target:
  type: Column
  source: dbt
  edge: { name: derives_from, qualified_name: "git.{t}/{c}", from: derived, to: upstream }
  map: { job: job }
  on_missing: deprecate
`;
const INCR = EDGES.replace('retry-edges', 'retry-incr').replace('mode: full', 'mode: incremental, cursor: updated').replace('"edges"', '"incr"');
const APPS = `
job: retry-apps
connection: fake
schedule: "0 3 * * *"
source: { query: "apps", mode: full }
target:
  type: Application
  key: id
  source: servicenow
  map: { name: name, owner: owner, hosting_country: country, status: { from: state, values: { Active: live, Sunset: retiring } } }
  on_missing: deprecate
`;

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
const edge = (from: string, to: string, over: Record<string, unknown> = {}): SourceRecord => ({ derived: { t: 't', c: from }, upstream: { t: 't', c: to }, job: 'j', updated: '2026-01-01', ...over });
const qn = (c: string) => `git.t/${c}`;

let server: EmbeddedPostgres; let admin: pg.Client; let cdb: pg.Client; let sdb: pg.Client; let svc: SyncService;
const run = (job: string) => svc.run(sdb, job, 'local');
const edges = async () => (await admin.query(`select f.qualified_name as f, t.qualified_name as t from catalog.edge e join catalog.node f on f.id = e.from_id join catalog.node t on t.id = e.to_id where e.valid_to is null order by 1, 2`)).rows as { f: string; t: string }[];
const state = async (job: string) => (await admin.query('select key, state from connectors.record_state where job = $1 order by key', [job])).rows as { key: string; state: string }[];
const addColumn = (c: string) => store.tx(cdb, () => store.applyNode(cdb, { type: 'Column', qualifiedName: qn(c), attributes: { name: c }, writer: git, actor: 'sync/git' }));

beforeAll(async () => {
  server = new EmbeddedPostgres({ databaseDir: mkdtempSync(join(tmpdir(), 'dmc-retry-')), user: 'postgres', password: 'pw', port: PORT, persistent: false });
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
    onReject: (s: Signal, reason) => { rejected.push({ key: s.subjectRef, reason }); },
  });
  svc = new SyncService({ connectors: { fake: connector }, signals: ingest, exceptions, sleep: async () => {} });
  await svc.upsertConnection(sdb, { name: 'fake', environment: 'local', type: 'fake', config: {}, secretRef: 'x' });
  for (const j of [EDGES, INCR, APPS]) await svc.installJob(sdb, resolveJob(compileJob(j), { connections: { fake: { secret: 'x' } }, jobs: {} }, 'local'));
}, 150_000);
afterAll(async () => {
  try {
    await sdb?.end(); await cdb?.end(); await admin?.end();
  } finally {
    try { await server?.stop(); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EBUSY') throw e; }
  }
});

describe('ADR 0024: a refused record is sent again', () => {
  it('SEN-1: an edge whose end is not in the catalog is refused, not recorded, and sent again unchanged once the node exists', async () => {
    await addColumn('a');
    table['edges'] = [edge('a', 'b')];
    rejected.length = 0;
    const r1 = await run('retry-edges');
    expect(r1).toMatchObject({ status: 'succeeded', complete: true, created: 1 });
    expect(r1.note).toMatch(/1 record refused by the catalog/);
    expect(rejected).toHaveLength(1);
    expect(await edges()).toEqual([]);
    expect(await state('retry-edges')).toEqual([]);

    // still missing: refused again, and reported again
    rejected.length = 0;
    expect(await run('retry-edges')).toMatchObject({ created: 1, unchanged: 0 });
    expect(rejected).toHaveLength(1);

    await addColumn('b');
    rejected.length = 0;
    const r3 = await run('retry-edges');
    expect(r3).toMatchObject({ status: 'succeeded', created: 1, updated: 0 });
    expect(r3.note).toBeUndefined();
    expect(rejected).toHaveLength(0);
    expect(await edges()).toEqual([{ f: qn('a'), t: qn('b') }]);
    expect(await state('retry-edges')).toEqual([{ key: `${qn('a')}->${qn('b')}`, state: 'active' }]);

    // and now it is unchanged
    expect(await run('retry-edges')).toMatchObject({ created: 0, updated: 0, unchanged: 1 });
  });

  it('a refused record is still read, so it does not make the run incomplete or cause a false deprecation; accepted records are recorded', async () => {
    await addColumn('c');
    table['edges'] = [edge('a', 'b'), edge('c', 'zz')]; // c -> zz is refused; a -> b stays
    const r = await run('retry-edges');
    expect(r).toMatchObject({ status: 'succeeded', complete: true, deprecated: 0, created: 1 });
    expect(await edges()).toEqual([{ f: qn('a'), t: qn('b') }]);
    // dropped at the source while still refused: nothing to end, because nothing was recorded
    table['edges'] = [edge('a', 'b')];
    expect(await run('retry-edges')).toMatchObject({ complete: true, deprecated: 0, unchanged: 1 });
  });

  it('a refused change keeps the last accepted state; once the end exists both the new edge and the change go through', async () => {
    table['edges'] = [edge('a', 'b', { job: 'j2' }), edge('c', 'zz')];
    await addColumn('zz');
    const r = await run('retry-edges');
    expect(r).toMatchObject({ created: 1, updated: 1 });
    expect([...new Set((await edges()).map((e) => e.f + '>' + e.t))]).toEqual([qn('a') + '>' + qn('b'), qn('c') + '>' + qn('zz')]); // a re-described edge keeps its history rows
  });

  it('an incremental job keeps its cursor while a record is refused, and moves it once all are accepted', async () => {
    table['incr'] = [edge('a', 'q', { updated: '2026-02-01' })];
    const cursor = async () => (await admin.query("select value from connectors.cursor where job = 'retry-incr'")).rows[0]?.value;
    await run('retry-incr');
    expect(await cursor()).toBeUndefined();
    await addColumn('q');
    expect(await run('retry-incr')).toMatchObject({ created: 1 });
    expect(await cursor()).toBe('2026-02-01');
  });

  it('a node record the metamodel refuses is not recorded either, and is reported on every run until the source fixes it', async () => {
    table['apps'] = [{ id: 'n1', name: 'N1', owner: 'alice', country: 'GB', state: 'Active' }, { id: 'n2', name: { nested: true }, owner: 'alice', country: 'GB', state: 'Active' }]; // n2: a name that is not text
    rejected.length = 0;
    expect(await run('retry-apps')).toMatchObject({ created: 2 });
    expect(rejected.map((x) => x.key)).toEqual(['Application:n2']);
    expect(await state('retry-apps')).toEqual([{ key: 'n1', state: 'active' }]);
    rejected.length = 0;
    await run('retry-apps');
    expect(rejected.map((x) => x.key)).toEqual(['Application:n2']);
    table['apps'] = [{ id: 'n1', name: 'N1', owner: 'alice', country: 'GB', state: 'Active' }, { id: 'n2', name: 'N2', owner: 'alice', country: 'GB', state: 'Active' }];
    rejected.length = 0;
    expect(await run('retry-apps')).toMatchObject({ created: 1, unchanged: 1 });
    expect(rejected).toHaveLength(0);
    expect((await store.getNode(cdb, 'n2'))!.attributes.name).toBe('N2');
  });
});

describe('ADR 0024: value map end to end', () => {
  it('CAT-9: source labels become metamodel enum values; an unmapped label is reported, the run is incomplete, and nothing is deprecated', async () => {
    table['apps'] = [{ id: 'n1', name: 'N1', owner: 'alice', country: 'GB', state: 'Sunset' }, { id: 'n2', name: 'N2', owner: 'alice', country: 'GB', state: 'Active' }, { id: 'n3', name: 'N3', owner: 'alice', country: 'GB', state: 'Weird' }];
    const r = await run('retry-apps');
    expect(r).toMatchObject({ status: 'succeeded', complete: false, errors: 1, updated: 1, deprecated: 0 });
    expect(r.note).toMatch(/1 record not mapped \(value "Weird" of "state" has no mapping for status\)/);
    expect((await store.getNode(cdb, 'n1'))!.attributes.status).toBe('retiring');
    expect(await store.getNode(cdb, 'n3')).toBeUndefined();
    // a record missing from a later read is not deprecated while the run is incomplete
    table['apps'] = [{ id: 'n1', name: 'N1', owner: 'alice', country: 'GB', state: 'Sunset' }, { id: 'n3', name: 'N3', owner: 'alice', country: 'GB', state: 'Weird' }];
    expect(await run('retry-apps')).toMatchObject({ complete: false, deprecated: 0 });
    expect((await store.getNode(cdb, 'n2'))!.lifecycle).not.toBe('deprecated');
  });
});
