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
import type { Signal } from '../packages/contracts/src/index';
import { createApi, devAuthenticator } from '../apps/api/src/index';

const root = join(import.meta.dirname, '..');
const registry = loadRegistry(join(root, 'metamodel/types'));
const store = new CatalogStore(registry);
const spec = loadSpec();
let server: EmbeddedPostgres; let admin: pg.Client; let pool: pg.Pool; let evPool: pg.Pool; let app: NestFastifyApplication;
const signals: Signal[] = [];
const linkTasks: import('../packages/contracts/src/index').TaskStatus[] = [];
const idem = new Map<string, { bodyHash: string; response: unknown }>();
const owner = { 'x-dmc-user': 'olive', 'x-dmc-groups': 'dmc-scope-owner' };
const other = { 'x-dmc-user': 'oscar', 'x-dmc-groups': 'dmc-scope-owner' };
const inj = (method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, headers: Record<string, string>, payload?: unknown) =>
  app.getHttpAdapter().getInstance().inject({ method, url, headers: { ...headers, ...(method === 'GET' ? {} : { 'idempotency-key': `k-${Math.random().toString(36).slice(2)}-xx` }) }, payload: payload as never });
const S = '/v1/scopes/scope-pra110';
const contract = (path: string, m: string, status: number, body: unknown) => expect(checkResponse(spec, path, m, status, body)).toEqual([]);

beforeAll(async () => {
  server = new EmbeddedPostgres({ databaseDir: mkdtempSync(join(tmpdir(), 'dmc-scope-')), user: 'postgres', password: 'pw', port: 54349, persistent: false });
  await server.initialise(); await server.start();
  admin = new pg.Client({ host: 'localhost', port: 54349, user: 'postgres', password: 'pw', database: 'postgres' });
  await admin.connect();
  for (const m of ['catalog', 'evidence']) {
    await provisionModule(admin, m, { password: m });
    await migrateModule(admin, m, join(root, `packages/${m}/migrations`));
    await admin.query(`grant all on all tables in schema ${m} to dmc_${m}`); await admin.query(`grant all on all sequences in schema ${m} to dmc_${m}`);
  }
  pool = new pg.Pool({ host: 'localhost', port: 54349, user: 'dmc_catalog', password: 'catalog', database: 'postgres', max: 4 });
  evPool = new pg.Pool({ host: 'localhost', port: 54349, user: 'dmc_evidence', password: 'evidence', database: 'postgres', max: 2 });
  const c = await pool.connect();
  const w = { kind: 'sync', source: 'scope-sources' } as const;
  try {
    await store.tx(c, () => store.applyNode(c, { type: 'Scope', qualifiedName: 'scope-pra110', attributes: { name: 'PRA110', owner: 'olive', kind: 'regulatory-return' }, writer: w, actor: 'sync/aris' }));
    for (const i of ['int-1', 'int-2']) await store.tx(c, () => store.applyNode(c, { type: 'Integration', qualifiedName: i, attributes: { status: 'live' }, writer: { kind: 'sync', source: 'servicenow' }, actor: 'sync/sn' }));
  } finally { c.release(); }
  const lease = (p: pg.Pool) => async () => { const x = await p.connect(); return { query: (s: string, a?: unknown[]) => x.query(s, a) as never, release: () => x.release() }; };
  app = await createApi({
    version: '0.1.0', registry, store, authz: Authz.load(readFileSync(join(root, 'config/authz.yaml'), 'utf8')), authenticate: devAuthenticator('local'),
    connect: lease(pool), connectEvidence: lease(evPool), policies: () => [],
    exceptions: { async raise() { return { id: 'e', created: true }; }, async withdraw() { return true; } },
    inbox: { async forSubject() { return linkTasks; }, async list() { return []; }, async get() { return undefined; }, async decide() { return { replayed: false }; } },
    signals: { async submit(x) { signals.push(...x); } },
    idempotency: { async get(k) { return idem.get(k); }, async put(k, e) { idem.set(k, e); } },
  });
}, 150_000);
afterAll(async () => { try { await app?.close(); await pool?.end(); await evPool?.end(); await admin?.end(); } finally { await server?.stop(); } });

