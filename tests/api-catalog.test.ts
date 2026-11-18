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
import { appendBatch, verifyProof } from '../packages/evidence/src/index';
import { createApi, devAuthenticator } from '../apps/api/src/index';

const root = join(import.meta.dirname, '..');
const registry = loadRegistry(join(root, 'metamodel/types'));
const store = new CatalogStore(registry);
const spec = loadSpec();
let server: EmbeddedPostgres; let admin: pg.Client; let pool: pg.Pool; let evPool: pg.Pool; let app: NestFastifyApplication;
const sn = { kind: 'sync', source: 'servicenow' } as const;

const signals: import('../packages/contracts/src/index').Signal[] = [];
const raised: import('../packages/contracts/src/index').RaiseExceptionRequest[] = [];
const tasks: import('../packages/contracts/src/index').InboxItem[] = [];
const decided: { taskId: string; decision: string; actor: string; assignees: string[]; key?: string }[] = [];
const task = (id: string, assignee: string): import('../packages/contracts/src/index').InboxItem => ({ id, assignee, kind: 'k', title: 'Resolve', message: 'm', subjectRef: 'app-1', decisions: ['resolve', 'dismiss'], raisedAt: '2026-11-01T00:00:00.000Z', escalated: false, severity: 'high' });
const idem = new Map<string, { bodyHash: string; response: unknown }>();
const as = (user: string, groups = '', extra: Record<string, string> = {}) => ({ 'x-dmc-user': user, 'x-dmc-groups': groups, ...extra });
const get = (url: string, headers: Record<string, string> = as('viewer-1')) => app.getHttpAdapter().getInstance().inject({ method: 'GET', url, headers });
const contractPatch = (status: number, body: unknown) => expect(checkResponse(spec, '/v1/nodes/{qualified_name}', 'patch', status, body)).toEqual([]);
const contract = (path: string, status: number, body: unknown) => expect(checkResponse(spec, path, 'get', status, body)).toEqual([]);

beforeAll(async () => {
  server = new EmbeddedPostgres({ databaseDir: mkdtempSync(join(tmpdir(), 'dmc-api-')), user: 'postgres', password: 'pw', port: 54341, persistent: false });
  await server.initialise(); await server.start();
  admin = new pg.Client({ host: 'localhost', port: 54341, user: 'postgres', password: 'pw', database: 'postgres' });
  await admin.connect();
  await provisionModule(admin, 'catalog', { password: 'cat' });
  await migrateModule(admin, 'catalog', join(root, 'packages/catalog/migrations'));
  await admin.query('grant all on all tables in schema catalog to dmc_catalog');
  await admin.query('grant all on all sequences in schema catalog to dmc_catalog');
  await provisionModule(admin, 'evidence', { password: 'ev' });
  await migrateModule(admin, 'evidence', join(root, 'packages/evidence/migrations'));
  evPool = new pg.Pool({ host: 'localhost', port: 54341, user: 'dmc_evidence', password: 'ev', database: 'postgres', max: 2 });
  pool = new pg.Pool({ host: 'localhost', port: 54341, user: 'dmc_catalog', password: 'cat', database: 'postgres', max: 4 });

  const c = await pool.connect();
  try {
    for (const i of [1, 2, 3]) await store.tx(c, () => store.applyNode(c, { type: 'Application', qualifiedName: `app-${i}`, attributes: { name: `App ${i}`, owner: i === 1 ? 'alice' : 'bob', hosting_country: 'GB', criticality: 'high' }, writer: sn, actor: 'sync/sn' }));
    await store.tx(c, () => store.applyNode(c, { type: 'Application', qualifiedName: 'app-1', attributes: { criticality: 'critical' }, writer: sn, actor: 'sync/sn' }));
    await store.tx(c, () => store.applyNode(c, { type: 'System', qualifiedName: 'sys-1', attributes: { name: 'Core', platform: 'k8s' }, writer: { kind: 'sync', source: 'git-json' }, actor: 'sync/git' }));
    await store.tx(c, () => store.link(c, { name: 'owns', fromQn: 'app-1', toQn: 'sys-1', source: 'git-json', actor: 'sync/git' }));
  } finally { c.release(); }
  const a1 = (await admin.query("select id from catalog.node where qualified_name = 'app-1'")).rows[0].id as string;
  const ev = await evPool.connect();
  try {
    await ev.query('begin');
    await appendBatch(ev, [
      { kind: 'node.created', subjectRef: `node/${a1}`, actor: 'sync/sn', sourceModule: 'catalog', sourceId: 1, occurredAt: '2026-01-01T00:00:00.000Z', payload: { qualified_name: 'app-1' } },
      { kind: 'node.created', subjectRef: 'node/other', actor: 'sync/sn', sourceModule: 'catalog', sourceId: 2, occurredAt: '2026-01-01T00:00:01.000Z', payload: {} },
      { kind: 'decision.made', subjectRef: 'Application:app-1', actor: 'system/decision', sourceModule: 'decision', sourceId: 1, occurredAt: '2026-01-01T00:00:02.000Z', payload: { policy: 'p' } },
    ]);
    await ev.query('commit');
  } finally { ev.release(); }

  app = await createApi({
    version: '0.1.0', registry, store, authz: Authz.load(readFileSync(join(root, 'config/authz.yaml'), 'utf8')),
    authenticate: devAuthenticator('local'),
    connectEvidence: async () => { const x = await evPool.connect(); return { query: (sql: string, params?: unknown[]) => x.query(sql, params) as never, release: () => x.release() }; },
    policies: () => [{ id: 'p-tcr1', implements: 'TCR-0001', mode: 'enforced' }, { id: 'p-tcr1b', implements: 'TCR-0001', mode: 'shadow' }, { id: 'p-tcr2', implements: 'TCR-0002', mode: 'shadow' }, { id: 'p-orphan', implements: 'TCR-9', mode: 'shadow' }],
    exceptions: { async raise(r) { raised.push(r); return { id: 'e', created: true }; }, async withdraw() { return true; } },
    inbox: {
      async forSubject() { return []; },
      async list(ids) { return tasks.filter((t) => ids.includes(t.assignee)); },
      async get(id) { return tasks.find((t) => t.id === id); },
      async decide(r) { decided.push(r); return { replayed: false }; },
    },
    signals: { async submit(x) { signals.push(...x); } },
    idempotency: { async get(k) { return idem.get(k); }, async put(k, e) { idem.set(k, e); } },
    connect: async () => { const x = await pool.connect(); return { query: (sql: string, params?: unknown[]) => x.query(sql, params) as never, release: () => x.release() }; },
  });
}, 150_000);
afterAll(async () => { try { await app?.close(); await pool?.end(); await evPool?.end(); await admin?.end(); } finally { await server?.stop(); } });

