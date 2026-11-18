import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { provisionModule, migrateModule, writeOutbox, markProcessed } from '../packages/platform/src/index.ts';

let server, admin, dataDir;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'dmc-pg-'));
  server = new EmbeddedPostgres({ databaseDir: dataDir, user: 'postgres', password: 'pw', port: 54329, persistent: false });
  await server.initialise();
  await server.start();
  admin = new pg.Client({ host: 'localhost', port: 54329, user: 'postgres', password: 'pw', database: 'postgres' });
  await admin.connect();
  await provisionModule(admin, 'catalog');
  await provisionModule(admin, 'policy');
}, 120_000);

afterAll(async () => {
  try {
    await admin?.end();
  } finally {
    await server?.stop();
  }
});

describe('F3: Postgres base', () => {
  it('a module cannot read another module\'s schema', async () => {
    await admin.query('create table policy.secret (id int)');
    await admin.query('grant all on policy.secret to dmc_policy');
    await admin.query('begin');
    await admin.query('set local role dmc_catalog');
    await expect(admin.query('select * from policy.secret')).rejects.toThrow(/permission denied/);
    await admin.query('rollback');
  });

  it('a module can use its own schema', async () => {
    await admin.query('begin');
    await admin.query('set local role dmc_catalog');
    await admin.query('create table catalog.node (id int)');
    await admin.query('insert into catalog.node values (1)');
    const r = await admin.query('select count(*)::int as n from catalog.node');
    expect(r.rows[0].n).toBe(1);
    await admin.query('commit');
  });

  it('outbox row is written in the same transaction as the change and rolls back with it', async () => {
    await admin.query('begin');
    await writeOutbox(admin, 'catalog', { type: 'node.created', subjectRef: 'node/1', actor: 'test', payload: { a: 1 } });
    await admin.query('rollback');
    const r = await admin.query('select count(*)::int as n from catalog.outbox');
    expect(r.rows[0].n).toBe(0);
  });

  it('inbox makes consumers idempotent', async () => {
    expect(await markProcessed(admin, 'catalog', 'evt-1')).toBe(true);
    expect(await markProcessed(admin, 'catalog', 'evt-1')).toBe(false);
  });

  it('migrations apply once and refuse edits to applied files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dmc-mig-'));
    try {
      writeFileSync(join(dir, '0001_init.sql'), 'create table widget (id int);');
      expect(await migrateModule(admin, 'policy', dir)).toEqual(['0001_init.sql']);
      expect(await migrateModule(admin, 'policy', dir)).toEqual([]);
      writeFileSync(join(dir, '0001_init.sql'), 'create table widget (id int, x int);');
      await expect(migrateModule(admin, 'policy', dir)).rejects.toThrow(/edited after it was applied/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
