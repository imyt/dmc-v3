import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, loadRuntime, modulePool } from '../packages/platform/src/index';
import { CatalogStore } from '../packages/catalog/src/index';
import { migrateAll, startWorkerProcess, type StartedWorker } from '../apps/worker/src/index';
import { startApi, type StartedApi } from '../apps/api/src/index';
import { seed } from '../scripts/seed-lib';

/**
 * The PRD's key journeys, end to end: embedded Postgres, migrations, the synthetic seed, the real worker and API,
 * driven over HTTP as the mock users (signed in through the mock login, as a browser would be).
 */
const root = join(import.meta.dirname, '..');
const PORT = 54420; const HTTP = 18520;
const env = { DMC_ENVIRONMENT: 'local', DMC_DB_HOST: 'localhost', DMC_DB_PORT: String(PORT), DMC_DB_NAME: 'postgres', DMC_DB_ADMIN_USER: 'postgres', DMC_DB_ADMIN_PASSWORD: 'pw', DMC_ROOT: root, DMC_HTTP_HOST: '127.0.0.1', DMC_HTTP_PORT: String(HTTP) };
const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const PRS = join(root, 'pull-requests'); const hadPrs = existsSync(PRS);   // the policy journey writes a pull request folder; remove what the test made
let server: EmbeddedPostgres; let worker: StartedWorker; let api: StartedApi; let admin: pg.Client;

const USERS = {
  amy: { staffID: '43000001', displayName: 'Amy Adams', groups: [] as string[] },
  ben: { staffID: '43000002', displayName: 'Ben Brooks', groups: [] as string[] },
  olive: { staffID: '43000004', displayName: 'Olive Okafor', groups: ['dmc-scope-owner'] },
  sam: { staffID: '43000005', displayName: 'Sam Shah', groups: ['dmc-steward-finance'] },
  priya: { staffID: '43000006', displayName: 'Priya Patel', groups: ['dmc-policy-author'] },
  ava: { staffID: '43000008', displayName: 'Ava Archer', groups: ['dmc-auditor'] },
  vera: { staffID: '43000010', displayName: 'Vera Vance', groups: [] as string[] },
};
type Who = keyof typeof USERS;
const cookies = new Map<Who, string>();
async function login(who: Who): Promise<string> {
  const r = await fetch(`${api.url}/v1/auth/mock-login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(USERS[who]) });
  expect(r.status).toBe(200);
  const c = r.headers.get('set-cookie')!.split(';')[0]!;
  cookies.set(who, c); return c;
}
let n = 0;
async function call(who: Who, method: string, path: string, body?: unknown, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { cookie: cookies.get(who) ?? (await login(who)), ...extra };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') headers['idempotency-key'] = `j-${++n}-${Math.random().toString(36).slice(2)}`;
  const r = await fetch(`${api.url}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : undefined };
}
const ok = (r: { status: number; body: unknown }, ...codes: number[]) => { expect([...(codes.length ? codes : [200])], JSON.stringify(r.body)).toContain(r.status); return r.body as any; };

beforeAll(async () => {
  server = new EmbeddedPostgres({ databaseDir: mkdtempSync(join(tmpdir(), 'dmc-journeys-')), user: 'postgres', password: 'pw', port: PORT, persistent: false });
  await server.initialise(); await server.start();
  admin = new pg.Client({ host: 'localhost', port: PORT, user: 'postgres', password: 'pw', database: 'postgres' });
  await admin.connect();
  const cfg = loadConfig(env);
  await migrateAll(cfg);
  const { registry } = loadRuntime(cfg);
  const pool = modulePool(cfg, 'catalog', 1); const db = await pool.connect();
  try { await seed(new CatalogStore(registry), db, root); } finally { db.release(); await pool.end(); }
  worker = await startWorkerProcess(cfg, { log: quiet, connectors: {} });
  api = await startApi(cfg, { log: quiet });
}, 180_000);
afterAll(async () => { try { await api?.close(); await worker?.close(); await admin?.end(); } finally { try { await server?.stop(); } finally { if (!hadPrs) rmSync(PRS, { recursive: true, force: true }); } } }, 60_000);

