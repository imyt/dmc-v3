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
const idem = new Map<string, { bodyHash: string; response: unknown }>();
const paused = { all: false, policies: new Set<string>() };
const as = (u: string, groups = '') => ({ 'x-dmc-user': u, 'x-dmc-groups': groups });
const inj = (method: 'GET' | 'POST', url: string, headers: Record<string, string>, payload?: unknown) =>
  app.getHttpAdapter().getInstance().inject({ method, url, headers: { ...headers, ...(method === 'GET' ? {} : { 'idempotency-key': `k-${Math.random().toString(36).slice(2)}-xx` }) }, payload: payload as never });
const contract = (path: string, m: string, status: number, body: unknown) => expect(checkResponse(spec, path, m, status, body)).toEqual([]);

beforeAll(async () => {
  server = new EmbeddedPostgres({ databaseDir: mkdtempSync(join(tmpdir(), 'dmc-adm-')), user: 'postgres', password: 'pw', port: 54450, persistent: false });
  await server.initialise(); await server.start();
  admin = new pg.Client({ host: 'localhost', port: 54450, user: 'postgres', password: 'pw', database: 'postgres' });
  await admin.connect();
  for (const m of ['catalog', 'evidence']) {
    await provisionModule(admin, m, { password: m });
    await migrateModule(admin, m, join(root, `packages/${m}/migrations`));
    await admin.query(`grant all on all tables in schema ${m} to dmc_${m}`); await admin.query(`grant all on all sequences in schema ${m} to dmc_${m}`);
  }
  pool = new pg.Pool({ host: 'localhost', port: 54450, user: 'dmc_catalog', password: 'catalog', database: 'postgres', max: 4 });
  evPool = new pg.Pool({ host: 'localhost', port: 54450, user: 'dmc_evidence', password: 'evidence', database: 'postgres', max: 2 });
  const c = await pool.connect();
  const sn = { kind: 'sync', source: 'servicenow' } as const;
  const n = (type: string, qn: string, attributes: Record<string, unknown>, writer: { kind: 'sync'; source: string } = sn) => store.tx(c, () => store.applyNode(c, { type, qualifiedName: qn, attributes, writer, actor: 'test' }));
  const d = { kind: 'sync', source: 'derived' } as const;
  try {
    await n('Application', 'app-a', { name: 'App A', owner: 'amy', delegates: ['dan'], hosting_country: 'GB' });
    await n('Application', 'app-b', { name: 'App B', owner: 'ben', hosting_country: 'GB' });
    await n('Application', 'app-c', { name: 'App C', owner: 'cat', hosting_country: 'GB' });
    await n('Integration', 'int-1', { status: 'live' });
    await n('Dataset', 'int-1--accounts', { name: 'Accounts' }, { kind: 'user' } as never);
    await n('Scope', 'sc-1', { name: 'PRA110', owner: 'olive', kind: 'report' }, { kind: 'sync', source: 'scope-sources' });
    await n('Scope', 'sc-2', { name: 'Other', owner: 'oscar', kind: 'report' }, { kind: 'sync', source: 'scope-sources' });
    await n('DataDomain', 'gl:finance', { name: 'Finance' }, { kind: 'sync', source: 'collibra' });
    await n('Classification', 'pii:email', { code: 'email', name: 'Email address', scheme: 'pii' }, { kind: 'sync', source: 'classification-tool' });
    await n('Classification', 'pii:phone', { code: 'phone', name: 'Phone', scheme: 'pii' }, { kind: 'sync', source: 'classification-tool' });
    for (const col of ['col-fin', 'col-free', 'col-fin2']) await n('Column', col, { name: col }, { kind: 'sync', source: 'git-json' });
    await n('Column', 'col-fin', { proposed_classification: ['pii:email', 'pii:phone'], proposed_from: ['col-src'] }, d);
    await n('Column', 'col-free', { proposed_classification: ['pii:email'], proposed_from: ['col-src'] }, d);
    await n('Column', 'col-fin2', { proposed_classification: ['pii:email'], proposed_from: ['col-src'] }, d);
    await n('Table', 't-1', { name: 'T1' }, { kind: 'sync', source: 'git-json' });
    await n('Table', 't-1', { required_tier: 'silver', trust_tier: 'bronze', trust_shortfall: true }, d);
    await n('Table', 't-2', { name: 'T2' }, { kind: 'sync', source: 'git-json' });
    await n('Table', 't-2', { required_tier: 'bronze', trust_tier: 'gold', trust_shortfall: false }, d);
    await store.tx(c, async () => {
      await store.link(c, { name: 'source_of', fromQn: 'app-a', toQn: 'int-1', source: 'servicenow', actor: 't' });
      await store.link(c, { name: 'in_domain', fromQn: 'col-fin', toQn: 'gl:finance', source: 'dmc', actor: 't' });
      await store.link(c, { name: 'in_domain', fromQn: 'col-fin2', toQn: 'gl:finance', source: 'dmc', actor: 't' });
      await store.link(c, { name: 'transfers', fromQn: 'int-1', toQn: 'int-1--accounts', source: 'dmc', actor: 't' });
    });
    await n('Scope', 'sc-1', { version: 1, status: 'submitted' }, { kind: 'user' } as never);
  } finally { c.release(); }
  const lease = (p: pg.Pool) => async () => { const x = await p.connect(); return { query: (s: string, a?: unknown[]) => x.query(s, a) as never, release: () => x.release() }; };
  app = await createApi({
    version: '1.2.3', registry, store, authz: Authz.load(readFileSync(join(root, 'config/authz.yaml'), 'utf8')), authenticate: devAuthenticator('local'),
    connect: lease(pool), connectEvidence: lease(evPool),
    policies: () => [{ id: 'p-privacy', control: 'privacy', mode: 'enforced' }, { id: 'p-move', control: 'data-movement', mode: 'shadow' }],
    admin: {
      async state() { return { enforcementPaused: paused.all, pausedPolicies: [...paused.policies] }; },
      async setEnforcement(p) { const ch = paused.all !== p; paused.all = p; return ch; },
      async setPolicy(id, p) { const ch = paused.policies.has(id) !== p; if (p) paused.policies.add(id); else paused.policies.delete(id); return ch; },
    },
    stats: async () => ({ exceptions: { openAgesDays: [1, 2, 3, 10, 40], overdue: 2 }, decisions: { automatic: 3, byPerson: 7 } }),
    exceptions: { async raise() { return { id: 'e', created: true }; }, async withdraw() { return true; } },
    inbox: { async forSubject() { return []; }, async list() { return []; }, async get() { return undefined; }, async decide() { return { replayed: false }; } },
    signals: { async submit(x) { signals.push(...x); } },
    idempotency: { async get(k) { return idem.get(k); }, async put(k, e) { idem.set(k, e); } },
  });
}, 150_000);
afterAll(async () => { try { await app?.close(); await pool?.end(); await evPool?.end(); await admin?.end(); } finally { await server?.stop(); } });