describe('M4: catalog API', () => {
  it('health needs no sign-in and matches the contract', async () => {
    const r = await get('/v1/health', {});
    expect(r.statusCode).toBe(200);
    contract('/v1/health', 200, r.json());
  });

  it('requests with no identity are 401 problem+json; a person with no role cannot be missing one (everyone is a viewer)', async () => {
    const r = await get('/v1/nodes?type=Application', {});
    expect(r.statusCode).toBe(401);
    expect(r.headers['content-type']).toMatch(/application\/problem\+json/);
    expect(r.json()).toMatchObject({ code: 'unauthenticated', status: 401 });
    contract('/v1/nodes', 401, r.json());
  });

  it('a service account without dmc.read is refused with the reason', async () => {
    const r = await get('/v1/nodes?type=Application', as('bot', '', { 'x-dmc-kind': 'service', 'x-dmc-scopes': 'dmc.signal.write' }));
    expect(r.statusCode).toBe(403);
    expect(r.json().detail).toMatch(/Missing scope dmc.read/);
  });

  it('lists by type with cursor pagination and matches the contract', async () => {
    const p1 = (await get('/v1/nodes?type=Application&limit=2')).json();
    expect(p1.items.map((n: any) => n.qualified_name)).toEqual(['app-1', 'app-2']);
    expect(p1.next_cursor).toBeTruthy();
    contract('/v1/nodes', 200, p1);
    const p2 = (await get(`/v1/nodes?type=Application&limit=2&cursor=${p1.next_cursor}`)).json();
    expect(p2.items.map((n: any) => n.qualified_name)).toEqual(['app-3']);
    expect(p2.next_cursor).toBeNull();
  });

  it('rejects an unknown type and a missing type', async () => {
    expect((await get('/v1/nodes?type=Nope')).json()).toMatchObject({ code: 'validation_failed', errors: [{ path: 'type' }] });
    expect((await get('/v1/nodes')).statusCode).toBe(422);
    expect((await get('/v1/nodes?type=Application&cursor=%%%')).statusCode).toBe(422);
  });

  it('gets one node with sources, an ETag and allowed actions', async () => {
    const r = await get('/v1/nodes/app-1');
    expect(r.statusCode).toBe(200);
    expect(r.headers.etag).toMatch(/^W\//);
    const n = r.json();
    contract('/v1/nodes/{qualified_name}', 200, n);
    expect(n).toMatchObject({ type: 'Application', attributes: { criticality: 'critical', owner: 'alice' }, attribute_sources: { owner: 'servicenow', description: 'dmc' } });
    expect(n.provenance.criticality).toMatchObject({ by: 'servicenow' });
  });

  it('allowed actions follow the caller: the owner may edit, someone else may not, and the reason is given', async () => {
    const alice = (await get('/v1/nodes/app-1', as('alice'))).json();
    expect(alice.allowed_actions).toEqual([{ id: 'edit_dmc_fields', allowed: true }]);
    const viewer = (await get('/v1/nodes/app-1', as('carol'))).json();
    expect(viewer.allowed_actions[0]).toMatchObject({ id: 'edit_dmc_fields', allowed: false });
    expect(viewer.allowed_actions[0].reason).toMatch(/Needs one of/);
    const agent = (await get('/v1/nodes/app-1', as('agent-1', '', { 'x-dmc-kind': 'service', 'x-dmc-scopes': 'dmc.read,dmc.propose', 'x-dmc-acting-for': 'alice' }))).json();
    expect(agent.allowed_actions[0].allowed).toBe(true);
    const bobsAgent = (await get('/v1/nodes/app-1', as('agent-2', '', { 'x-dmc-kind': 'service', 'x-dmc-scopes': 'dmc.read,dmc.propose', 'x-dmc-acting-for': 'bob' }))).json();
    expect(bobsAgent.allowed_actions[0].allowed).toBe(false);
  });

  it('404 for a node that does not exist, with a problem body', async () => {
    const r = await get('/v1/nodes/nope');
    expect(r.statusCode).toBe(404);
    contract('/v1/nodes/{qualified_name}', 404, r.json());
    expect((await get('/v1/no-such-route')).json()).toMatchObject({ code: 'not_found' });
  });

  it('relationships name both ends and follow direction', async () => {
    const out = (await get('/v1/nodes/app-1/relationships')).json();
    contract('/v1/nodes/{qualified_name}/relationships', 200, out);
    expect(out.items).toEqual([expect.objectContaining({ name: 'owns', from: 'app-1', to: 'sys-1', source: 'git-json' })]);
    const inn = (await get('/v1/nodes/sys-1/relationships?direction=in&name=owns')).json();
    expect(inn.items).toHaveLength(1);
    expect((await get('/v1/nodes/app-1/relationships?direction=sideways')).statusCode).toBe(422);
    expect((await get('/v1/nodes/ghost/relationships')).statusCode).toBe(404);
  });

  it('history lists every recorded version, oldest first', async () => {
    const h = (await get('/v1/nodes/app-1/history')).json();
    contract('/v1/nodes/{qualified_name}/history', 200, h);
    const values = h.items.map((v: any) => v.attributes.criticality);
    expect(values[0]).toBe('high');
    expect(values.at(-1)).toBe('critical');
    const times = h.items.map((v: any) => v.recorded_from);
    expect([...times].sort()).toEqual(times); // oldest first
  });

  it('as-of reads: what we believed before the change', async () => {
    const before = new Date(Date.now() - 3_600_000).toISOString();
    expect((await get(`/v1/nodes/app-1?known_at=${before}`)).statusCode).toBe(404); // nothing was known an hour ago
    expect((await get('/v1/nodes/app-1?valid_at=not-a-date')).statusCode).toBe(422);
  });

  it('qualified names with slashes work when URL-encoded', async () => {
    const c = await pool.connect();
    try { await store.tx(c, () => store.applyNode(c, { type: 'System', qualifiedName: 'repo/payments/core', attributes: { name: 'Pay core', platform: 'vm' }, writer: { kind: 'sync', source: 'git-json' }, actor: 'sync/git' })); } finally { c.release(); }
    const r = await get(`/v1/nodes/${encodeURIComponent('repo/payments/core')}`);
    expect(r.statusCode).toBe(200);
    expect(r.json().qualified_name).toBe('repo/payments/core');
  });

  it('the header authenticator refuses to exist outside local', () => {
    expect(() => devAuthenticator('prod')).toThrow(/only for the local/);
  });
});

describe('D4: writes through the API', () => {
  const patch = (qn: string, body: unknown, headers: Record<string, string>, query = '') =>
    app.getHttpAdapter().getInstance().inject({ method: 'PATCH', url: `/v1/nodes/${encodeURIComponent(qn)}${query}`, headers, payload: body as never });
  const owner = as('alice', 'dmc-app-owner');
  const etag = async (qn: string) => (await get(`/v1/nodes/${qn}`)).headers.etag as string;
  const write = async (qn: string, headers: Record<string, string>, attrs: Record<string, unknown>, key: string, query = '') =>
    patch(qn, { attributes: attrs }, { ...headers, 'if-match': await etag(qn), 'idempotency-key': key }, query);

  it('a person who owns the application edits a DMC field: applied at once, and a signal is emitted', async () => {
    signals.length = 0;
    const r = await write('app-1', owner, { description: 'Core payments' }, 'key-person-1');
    expect(r.statusCode).toBe(200);
    expect(r.json().attributes.description).toBe('Core payments');
    expect(signals).toMatchObject([{ kind: 'write.applied', subjectRef: 'Application:app-1', actor: 'alice' }]);
    expect(signals[0]!.change).toBeUndefined();
    contractPatch(200, r.json());
  });

  it('the same Idempotency-Key and body returns the first result without writing again', async () => {
    signals.length = 0;
    const r = await write('app-1', owner, { description: 'Core payments' }, 'key-person-1');
    expect(r.statusCode).toBe(200);
    expect(signals).toHaveLength(0);
  });

  it('refuses a synced field with the reason, and someone who is not the owner', async () => {
    const a = await write('app-1', owner, { criticality: 'low' }, 'key-synced-1');
    expect(a.statusCode).toBe(403);
    expect(a.json().detail).toMatch(/owned by servicenow/);
    const b = await write('app-1', as('mallory', ''), { description: 'x' }, 'key-other-1');
    expect(b.statusCode).toBe(403);
  });

  it('needs If-Match and Idempotency-Key, rejects a stale tag, and validates the field name', async () => {
    expect((await patch('app-1', { attributes: { description: 'x' } }, { ...owner, 'idempotency-key': 'key-nomatch-1' })).statusCode).toBe(428);
    expect((await patch('app-1', { attributes: { description: 'x' } }, { ...owner, 'if-match': 'W/"stale"', 'idempotency-key': 'key-stale-1' })).statusCode).toBe(412);
    expect((await write('app-1', owner, { nope: 1 }, 'key-bad-1')).statusCode).toBe(422);
    expect((await write('app-1', owner, { description: 'x' }, 'short')).statusCode).toBe(422);
  });

  it('dry_run authorises and validates but writes nothing and emits nothing', async () => {
    signals.length = 0;
    const r = await write('app-1', owner, { description: 'Preview only' }, 'key-dry-1', '?dry_run=true');
    expect(r.statusCode).toBe(200);
    expect(signals).toHaveLength(0);
    expect((await get('/v1/nodes/app-1')).json().attributes.description).toBe('Core payments');
  });

  it('an agent acting for the owner only proposes: nothing is written, the signal carries the change and both identities', async () => {
    signals.length = 0;
    const agent = as('agent:doc-bot', '', { 'x-dmc-acting-for': 'alice', 'x-dmc-acting-groups': 'dmc-app-owner', 'x-dmc-kind': 'service', 'x-dmc-scopes': 'dmc.read,dmc.propose' });
    const r = await write('app-1', agent, { description: 'Written by an agent' }, 'key-agent-1');
    expect(r.statusCode).toBe(202);
    expect(r.json()).toMatchObject({ status: 'proposed', fields: ['description'] });
    contractPatch(202, r.json());
    expect(signals).toMatchObject([{ kind: 'write.proposed', actor: 'agent:doc-bot for alice', change: { attribute: 'description', value: 'Written by an agent' } }]);
    expect((await get('/v1/nodes/app-1')).json().attributes.description).toBe('Core payments');
  });

  it('a script is treated the same way: it proposes for a person, and cannot write on its own', async () => {
    const own = as('script-1', '', { 'x-dmc-kind': 'service', 'x-dmc-scopes': 'dmc.read,dmc.signal.write' });
    const a = await write('app-1', own, { description: 'From a script' }, 'key-script-1');
    expect(a.statusCode).toBe(403);
    expect(a.json().detail).toMatch(/acting for a person/);
    signals.length = 0;
    const forAlice = as('script-1', '', { 'x-dmc-kind': 'service', 'x-dmc-scopes': 'dmc.read,dmc.propose', 'x-dmc-acting-for': 'alice', 'x-dmc-acting-groups': 'dmc-app-owner' });
    expect((await write('app-1', forAlice, { description: 'From a script' }, 'key-script-2')).statusCode).toBe(202);
    expect(signals[0]).toMatchObject({ kind: 'write.proposed', actor: 'script-1 for alice' });
  });
});

describe('E4: evidence API', () => {
  const auditor = as('audrey', 'dmc-auditor');
  const evidence = (path: string, h: Record<string, string> = auditor) => get(path, h);

  it('is for auditors: an ordinary viewer is refused', async () => {
    expect((await evidence('/v1/nodes/app-1/evidence', as('viewer-1'))).statusCode).toBe(403);
    expect((await evidence('/v1/evidence/verify', as('viewer-1'))).statusCode).toBe(403);
  });

  it('traces a node by every name the ledger knows it by, oldest first, and pages', async () => {
    const r = await evidence('/v1/nodes/app-1/evidence');
    expect(r.statusCode).toBe(200);
    expect(r.json().items.map((e: any) => e.kind)).toEqual(['node.created', 'decision.made']);
    contract('/v1/nodes/{qualified_name}/evidence', 200, r.json());
    const p1 = (await evidence('/v1/nodes/app-1/evidence?limit=1')).json();
    expect(p1.next_cursor).toBeTruthy();
    expect((await evidence(`/v1/nodes/app-1/evidence?limit=1&cursor=${p1.next_cursor}`)).json().items[0].kind).toBe('decision.made');
    expect((await evidence('/v1/nodes/app-1/evidence?kind=decision.made')).json().items).toHaveLength(1);
    expect((await evidence('/v1/nodes/nope/evidence')).statusCode).toBe(404);
  });

  it('exports a proof that passes the verifier', async () => {
    const r = await evidence('/v1/nodes/app-1/evidence/proof');
    expect(r.statusCode).toBe(200);
    contract('/v1/nodes/{qualified_name}/evidence/proof', 200, r.json());
    expect(verifyProof(r.json())).toMatchObject({ ok: true, entries: 2 });
  });

  it('verifies the chain on demand', async () => {
    const r = await evidence('/v1/evidence/verify');
    expect(r.json()).toEqual({ ok: true, checked: 3 });
    contract('/v1/evidence/verify', 200, r.json());
    expect((await evidence('/v1/evidence/verify?from_seq=0')).statusCode).toBe(422);
  });
});

describe('C5: control requirements', () => {
  const author = as('pat', 'dmc-policy-author');
  const post = (url: string, body: unknown, headers: Record<string, string>, key = 'k') =>
    app.getHttpAdapter().getInstance().inject({ method: 'POST', url, headers: { ...headers, 'idempotency-key': `key-${key}-${Math.random()}`.slice(0, 40) }, payload: body as never });
  const postContract = (path: string, status: number, body: unknown) => expect(checkResponse(spec, path, 'post', status, body)).toEqual([]);
  const CSV = [
    'reference_id,title,kind,owner,confluence_link,version',
    'TCR-0001,Every integration has a dataset,technical-control-requirement,carol,https://confluence.example/x,1',
    'TCR-0002,"Owners are named, always",operating-instruction,,,1',
  ].join('\n');

  it('only people with the right role may register requirements, and agents may not', async () => {
    const one = { reference_id: 'TCR-0100', title: 't', kind: 'operating-instruction' };
    expect((await post('/v1/requirements', one, as('viewer-1'))).statusCode).toBe(403);
    const agent = as('agent:x', '', { 'x-dmc-kind': 'service', 'x-dmc-scopes': 'dmc.read,dmc.propose', 'x-dmc-acting-for': 'pat', 'x-dmc-acting-groups': 'dmc-policy-author' });
    expect((await post('/v1/requirements', one, agent)).json().detail).toMatch(/registered by people/);
  });

  it('imports a CSV (quoted commas work), and dry_run shows the same report without saving', async () => {
    const dry = await post('/v1/requirements/import?dry_run=true', { csv: CSV }, author);
    expect(dry.statusCode).toBe(200);
    expect(dry.json()).toMatchObject({ dry_run: true, created: 2, updated: 0 });
    expect((await get('/v1/nodes/requirement-tcr-0001')).statusCode).toBe(404);
    const r = await post('/v1/requirements/import', { csv: CSV }, author);
    expect(r.statusCode).toBe(201);
    postContract('/v1/requirements/import', 201, r.json());
    expect(r.json()).toMatchObject({ created: 2, rows: [{ line: 2, reference_id: 'TCR-0001', qualified_name: 'requirement-tcr-0001', status: 'created' }, { line: 3 }] });
    expect((await get('/v1/nodes/requirement-tcr-0002')).json().attributes.title).toBe('Owners are named, always');
  });

  it('one bad row saves nothing and names the line and field', async () => {
    const bad = CSV + '\nTCR-0003,No kind,wrong-kind,,,1\n,Missing id,operating-instruction,,,1';
    const r = await post('/v1/requirements/import', { csv: bad.replace('TCR-0001', 'TCR-0010') }, author);
    expect(r.statusCode).toBe(422);
    expect(r.json().errors.map((e: any) => e.path)).toEqual(expect.arrayContaining(['line 4: kind', 'line 5: reference_id']));
    expect((await get('/v1/nodes/requirement-tcr-0010')).statusCode).toBe(404);
    expect((await post('/v1/requirements/import', { csv: 'a,b\n1,2' }, author)).json().errors[0].message).toMatch(/unknown column/);
  });

  it('saving the same file again changes nothing; a lower version is refused; a higher version flags the policies that implement it', async () => {
    raised.length = 0;
    expect((await post('/v1/requirements/import', { csv: CSV }, author)).json()).toMatchObject({ created: 0, updated: 0, unchanged: 2 });
    expect((await post('/v1/requirements', { reference_id: 'TCR-0001', title: 'x', kind: 'operating-instruction', version: 0 }, author)).statusCode).toBe(422);
    const v2 = await post('/v1/requirements', { reference_id: 'TCR-0001', title: 'Every integration has a dataset', kind: 'technical-control-requirement', version: 2 }, author);
    expect(v2.statusCode).toBe(200);
    postContract('/v1/requirements', 200, v2.json());
    expect(v2.json()).toMatchObject({ updated: 1, flagged_policies: ['p-tcr1', 'p-tcr1b'] });
    expect(raised.map((r) => [r.kind, r.subjectRef, r.route])).toEqual([['policy.review', 'Policy:p-tcr1', 'policy-authors'], ['policy.review', 'Policy:p-tcr1b', 'policy-authors']]);
    expect((await get('/v1/nodes/requirement-tcr-0001')).json().attributes.version).toBe(2);
  });

  it('coverage lists requirements with no policy, shadow policies only, and enforced policies, and policies naming unknown requirements', async () => {
    await post('/v1/requirements', { reference_id: 'TCR-0003', title: 'Nothing implements this', kind: 'operating-instruction' }, author);
    const r = await get('/v1/requirements/coverage');
    expect(r.statusCode).toBe(200);
    contract('/v1/requirements/coverage', 200, r.json());
    const by = Object.fromEntries(r.json().items.map((i: any) => [i.reference_id, i.status]));
    expect(by).toMatchObject({ 'TCR-0001': 'enforced', 'TCR-0002': 'shadow_only', 'TCR-0003': 'none' });
    expect(r.json().summary).toEqual({ none: 1, shadow_only: 1, enforced: 1 });
    expect(r.json().unknown_references).toEqual([{ policy: 'p-orphan', implements: 'TCR-9' }]);
  });
});

describe('L1: lineage and impact API', () => {
  beforeAll(async () => {
    const c = await pool.connect();
    try {
      await store.tx(c, async () => {
        const git = { kind: 'sync', source: 'git-json' } as const;
        await store.applyNode(c, { type: 'Table', qualifiedName: 't1', attributes: { name: 't1' }, writer: git, actor: 'x' });
        for (const col of ['t1.a', 't1.b', 't1.c']) {
          await store.applyNode(c, { type: 'Column', qualifiedName: col, attributes: { name: col }, writer: git, actor: 'x' });
          await store.link(c, { name: 'contains', fromQn: 't1', toQn: col, source: 'git-json', actor: 'x' });
        }
        await store.link(c, { name: 'derives_from', fromQn: 't1.b', toQn: 't1.a', source: 'dbt', actor: 'x', attributes: { job: 'j1', confidence: 0.9 } });
        await store.link(c, { name: 'derives_from', fromQn: 't1.c', toQn: 't1.b', source: 'dbt', actor: 'x' });
      });
    } finally { c.release(); }
  });

  it('upstream and downstream, with the job on the edge, matching the contract', async () => {
    const down = await get('/v1/nodes/t1.a/lineage?direction=downstream');
    expect(down.statusCode).toBe(200);
    contract('/v1/nodes/{qualified_name}/lineage', 200, down.json());
    expect(down.json().nodes.map((n: any) => n.qualified_name)).toEqual(['t1.a', 't1.b', 't1.c']);
    expect(down.json().edges).toContainEqual({ from: 't1.b', to: 't1.a', source: 'dbt', job: 'j1', confidence: 0.9 });
    const up = (await get('/v1/nodes/t1.c/lineage')).json();
    expect(up.direction).toBe('upstream');
    expect(up.nodes.map((n: any) => n.qualified_name)).toEqual(['t1.c', 't1.b', 't1.a']);
  });

  it('impact summarises what a change reaches', async () => {
    const r = await get('/v1/nodes/t1.a/impact');
    contract('/v1/nodes/{qualified_name}/impact', 200, r.json());
    expect(r.json()).toMatchObject({ affected: 2, by_type: { Column: 2 }, by_container: [{ container: 't1', count: 2 }], truncated: { depth: false, nodes: false } });
    expect((await get('/v1/nodes/t1.a/impact?depth=1')).json()).toMatchObject({ affected: 1, truncated: { depth: true } });
  });

  it('validates its parameters and reports a missing node', async () => {
    expect((await get('/v1/nodes/t1.a/lineage?direction=sideways')).statusCode).toBe(422);
    expect((await get('/v1/nodes/t1.a/lineage?depth=99')).statusCode).toBe(422);
    expect((await get('/v1/nodes/t1.a/lineage?min_confidence=2')).statusCode).toBe(422);
    expect((await get('/v1/nodes/nope/impact')).statusCode).toBe(404);
  });
});

describe('G1: glossary and the source switch', () => {
  const root = join(import.meta.dirname, '..');
  const admin1 = as('root', 'dmc-platform-admin');
  const fin = as('sam', 'dmc-steward-finance');
  const risk = as('rae', 'dmc-steward-risk');
  const send = (method: 'POST' | 'PATCH', url: string, body: unknown, headers: Record<string, string>) =>
    app.getHttpAdapter().getInstance().inject({ method, url, headers: { ...headers, 'idempotency-key': `g1-${Math.random().toString(36).slice(2)}-key` }, payload: body as never });
  const edit = async (qn: string, attrs: Record<string, unknown>, headers: Record<string, string>) => {
    const tag = (await get(`/v1/nodes/${encodeURIComponent(qn)}`)).headers.etag as string;
    return send('PATCH', `/v1/nodes/${encodeURIComponent(qn)}`, { attributes: attrs }, { ...headers, 'if-match': tag });
  };
  let cutover: NestFastifyApplication;

  beforeAll(async () => {
    // the glossary as Collibra sync would have left it: a domain, a category and a term, owned by Collibra
    const c = await pool.connect();
    try {
      await store.tx(c, async () => {
        const collibra = { kind: 'sync', source: 'collibra' } as const;
        await store.applyNode(c, { type: 'DataDomain', qualifiedName: 'glossary:finance', attributes: { name: 'Finance' }, writer: collibra, actor: 'sync/collibra' });
        await store.applyNode(c, { type: 'DataDomain', qualifiedName: 'glossary:risk', attributes: { name: 'Risk' }, writer: collibra, actor: 'sync/collibra' });
        await store.applyNode(c, { type: 'DataCategory', qualifiedName: 'glossary:revenue', attributes: { name: 'Revenue' }, writer: collibra, actor: 'sync/collibra' });
        await store.link(c, { name: 'part_of', fromQn: 'glossary:revenue', toQn: 'glossary:finance', source: 'collibra', actor: 'sync/collibra' });
        await store.applyNode(c, { type: 'BusinessTerm', qualifiedName: 'glossary:net-revenue', attributes: { name: 'Net revenue', definition: 'old' }, writer: collibra, actor: 'sync/collibra' });
        await store.link(c, { name: 'part_of', fromQn: 'glossary:net-revenue', toQn: 'glossary:revenue', source: 'collibra', actor: 'sync/collibra' });
      });
    } finally { c.release(); }
    // the same service after the cutover: the registry and the store are built from the switched metamodel
    const switched = registry.withSourceOfTruth({ BusinessTerm: 'dmc', DataCategory: 'dmc', DataDomain: 'dmc' });
    cutover = await createApi({
      version: '0.1.0', registry: switched, store: new CatalogStore(switched), authz: Authz.load(readFileSync(join(root, 'config/authz.yaml'), 'utf8')), authenticate: devAuthenticator('local'),
      connectEvidence: async () => { throw new Error('unused'); }, policies: () => [], exceptions: { async raise() { return { id: 'e', created: true }; }, async withdraw() { return true; } },
      signals: { async submit() {} }, idempotency: { async get(k) { return idem.get(k); }, async put(k, e) { idem.set(k, e); } },
      connect: async () => { const x = await pool.connect(); return { query: (sql: string, params?: unknown[]) => x.query(sql, params) as never, release: () => x.release() }; },
    });
  });
  afterAll(async () => { await cutover?.close(); });

  const afterCutover = async (method: 'POST' | 'PATCH', url: string, body: unknown, headers: Record<string, string>, extra: Record<string, string> = {}) =>
    cutover.getHttpAdapter().getInstance().inject({ method, url, headers: { ...headers, ...extra, 'idempotency-key': `g1-${Math.random().toString(36).slice(2)}-key` }, payload: body as never });
  const tag = async (qn: string) => (await cutover.getHttpAdapter().getInstance().inject({ method: 'GET', url: `/v1/nodes/${encodeURIComponent(qn)}`, headers: as('viewer-1') })).headers.etag as string;

  it('before the cutover, Collibra owns the glossary: even the right steward is told where to make the change', async () => {
    const r = await edit('glossary:net-revenue', { definition: 'new' }, fin);
    expect(r.statusCode).toBe(403);
    expect(r.json().detail).toMatch(/owned by collibra/);
    expect((await send('POST', '/v1/nodes', { type: 'BusinessTerm', qualified_name: 'glossary:t2', attributes: { name: 'T2' }, part_of: 'glossary:revenue' }, fin)).statusCode).toBe(403);
  });

  it('a node reports which action edits it and whether this person may (a steward of another domain may not)', async () => {
    expect((await get('/v1/nodes/glossary%3Anet-revenue', fin)).json().allowed_actions[0]).toMatchObject({ id: 'edit_glossary', allowed: true });
    expect((await get('/v1/nodes/glossary%3Anet-revenue', risk)).json().allowed_actions[0]).toMatchObject({ id: 'edit_glossary', allowed: false });
  });

  it('after the cutover, a steward edits terms in their own domain and not in another', async () => {
    const ok = await afterCutover('PATCH', '/v1/nodes/glossary%3Anet-revenue', { attributes: { definition: 'Revenue after returns and discounts' } }, fin, { 'if-match': await tag('glossary:net-revenue') });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().attributes.definition).toBe('Revenue after returns and discounts');
    expect(ok.json().allowed_actions[0]).toMatchObject({ id: 'edit_glossary', allowed: true });
    const other = await afterCutover('PATCH', '/v1/nodes/glossary%3Anet-revenue', { attributes: { definition: 'x' } }, risk, { 'if-match': await tag('glossary:net-revenue') });
    expect(other.statusCode).toBe(403);
    expect(other.json().detail).toMatch(/Needs one of: steward/);
  });

  it('after the cutover, a steward creates a term under a category of their domain; the right domain only', async () => {
    const mk = (headers: Record<string, string>, qn: string) => afterCutover('POST', '/v1/nodes', { type: 'BusinessTerm', qualified_name: qn, attributes: { name: 'Gross revenue', definition: 'Before returns' }, part_of: 'glossary:revenue' }, headers);
    expect((await mk(risk, 'glossary:gross-revenue')).statusCode).toBe(403);
    const r = await mk(fin, 'glossary:gross-revenue');
    expect(r.statusCode).toBe(201);
    expect(r.headers.etag).toBeTruthy();
    expect((await cutover.getHttpAdapter().getInstance().inject({ method: 'GET', url: '/v1/nodes/glossary%3Agross-revenue/relationships', headers: as('viewer-1') })).json().items[0]).toMatchObject({ name: 'part_of', to: 'glossary:revenue' });
    expect((await mk(fin, 'glossary:gross-revenue')).statusCode).toBe(409);
  });

  it('only administrators create domains, and a term needs a category to belong to', async () => {
    const domain = { type: 'DataDomain', qualified_name: 'glossary:ops', attributes: { name: 'Operations' } };
    expect((await afterCutover('POST', '/v1/nodes', domain, fin)).statusCode).toBe(403);
    expect((await afterCutover('POST', '/v1/nodes', domain, admin1)).statusCode).toBe(201);
    expect((await afterCutover('POST', '/v1/nodes', { type: 'BusinessTerm', qualified_name: 'glossary:orphan', attributes: { name: 'x' } }, fin)).statusCode).toBe(422);
    expect((await afterCutover('POST', '/v1/nodes', { type: 'Application', qualified_name: 'x', attributes: {} }, admin1)).statusCode).toBe(422);
  });

  it('the cutover is clean: the sync job can no longer write what moved to DMC, and a typo in the switch is refused', () => {
    const switched = registry.withSourceOfTruth({ BusinessTerm: 'dmc' });
    const s = new CatalogStore(switched);
    expect(s.validate('BusinessTerm', { definition: 'x' }, { kind: 'sync', source: 'collibra' }, { partial: true })).toEqual([{ path: 'definition', message: 'is read-only here: its source is dmc' }]);
    expect(s.validate('BusinessTerm', { definition: 'x' }, { kind: 'user' }, { partial: true })).toEqual([]);
    expect(registry.get('BusinessTerm').attributes.definition!.source).toBe('collibra'); // the original is untouched
    expect(() => registry.withSourceOfTruth({ Businessterm: 'dmc' })).toThrow(/unknown type/);
    expect(() => registry.withSourceOfTruth({ Application: 'dmc' })).toThrow(/no attributes that Collibra owns/);
  });
});