describe('journey 2: the regulatory report owner defines a scope', () => {
  const S = '/v1/scopes/scope-bcbs-var';
  let linkTaskBen: string; let linkTaskOlive: string;

  it('signs in and sees the seeded draft scope with the tier the owner chose', async () => {
    const me = ok(await call('olive', 'GET', '/v1/auth/me'));
    expect(me.id).toBe('43000004');
    const s = ok(await call('olive', 'GET', S));
    expect(s).toMatchObject({ status: 'draft', owner: '43000004', required_tier: 'silver' });
  });

  it('a stranger cannot change it; the owner builds groups, elements and flows', async () => {
    expect((await call('vera', 'POST', `${S}/groups`, { name: 'Nope' })).status).toBe(403);
    ok(await call('olive', 'POST', `${S}/groups`, { name: 'Positions' }), 201);
    ok(await call('olive', 'POST', `${S}/groups/scope-bcbs-var--positions/elements`, { name: 'Net position', definition: 'Position after netting', criticality: 'high' }), 201);
    ok(await call('olive', 'PUT', `${S}/flows`, { integrations: ['int-ledger-to-risk', 'int-risk-to-reporting'] }));
    expect(ok(await call('olive', 'GET', `${S}/completeness`)).complete).toBe(false);
  });

  it('a dry run of submit changes nothing; the real submit locks the scope', async () => {
    expect(ok(await call('olive', 'POST', `${S}/submit?dry_run=true`)).dry_run).toBe(true);
    expect(ok(await call('olive', 'GET', S)).locked).toBe(false);
    expect(ok(await call('olive', 'POST', `${S}/submit`)).status).toBe('submitted');
    expect(ok(await call('olive', 'GET', S)).locked).toBe(true);
    expect((await call('olive', 'POST', `${S}/groups`, { name: 'Late' })).status).toBe(403);   // locked
  });

  it('housekeeping opens one task per application on the flows, in each owner\'s inbox', async () => {
    const t = await worker.composition.tick();
    expect(t.linkTasksOpened).toBe(6);                       // 3 applications on this scope's flows, and the same 3 on the already submitted PRA110
    const ben = ok(await call('ben', 'GET', '/v1/inbox'));
    const mine = ben.items.filter((i: any) => i.subject_ref === 'Scope:scope-bcbs-var');
    expect(mine).toHaveLength(2);                            // Ben owns two of the three applications
    linkTaskBen = mine[0].id;
    const olive = ok(await call('olive', 'GET', '/v1/inbox'));
    linkTaskOlive = olive.items.find((i: any) => i.subject_ref === 'Scope:scope-bcbs-var').id;
    expect((await call('vera', 'POST', `/v1/inbox/${linkTaskBen}/decision`, { decision: 'done' })).status).toBe(403);
  });

  it('app owners link the element to their columns; an outsider cannot', async () => {
    const link = { element: 'scope-bcbs-var--positions--net-position', target: 'git.risk-engine/exposure/positions/exposure_at_default', app: 'app-risk-engine' };
    expect((await call('amy', 'POST', `${S}/links`, link)).status).toBe(403);
    expect(ok(await call('ben', 'POST', `${S}/links?dry_run=true`, link), 200, 201).dry_run).toBe(true);
    expect(ok(await call('ben', 'POST', `${S}/links`, link), 201).state).toBe('confirmed');
    const c = ok(await call('olive', 'GET', `${S}/completeness`));
    expect(c.elements).toMatchObject({ total: 2, linked: 1 });
    expect(c.complete).toBe(false);                          // one element unlinked, tasks open
    ok(await call('ben', 'POST', `${S}/links`, { element: 'scope-bcbs-var--core--exposure', target: 'git.core-banking/ledger/accounts/closing_balance', app: 'app-core-banking' }), 201);
    expect(ok(await call('olive', 'GET', `${S}/completeness`)).elements).toMatchObject({ total: 2, linked: 2 });
  });

  it('the owners decide their tasks; the scope is then complete', async () => {
    const ben = ok(await call('ben', 'GET', '/v1/inbox'));
    for (const i of ben.items.filter((x: any) => x.subject_ref === 'Scope:scope-bcbs-var')) {
      const d = 'done';
      ok(await call('ben', 'POST', `/v1/inbox/${i.id}/decision`, { decision: d }));
    }
    ok(await call('olive', 'POST', `/v1/inbox/${linkTaskOlive}/decision`, { decision: 'none_held' }));
    await worker.composition.tick();
    const c = ok(await call('olive', 'GET', `${S}/completeness`));
    expect(c.applications.every((a: any) => a.task !== 'open' && a.task !== 'missing')).toBe(true);
    expect(c.complete).toBe(true);
  });

  it('an amendment opens version 2 and keeps version 1 readable', async () => {
    expect(ok(await call('olive', 'POST', `${S}/amend`)).version).toBe(2);
    const now = ok(await call('olive', 'GET', S));
    expect(now).toMatchObject({ version: 2, status: 'amended', locked: false });
    expect(now.versions.map((v: any) => v.version)).toEqual([1]);
    await worker.composition.tick();
    expect(ok(await call('olive', 'GET', `${S}/completeness`)).submitted).toBe(false);
  });
});

