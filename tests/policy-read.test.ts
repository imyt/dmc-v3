import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Authz, loadRegistry } from '../packages/platform/src/index';
import { CatalogStore } from '../packages/catalog/src/index';
import { listPolicySources, loadPolicies, sourceChecksum } from '../packages/policy/src/index';
import { checkResponse, loadSpec } from '../packages/contracts/src/index';
import { createApi, devAuthenticator } from '../apps/api/src/index';

// P3 / U2: reading policies with their source. No database is touched: policies come from a policies folder and the pause state from a fake control state.
const root = join(import.meta.dirname, '..');
const registry = loadRegistry(join(root, 'metamodel/types'));
const spec = loadSpec();
const real = join(root, 'policies');
const tmp = mkdtempSync(join(tmpdir(), 'dmc-pol-'));
const state = { enforcementPaused: false, pausedPolicies: [] as string[] };
let app: NestFastifyApplication;
const as = (u: string, groups = '', extra: Record<string, string> = {}) => ({ 'x-dmc-user': u, 'x-dmc-groups': groups, ...extra });
const get = (url: string, headers: Record<string, string>) => app.getHttpAdapter().getInstance().inject({ method: 'GET', url, headers });
const contract = (path: string, status: number, body: unknown) => expect(checkResponse(spec, path, 'get', status, body)).toEqual([]);
const fail = () => { throw new Error('no database in this test'); };

beforeAll(async () => {
  // a policies folder whose local overlay disables one policy and overrides another's mode, and one policy with no golden file
  const dir = join(tmp, 'policies');
  mkdirSync(join(dir, 'env'), { recursive: true });
  for (const f of ['application-has-owner.yaml', 'application-has-owner.golden.yaml', 'critical-app-review.yaml', 'critical-app-review.golden.yaml', 'cross-border-covered.yaml']) cpSync(join(real, 'examples', f), join(dir, f));
  writeFileSync(join(dir, 'env', 'local.yaml'), 'overrides:\n  application-has-owner: { mode: shadow }\ndisabled: [cross-border-covered]\n');
  const sources = listPolicySources(dir, registry, 'local');
  app = await createApi({
    version: '1.2.3', registry, store: new CatalogStore(registry), authz: Authz.load(readFileSync(join(root, 'config/authz.yaml'), 'utf8')), authenticate: devAuthenticator('local'),
    connect: fail as never, connectEvidence: fail as never,
    policySources: () => sources, policies: () => [],
    admin: { async state() { return { enforcementPaused: state.enforcementPaused, pausedPolicies: [...state.pausedPolicies] }; }, async setEnforcement() { return true; }, async setPolicy() { return true; } },
    exceptions: { async raise() { return { id: 'e', created: true }; }, async withdraw() { return true; } },
    inbox: { async forSubject() { return []; }, async list() { return []; }, async get() { return undefined; }, async decide() { return { replayed: false }; } },
    signals: { async submit() {} }, idempotency: { async get() { return undefined; }, async put() {} },
  });
});
afterAll(async () => { try { await app?.close(); } finally { rmSync(tmp, { recursive: true, force: true }); } });

