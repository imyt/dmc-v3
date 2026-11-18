import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Authz, loadRegistry, migrateModule, provisionModule } from '../packages/platform/src/index';
import { CatalogStore } from '../packages/catalog/src/index';
import { checkResponse, loadSpec } from '../packages/contracts/src/index';
import { createApi, devAuthenticator } from '../apps/api/src/index';

const root = join(import.meta.dirname, '..');
const registry = loadRegistry(join(root, 'metamodel/types'));
const store = new CatalogStore(registry);
const spec = loadSpec();
let server: EmbeddedPostgres; let admin: pg.Client; let pool: pg.Pool; let evPool: pg.Pool; let app: NestFastifyApplication;
const idem = new Map<string, { bodyHash: string; response: unknown }>();
const as = (u: string) => ({ 'x-dmc-user': u });
const inj = (method: 'GET' | 'POST' | 'PATCH', url: string, headers: Record<string, string>, payload?: unknown) =>
  app.getHttpAdapter().getInstance().inject({ method, url, headers: { ...headers, ...(method === 'GET' ? {} : { 'idempotency-key': `k-${Math.random().toString(36).slice(2)}-xx` }) }, payload: payload as never });
const contract = (path: string, m: string, status: number, body: unknown) => expect(checkResponse(spec, path, m, status, body)).toEqual([]);
const I = '/v1/integrations/int-1/datasets';

beforeAll(async () => {
  server = new EmbeddedPostgres({ databaseDir: mkdtempSync(join(tmpdir(), 'dmc-ds-')), user: 'postgres', password: 'pw', port: 54351, persistent: false });
  await server.initialise(); await server.start();
  admin = new pg.Client({ host: 'localhost', port: 54351, user: 'postgres', password: 'pw', database: 'postgres' });
  await admin.connect();
  for (const m of ['catalog', 'evidence']) {
    await provisionModule(admin, m, { password: m });
    await migrateModule(admin, m, join(root, `packages/${m}/migrations`));
    await admin.query(`grant all on all tables in schema ${m} to dmc_${m}`); await admin.query(`grant all on all sequences in schema ${m} to dmc_${m}`);
  }
  pool = new pg.Pool({ host: 'localhost', port: 54351, user: 'dmc_catalog', password: 'catalog', database: 'postgres', max: 4 });
  evPool = new pg.Pool({ host: 'localhost', port: 54351, user: 'dmc_evidence', password: 'evidence', database: 'postgres', max: 2 });
  const c = await pool.connect();
  const sn = { kind: 'sync', source: 'servicenow' } as const;
  const n = (type: string, qn: string, attributes: Record<string, unknown>, writer: { kind: 'sync'; source: string } = sn) => store.tx(c, () => store.applyNode(c, { type, qualifiedName: qn, attributes, writer, actor: 'test' }));
  try {
    await n('Application', 'app-a', { name: 'App A', owner: 'amy', delegates: ['dan'], hosting_country: 'GB' });
    await n('Application', 'app-b', { name: 'App B', owner: 'ben', hosting_country: 'GB' });
    await n('Application', 'app-c', { name: 'App C', owner: 'cat', hosting_country: 'GB' });
    await n('Integration', 'int-1', { status: 'live' });
    await n('Integration', 'int-2', { status: 'live' });
    await n('DataCategory', 'gl:customer-pii', { name: 'Customer PII' }, { kind: 'sync', source: 'collibra' });
    await n('RecordClass', 'dstorm:rc-7y', { code: 'RC-7Y', name: 'Seven years' }, { kind: 'sync', source: 'dstorm' });
    for (const col of ['col-1', 'col-2']) await n('Column', col, { name: col }, { kind: 'sync', source: 'git-json' });
    await store.tx(c, async () => {
      await store.link(c, { name: 'source_of', fromQn: 'app-a', toQn: 'int-1', source: 'servicenow', actor: 't' });
      await store.link(c, { name: 'target_of', fromQn: 'app-b', toQn: 'int-1', source: 'servicenow', actor: 't' });
      await store.link(c, { name: 'source_of', fromQn: 'app-c', toQn: 'int-2', source: 'servicenow', actor: 't' });
    });
  } finally { c.release(); }
  const lease = (p: pg.Pool) => async () => { const x = await p.connect(); return { query: (s: string, a?: unknown[]) => x.query(s, a) as never, release: () => x.release() }; };
  app = await createApi({
    version: '0.1.0', registry, store, authz: Authz.load(readFileSync(join(root, 'config/authz.yaml'), 'utf8')), authenticate: devAuthenticator('local'),
    connect: lease(pool), connectEvidence: lease(evPool), policies: () => [],
    exceptions: { async raise() { return { id: 'e', created: true }; }, async withdraw() { return true; } },
    inbox: { async forSubject() { return []; }, async list() { return []; }, async get() { return undefined; }, async decide() { return { replayed: false }; } },
    signals: { async submit() {} },
    idempotency: { async get(k) { return idem.get(k); }, async put(k, e) { idem.set(k, e); } },
  });
}, 150_000);
afterAll(async () => { try { await app?.close(); await pool?.end(); await evPool?.end(); await admin?.end(); } finally { await server?.stop(); } });