describe('C1: scopes', () => {
  it('cannot be submitted while empty, and says what is missing', async () => {
    const r = await inj('POST', `${S}/submit`, owner);
    expect(r.statusCode).toBe(422);
    expect(r.json().errors.map((e: { path: string }) => e.path)).toEqual(['groups', 'flows']);
  });

  it('the owner builds groups, elements and flows', async () => {
    const g = await inj('POST', `${S}/groups`, owner, { name: 'Credit risk', order: 1 });
    expect(g.statusCode).toBe(201);
    expect(g.json().qualified_name).toBe('scope-pra110--credit-risk');
    contract('/v1/scopes/{qualified_name}/groups', 'post', 201, g.json());
    expect((await inj('POST', `${S}/groups`, owner, { name: 'Credit risk' })).statusCode).toBe(409);
    const e = await inj('POST', `${S}/groups/scope-pra110--credit-risk/elements`, owner, { name: 'Exposure at default', definition: 'Expected exposure', criticality: 'high' });
    expect(e.statusCode).toBe(201);
    expect((await inj('POST', `${S}/groups/nope/elements`, owner, { name: 'x' })).statusCode).toBe(404);
    expect((await inj('POST', `${S}/groups`, owner, {})).statusCode).toBe(422);
    const f = await inj('PUT', `${S}/flows`, owner, { integrations: ['int-1', 'int-2'] });
    expect(f.statusCode).toBe(200);
    contract('/v1/scopes/{qualified_name}/flows', 'put', 200, f.json());
    expect((await inj('PUT', `${S}/flows`, owner, { integrations: ['nope'] })).statusCode).toBe(422);
    const back = await inj('PUT', `${S}/flows`, owner, { integrations: ['int-1'] });   // int-2 is taken out again
    expect(back.json().integrations).toEqual(['int-1']);
    await inj('PUT', `${S}/flows`, owner, { integrations: ['int-1', 'int-2'] });
  });

  it('only the owner can change it: not another scope owner, not an agent', async () => {
    expect((await inj('POST', `${S}/groups`, other, { name: 'Market risk' })).statusCode).toBe(403);
    const agent = await inj('POST', `${S}/groups`, { 'x-dmc-user': 'svc', 'x-dmc-kind': 'service', 'x-dmc-acting-for': 'olive', 'x-dmc-acting-groups': 'dmc-scope-owner' }, { name: 'Market risk' });
    expect(agent.statusCode).toBe(403);
  });

  it('submit locks it, and a locked scope is read-only (structure and fields), with a signal for the policies', async () => {
    signals.length = 0;
    const r = await inj('POST', `${S}/submit`, owner);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ version: 1, status: 'submitted' });
    contract('/v1/scopes/{qualified_name}/submit', 'post', 200, r.json());
    expect(signals.map((s) => s.kind)).toEqual(['scope.submitted']);
    expect(signals[0]).toMatchObject({ subjectRef: 'Scope:scope-pra110', actor: 'olive' });
    const add = await inj('POST', `${S}/groups`, owner, { name: 'Market risk' });
    expect(add.statusCode).toBe(403);
    expect(add.json().detail).toMatch(/locked/i);
    expect((await inj('PUT', `${S}/flows`, owner, { integrations: [] })).statusCode).toBe(403);
    const patch = await inj('PATCH', '/v1/nodes/scope-pra110', { ...owner, 'if-match': (await inj('GET', '/v1/nodes/scope-pra110', owner)).headers.etag as string }, { attributes: { criticality: 'critical' } });
    expect(patch.statusCode).toBe(403);
    const d = (await inj('GET', S, owner)).json();
    expect(d).toMatchObject({ version: 1, status: 'submitted', locked: true, flows: ['int-1', 'int-2'] });
    expect(d.versions).toHaveLength(1);
    contract('/v1/scopes/{qualified_name}', 'get', 200, d);
  });

  it('an amendment is only for the owner, reopens it as version 2, and version 1 stays readable', async () => {
    const before = new Date().toISOString();
    expect((await inj('POST', `${S}/amend`, other)).statusCode).toBe(403);
    const a = await inj('POST', `${S}/amend`, owner);
    expect(a.statusCode).toBe(200);
    expect(a.json()).toMatchObject({ version: 2, status: 'amended' });
    expect((await inj('POST', `${S}/amend`, owner)).statusCode).toBe(409);  // already open
    expect((await inj('POST', `${S}/groups`, owner, { name: 'Market risk' })).statusCode).toBe(201);
    const now = (await inj('GET', S, owner)).json();
    expect(now).toMatchObject({ version: 2, status: 'amended', locked: false });
    expect(now.groups.map((g: { name: string }) => g.name)).toEqual(['Credit risk', 'Market risk']);
    const v1 = (await inj('GET', `${S}?known_at=${encodeURIComponent(before)}`, owner)).json();
    expect(v1).toMatchObject({ version: 1, status: 'submitted' });
    expect(v1.groups.map((g: { name: string }) => g.name)).toEqual(['Credit risk']);
    const sub = await inj('POST', `${S}/submit`, owner);
    expect(sub.statusCode).toBe(422);   // the new group has no element yet
    await inj('POST', `${S}/groups/scope-pra110--market-risk/elements`, owner, { name: 'Trading book VaR' });
    expect((await inj('POST', `${S}/submit`, owner)).json()).toMatchObject({ version: 2, status: 'submitted' });
    expect((await inj('GET', S, owner)).json().versions.map((v: { version: number }) => v.version)).toEqual([1, 2]);
  });

  it('dry run checks and writes nothing; an unknown scope is 404; the history is evidenced by the catalog outbox', async () => {
    const r = await inj('POST', `${S}/amend?dry_run=true`, owner);
    expect(r.json(), JSON.stringify(r.json())).toEqual({ dry_run: true });
    expect((await inj('GET', S, owner)).json().status).toBe('submitted');
    expect((await inj('GET', '/v1/scopes/nope', owner)).statusCode).toBe(404);
    const ev = await admin.query("select event_type from catalog.outbox where event_type like 'node.%' or event_type like 'edge.%'");
    expect(ev.rowCount).toBeGreaterThan(5);
  });
});

