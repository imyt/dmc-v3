import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { provisionModule, migrateModule } from '../packages/platform/src/index';
import { CatalogStore } from '../packages/catalog/src/index';
import { loadRegistry } from '../packages/platform/src/index';

let server: EmbeddedPostgres;
let admin: pg.Client;
let db: pg.Client; // connects as dmc_catalog: the module's own role
const store = new CatalogStore(loadRegistry(join(import.meta.dirname, '../metamodel/types')));
const git = { kind: 'sync', source: 'git-json' } as const;
const idp = { kind: 'sync', source: 'idp' } as const;
const d = (s: string) => new Date(s);

beforeAll(async () => {
  server = new EmbeddedPostgres({ databaseDir: mkdtempSync(join(tmpdir(), 'dmc-cat-')), user: 'postgres', password: 'pw', port: 54331, persistent: false });
  await server.initialise();
  await server.start();
  admin = new pg.Client({ host: 'localhost', port: 54331, user: 'postgres', password: 'pw', database: 'postgres' });
  await admin.connect();
  await provisionModule(admin, 'catalog', { password: 'cat' });
  await migrateModule(admin, 'catalog', join(import.meta.dirname, '../packages/catalog/migrations'));
  await admin.query('grant all on all tables in schema catalog to dmc_catalog');
  await admin.query('grant all on all sequences in schema catalog to dmc_catalog');
  db = new pg.Client({ host: 'localhost', port: 54331, user: 'dmc_catalog', password: 'cat', database: 'postgres' });
  await db.connect();
}, 120_000);

afterAll(async () => {
  try {
    await db?.end();
    await admin?.end();
  } finally {
    await server?.stop();
  }
});

const apply = (qn: string, attributes: Record<string, unknown>, extra: Partial<Parameters<CatalogStore['applyNode']>[1]> = {}) =>
  store.tx(db, () => store.applyNode(db, { type: 'System', qualifiedName: qn, attributes, writer: git, actor: 'sync/git', ...extra }));

