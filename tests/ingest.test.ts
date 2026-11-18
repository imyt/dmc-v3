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

const root = join(import.meta.dirname, '..');
const store = new CatalogStore(loadRegistry(join(root, 'metamodel/types')));
let server: EmbeddedPostgres; let admin: pg.Client; let cdb: pg.Client; let pool: pg.Pool;

const JOB = `
job: apps
connection: snow
schedule: "0 3 * * *"
source: { query: "select * from apps", mode: full, page_size: 10 }
target:
  type: Application
  key: sys_id
  source: servicenow
  map: { name: name, owner: owner, hosting_country: country, status: status }
  on_missing: deprecate
`;
let table: SourceRecord[] = [];
const connector: Connector = {
  async test() { return { ok: true }; },
  async read(): Promise<ReadPage> { return { records: table, nextCursor: null, done: true, highWater: null }; },
};
const rejected: { key: string; reason: string }[] = [];
const forwarded: Signal[] = [];
const exceptions: ExceptionPort = { async raise() { return { id: 'x', created: true }; }, async withdraw() { return true; } };
const rec = (id: string, over: Record<string, unknown> = {}): SourceRecord => ({ sys_id: id, name: `App ${id}`, owner: 'alice', country: 'GB', status: 'live', ...over });
const lifecycle = async (qn: string) => (await store.getNode(cdb, qn))?.lifecycle;

let svc: SyncService;
beforeAll(async () => {
  server = new EmbeddedPostgres({ databaseDir: mkdtempSync(join(tmpdir(), 'dmc-ing-')), user: 'postgres', password: 'pw', port: 54342, persistent: false });
  await server.initialise(); await server.start();
  admin = new pg.Client({ host: 'localhost', port: 54342, user: 'postgres', password: 'pw', database: 'postgres' }); await admin.connect();
  for (const [m, pw] of [['catalog', 'cat'], ['connectors', 'con']] as const) {
    await provisionModule(admin, m, { password: pw });
    await migrateModule(admin, m, join(root, `packages/${m}/migrations`));
    await admin.query(`grant all on all tables in schema ${m} to dmc_${m}`);
    await admin.query(`grant all on all sequences in schema ${m} to dmc_${m}`);
  }
  cdb = new pg.Client({ host: 'localhost', port: 54342, user: 'dmc_catalog', password: 'cat', database: 'postgres' }); await cdb.connect();
  pool = new pg.Pool({ host: 'localhost', port: 54342, user: 'dmc_catalog', password: 'cat', database: 'postgres', max: 2 });
  const sdb = new pg.Client({ host: 'localhost', port: 54342, user: 'dmc_connectors', password: 'con', database: 'postgres' }); await sdb.connect();
  const ingest = new CatalogIngest({
    store, connect: async () => { const x = await pool.connect(); return { query: (q: string, p?: unknown[]) => x.query(q, p) as never, release: () => x.release() }; },
    sourceOf: (job) => svc.writerSource(sdb, job),
    next: { async submit(s) { forwarded.push(...s); } },
    onReject: (s, reason) => { rejected.push({ key: s.subjectRef, reason }); },
  });
  svc = new SyncService({ connectors: { fake: connector }, signals: ingest, exceptions, sleep: async () => {} });
  await svc.upsertConnection(sdb, { name: 'snow', environment: 'local', type: 'fake', config: {}, secretRef: 'x' });
  await svc.installJob(sdb, resolveJob(compileJob(JOB), { connections: { snow: { secret: 'x' } }, jobs: {} }, 'local'));
  (globalThis as any).__sdb = sdb;
}, 150_000);
afterAll(async () => { try { await (globalThis as any).__sdb?.end(); await cdb?.end(); await pool?.end(); await admin?.end(); } finally { await server?.stop(); } });
const run = () => svc.run((globalThis as any).__sdb, 'apps', 'local');

describe('S2: sync to catalog', () => {
  it('a run creates nodes from the source, owned by the source, and passes the signals on', async () => {
    table = [rec('a1'), rec('a2')];
    await run();
    const n = await store.getNode(cdb, 'a1');
    expect(n).toMatchObject({ type: 'Application', lifecycle: 'discovered', attributes: { name: 'App a1', owner: 'alice', status: 'live' } });
    expect(n!.provenance.name!.by).toBe('servicenow');
    expect(forwarded.map((s) => s.subjectRef).sort()).toEqual(['Application:a1', 'Application:a2']);
  });

  it('a changed record updates the node and keeps history; an unchanged run writes nothing', async () => {
    table = [rec('a1', { status: 'retiring' }), rec('a2')];
    await run();
    expect((await store.getNode(cdb, 'a1'))!.attributes.status).toBe('retiring');
    expect((await store.history(cdb, 'a1')).length).toBeGreaterThanOrEqual(2);
    const before = (await store.history(cdb, 'a2')).length;
    await run();
    expect((await store.history(cdb, 'a2')).length).toBe(before);
  });

  it('a record that disappears from a full run is deprecated, and comes back as discovered when seen again', async () => {
    table = [rec('a1', { status: 'retiring' })];
    await run();
    expect(await lifecycle('a2')).toBe('deprecated');
    table = [rec('a1', { status: 'retiring' }), rec('a2')];
    await run();
    expect(await lifecycle('a2')).toBe('discovered');
  });

  it('a record the metamodel refuses is skipped and reported, and the rest still go through', async () => {
    table = [rec('a1', { status: 'retiring' }), rec('a2'), rec('bad', { country: 'XX not a country' }), rec('a3')];
    await run();
    expect(rejected.map((r) => r.key)).toEqual(['Application:bad']);
    expect(await store.getNode(cdb, 'bad')).toBeUndefined();
    expect(await lifecycle('a3')).toBe('discovered');
  });
});
