// L1 load check: impact query p95 under 2 s at depth 10 on a fixture (plan L1, "Load" row).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { join } from 'node:path';
import { provisionModule, migrateModule } from '../../packages/platform/src/index';
import { CatalogLineage } from '../../packages/catalog/src/index';
import { hardware, percentile, startPg } from './support';

const TARGET_MS = 2000;
const L = 11; const W = 20_000; const FAN = 4; // 11 layers (depth 10) x 20,000 columns, 4 upstream parents each: 220k nodes, 800k edges
let server: EmbeddedPostgres; let admin: pg.Client;

beforeAll(async () => {
  ({ server, admin } = await startPg(54562, 'lineage'));
  await provisionModule(admin, 'catalog');
  await migrateModule(admin, 'catalog', join(import.meta.dirname, '../../packages/catalog/migrations'));
});
afterAll(async () => { await admin?.end(); await server?.stop(); });

describe('L1 load: impact query', () => {
  it(`p95 under ${TARGET_MS} ms at depth 10 (${L * W} nodes, ${(L - 1) * W * FAN} edges)`, async () => {
    const f0 = performance.now();
    await admin.query(`insert into catalog.node (type, qualified_name) select 'Column', 'perf.l' || l || '.c' || c from generate_series(0, ${L - 1}) l, generate_series(0, ${W - 1}) c`);
    await admin.query(`insert into catalog.edge (name, from_id, to_id, lifecycle, source, valid_from, actor)
      select 'derives_from', f.id, t.id, 'confirmed', 'dbt', now(), 'perf'
        from generate_series(1, ${L - 1}) l cross join generate_series(0, ${W - 1}) c cross join generate_series(0, ${FAN - 1}) k
        join catalog.node f on f.qualified_name = 'perf.l' || l || '.c' || c
        join catalog.node t on t.qualified_name = 'perf.l' || (l - 1) || '.c' || ((c * 3 + k * 211) % ${W})`);
    await admin.query('analyze catalog.edge'); await admin.query('analyze catalog.node');
    console.log(`[perf] L1 fixture built in ${Math.round((performance.now() - f0) / 1000)} s`);

    const lineage = new CatalogLineage(admin);
    await lineage.traverse('perf.l0.c0', { direction: 'downstream', depth: 10, maxNodes: 20_000 }); // warm-up
    const times: number[] = []; const sizes: number[] = [];
    for (let i = 0; i < 40; i++) {
      const t0 = performance.now();
      const r = await lineage.traverse(`perf.l0.c${i * 487}`, { direction: i % 4 === 3 ? 'upstream' : 'downstream', depth: 10, maxNodes: 20_000 });
      times.push(performance.now() - t0);
      sizes.push(r!.nodes.length);
    }
    times.sort((a, b) => a - b);
    const p95 = percentile(times, 0.95);
    console.log(`[perf] L1 impact depth 10 over ${times.length} queries (up to ${Math.max(...sizes)} nodes returned): p50 ${Math.round(percentile(times, 0.5))} ms, p95 ${Math.round(p95)} ms, max ${Math.round(times.at(-1)!)} ms (target p95 < ${TARGET_MS}) | ${hardware()}`);
    expect(Math.max(...sizes)).toBeGreaterThan(1000);
    expect(p95).toBeLessThan(TARGET_MS);
  });
});
