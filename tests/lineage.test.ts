import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRegistry, migrateModule, provisionModule } from '../packages/platform/src/index';
import { CatalogLineage, CatalogStore } from '../packages/catalog/src/index';

let server: EmbeddedPostgres; let admin: pg.Client; let db: pg.Client;
const store = new CatalogStore(loadRegistry(join(import.meta.dirname, '../metamodel/types')));
const git = { kind: 'sync', source: 'git-json' } as const;
let lineage: CatalogLineage;

beforeAll(async () => {
  server = new EmbeddedPostgres({ databaseDir: mkdtempSync(join(tmpdir(), 'dmc-lin-')), user: 'postgres', password: 'pw', port: 54346, persistent: false });
  await server.initialise(); await server.start();
  admin = new pg.Client({ host: 'localhost', port: 54346, user: 'postgres', password: 'pw', database: 'postgres' }); await admin.connect();
  await provisionModule(admin, 'catalog', { password: 'cat' });
  await migrateModule(admin, 'catalog', join(import.meta.dirname, '../packages/catalog/migrations'));
  await admin.query('grant all on all tables in schema catalog to dmc_catalog');
  await admin.query('grant all on all sequences in schema catalog to dmc_catalog');
  db = new pg.Client({ host: 'localhost', port: 54346, user: 'dmc_catalog', password: 'cat', database: 'postgres' }); await db.connect();
  lineage = new CatalogLineage(db);
  // raw → stg → mart, with tables containing columns
  await store.tx(db, async () => {
    for (const t of ['raw.t', 'stg.t', 'mart.t']) await store.applyNode(db, { type: 'Table', qualifiedName: t, attributes: { name: t }, writer: git, actor: 'sync/git' });
    for (const c of ['raw.t.a', 'raw.t.b', 'stg.t.a', 'mart.t.a', 'mart.t.sum']) {
      await store.applyNode(db, { type: 'Column', qualifiedName: c, attributes: { name: c.split('.').pop()! }, writer: git, actor: 'sync/git' });
      await store.link(db, { name: 'contains', fromQn: c.split('.').slice(0, 2).join('.'), toQn: c, source: 'git-json', actor: 'sync/git' });
    }
    const dep = (from: string, to: string, attributes: Record<string, unknown>) => store.link(db, { name: 'derives_from', fromQn: from, toQn: to, source: 'dbt', actor: 'sync/dbt', attributes });
    await dep('stg.t.a', 'raw.t.a', { job: 'stg_build', confidence: 1 });
    await dep('mart.t.a', 'stg.t.a', { job: 'mart_build', confidence: 0.6 });
    await dep('mart.t.sum', 'stg.t.a', { job: 'mart_build' });
    await dep('mart.t.sum', 'raw.t.b', { job: 'mart_build', confidence: 0.9 });
  });
}, 120_000);
afterAll(async () => { try { await db?.end(); await admin?.end(); } finally { await server?.stop(); } });

const names = (r: { nodes: { qualifiedName: string }[] } | undefined) => r!.nodes.map((n) => n.qualifiedName).sort();