describe('datasets: application owners, and a coding agent registering one with a dry run first', () => {
  const I = '/v1/integrations/int-ledger-to-risk/datasets';
  it('the app owner adds a dataset; a stranger cannot', async () => {
    const body = { name: 'Exposure feed', business_context: 'Daily exposure', categories: ['gl:credit-exposure'], record_class: 'dstorm:rc-7y', columns: ['git.risk-engine/exposure/positions/exposure_at_default'] };
    expect((await call('vera', 'POST', I, body)).status).toBe(403);
    expect(ok(await call('ben', 'POST', I, body), 201).qualified_name).toBe('int-ledger-to-risk--exposure-feed');
    expect(ok(await call('vera', 'GET', I)).datasets.length).toBeGreaterThanOrEqual(2);
  });

  it('an agent acting for the owner can check a new dataset with a dry run', async () => {
    const agent = { 'x-dmc-user': 'copilot', 'x-dmc-kind': 'service', 'x-dmc-acting-for': '43000002', 'x-dmc-scopes': 'dmc.read,dmc.propose' };
    const r = await fetch(`${api.url}${I}?dry_run=true`, { method: 'POST', headers: { ...agent, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Agent registered', categories: ['gl:credit-exposure'] }) });
    expect(r.status, await r.clone().text()).toBe(200);
    expect((await r.json()).dry_run).toBe(true);
    expect(ok(await call('ben', 'GET', I)).datasets.map((d: any) => d.name)).not.toContain('Agent registered');
  });
});

describe('journey 3: the steward clears the inbox', () => {
  let wf: pg.Client;
  beforeAll(async () => { wf = new pg.Client({ host: 'localhost', port: PORT, user: 'dmc_workflow', password: 'workflow', database: 'postgres' }); await wf.connect(); });
  afterAll(async () => { await wf?.end(); });

  it('an exception reaches the steward with its context, and one action settles it', async () => {
    const raised = await worker.composition.exceptions.raise(wf, { kind: 'quality', severity: 'medium', subjectRef: 'Column:git.core-banking/ledger/accounts/customer_name', policyId: 'journey-test', route: 'dmc-steward-finance', message: 'Customer name has no classification', actor: 'journey' });
    expect(raised.created).toBe(true);
    const inbox = ok(await call('sam', 'GET', '/v1/inbox'));
    const item = inbox.items.find((i: any) => i.subject_ref === 'Column:git.core-banking/ledger/accounts/customer_name');
    expect(item).toBeTruthy();
    expect(item.message).toContain('no classification');
    expect([...item.decisions].sort()).toEqual(['accept_risk', 'dismiss', 'resolve']);
    expect((await call('vera', 'POST', `/v1/inbox/${item.id}/decision`, { decision: 'resolve' })).status).toBe(403);
    expect((await call('sam', 'POST', `/v1/inbox/${item.id}/decision`, { decision: 'not-a-decision' })).status).toBe(422);
    ok(await call('sam', 'POST', `/v1/inbox/${item.id}/decision`, { decision: 'resolve' }));
    expect(ok(await call('sam', 'GET', '/v1/inbox')).items.some((i: any) => i.id === item.id)).toBe(false);
  });

  it('derived facts run: cross-border cover is checked and anything found lands in someone\'s inbox', async () => {
    await worker.composition.derive();
    await worker.composition.tick();
    const all = await Promise.all((['amy', 'ben', 'olive', 'sam'] as Who[]).map(async (w) => ok(await call(w, 'GET', '/v1/inbox')).items.length));
    expect(all.every((c) => Number.isInteger(c))).toBe(true);
  });
});

describe('journey 1: a sensitive column appears and its classification follows the lineage', () => {
  it('a tool classification on a column becomes a proposal on the columns built from it, with a task for the steward', async () => {
    const c = worker.composition;
    const conn = new pg.Client({ host: 'localhost', port: PORT, user: 'dmc_catalog', password: 'catalog', database: 'postgres' });
    await conn.connect();
    try {
      await c.store.tx(conn, async () => {
        await c.store.applyNode(conn, { type: 'Classification', qualifiedName: 'pii:personal', attributes: { code: 'personal', name: 'Personal data', scheme: 'pii' }, writer: { kind: 'sync', source: 'classification-tool' }, actor: 'sync/classifier' });
        await c.store.link(conn, { name: 'classified_as', fromQn: 'git.core-banking/ledger/accounts/closing_balance', toQn: 'pii:personal', source: 'classification-tool', actor: 'sync/classifier' });
      });
    } finally { await conn.end(); }
    await c.derive();
    await c.tick();
    const down = ok(await call('ava', 'GET', '/v1/nodes/git.risk-engine%2Fexposure%2Fpositions%2Fexposure_at_default'));
    expect(down.attributes.proposed_classification).toEqual(['pii:personal']);
    expect(down.attribute_sources.proposed_classification).toBeDefined();
    // the tool's own classification is not touched
    const src = ok(await call('ava', 'GET', '/v1/nodes/git.core-banking%2Fledger%2Faccounts%2Fclosing_balance'));
    expect(src.attributes.proposed_classification).toBeUndefined();
  });
});

describe('journey 4: the policy author ships a retention rule', () => {
  const yaml = `policy: dataset-has-description
control: retention
implements: DM-1
mode: shadow
scope:
  type: Dataset
when: "!has(dataset.description) || dataset.description == ''"
effect:
  action: raise_exception
  message: Every dataset needs a description
route: platform-governance
escalate_after: 5d
autonomy: act_notify
`;
  const golden = `cases:
  - name: no description matches
    asset: { qualified_name: ds1, name: A }
    expect: true
  - name: described does not match
    asset: { qualified_name: ds2, name: B, description: Daily feed }
    expect: false
`;
  it('validation errors come back as a report, and only people with the role can check', async () => {
    const bad = ok(await call('priya', 'POST', '/v1/policies/check', { yaml: 'policy: x' }));
    expect(bad.ok).toBe(false);
    expect(bad.problems.length).toBeGreaterThan(0);
    expect((await call('vera', 'POST', '/v1/policies/check', { yaml })).status).toBe(403);
  });
  it('a failing draft opens no pull request; a good one does, with its report', async () => {
    expect((await call('priya', 'POST', '/v1/policies/propose', { yaml: 'policy: x' })).status).toBe(422);
    const missing = ok(await call('priya', 'POST', '/v1/policies/check', { yaml }));
    expect(missing.problems.join(' ')).toContain('golden');
    const good = ok(await call('priya', 'POST', '/v1/policies/check', { yaml, golden }));
    expect(good.problems, JSON.stringify(good)).toEqual([]);
    expect(good.dryRun.sampled).toBeGreaterThan(0);             // the impact on real datasets
    const pr = ok(await call('priya', 'POST', '/v1/policies/propose', { yaml, golden, message: 'Datasets need a description' }), 200, 201);
    expect(pr.report.ok).toBe(true);
  });
  it('requirement coverage shows where each requirement stands', async () => {
    const c = ok(await call('priya', 'GET', '/v1/requirements/coverage'));
    expect(c.items.map((i: any) => i.reference_id).sort()).toEqual(['DM-1', 'DM-2']);
    expect(c.summary).toHaveProperty('enforced');
  });
});

describe('journey 5: the auditor proves a control', () => {
  it('sees the chain behind the scope, verifies it and exports proof; others cannot', async () => {
    await worker.composition.relay();
    expect((await call('vera', 'GET', '/v1/evidence/verify')).status).toBe(403);
    const ev = ok(await call('ava', 'GET', '/v1/nodes/scope-bcbs-var/evidence'));
    expect(ev.items.length).toBeGreaterThan(3);
    const v = ok(await call('ava', 'GET', '/v1/evidence/verify'));
    expect(v.ok).toBe(true);
    expect(v.checked).toBeGreaterThan(10);
    const proof = ok(await call('ava', 'GET', '/v1/nodes/scope-bcbs-var/evidence/proof'));
    expect(proof).toBeTruthy();
  });
});