describe('M3: catalog store', () => {
  it('re-applying a record makes no duplicate and records nothing new', async () => {
    const a = await apply('sys.payments', { name: 'Payments', platform: 'k8s' });
    const b = await apply('sys.payments', { name: 'Payments', platform: 'k8s' });
    expect(a).toMatchObject({ created: true, changed: true });
    expect(b).toMatchObject({ created: false, changed: false, id: a.id });
    expect((await store.history(db, 'sys.payments')).length).toBe(1);
    const n = await admin.query("select count(*)::int c from catalog.node where qualified_name = 'sys.payments'");
    expect(n.rows[0].c).toBe(1);
    const ev = await admin.query("select count(*)::int c from catalog.outbox where subject_ref = $1", [`node/${a.id}`]);
    expect(ev.rows[0].c).toBe(1); // evidence only for real changes
  });

  it('state at any past date is queryable (valid time) and so is what we believed then (record time)', async () => {
    await apply('sys.ledger', { name: 'Ledger', platform: 'vm' }, { validFrom: d('2026-01-01') });
    const t1 = new Date();
    await new Promise((r) => setTimeout(r, 20));
    await apply('sys.ledger', { platform: 'k8s' }, { validFrom: d('2026-06-01') });
    expect((await store.getNode(db, 'sys.ledger'))!.attributes.platform).toBe('k8s');
    expect((await store.getNode(db, 'sys.ledger', { validAt: d('2026-03-01') }))!.attributes.platform).toBe('vm');
    expect((await store.getNode(db, 'sys.ledger', { validAt: d('2026-07-01') }))!.attributes.platform).toBe('k8s');
    // before the change was recorded we believed it was vm all along
    expect((await store.getNode(db, 'sys.ledger', { validAt: d('2026-07-01'), knownAt: t1 }))!.attributes.platform).toBe('vm');
    expect(await store.getNode(db, 'sys.ledger', { validAt: d('2025-01-01') })).toBeUndefined();
  });

  it('records which source set each attribute', async () => {
    const n = (await store.getNode(db, 'sys.payments'))!;
    expect(n.provenance.platform!.by).toBe('git-json');
    await expect(apply('sys.payments', { hosting_country: 'GB' })).rejects.toMatchObject({ code: 'validation_failed' }); // derived, read-only for git
  });

  it('refuses invalid writes with field-level errors', async () => {
    await expect(apply('sys.bad', { platform: 'k8s' })).rejects.toMatchObject({ code: 'validation_failed' }); // name is required on create
    await expect(store.tx(db, () => store.applyNode(db, { type: 'Nope', qualifiedName: 'x', attributes: {}, writer: git, actor: 'a' }))).rejects.toThrow(/Unknown type/);
    await expect(store.tx(db, () => store.applyNode(db, { type: 'Person', qualifiedName: 'sys.payments', attributes: { email: 'a@b' }, writer: idp, actor: 'a' }))).rejects.toMatchObject({ code: 'conflict' });
    const none = await admin.query("select 1 from catalog.node where qualified_name = 'sys.bad'");
    expect(none.rowCount).toBe(0); // rolled back
  });

  it('lifecycle follows the allowed transitions', async () => {
    await store.tx(db, () => store.setLifecycle(db, 'sys.payments', 'proposed', 'u'));
    await store.tx(db, () => store.setLifecycle(db, 'sys.payments', 'confirmed', 'u'));
    await expect(store.tx(db, () => store.setLifecycle(db, 'sys.payments', 'proposed', 'u'))).rejects.toMatchObject({ code: 'conflict' });
    await store.tx(db, () => store.setLifecycle(db, 'sys.payments', 'deprecated', 'u'));
    expect((await store.getNode(db, 'sys.payments'))!.lifecycle).toBe('deprecated');
  });

  it('edges obey the metamodel and cardinality, and are idempotent', async () => {
    await store.tx(db, () => store.applyNode(db, { type: 'Person', qualifiedName: '00000001', attributes: { email: 'alice@x' }, writer: idp, actor: 'a' }));
    await store.tx(db, () => store.applyNode(db, { type: 'Person', qualifiedName: '00000002', attributes: { email: 'bob@x' }, writer: idp, actor: 'a' }));
    const link = (to: string, from = 'sys.ledger') => store.tx(db, () => store.link(db, { name: 'owned_by', fromQn: from, toQn: to, source: 'git-json', actor: 'a' }));
    expect(await link('00000001')).toEqual({ changed: true });
    expect(await link('00000001')).toEqual({ changed: false });
    await expect(link('00000002')).rejects.toMatchObject({ code: 'conflict' }); // many-to-one: one owner
    await expect(store.tx(db, () => store.link(db, { name: 'owned_by', fromQn: 'sys.ledger', toQn: 'sys.payments', source: 'x', actor: 'a' }))).rejects.toMatchObject({ code: 'validation_failed' });
    const out = await store.edgesOf(db, 'sys.ledger', { name: 'owned_by' });
    expect(out).toHaveLength(1);
    const incoming = await store.edgesOf(db, '00000001', { direction: 'in' });
    expect(incoming[0]!.name).toBe('owned_by');
  });

  it('removing an edge keeps its past', async () => {
    const before = new Date();
    await new Promise((r) => setTimeout(r, 20));
    await store.tx(db, () => store.unlink(db, { name: 'owned_by', fromQn: 'sys.ledger', toQn: '00000001', actor: 'a' }));
    expect(await store.edgesOf(db, 'sys.ledger', { name: 'owned_by' })).toHaveLength(0);
    expect(await store.edgesOf(db, 'sys.ledger', { name: 'owned_by', validAt: before, knownAt: before })).toHaveLength(1);
  });

  it('lists by type with paging', async () => {
    const page = await store.listByType(db, 'System', { limit: 1 });
    expect(page).toHaveLength(2); // limit + 1 tells the caller there is another page
    const next = await store.listByType(db, 'System', { limit: 1, afterQn: page[0]!.qualifiedName });
    expect(next[0]!.qualifiedName).not.toBe(page[0]!.qualifiedName);
  });
});