describe('L1: lineage store', () => {
  it('downstream is the impact of a change: everything built from a column, with depth and table', async () => {
    const r = await lineage.traverse('raw.t.a', { direction: 'downstream' });
    expect(names(r)).toEqual(['mart.t.a', 'mart.t.sum', 'raw.t.a', 'stg.t.a']);
    expect(r!.nodes.find((n) => n.qualifiedName === 'mart.t.sum')).toMatchObject({ depth: 2, container: 'mart.t', type: 'Column' });
    expect(r!.edges.find((e) => e.from === 'mart.t.a')).toEqual({ from: 'mart.t.a', to: 'stg.t.a', source: 'dbt', job: 'mart_build', confidence: 0.6 });
    expect(r!.truncated).toEqual({ depth: false, nodes: false });
  });

  it('upstream is where a column comes from', async () => {
    expect(names(await lineage.traverse('mart.t.sum', { direction: 'upstream' }))).toEqual(['mart.t.sum', 'raw.t.a', 'raw.t.b', 'stg.t.a']);
  });

  it('caps depth and says so; caps node count and says so', async () => {
    const d1 = await lineage.traverse('raw.t.a', { direction: 'downstream', depth: 1 });
    expect(names(d1)).toEqual(['raw.t.a', 'stg.t.a']);
    expect(d1!.truncated).toEqual({ depth: true, nodes: false });
    const n2 = await lineage.traverse('raw.t.a', { direction: 'downstream', maxNodes: 2 });
    expect(n2!.nodes).toHaveLength(2);
    expect(n2!.truncated.nodes).toBe(true);
    await expect(lineage.traverse('raw.t.a', { direction: 'downstream', depth: 99 })).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('ignores edges the source is less sure of than the threshold (no confidence counts as sure)', async () => {
    expect(names(await lineage.traverse('stg.t.a', { direction: 'downstream', minConfidence: 0.8 }))).toEqual(['mart.t.sum', 'stg.t.a']);
    expect(names(await lineage.traverse('raw.t.b', { direction: 'downstream', minConfidence: 0.95 }))).toEqual(['raw.t.b']);
  });

  it('an ended edge is no longer walked; a changed description of an edge replaces it and keeps history', async () => {
    await store.tx(db, () => store.link(db, { name: 'derives_from', fromQn: 'mart.t.a', toQn: 'stg.t.a', source: 'dbt', actor: 'sync/dbt', attributes: { job: 'mart_build', confidence: 0.99 } }));
    expect((await lineage.traverse('mart.t.a', { direction: 'upstream', minConfidence: 0.9 }))!.nodes.map((n) => n.qualifiedName)).toContain('stg.t.a');
    expect((await admin.query("select count(*)::int as n from catalog.edge where name = 'derives_from' and from_id = (select id from catalog.node where qualified_name='mart.t.a')")).rows[0].n).toBe(2);
    await store.tx(db, () => store.unlink(db, { name: 'derives_from', fromQn: 'mart.t.sum', toQn: 'raw.t.b', actor: 'sync/dbt' }));
    expect(names(await lineage.traverse('raw.t.b', { direction: 'downstream' }))).toEqual(['raw.t.b']);
  });

  it('a cycle ends at the depth cap and a missing node is undefined', async () => {
    await store.tx(db, () => store.link(db, { name: 'derives_from', fromQn: 'raw.t.a', toQn: 'mart.t.a', source: 'declared', actor: 'u' }));
    const r = await lineage.traverse('raw.t.a', { direction: 'downstream', depth: 20 });
    expect(names(r)).toEqual(['mart.t.a', 'mart.t.sum', 'raw.t.a', 'stg.t.a']);
    expect(await lineage.traverse('nope', { direction: 'upstream' })).toBeUndefined();
  });

  it('impact query at depth 10 over 20,000 columns answers in well under 2 seconds', async () => {
    // 10 layers of 2,000 columns; each derives from four in the layer below, so a change near the bottom reaches almost every column above
    const L = 10; const W = 2000;
    await admin.query(`insert into catalog.node (type, qualified_name) select 'Column', 'perf.l' || l || '.c' || c from generate_series(0, ${L - 1}) l, generate_series(0, ${W - 1}) c`);
    await admin.query(`insert into catalog.edge (name, from_id, to_id, lifecycle, source, valid_from, actor)
      select 'derives_from', f.id, t.id, 'confirmed', 'dbt', now(), 'perf'
        from generate_series(1, ${L - 1}) l cross join generate_series(0, ${W - 1}) c cross join generate_series(0, 3) k
        join catalog.node f on f.qualified_name = 'perf.l' || l || '.c' || c
        join catalog.node t on t.qualified_name = 'perf.l' || (l - 1) || '.c' || ((c * 3 + k * 211) % ${W})`);
    await admin.query('analyze catalog.edge'); await admin.query('analyze catalog.node');
    const times: number[] = [];
    for (let i = 0; i < 8; i++) {
      const t0 = performance.now();
      const r = await lineage.traverse(`perf.l0.c${i * 13}`, { direction: 'downstream', depth: 10, maxNodes: 20000 });
      times.push(performance.now() - t0);
      expect(r!.nodes.length).toBeGreaterThan(i === 0 ? 5000 : 10);
    }
    times.sort((a, b) => a - b);
    console.log(`lineage impact depth 10: p50 ${Math.round(times[3]!)} ms, max ${Math.round(times.at(-1)!)} ms`);
    expect(times.at(-1)!).toBeLessThan(2000);
  }, 120_000);
});
