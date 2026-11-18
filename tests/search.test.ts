import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { provisionModule, migrateModule } from '../packages/platform/src/index';
import { CatalogStore, PostgresSearch, toTsQuery } from '../packages/catalog/src/index';
import { loadRegistry } from '../packages/platform/src/index';

let server: EmbeddedPostgres;
let admin: pg.Client;
const PERF = process.env.DMC_PERF === '1';

beforeAll(async () => {
  server = new EmbeddedPostgres({ databaseDir: mkdtempSync(join(tmpdir(), 'dmc-srch-')), user: 'postgres', password: 'pw', port: 54333, persistent: false });
  await server.initialise(); await server.start();
  admin = new pg.Client({ host: 'localhost', port: 54333, user: 'postgres', password: 'pw', database: 'postgres' });
  await admin.connect();
  await provisionModule(admin, 'catalog');
  await migrateModule(admin, 'catalog', join(import.meta.dirname, '../packages/catalog/migrations'));
}, 120_000);
afterAll(async () => { try { await admin?.end(); } finally { await server?.stop(); } });

describe('M5: search', () => {
  it('builds prefix queries', () => {
    expect(toTsQuery('Sys pay')).toBe("'sys':* & 'pay':*");
    expect(toTsQuery("  ' ")).toBeUndefined();
  });

  it('finds by name, qualified name and other text, with facets, and follows updates', async () => {
    const store = new CatalogStore(loadRegistry(join(import.meta.dirname, '../metamodel/types')));
    const w = { kind: 'sync', source: 'git-json' } as const;
    await store.tx(admin, async () => {
      await store.applyNode(admin, { type: 'System', qualifiedName: 'apps.payments.core', attributes: { name: 'Payments Core', platform: 'kubernetes' }, writer: w, actor: 't' });
      await store.applyNode(admin, { type: 'System', qualifiedName: 'apps.ledger.core', attributes: { name: 'Ledger', platform: 'mainframe' }, writer: w, actor: 't' });
      await store.applyNode(admin, { type: 'Schema', qualifiedName: 'apps.payments.core/main', attributes: { name: 'main' }, writer: w, actor: 't' });
    });
    const s = new PostgresSearch(admin);
    expect((await s.search({ text: 'pay' })).hits.map((h) => h.qualifiedName)[0]).toBe('apps.payments.core'); // name beats qn-only match
    const r = await s.search({ text: 'payments' });
    expect(r.facets.type).toEqual({ System: 1, Schema: 1 });
    expect((await s.search({ text: 'payments', types: ['Schema'] })).hits).toHaveLength(1);
    expect((await s.search({ text: 'mainframe' })).hits[0]!.name).toBe('Ledger');
    await store.tx(admin, () => store.applyNode(admin, { type: 'System', qualifiedName: 'apps.ledger.core', attributes: { platform: 'kubernetes' }, writer: w, actor: 't' }));
    expect((await s.search({ text: 'mainframe' })).hits).toHaveLength(0);
    await store.tx(admin, () => store.setLifecycle(admin, 'apps.ledger.core', 'deprecated', 't'));
    expect((await s.search({ text: 'ledger', lifecycles: ['deprecated'] })).hits).toHaveLength(1);
    expect((await s.search({ text: '!!!' })).hits).toEqual([]);
  });

  it.skipIf(!PERF)('p95 under 400 ms on a 1M-node fixture', async () => {
    await admin.query(`
      insert into catalog.node (id, type, qualified_name)
        select gen_random_uuid(), (array['Table','Column','System','Schema'])[1 + (i % 4)], 'fx.' || (array['payments','ledger','risk','treasury','kyc','fraud'])[1 + (i % 6)] || '.obj' || i
        from generate_series(1, 1000000) i;
      insert into catalog.search_doc (node_id, type, lifecycle, qualified_name, name, doc)
        select id, type, 'discovered', qualified_name, 'Object ' || split_part(qualified_name, '.', 3),
               setweight(to_tsvector('simple', 'Object ' || split_part(qualified_name, '.', 3)), 'A') || setweight(to_tsvector('simple', replace(qualified_name, '.', ' ')), 'B')
        from catalog.node where qualified_name like 'fx.%';
      analyze catalog.search_doc;`);
    const s = new PostgresSearch(admin);
    const queries = ['payments', 'ledger obj', 'risk', 'treasury obj1', 'kyc', 'fraud obj99', 'obj12345', 'pay', 'led', 'object', 'fx payments obj5'];
    const times: number[] = [];
    for (let round = 0; round < 6; round++)
      for (const text of queries) {
        const t0 = performance.now();
        await s.search({ text, limit: 20, ...(round % 2 ? { types: ['Table'] } : {}) });
        times.push(performance.now() - t0);
      }
    times.sort((a, b) => a - b);
    const p95 = times[Math.floor(times.length * 0.95)]!;
    console.log(`search p95 over ${times.length} queries on 1M nodes: ${Math.round(p95)} ms (max ${Math.round(times.at(-1)!)} ms)`);
    expect(p95).toBeLessThan(400);
  }, 600_000);
});
