// M5 load check: search p95 under 400 ms on a 1M-node fixture (plan M5, "Load" row).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { join } from 'node:path';
import { provisionModule, migrateModule } from '../../packages/platform/src/index';
import { PostgresSearch } from '../../packages/catalog/src/index';
import { hardware, percentile, startPg } from './support';

const TARGET_MS = 400;
let server: EmbeddedPostgres; let admin: pg.Client;

beforeAll(async () => {
  ({ server, admin } = await startPg(54561, 'search'));
  await provisionModule(admin, 'catalog');
  await migrateModule(admin, 'catalog', join(import.meta.dirname, '../../packages/catalog/migrations'));
});
afterAll(async () => { await admin?.end(); await server?.stop(); });

describe('M5 load: search', () => {
  it(`p95 under ${TARGET_MS} ms on a 1M-node fixture`, async () => {
    const f0 = performance.now();
    await admin.query(`
      insert into catalog.node (id, type, qualified_name)
        select gen_random_uuid(), (array['Table','Column','System','Schema'])[1 + (i % 4)], 'fx.' || (array['payments','ledger','risk','treasury','kyc','fraud'])[1 + (i % 6)] || '.obj' || i
        from generate_series(1, 1000000) i;
      insert into catalog.search_doc (node_id, type, lifecycle, qualified_name, name, doc)
        select id, type, (array['discovered','confirmed','deprecated'])[1 + (abs(hashtext(qualified_name)) % 3)], qualified_name, 'Object ' || split_part(qualified_name, '.', 3),
               setweight(to_tsvector('simple', 'Object ' || split_part(qualified_name, '.', 3)), 'A') || setweight(to_tsvector('simple', replace(qualified_name, '.', ' ')), 'B')
        from catalog.node where qualified_name like 'fx.%';
      analyze catalog.search_doc;`);
    const n = await admin.query('select count(*)::int n from catalog.search_doc');
    console.log(`[perf] M5 fixture: ${n.rows[0].n} indexed nodes built in ${Math.round((performance.now() - f0) / 1000)} s`);
    expect(n.rows[0].n).toBeGreaterThanOrEqual(1_000_000);

    const s = new PostgresSearch(admin);
    const queries = ['payments', 'ledger obj', 'risk', 'treasury obj1', 'kyc', 'fraud obj99', 'obj12345', 'pay', 'led', 'object', 'fx payments obj5', 'fx', 'obj7'];
    for (const text of queries) await s.search({ text, limit: 20 }); // warm-up: first touch reads index pages from disk
    const times: number[] = [];
    for (let round = 0; round < 8; round++)
      for (const text of queries) {
        const t0 = performance.now();
        await s.search({ text, limit: 20, ...(round % 2 ? { types: ['Table'] } : {}), ...(round % 4 === 3 ? { lifecycles: ['confirmed' as const] } : {}) });
        times.push(performance.now() - t0);
      }
    times.sort((a, b) => a - b);
    const p95 = percentile(times, 0.95);
    console.log(`[perf] M5 search over ${times.length} queries on 1M nodes: p50 ${Math.round(percentile(times, 0.5))} ms, p95 ${Math.round(p95)} ms, max ${Math.round(times.at(-1)!)} ms (target p95 < ${TARGET_MS}) | ${hardware()}`);
    expect(p95).toBeLessThan(TARGET_MS);
  });
});