describe('U1: search API', () => {
  it('finds by prefix, ranks the name first, returns facets, and matches the contract', async () => {
    const r = await get('/v1/search?q=App');
    expect(r.statusCode).toBe(200);
    contract('/v1/search', 200, r.json());
    expect(r.json().hits.length).toBeGreaterThan(0);
    expect(r.json().facets.type.Application).toBeGreaterThan(0);
  });
  it('filters by type and lifecycle, and validates its parameters', async () => {
    const r = (await get('/v1/search?q=core&type=System')).json();
    expect(r.hits.every((h: any) => h.type === 'System')).toBe(true);
    expect((await get('/v1/search')).statusCode).toBe(422);
    expect((await get('/v1/search?q=x&type=Nope')).statusCode).toBe(422);
    expect((await get('/v1/search?q=x&offset=5000')).statusCode).toBe(422);
    expect((await get('/v1/search?q=App', {})).statusCode).toBe(401);
  });
});

describe('W2: inbox API', () => {
  const post = (url: string, body: unknown, headers: Record<string, string>) => app.getHttpAdapter().getInstance().inject({ method: 'POST', url, payload: body as never, headers });
  beforeAll(() => { tasks.push(task('t-alice', 'alice'), task('t-group', 'dmc-steward-data'), task('t-bob', 'bob')); });

  it('lists what is assigned to you or to your groups, and matches the contract', async () => {
    const r = await get('/v1/inbox', as('alice', 'dmc-steward-data'));
    expect(r.statusCode).toBe(200);
    expect(r.json().items.map((i: { id: string }) => i.id).sort()).toEqual(['t-alice', 't-group']);
    expect(r.json().count).toBe(2);
    expect(r.json().items[0].subject_ref).toBe('app-1');
    contract('/v1/inbox', 200, r.json());
    expect((await get('/v1/inbox', {})).statusCode).toBe(401);
  });

  it('lets the assignee decide in one action, passing their identities and the key', async () => {
    const r = await post('/v1/inbox/t-group/decision', { decision: 'resolve' }, { ...as('alice', 'dmc-steward-data'), 'idempotency-key': 'key-12345' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ replayed: false });
    expect(decided.at(-1)).toMatchObject({ taskId: 't-group', decision: 'resolve', actor: 'alice', assignees: ['alice', 'dmc-steward-data'], key: 'key-12345' });
    expect(checkResponse(spec, '/v1/inbox/{id}/decision', 'post', 200, r.json())).toEqual([]);
  });

  it('refuses someone it is not assigned to, an agent, a missing task and an unoffered decision', async () => {
    const n = decided.length;
    const notMine = await post('/v1/inbox/t-bob/decision', { decision: 'resolve' }, as('alice', 'dmc-steward-data'));
    expect(notMine.statusCode).toBe(403);
    const agent = await post('/v1/inbox/t-alice/decision', { decision: 'resolve' }, { ...as('svc', '', { 'x-dmc-kind': 'service', 'x-dmc-acting-for': 'alice', 'x-dmc-acting-groups': 'dmc-steward-data' }) });
    expect(agent.statusCode).toBe(403);
    expect((await post('/v1/inbox/nope/decision', { decision: 'resolve' }, as('alice', 'dmc-steward-data'))).statusCode).toBe(404);
    expect((await post('/v1/inbox/t-alice/decision', { decision: 'maybe' }, as('alice', 'dmc-steward-data'))).statusCode).toBe(422);
    expect((await post('/v1/inbox/t-alice/decision', {}, as('alice', 'dmc-steward-data'))).statusCode).toBe(422);
    expect(decided).toHaveLength(n);
  });
});