describe('C4: datasets', () => {
  const body = { name: 'Customer accounts', description: 'Open accounts', business_context: 'Used by credit risk', categories: ['gl:customer-pii'], record_class: 'dstorm:rc-7y', columns: ['col-1'] };

  it('an owner of an application on the integration adds a dataset with category, record class and columns', async () => {
    const r = await inj('POST', I, as('amy'), body);
    expect(r.statusCode).toBe(201);
    expect(r.json().qualified_name).toBe('int-1--customer-accounts');
    contract('/v1/integrations/{qualified_name}/datasets', 'post', 201, r.json());
    const l = await inj('GET', I, as('amy'));
    expect(l.json().datasets).toEqual([expect.objectContaining({ qualified_name: 'int-1--customer-accounts', categories: ['gl:customer-pii'], record_class: 'dstorm:rc-7y', columns: ['col-1'], can_edit: true })]);
    contract('/v1/integrations/{qualified_name}/datasets', 'get', 200, l.json());
  });

  it('delegates and the other end’s owner may edit; others may not, and can see it read-only', async () => {
    expect((await inj('POST', I, as('dan'), { name: 'Delegate made' })).statusCode).toBe(201);
    expect((await inj('POST', I, as('ben'), { name: 'Target made' })).statusCode).toBe(201);
    const nope = await inj('POST', I, as('cat'), { name: 'Not mine' });
    expect(nope.statusCode).toBe(403);
    expect((await inj('GET', I, as('cat'))).json().datasets.every((d: { can_edit: boolean }) => d.can_edit === false)).toBe(true);
    expect((await inj('PATCH', '/v1/datasets/int-1--customer-accounts', as('cat'), { description: 'x' })).statusCode).toBe(403);
  });

  it('refuses agents, duplicates, unknown references and a missing name', async () => {
    expect((await inj('POST', I, { 'x-dmc-user': 'copilot', 'x-dmc-kind': 'service', 'x-dmc-acting-for': 'amy' }, { name: 'By agent' })).statusCode).toBe(403);
    expect((await inj('POST', I, as('amy'), body)).statusCode).toBe(409);
    const bad = await inj('POST', I, as('amy'), { name: 'Bad refs', categories: ['col-1'], columns: ['gl:customer-pii'], record_class: 'nope' });
    expect(bad.statusCode).toBe(422);
    expect(bad.json().errors.map((e: { path: string }) => e.path).sort()).toEqual(['categories.0', 'columns.0', 'record_class']);
    expect((await inj('POST', I, as('amy'), {})).statusCode).toBe(422);
    expect((await inj('POST', '/v1/integrations/nope/datasets', as('amy'), { name: 'x' })).statusCode).toBe(404);
  });

  it('a dry run changes nothing', async () => {
    const r = await inj('POST', `${I}?dry_run=true`, as('amy'), { name: 'Dry one' });
    expect(r.statusCode).toBe(200);
    expect((await inj('GET', I, as('amy'))).json().datasets.map((d: { name: string }) => d.name)).not.toContain('Dry one');
  });

  it('an update changes what is sent and replaces lists', async () => {
    const r = await inj('PATCH', '/v1/datasets/int-1--customer-accounts', as('dan'), { business_context: 'Now also finance', columns: ['col-2'], record_class: null });
    expect(r.statusCode).toBe(200);
    contract('/v1/datasets/{qualified_name}', 'patch', 200, r.json());
    const d = (await inj('GET', I, as('amy'))).json().datasets.find((x: { qualified_name: string }) => x.qualified_name === 'int-1--customer-accounts');
    expect(d).toMatchObject({ business_context: 'Now also finance', description: 'Open accounts', columns: ['col-2'], categories: ['gl:customer-pii'] });
    expect(d.record_class).toBeUndefined();
    expect((await inj('PATCH', '/v1/datasets/none', as('amy'), { name: 'x' })).statusCode).toBe(404);
  });
});