describe('C2: delegation', () => {
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const dee = { 'x-dmc-user': 'dee' };   // no group at all: the right comes from the delegation
  const grant = (body: unknown, who = owner) => inj('POST', '/v1/delegations', who, body);
  const R = '/v1/scopes/scope-rris';
  let first = '';

  beforeAll(async () => {
    const c = await pool.connect();
    try {
      for (const [qn, o] of [['scope-rris', 'olive'], ['scope-other', 'olive'], ['scope-theirs', 'oscar']] as const)
        await store.tx(c, () => store.applyNode(c, { type: 'Scope', qualifiedName: qn, attributes: { name: qn, owner: o, kind: 'report' }, writer: { kind: 'sync', source: 'scope-sources' }, actor: 'sync/rris' }));
    } finally { c.release(); }
  });

  it('a delegate has no rights until the owner grants them', async () => {
    expect((await inj('POST', `${R}/groups`, dee, { name: 'Liquidity' })).statusCode).toBe(403);
    const g = await grant({ delegate: 'dee', covers: 'one-scope', scope: 'scope-rris', valid_to: day(90), reason: 'Cover while I am away' });
    expect(g.statusCode).toBe(201);
    contract('/v1/delegations', 'post', 201, g.json());
    expect(g.json()).toMatchObject({ owner: 'olive', delegate: 'dee', covers: 'one-scope', scope: 'scope-rris', active: true });
    first = g.json().qualified_name;
    const mine = (await inj('GET', '/v1/delegations', owner)).json();
    expect(mine.granted.map((x: { qualified_name: string }) => x.qualified_name)).toContain(first);
    expect((await inj('GET', '/v1/delegations', dee)).json().received.map((x: { qualified_name: string }) => x.qualified_name)).toEqual([first]);
    contract('/v1/delegations', 'get', 200, mine);
  });

  it('the delegate prepares and submits, and the ledger names them', async () => {
    expect((await inj('POST', `${R}/groups`, dee, { name: 'Liquidity' })).statusCode).toBe(201);
    expect((await inj('POST', `${R}/groups/scope-rris--liquidity/elements`, dee, { name: 'LCR' })).statusCode).toBe(201);
    expect((await inj('PUT', `${R}/flows`, dee, { integrations: ['int-1'] })).statusCode).toBe(200);
    expect((await inj('POST', `${R}/submit`, dee)).statusCode).toBe(200);
    const who = await admin.query("select distinct actor from catalog.node_version v join catalog.node n on n.id = v.node_id where n.qualified_name = 'scope-rris--liquidity'");
    expect(who.rows).toEqual([{ actor: 'dee' }]);
    expect((await inj('POST', `${R}/amend`, dee)).statusCode).toBe(200);   // same path as the owner
  });

  it('refuses a delegation longer than 12 months, in the past, to yourself, twice, or for a scope you do not own', async () => {
    const bad = (b: object) => grant({ delegate: 'zed', covers: 'one-scope', scope: 'scope-other', valid_to: day(30), ...b });
    const long = await bad({ valid_to: day(400) });
    expect(long.statusCode).toBe(422);
    expect(long.json().errors[0]).toMatchObject({ path: 'valid_to' });
    expect((await bad({ valid_from: day(-3) })).json().errors[0].path).toBe('valid_from');
    expect((await bad({ delegate: 'olive' })).json().errors[0].path).toBe('delegate');
    expect((await bad({ covers: 'some' })).statusCode).toBe(422);
    expect((await grant({ delegate: 'dee', covers: 'one-scope', scope: 'scope-rris', valid_to: day(30) })).statusCode).toBe(409);
    expect((await grant({ delegate: 'zed', covers: 'one-scope', scope: 'scope-other', valid_to: day(30) }, other)).statusCode).toBe(403);
    expect((await grant({ delegate: 'zed', covers: 'one-scope', scope: 'nope', valid_to: day(30) })).statusCode).toBe(404);
    expect((await grant({ delegate: 'zed', covers: 'one-scope', scope: 'scope-other', valid_to: day(30) }, { 'x-dmc-user': 'svc', 'x-dmc-kind': 'service', 'x-dmc-acting-for': 'olive', 'x-dmc-acting-groups': 'dmc-scope-owner' })).statusCode).toBe(403);
  });

  it('a delegate cannot delegate further or revoke; only the owner revokes, and then the right is gone', async () => {
    expect((await grant({ delegate: 'dan', covers: 'one-scope', scope: 'scope-rris', valid_to: day(30) }, dee)).statusCode).toBe(403);
    expect((await inj('POST', '/v1/delegations', { ...dee }, { delegate: 'dan', covers: 'all-scopes', valid_to: day(30) })).statusCode).toBe(403);
    expect((await inj('DELETE', `/v1/delegations/${first}`, dee)).statusCode).toBe(403);
    expect((await inj('DELETE', `/v1/delegations/${first}`, other)).statusCode).toBe(403);
    const r = await inj('DELETE', `/v1/delegations/${first}`, owner);
    expect(r.statusCode).toBe(200);
    contract('/v1/delegations/{id}', 'delete', 200, r.json());
    expect((await inj('POST', `${R}/groups`, dee, { name: 'Funding' })).statusCode).toBe(403);
    expect((await inj('DELETE', `/v1/delegations/${first}`, owner)).statusCode).toBe(404);
  });

  it('an expired delegate is refused', async () => {
    const g = (await grant({ delegate: 'eve', covers: 'one-scope', scope: 'scope-rris', valid_to: day(5) })).json();
    expect((await inj('POST', `${R}/groups`, { 'x-dmc-user': 'eve' }, { name: 'Funding' })).statusCode).toBe(201);
    const c = await pool.connect();
    try { await store.tx(c, () => store.applyNode(c, { type: 'Delegation', qualifiedName: g.qualified_name, attributes: { valid_to: day(-1) }, writer: { kind: 'user' }, actor: 'test' })); } finally { c.release(); }
    const r = await inj('POST', `${R}/groups`, { 'x-dmc-user': 'eve' }, { name: 'Stress testing' });
    expect(r.statusCode).toBe(403);
    expect((await inj('GET', '/v1/delegations', { 'x-dmc-user': 'eve' })).json().received[0].active).toBe(false);
  });

  it('all scopes covers the owner’s scopes, and only theirs', async () => {
    expect((await grant({ delegate: 'fay', covers: 'all-scopes', valid_to: day(60) })).statusCode).toBe(201);
    const fay = { 'x-dmc-user': 'fay' };
    expect((await inj('POST', '/v1/scopes/scope-other/groups', fay, { name: 'A' })).statusCode).toBe(201);
    expect((await inj('POST', '/v1/scopes/scope-theirs/groups', fay, { name: 'A' })).statusCode).toBe(403);
    expect((await grant({ delegate: 'gus', covers: 'all-scopes', valid_to: day(60) }, { 'x-dmc-user': 'nobody', 'x-dmc-groups': 'dmc-scope-owner' })).statusCode).toBe(403);   // owns nothing
  });

  it('a delegation ends when the source system changes the scope’s owner', async () => {
    const { CatalogDelegations } = await import('../packages/catalog/src/index');
    const dl = new CatalogDelegations(store);
    const g = (await grant({ delegate: 'hal', covers: 'one-scope', scope: 'scope-other', valid_to: day(60) })).json();
    const hal = { 'x-dmc-user': 'hal' };
    expect((await inj('POST', '/v1/scopes/scope-other/groups', hal, { name: 'B' })).statusCode).toBe(201);
    const c = await pool.connect();
    try {
      await store.tx(c, () => store.applyNode(c, { type: 'Scope', qualifiedName: 'scope-other', attributes: { owner: 'ozzy' }, writer: { kind: 'sync', source: 'scope-sources' }, actor: 'sync/rris' }));
      expect(await dl.endForOwnerChange(c)).toEqual([g.qualified_name]);   // olive's one-scope delegations on scope-other
      expect(await dl.endForOwnerChange(c)).toEqual([]);
    } finally { c.release(); }
    expect((await inj('POST', '/v1/scopes/scope-other/groups', hal, { name: 'C' })).statusCode).toBe(403);
    expect((await inj('POST', '/v1/scopes/scope-other/groups', { 'x-dmc-user': 'fay' }, { name: 'C' })).statusCode).toBe(403);   // fay's all-scopes was olive's: no longer covers it
    const history = await admin.query("select lifecycle, attributes->>'ended_reason' as why from catalog.node_version v join catalog.node n on n.id = v.node_id where n.qualified_name = $1 and v.recorded_to is null and v.valid_to is null", [g.qualified_name]);
    expect(history.rows).toEqual([{ lifecycle: 'deprecated', why: 'owner-changed' }]);
  });
});