describe('roles on /me', () => {
  it('come from groups and from what the data says', async () => {
    const steward = (await inj('GET', '/v1/auth/me', as('sam', 'dmc-steward-finance,dmc-auditor'))).json();
    expect(steward.roles).toEqual(['auditor', 'steward', 'viewer']);
    contract('/v1/auth/me', 'get', 200, steward);
    expect((await inj('GET', '/v1/auth/me', as('amy'))).json().roles).toEqual(['app-owner', 'viewer']);
    expect((await inj('GET', '/v1/auth/me', as('dan'))).json().roles).toEqual(['app-owner', 'viewer']);
    expect((await inj('GET', '/v1/auth/me', as('olive', 'dmc-scope-owner'))).json().roles).toEqual(['scope-owner', 'viewer']);
    expect((await inj('GET', '/v1/auth/me', as('oscar'))).json().roles).toEqual(['scope-owner', 'viewer']);
    expect((await inj('GET', '/v1/auth/me', as('nobody'))).json().roles).toEqual(['viewer']);
  });
});

describe('L2: deciding classification proposals', () => {
  const steward = as('sam', 'dmc-steward-finance');
  let ids: Record<string, string> = {};
  it('lists the open proposals, with who may decide them', async () => {
    const r = await inj('GET', '/v1/classifications/proposals', steward);
    expect(r.statusCode).toBe(200);
    contract('/v1/classifications/proposals', 'get', 200, r.json());
    const ps = r.json().proposals as { id: string; column: string; code: string; name?: string; via: string[]; can_decide: boolean }[];
    expect(ps.map((p) => `${p.column}|${p.code}|${p.can_decide}`)).toEqual(['col-fin|pii:email|true', 'col-fin|pii:phone|true', 'col-fin2|pii:email|true', 'col-free|pii:email|true']);
    expect(ps[0]).toMatchObject({ name: 'Email address', via: ['col-src'] });
    ids = Object.fromEntries(ps.map((p) => [`${p.column}|${p.code}`, p.id]));
    const other = (await inj('GET', '/v1/classifications/proposals?mine=true', as('rae', 'dmc-steward-risk'))).json().proposals as { column: string }[];
    expect(other.map((p) => p.column)).toEqual(['col-free']);   // a column with no domain is anyone's steward's; the finance ones are not
    expect((await inj('GET', '/v1/classifications/proposals', as('vera'))).json().proposals.every((p: { can_decide: boolean }) => !p.can_decide)).toBe(true);
  });

  it('refuses a steward of another domain, a viewer and an agent', async () => {
    const id = ids['col-fin|pii:email']!;
    expect((await inj('POST', `/v1/classifications/proposals/${id}/decision`, as('rae', 'dmc-steward-risk'), { decision: 'accept' })).statusCode).toBe(403);
    expect((await inj('POST', `/v1/classifications/proposals/${id}/decision`, as('vera'), { decision: 'accept' })).statusCode).toBe(403);
    expect((await inj('POST', `/v1/classifications/proposals/${id}/decision`, { 'x-dmc-user': 'bot', 'x-dmc-kind': 'service', 'x-dmc-acting-for': 'sam', 'x-dmc-groups': '' }, { decision: 'accept' })).statusCode).toBe(403);
    expect((await inj('POST', `/v1/classifications/proposals/${id}/decision`, steward, { decision: 'maybe' })).statusCode).toBe(422);
    expect((await inj('POST', `/v1/classifications/proposals/bm9wZQ/decision`, steward, { decision: 'accept' })).statusCode).toBe(404);
  });

  it('a dry run changes nothing', async () => {
    const r = await inj('POST', `/v1/classifications/proposals/${ids['col-fin|pii:email']}/decision?dry_run=true`, steward, { decision: 'accept' });
    expect(r.statusCode).toBe(200);
    expect((await inj('GET', '/v1/classifications/proposals', steward)).json().proposals).toHaveLength(4);
    expect(signals.filter((s) => s.kind === 'derived.upsert' && s.subjectRef === 'Column:col-fin')).toHaveLength(0);
  });

  it('accepting writes the classification, with who accepted it, and tells the decision path the proposal is gone', async () => {
    const r = await inj('POST', `/v1/classifications/proposals/${ids['col-fin|pii:email']}/decision`, steward, { decision: 'accept' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ column: 'col-fin', code: 'pii:email', decision: 'accepted', remaining: 1 });
    contract('/v1/classifications/proposals/{id}/decision', 'post', 200, r.json());
    const c = await pool.connect();
    try {
      const e = (await store.namedEdgesOf(c, 'col-fin', { name: 'classified_as', direction: 'out' }));
      expect(e.map((x) => [x.toQn, x.source, x.attributes?.accepted_by])).toEqual([['pii:email', 'dmc', 'sam']]);
      expect((await store.getNode(c, 'col-fin'))!.attributes.proposed_classification).toEqual(['pii:phone']);
    } finally { c.release(); }
    const s = signals.find((x) => x.subjectRef === 'Column:col-fin')!;
    expect(s).toMatchObject({ kind: 'derived.upsert', actor: 'sam', asset: { proposed_classification: ['pii:phone'] } });
    expect((await inj('POST', `/v1/classifications/proposals/${ids['col-fin|pii:email']}/decision`, steward, { decision: 'accept' })).statusCode).toBe(404);   // no longer open
  });

  it('rejecting remembers it, and clears the proposal when it was the last', async () => {
    const r = await inj('POST', `/v1/classifications/proposals/${ids['col-fin|pii:phone']}/decision`, steward, { decision: 'reject' });
    expect(r.json()).toMatchObject({ decision: 'rejected', remaining: 0 });
    const c = await pool.connect();
    try {
      const n = (await store.getNode(c, 'col-fin'))!;
      expect(n.attributes.rejected_classification).toEqual(['pii:phone']);
      expect(n.attributes.proposed_classification).toEqual([]);
      expect(await store.namedEdgesOf(c, 'col-fin', { name: 'classified_as', direction: 'out' })).toHaveLength(1);
    } finally { c.release(); }
    expect(signals.filter((s) => s.subjectRef === 'Column:col-fin').at(-1)!.asset.proposed_classification).toEqual([]);
  });

  it('an administrator may decide any', async () => {
    expect((await inj('POST', `/v1/classifications/proposals/${ids['col-fin2|pii:email']}/decision`, as('anil', 'dmc-platform-admin'), { decision: 'accept' })).statusCode).toBe(200);
  });
});

