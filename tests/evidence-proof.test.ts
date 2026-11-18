import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { provisionModule, migrateModule } from '../packages/platform/src/index';
import { appendBatch, exportProof, trace, verifyProof, ProofTooLarge, type EntryFields } from '../packages/evidence/src/index';

let server: EmbeddedPostgres; let admin: pg.Client; let writer: pg.Client;
const entry = (i: number, subject: string): EntryFields => ({ kind: 'node.updated', subjectRef: subject, actor: 'svc', sourceModule: 'catalog', sourceId: i,
  occurredAt: new Date(1_700_000_000_000 + i).toISOString(), payload: { i, nested: { b: 1, a: 2 } } });

beforeAll(async () => {
  server = new EmbeddedPostgres({ databaseDir: mkdtempSync(join(tmpdir(), 'dmc-prf-')), user: 'postgres', password: 'pw', port: 54344, persistent: false });
  await server.initialise(); await server.start();
  admin = new pg.Client({ host: 'localhost', port: 54344, user: 'postgres', password: 'pw', database: 'postgres' }); await admin.connect();
  await provisionModule(admin, 'evidence', { password: 'ev' });
  await migrateModule(admin, 'evidence', join(import.meta.dirname, '../packages/evidence/migrations'));
  writer = new pg.Client({ host: 'localhost', port: 54344, user: 'dmc_evidence', password: 'ev', database: 'postgres' }); await writer.connect();
  // 30 entries, interleaved: every third is about the asset we trace
  await writer.query('begin');
  await appendBatch(writer, Array.from({ length: 30 }, (_, i) => entry(i + 1, i % 3 === 0 ? 'node/asset-1' : `node/other-${i}`)));
  await writer.query('commit');
}, 120_000);
afterAll(async () => { try { await writer?.end(); await admin?.end(); } finally { await server?.stop(); } });

describe('E4: trace and proof', () => {
  it('traces every entry about a subject, in order, with paging', async () => {
    const p1 = await trace(admin, ['node/asset-1'], { limit: 4 });
    expect(p1.map((e) => e.seq)).toEqual([1, 4, 7, 10]);
    const p2 = await trace(admin, ['node/asset-1'], { limit: 50, afterSeq: 10 });
    expect(p2.map((e) => e.seq)).toEqual([13, 16, 19, 22, 25, 28]);
    expect(await trace(admin, ['node/asset-1', 'node/other-1'], { limit: 3 })).toHaveLength(3);
  });

  it('an exported proof passes the verifier, with no database', async () => {
    const proof = await exportProof(admin, ['node/asset-1']);
    expect(proof.entries).toHaveLength(10);
    expect(proof.chain).toHaveLength(28); // every link from seq 1 to 28, so the entries are tied to each other
    expect(proof.head).toMatchObject({ seq: 30 });
    expect(verifyProof(JSON.parse(JSON.stringify(proof)))).toEqual({ ok: true, entries: 10, links: 28 });
  });

  it('a proof for a subject with no entries is valid and empty', async () => {
    expect(verifyProof(await exportProof(admin, ['node/none']))).toEqual({ ok: true, entries: 0, links: 0 });
  });

  it('any edit to the proof is caught', async () => {
    const good = JSON.parse(JSON.stringify(await exportProof(admin, ['node/asset-1'])));
    const edit = (f: (b: any) => void) => { const b = structuredClone(good); f(b); return verifyProof(b); };
    expect(edit((b) => { b.entries[3].payload.i = 999; })).toMatchObject({ ok: false, badSeq: 10, reason: 'entry content does not match its hash' });
    expect(edit((b) => { b.entries[3].actor = 'someone-else'; })).toMatchObject({ ok: false, badSeq: 10 });
    expect(edit((b) => { b.chain[5].hash = 'f'.repeat(64); })).toMatchObject({ ok: false, reason: 'chain link does not recompute' });
    expect(edit((b) => { b.chain.splice(6, 1); })).toMatchObject({ ok: false, reason: 'gap in the chain' });
    expect(edit((b) => { b.entries.splice(2, 1); })).toMatchObject({ ok: true }); // dropping an entry from the list is not forgery, but the others still verify
    expect(edit((b) => { b.anchorPrev = '1'.repeat(64); })).toMatchObject({ ok: false });
  });

  it('refuses to export a span larger than the limit', async () => {
    await expect(exportProof(admin, ['node/asset-1'], { maxChain: 10 })).rejects.toBeInstanceOf(ProofTooLarge);
  });
});