describe('the repository policies as sources', () => {
  it('lists all six seeded policies with their YAML, golden cases and a checksum', () => {
    const s = listPolicySources(real, registry, 'local');
    expect(s.map((x) => x.id)).toEqual(['application-has-owner', 'classification-proposed', 'critical-app-review', 'cross-border-covered', 'integration-has-dataset', 'required-trust-tier']);
    for (const x of s) {
      const rel = x.path.replace(/^policies\//, '');
      expect(x.yaml).toBe(readFileSync(join(real, rel), 'utf8'));
      expect(x.golden).toBe(readFileSync(join(real, rel.replace(/\.yaml$/, '.golden.yaml')), 'utf8'));
      expect(x.checksum).toBe(sourceChecksum(x.yaml, x.golden));
    }
    // what the running system loads is the same set, with the same effective modes
    const loaded = loadPolicies(real, registry, 'uat');
    expect(listPolicySources(real, registry, 'uat').filter((x) => x.effective).map((x) => [x.id, x.mode])).toEqual(loaded.map((p) => [p.id, p.mode]).sort((a, b) => a[0]!.localeCompare(b[0]!)));
  });
});

describe('P3 GET /v1/policies', () => {
  const author = as('pat', 'dmc-policy-author');
  it('lists every policy file with the mode in force, the pause state from the control state, and whether it is effective here', async () => {
    const r = await get('/v1/policies', author);
    expect(r.statusCode).toBe(200);
    contract('/v1/policies', 200, r.json());
    expect(r.json().items).toEqual([
      expect.objectContaining({ id: 'application-has-owner', control: 'ownership', type: 'Application', mode: 'shadow', source_mode: 'enforced', paused: false, effective: true }),
      expect.objectContaining({ id: 'critical-app-review', paused: false, effective: true }),
      expect.objectContaining({ id: 'cross-border-covered', paused: false, effective: false }),
    ]);
    expect(JSON.stringify(r.json())).not.toContain('yaml');
  });
  it('shows a paused policy, and every policy when all enforcement is paused', async () => {
    state.pausedPolicies = ['critical-app-review'];
    const one = (await get('/v1/policies', author)).json().items as { id: string; paused: boolean }[];
    expect(one.map((p) => [p.id, p.paused])).toEqual([['application-has-owner', false], ['critical-app-review', true], ['cross-border-covered', false]]);
    state.enforcementPaused = true;
    expect(((await get('/v1/policies', author)).json().items as { paused: boolean }[]).every((p) => p.paused)).toBe(true);
    state.enforcementPaused = false; state.pausedPolicies = [];
  });
});

describe('P3 GET /v1/policies/{id}', () => {
  const author = as('pat', 'dmc-policy-author');
  it('returns the stored YAML, the golden cases and the checksum', async () => {
    const r = await get('/v1/policies/application-has-owner', author);
    expect(r.statusCode).toBe(200);
    contract('/v1/policies/{id}', 200, r.json());
    const b = r.json();
    expect(b.yaml).toBe(readFileSync(join(tmp, 'policies/application-has-owner.yaml'), 'utf8'));
    expect(b.golden).toBe(readFileSync(join(tmp, 'policies/application-has-owner.golden.yaml'), 'utf8'));
    expect(b.checksum).toBe(sourceChecksum(b.yaml, b.golden));
    expect(b).toMatchObject({ id: 'application-has-owner', mode: 'shadow', source_mode: 'enforced', path: 'policies/application-has-owner.yaml' });
  });
  it('golden is null for a policy with no golden file, and an ineffective policy is still readable', async () => {
    const r = await get('/v1/policies/cross-border-covered', author);
    expect(r.statusCode).toBe(200);
    contract('/v1/policies/{id}', 200, r.json());
    expect(r.json()).toMatchObject({ golden: null, effective: false });
  });
  it('404 for an unknown id', async () => {
    const r = await get('/v1/policies/nope', author);
    expect(r.statusCode).toBe(404);
    expect(r.json().detail).toContain('nope');
  });
});

describe('P3 authorization of the policy reads', () => {
  const allowed: [string, string][] = [['policy author', 'dmc-policy-author'], ['control owner', 'dmc-control-owner-privacy'], ['auditor', 'dmc-auditor'], ['admin', 'dmc-platform-admin']];
  const denied: [string, string][] = [['viewer', ''], ['steward', 'dmc-steward-finance'], ['scope owner', 'dmc-scope-owner']];
  for (const url of ['/v1/policies', '/v1/policies/application-has-owner']) {
    for (const [name, group] of allowed) it(`${name} may read ${url}`, async () => { expect((await get(url, as('u1', group))).statusCode).toBe(200); });
    for (const [name, group] of denied) it(`${name} may not read ${url}`, async () => { expect((await get(url, as('u2', group))).statusCode).toBe(403); });
    it(`a service account on its own, and no identity, are refused on ${url}`, async () => {
      expect((await get(url, as('bot', 'dmc-policy-author', { 'x-dmc-kind': 'service' }))).statusCode).toBe(403);
      expect((await get(url, {})).statusCode).toBe(401);
    });
  }
});
