import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { provisionModule, migrateModule, writeOutbox } from '../packages/platform/src/index';
import { appendBatch, grantRelay, relayOutbox, verifyChain, type EntryFields } from '../packages/evidence/src/index';

let server: EmbeddedPostgres;
let admin: pg.Client;
let writer: pg.Client; // connects as dmc_evidence
const MIGRATIONS = join(import.meta.dirname, '../packages/evidence/migrations');

const entry = (i: number): EntryFields => ({
  kind: 'node.updated', subjectRef: `node/${i % 50}`, actor: 'svc', sourceModule: 'catalog', sourceId: i,
  occurredAt: new Date(1_700_000_000_000 + i).toISOString(), payload: { i, tags: ['a', 'b'], nested: { z: 1, a: 2 } },
});

async function reset() {
  await admin.query('set session_replication_role = replica');
  await admin.query('truncate evidence.ledger_entry');
  await admin.query('set session_replication_role = origin');
}

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dmc-ev-'));
  server = new EmbeddedPostgres({ databaseDir: dir, user: 'postgres', password: 'pw', port: 54330, persistent: false });
  await server.initialise();
  await server.start();
  admin = new pg.Client({ host: 'localhost', port: 54330, user: 'postgres', password: 'pw', database: 'postgres' });
  await admin.connect();
  await provisionModule(admin, 'evidence', { password: 'ev' });
  await provisionModule(admin, 'catalog');
  await provisionModule(admin, 'policy');
  await migrateModule(admin, 'evidence', MIGRATIONS);
  await grantRelay(admin, ['catalog', 'policy']);
  writer = new pg.Client({ host: 'localhost', port: 54330, user: 'dmc_evidence', password: 'ev', database: 'postgres' });
  await writer.connect();
}, 120_000);

afterAll(async () => {
  try {
    await writer?.end();
    await admin?.end();
  } finally {
    await server?.stop();
  }
});

describe('E1: ledger', () => {
  it('chains entries and verifies', async () => {
    await writer.query('begin');
    await appendBatch(writer, [1, 2, 3].map(entry));
    await writer.query('commit');
    expect(await verifyChain(admin)).toEqual({ ok: true, checked: 3 });
  });

  it('the writer role cannot update, delete or truncate', async () => {
    await expect(writer.query("update evidence.ledger_entry set actor = 'x'")).rejects.toThrow(/permission denied/);
    await expect(writer.query('delete from evidence.ledger_entry')).rejects.toThrow(/permission denied/);
    await expect(writer.query('truncate evidence.ledger_entry')).rejects.toThrow(/permission denied/);
  });

  it('even an owner-level change is blocked by the trigger', async () => {
    await expect(admin.query("update evidence.ledger_entry set actor = 'x'")).rejects.toThrow(/append-only/);
  });

  it('detects an edited payload, a deleted row and a rewritten hash', async () => {
    const tamper = async (sql: string) => {
      await admin.query('set session_replication_role = replica');
      await admin.query(sql);
      await admin.query('set session_replication_role = origin');
    };
    await tamper(`update evidence.ledger_entry set payload = '{"i": 99}' where seq = 2`);
    expect(await verifyChain(admin)).toMatchObject({ ok: false, firstBadSeq: 2, reason: expect.stringMatching(/payload_hash/) });

    await reset();
    await writer.query('begin'); await appendBatch(writer, [1, 2, 3, 4].map(entry)); await writer.query('commit');
    await tamper('delete from evidence.ledger_entry where seq = 2');
    expect(await verifyChain(admin)).toMatchObject({ ok: false, firstBadSeq: 2, reason: expect.stringMatching(/gap/) });

    await reset();
    await writer.query('begin'); await appendBatch(writer, [1, 2, 3].map(entry)); await writer.query('commit');
    await tamper(`update evidence.ledger_entry set hash = repeat('a', 64) where seq = 2`);
    expect(await verifyChain(admin)).toMatchObject({ ok: false, firstBadSeq: 2 });
    await reset();
  });

  it('relays outbox rows from several modules once, in order, and marks them published', async () => {
    await writeOutbox(admin, 'catalog', { type: 'node.created', subjectRef: 'node/1', actor: 'a', payload: { k: 1 } });
    await writeOutbox(admin, 'policy', { type: 'policy.activated', subjectRef: 'policy/9', actor: 'b', payload: { v: 2 } });
    expect(await relayOutbox(writer, ['catalog', 'policy'])).toBe(2);
    expect(await relayOutbox(writer, ['catalog', 'policy'])).toBe(0);
    const r = await admin.query('select kind, source_module from evidence.ledger_entry order by seq');
    expect(r.rows.map((x) => x.kind)).toEqual(['node.created', 'policy.activated']);
    expect(await verifyChain(admin)).toMatchObject({ ok: true, checked: 2 });
  });

  it('a failed relay changes nothing', async () => {
    await writeOutbox(admin, 'catalog', { type: 'node.created', subjectRef: 'node/2', actor: 'a', payload: {} });
    await admin.query('revoke update (published_at) on catalog.outbox from dmc_evidence');
    await expect(relayOutbox(writer, ['catalog'])).rejects.toThrow();
    await admin.query('grant update (published_at) on catalog.outbox to dmc_evidence');
    const left = await admin.query('select count(*)::int n from catalog.outbox where published_at is null');
    expect(left.rows[0].n).toBe(1);
    expect(await relayOutbox(writer, ['catalog'])).toBe(1);
    expect(await verifyChain(admin)).toMatchObject({ ok: true, checked: 3 });
  });

  it('writes at least 2,000 entries per second', async () => {
    await reset();
    const N = 20_000;
    const all = Array.from({ length: N }, (_, i) => entry(i + 1));
    const t0 = performance.now();
    for (let i = 0; i < N; i += 1000) {
      await writer.query('begin');
      await appendBatch(writer, all.slice(i, i + 1000));
      await writer.query('commit');
    }
    const perSec = N / ((performance.now() - t0) / 1000);
    console.log(`ledger append: ${Math.round(perSec)} entries/s`);
    expect(perSec).toBeGreaterThan(2000);
    expect(await verifyChain(admin)).toEqual({ ok: true, checked: N });
  }, 120_000);
});
