// E1 load check: the ledger writer must sustain 2,000 entries/s (plan E1, "Load" row).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { join } from 'node:path';
import { provisionModule, migrateModule } from '../../packages/platform/src/index';
import { appendBatch, grantRelay, relayOutbox, verifyChain, type EntryFields } from '../../packages/evidence/src/index';
import { hardware, startPg } from './support';

const TARGET = 2000;
let server: EmbeddedPostgres; let admin: pg.Client; let writer: pg.Client;

const entry = (i: number): EntryFields => ({
  kind: 'node.updated', subjectRef: `node/${i % 5000}`, actor: 'svc', sourceModule: 'policy', sourceId: i,
  occurredAt: new Date(1_700_000_000_000 + i).toISOString(), payload: { i, tags: ['a', 'b'], nested: { z: 1, a: 2 }, note: 'x'.repeat(200) },
});

beforeAll(async () => {
  ({ server, admin } = await startPg(54560, 'ledger'));
  await provisionModule(admin, 'evidence', { password: 'ev' });
  await provisionModule(admin, 'catalog');
  await migrateModule(admin, 'evidence', join(import.meta.dirname, '../../packages/evidence/migrations'));
  await grantRelay(admin, ['catalog']);
  writer = new pg.Client({ host: 'localhost', port: 54560, user: 'dmc_evidence', password: 'ev', database: 'postgres' });
  await writer.connect();
});
afterAll(async () => { await writer?.end(); await admin?.end(); await server?.stop(); });

describe('E1 load: ledger writer', () => {
  it(`appendBatch sustains at least ${TARGET} entries/s (100,000 entries, batches of 1,000)`, async () => {
    const N = 100_000;
    const all = Array.from({ length: N }, (_, i) => entry(i + 1));
    const t0 = performance.now();
    for (let i = 0; i < N; i += 1000) {
      await writer.query('begin');
      await appendBatch(writer, all.slice(i, i + 1000));
      await writer.query('commit');
    }
    const perSec = N / ((performance.now() - t0) / 1000);
    console.log(`[perf] E1 ledger appendBatch: ${Math.round(perSec)} entries/s (target ${TARGET}) | ${hardware()}`);
    expect(perSec).toBeGreaterThanOrEqual(TARGET);
    const v0 = performance.now();
    expect(await verifyChain(admin)).toEqual({ ok: true, checked: N });
    console.log(`[perf] E1 verifyChain over ${N}: ${Math.round(N / ((performance.now() - v0) / 1000))} entries/s`);
  });

  it(`outbox relay (read, chain, insert, mark published) sustains at least ${TARGET} entries/s`, async () => {
    const N = 50_000;
    await admin.query(`insert into catalog.outbox (event_type, subject_ref, actor, payload)
      select 'node.updated', 'node/' || (i % 5000), 'svc', jsonb_build_object('i', i, 'note', repeat('x', 200)) from generate_series(1, ${N}) i`);
    const t0 = performance.now();
    let moved = 0;
    for (;;) { const n = await relayOutbox(writer, ['catalog'], { batch: 1000 }); if (!n) break; moved += n; }
    const perSec = moved / ((performance.now() - t0) / 1000);
    console.log(`[perf] E1 outbox relay: ${Math.round(perSec)} entries/s (target ${TARGET}) | ${hardware()}`);
    expect(moved).toBe(N);
    expect(perSec).toBeGreaterThanOrEqual(TARGET);
  });
});
