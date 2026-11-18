import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRegistry, migrateModule, provisionModule } from '../packages/platform/src/index';
import { CatalogStore } from '../packages/catalog/src/index';
import { compileJob, compileOverlay, resolveJob } from '../packages/connectors/src/index';
import { seed } from '../scripts/seed-lib';

const root = join(import.meta.dirname, '..');
const store = new CatalogStore(loadRegistry(join(root, 'metamodel/types')));
let server: EmbeddedPostgres; let admin: pg.Client; let cat: pg.Client;

beforeAll(async () => {
  server = new EmbeddedPostgres({ databaseDir: mkdtempSync(join(tmpdir(), 'dmc-seed-')), user: 'postgres', password: 'pw', port: 54381, persistent: false });
  await server.initialise(); await server.start();
  admin = new pg.Client({ host: 'localhost', port: 54381, user: 'postgres', password: 'pw', database: 'postgres' }); await admin.connect();
  await provisionModule(admin, 'catalog', { password: 'catalog' }); await migrateModule(admin, 'catalog', join(root, 'packages/catalog/migrations'));
  await admin.query('grant all on all tables in schema catalog to dmc_catalog'); await admin.query('grant all on all sequences in schema catalog to dmc_catalog');
  cat = new pg.Client({ host: 'localhost', port: 54381, user: 'dmc_catalog', password: 'catalog', database: 'postgres' }); await cat.connect();
}, 120_000);
afterAll(async () => { try { await cat?.end(); await admin?.end(); } finally { await server?.stop(); } });

describe('synthetic seed', () => {
  it('loads through the normal write path and re-running changes nothing', async () => {
    const r = await seed(store, cat, root);
    expect(r.nodes).toBeGreaterThan(50);
    const count = async () => Number((await cat.query('select (select count(*) from catalog.node) n, (select count(*) from catalog.edge) e')).rows[0].n) * 1e6 + Number((await cat.query('select count(*) e from catalog.edge')).rows[0].e);
    const before = await count();
    await seed(store, cat, root);
    expect(await count()).toBe(before);
    const sc = await store.getNode(cat, 'scope-pra110');
    expect(sc?.attributes).toMatchObject({ status: 'submitted', required_tier: 'gold', owner: '43000004' });
    expect((await store.getNode(cat, 'app-payments-hub'))?.attributes.delegates).toEqual(['43000003']);
  });

  it('the local sync job and overlay resolve against the fixtures', () => {
    const job = compileJob(readFileSync(join(root, 'sync/jobs/servicenow-applications.yaml'), 'utf8'));
    const overlay = compileOverlay(readFileSync(join(root, 'sync/overlays/local.yaml'), 'utf8'));
    expect(resolveJob(job, overlay, 'local').connection).toBe('mock-servicenow');
  });

  it('the mock login users are well formed', () => {
    const users = JSON.parse(readFileSync(join(root, 'config/local-users.json'), 'utf8')) as { staffID: string; displayName: string; groups: string[] }[];
    expect(new Set(users.map((u) => u.staffID)).size).toBe(users.length);
    expect(users.every((u) => u.staffID && u.displayName && Array.isArray(u.groups))).toBe(true);
  });
});

describe('node versions written in the same millisecond', () => {
  it('seed flake: three writes to one node at one instant are three versions, not a duplicate node_version key', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-01T10:00:00.000Z'));
    try {
      const w = { kind: 'user' } as const;
      for (const name of ['One', 'Two', 'Three']) await store.tx(cat, () => store.applyNode(cat, { type: 'Regulation', qualifiedName: 'reg:same-ms', attributes: { code: 'SMS', name }, writer: w, actor: 'seed' }));
    } finally { vi.useRealTimers(); }
    const rows = (await cat.query(`select v.attributes->>'name' n, (v.recorded_to is null and v.valid_to is null) cur from catalog.node_version v join catalog.node x on x.id = v.node_id where x.qualified_name = 'reg:same-ms' order by v.recorded_from, v.valid_to nulls last`)).rows;
    expect(rows.filter((r) => r.cur).map((r) => r.n)).toEqual(['Three']);
    expect((await store.getNode(cat, 'reg:same-ms'))?.attributes.name).toBe('Three');
    expect(rows.length).toBe(5); // current + (closed copy + superseded row) for each of the two changes
  });
});