describe('U2: pause switches', () => {
  const adm = as('anil', 'dmc-platform-admin');
  it('shows what is running', async () => {
    const r = await inj('GET', '/v1/admin/status', adm);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ version: '1.2.3', enforcement: 'running', policies: [{ id: 'p-move', mode: 'shadow', paused: false }, { id: 'p-privacy', mode: 'enforced', paused: false }] });
    expect(r.json().metamodel_version).toMatch(/^\d+ types, [0-9a-f]{8}$/);
    contract('/v1/admin/status', 'get', 200, r.json());
    expect((await inj('GET', '/v1/admin/status', as('vera'))).statusCode).toBe(403);
  });
  it('only an administrator pauses enforcement; it shows in the status', async () => {
    expect((await inj('POST', '/v1/admin/enforcement', as('carl', 'dmc-control-owner-privacy'), { paused: true })).statusCode).toBe(403);
    expect((await inj('POST', '/v1/admin/enforcement', adm, { paused: 'yes' })).statusCode).toBe(422);
    const r = await inj('POST', '/v1/admin/enforcement', adm, { paused: true });
    expect(r.json()).toEqual({ enforcement: 'paused', changed: true });
    contract('/v1/admin/enforcement', 'post', 200, r.json());
    expect((await inj('POST', '/v1/admin/enforcement', adm, { paused: true })).json().changed).toBe(false);
    const st = (await inj('GET', '/v1/admin/status', adm)).json();
    expect(st.enforcement).toBe('paused');
    expect(st.policies.every((p: { paused: boolean }) => p.paused)).toBe(true);
    await inj('POST', '/v1/admin/enforcement', adm, { paused: false });
  });
  it('a control owner pauses their own control’s policy, not another’s', async () => {
    const carl = as('carl', 'dmc-control-owner-privacy');
    const r = await inj('POST', '/v1/admin/policies/p-privacy/pause', carl, { paused: true });
    expect(r.json()).toEqual({ id: 'p-privacy', paused: true, changed: true });
    contract('/v1/admin/policies/{id}/pause', 'post', 200, r.json());
    expect((await inj('POST', '/v1/admin/policies/p-move/pause', carl, { paused: true })).statusCode).toBe(403);
    expect((await inj('POST', '/v1/admin/policies/nope/pause', adm, { paused: true })).statusCode).toBe(404);
    expect((await inj('GET', '/v1/admin/status', adm)).json().policies.find((p: { id: string }) => p.id === 'p-privacy').paused).toBe(true);
    expect((await inj('POST', '/v1/admin/policies/p-privacy/pause', adm, { paused: false })).json().paused).toBe(false);
  });
  it('agents cannot press them', async () => {
    expect((await inj('POST', '/v1/admin/enforcement', { 'x-dmc-user': 'bot', 'x-dmc-kind': 'service', 'x-dmc-acting-for': 'anil', 'x-dmc-groups': 'dmc-platform-admin' }, { paused: true })).statusCode).toBe(403);
  });
});

