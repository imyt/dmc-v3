import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExceptionPort, RaiseExceptionRequest, Signal } from '../packages/contracts/src/index';
import { loadRegistry, migrateModule, provisionModule } from '../packages/platform/src/index';
import { CatalogStore } from '../packages/catalog/src/index';
import { ScopeOwnerCheck } from '../apps/worker/src/scope-owners';

// ADR 0024: the unknown-owner exception is also withdrawn by a periodic re-check, without the scope record changing
const root = join(import.meta.dirname, '..');
const PORT = 54481;
const store = new CatalogStore(loadRegistry(join(root, 'metamodel/types')));
const src = { kind: 'sync', source: 'scope-sources' } as const;
const idp = { kind: 'sync', source: 'idp' } as const;

let server: EmbeddedPostgres; let cdb: pg.Client; let admin: pg.Client;
const open = new Set<string>(); const raised: RaiseExceptionRequest[] = []; const forwarded: Signal[] = [];
const exceptions: ExceptionPort = {
  async raise(r) { raised.push(r); open.add(r.subjectRef); return { id: 'x', created: true }; },
  async withdraw(r) { return open.delete(r.subjectRef); },
};
let owners: ScopeOwnerCheck;
const scope = (id: string, owner: string): Signal => ({ source: 'aris-scopes', key: `${id}@h`, kind: 'sync.upsert', subjectRef: `Scope:${id}`, subjectType: 'Scope', asset: { name: id, owner, kind: 'report' }, actor: 'sync' });
const makeScope = (id: string, owner: string) => store.tx(cdb, () => store.applyNode(cdb, { type: 'Scope', qualifiedName: id, attributes: { name: id, owner, kind: 'report' }, writer: src, actor: 'sync' }));

beforeAll(async () => {
  server = new EmbeddedPostgres({ databaseDir: mkdtempSync(join(tmpdir(), 'dmc-own-')), user: 'postgres', password: 'pw', port: PORT, persistent: false });
  await server.initialise(); await server.start();
  admin = new pg.Client({ host: 'localhost', port: PORT, user: 'postgres', password: 'pw', database: 'postgres' }); await admin.connect();
  await provisionModule(admin, 'catalog', { password: 'cat' });
  await migrateModule(admin, 'catalog', join(root, 'packages/catalog/migrations'));
  await admin.query('grant all on all tables in schema catalog to dmc_catalog');
  await admin.query('grant all on all sequences in schema catalog to dmc_catalog');
  cdb = new pg.Client({ host: 'localhost', port: PORT, user: 'dmc_catalog', password: 'cat', database: 'postgres' }); await cdb.connect();
  owners = new ScopeOwnerCheck({
    store, connect: async () => ({ query: (q: string, p?: unknown[]) => cdb.query(q, p) as never, release() {} }), exceptions,
    next: { async submit(s) { forwarded.push(...s); } },
    openUnknown: async () => [...open],
  });
}, 150_000);
afterAll(async () => {
  try {
    await cdb?.end(); await admin?.end();
  } finally {
    try { await server?.stop(); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EBUSY') throw e; }
  }
});

// ADR 0026: an owner is found by the Person's key, the staff ID, exactly as the source gave it (a number with fewer digits is a different, unknown owner: it is never padded)
describe('ADR 0024: periodic re-check of scope owners', () => {
  it('CAT-9: an unknown owner raises an exception; a re-check with no change leaves it open and raises nothing new', async () => {
    for (const [id, o] of [['s1', '00000071'], ['s2', '00000072'], ['s3', '04300004']] as const) { await makeScope(id, o); await owners.submit([scope(id, o)]); }
    expect([...open].sort()).toEqual(['Scope:s1', 'Scope:s2', 'Scope:s3']);
    raised.length = 0;
    expect(await owners.recheck()).toEqual({ checked: 3, withdrawn: 0 });
    expect(raised).toHaveLength(0);
  });

  it('CAT-9 / ADR 0026: when the Person appears (its key is the staff ID, leading zeros kept) the exception is withdrawn without the scope changing', async () => {
    await store.tx(cdb, () => store.applyNode(cdb, { type: 'Person', qualifiedName: '00000071', attributes: { email: 'late1@bank.example', name: 'Late' }, writer: idp, actor: 'idp' }));
    await store.tx(cdb, () => store.applyNode(cdb, { type: 'Person', qualifiedName: '04300004', attributes: { email: 'late@bank.example', name: 'Other' }, writer: idp, actor: 'idp' }));
    expect(await owners.recheck()).toEqual({ checked: 3, withdrawn: 2 });
    expect([...open]).toEqual(['Scope:s2']);
    expect(await owners.recheck()).toEqual({ checked: 1, withdrawn: 0 });
  });

  it('CAT-9 / ADR 0026: an owner that lost its leading zeros does not match the person who has them, and is not padded', async () => {
    await makeScope('s4', '4300004');
    await owners.submit([scope('s4', '4300004')]);
    expect(open.has('Scope:s4')).toBe(true);
    expect(await owners.recheck()).toMatchObject({ withdrawn: 0 });
    expect(open.has('Scope:s4')).toBe(true);
    open.delete('Scope:s4');
  });

  it('CAT-9: a scope that is deprecated is withdrawn too, and a re-check with nothing open does nothing', async () => {
    await store.tx(cdb, () => store.setLifecycle(cdb, 's2', 'deprecated', 'sync'));
    expect(await owners.recheck()).toEqual({ checked: 1, withdrawn: 1 });
    expect(open.size).toBe(0);
    expect(await owners.recheck()).toEqual({ checked: 0, withdrawn: 0 });
  });
});