describe('C3: links and completeness', () => {
  const amy = { 'x-dmc-user': 'amy' };       // owns app-a, no group: ownership comes from the catalog
  const ben = { 'x-dmc-user': 'ben' };
  const L = '/v1/scopes/scope-lnk';
  const elA = 'scope-lnk--exposure--ead';
  const elB = 'scope-lnk--exposure--lgd';
  const link = (who: Record<string, string>, body: unknown) => inj('POST', `${L}/links`, who, body);

  beforeAll(async () => {
    const c = await pool.connect();
    const sn = { kind: 'sync', source: 'servicenow' } as const;
    try {
      await store.tx(c, () => store.applyNode(c, { type: 'Scope', qualifiedName: 'scope-lnk', attributes: { name: 'Links', owner: 'olive', kind: 'report' }, writer: { kind: 'sync', source: 'scope-sources' }, actor: 'sync/rris' }));
      for (const [qn, o] of [['app-a', 'amy'], ['app-b', 'ben'], ['app-off', 'zoe']] as const)
        await store.tx(c, () => store.applyNode(c, { type: 'Application', qualifiedName: qn, attributes: { name: qn, owner: o, hosting_country: 'GB', criticality: 'low' }, writer: sn, actor: 'sync/sn' }));
      await store.tx(c, () => store.applyNode(c, { type: 'Integration', qualifiedName: 'int-ab', attributes: { status: 'live' }, writer: sn, actor: 'sync/sn' }));
      await store.tx(c, () => store.link(c, { name: 'source_of', fromQn: 'app-a', toQn: 'int-ab', source: 'servicenow', actor: 'sync/sn' }));
      await store.tx(c, () => store.link(c, { name: 'target_of', fromQn: 'app-b', toQn: 'int-ab', source: 'servicenow', actor: 'sync/sn' }));
      for (const qn of ['git.a/s/t/ead', 'git.b/s/t/lgd']) await store.tx(c, () => store.applyNode(c, { type: 'Column', qualifiedName: qn, attributes: { name: qn }, writer: { kind: 'sync', source: 'git-json' }, actor: 'sync/git' }));
    } finally { c.release(); }
    await inj('POST', `${L}/groups`, owner, { name: 'Exposure' });
    await inj('POST', `${L}/groups/scope-lnk--exposure/elements`, owner, { name: 'EAD' });
    await inj('POST', `${L}/groups/scope-lnk--exposure/elements`, owner, { name: 'LGD' });
    await inj('PUT', `${L}/flows`, owner, { integrations: ['int-ab'] });
  });

  it('links wait for the scope to be submitted', async () => {
    const r = await link(amy, { element: elA, target: 'git.a/s/t/ead', app: 'app-a' });
    expect(r.statusCode).toBe(409);
    expect((await inj('POST', `${L}/submit`, owner)).statusCode).toBe(200);
  });

  it('shows who has what to do, and that nothing is linked yet', async () => {
    const r = await inj('GET', `${L}/completeness`, owner);
    contract('/v1/scopes/{qualified_name}/completeness', 'get', 200, r.json());
    expect(r.json()).toMatchObject({ complete: false, submitted: true, elements: { total: 2, linked: 0 } });
    expect(r.json().applications.map((a: { application: string; owner: string; task: string }) => [a.application, a.owner, a.task])).toEqual([['app-a', 'amy', 'missing'], ['app-b', 'ben', 'missing']]);
  });

  it('only the owner of the application (or its delegate) links its side, and only to real columns of elements in this scope', async () => {
    expect((await link(ben, { element: elA, target: 'git.a/s/t/ead', app: 'app-a' })).statusCode).toBe(403);
    expect((await link(amy, { element: elA, target: 'git.a/s/t/ead', app: 'app-b' })).statusCode).toBe(403);
    expect((await link(amy, { element: elA, target: 'git.a/s/t/ead', app: 'app-off' })).statusCode).toBe(422);   // not on the flows
    expect((await link(amy, { element: elA, target: 'int-ab', app: 'app-a' })).statusCode).toBe(422);
    expect((await link(amy, { element: 'scope-lnk--nope', target: 'git.a/s/t/ead', app: 'app-a' })).statusCode).toBe(404);
    expect((await link(amy, { element: elA })).statusCode).toBe(422);
    const ok = await link(amy, { element: elA, target: 'git.a/s/t/ead', app: 'app-a' });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toEqual({ element: elA, target: 'git.a/s/t/ead', app: 'app-a', state: 'confirmed' });
    contract('/v1/scopes/{qualified_name}/links', 'post', 201, ok.json());
  });

  it('an agent acting for the owner proposes; only the owner confirms', async () => {
    const agent = { 'x-dmc-user': 'svc', 'x-dmc-kind': 'service', 'x-dmc-acting-for': 'ben', 'x-dmc-scopes': 'dmc.read,dmc.propose' };
    const p = await link(agent, { element: elB, target: 'git.b/s/t/lgd', app: 'app-b' });
    expect(p.statusCode).toBe(201);
    expect(p.json().state).toBe('proposed');
    expect((await inj('GET', `${L}/completeness`, owner)).json().elements).toMatchObject({ linked: 1, unlinked: [elB] });   // a proposal does not count
    expect((await inj('POST', `${L}/links/confirm`, agent, { element: elB, target: 'git.b/s/t/lgd' })).statusCode).toBe(403);
    expect((await inj('POST', `${L}/links/confirm`, amy, { element: elB, target: 'git.b/s/t/lgd' })).statusCode).toBe(403);
    const c = await inj('POST', `${L}/links/confirm`, ben, { element: elB, target: 'git.b/s/t/lgd' });
    expect(c.statusCode).toBe(200);
    expect(c.json().state).toBe('confirmed');
    contract('/v1/scopes/{qualified_name}/links/confirm', 'post', 200, c.json());
    expect((await inj('GET', `${L}/completeness`, owner)).json().elements).toMatchObject({ linked: 2, unlinked: [] });
    const detail = (await inj('GET', L, owner)).json();
    contract('/v1/scopes/{qualified_name}', 'get', 200, detail);
    expect(detail.groups[0].elements.find((e: { qualified_name: string }) => e.qualified_name === elA).links).toEqual([{ target: 'git.a/s/t/ead', app: 'app-a', state: 'confirmed' }]);
  });

  it('is complete only when every application has also finished its task', async () => {
    const task = (app: string, status: 'open' | 'done', decision?: string) => ({ id: `t-${app}`, assignee: app, status, ...(decision ? { decision } : {}), escalated: false, context: { app, version: 1 } });
    linkTasks.push(task('app-a', 'done', 'done'), task('app-b', 'open'));
    let r = (await inj('GET', `${L}/completeness`, owner)).json();
    expect(r.complete).toBe(false);
    expect(r.applications.map((a: { task: string }) => a.task)).toEqual(['done', 'open']);
    expect(r.applications.map((a: { links: number }) => a.links)).toEqual([1, 1]);
    linkTasks.length = 0;
    linkTasks.push(task('app-a', 'done', 'done'), task('app-b', 'done', 'none_held'));
    r = (await inj('GET', `${L}/completeness`, owner)).json();
    expect(r.complete).toBe(true);
    expect(r.applications.map((a: { task: string }) => a.task)).toEqual(['done', 'none_held']);
    // tasks of an older version do not count towards a newer one
    linkTasks.length = 0;
    linkTasks.push({ ...task('app-a', 'done', 'done'), context: { app: 'app-a', version: 0 } });
    expect((await inj('GET', `${L}/completeness`, owner)).json().applications.map((a: { task: string }) => a.task)).toEqual(['missing', 'missing']);
  });
});

describe('required tier', () => {
  it('the owner chooses it; others cannot; bad values are refused; it shows on the scope', async () => {
    expect((await inj('GET', S, owner)).json().required_tier).toBe('bronze');
    await inj('POST', `${S}/amend`, owner);   // a submitted scope is locked until amended
    const r = await inj('PUT', `${S}/required-tier`, owner, { required_tier: 'silver' });
    expect(r.statusCode).toBe(200);
    contract('/v1/scopes/{qualified_name}/required-tier', 'put', 200, r.json());
    expect((await inj('GET', S, owner)).json().required_tier).toBe('silver');
    expect((await inj('PUT', `${S}/required-tier`, other, { required_tier: 'gold' })).statusCode).toBe(403);
    expect((await inj('PUT', `${S}/required-tier`, owner, { required_tier: 'platinum' })).statusCode).toBe(422);
  });
});