describe('U5: dashboard measures', () => {
  it('works out what it can from the catalog and the operational figures', async () => {
    const r = await inj('GET', '/v1/dashboard/measures', as('vera'));
    expect(r.statusCode).toBe(200);
    contract('/v1/dashboard/measures', 'get', 200, r.json());
    const m = Object.fromEntries((r.json().measures as { id: string; value: number; target: number | null; unit: string }[]).map((x) => [x.id, x]));
    expect(m.applications_taken_on).toMatchObject({ value: 33.3, target: 10, unit: 'percent' });   // only app-a is on an integration that carries a dataset
    expect(m.scopes_submitted).toMatchObject({ value: 1, target: 50, unit: 'count' });
    expect(m.element_links.value).toBe(0);
    expect(m.trust_at_required).toMatchObject({ value: 50, target: 40 });
    expect([m.trust_bronze.value, m.trust_gold.value]).toEqual([1, 1]);
    expect(m.exceptions_open.value).toBe(5);
    expect(m.exceptions_overdue.value).toBe(2);
    expect(m.exception_age_median).toMatchObject({ value: 3, target: 15, unit: 'days' });
    expect(m.exception_age_p95).toMatchObject({ value: 40, target: 45 });
    expect(m.automation_rate).toMatchObject({ value: 30, target: 30 });
    expect(m.evidence_checks.target).toBe(100);
  });
});
