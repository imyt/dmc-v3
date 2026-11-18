import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { mkdtempSync, mkdirSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { provisionModule, migrateModule, loadRegistry } from '../packages/platform/src/index';
import { PolicyError, PolicyIndex, evaluateAsset, loadPolicies, recordShadow, shadowSummary } from '../packages/policy/src/index';

const reg = loadRegistry(join(import.meta.dirname, '../metamodel/types'));
const POLICIES = join(import.meta.dirname, '../policies');
const tmps: string[] = [];
const tmp = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); tmps.push(d); return d; };
afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });
let server: EmbeddedPostgres;
let admin: pg.Client;

beforeAll(async () => {
  server = new EmbeddedPostgres({ databaseDir: mkdtempSync(join(tmpdir(), 'dmc-pol-')), user: 'postgres', password: 'pw', port: 54337, persistent: false });
  await server.initialise(); await server.start();
  admin = new pg.Client({ host: 'localhost', port: 54337, user: 'postgres', password: 'pw', database: 'postgres' });
  await admin.connect();
  await provisionModule(admin, 'policy');
  await migrateModule(admin, 'policy', join(import.meta.dirname, '../packages/policy/migrations'));
}, 120_000);
afterAll(async () => { try { await admin?.end(); } finally { await server?.stop(); } });

describe('P2: load per environment, shadow and enforced', () => {
  it('merges the environment overlay', () => {
    const local = loadPolicies(POLICIES, reg, 'local').find((p) => p.id === 'application-has-owner')!;
    const uat = loadPolicies(POLICIES, reg, 'uat').find((p) => p.id === 'application-has-owner')!;
    expect(local.mode).toBe('enforced');
    expect(uat.mode).toBe('shadow');
  });

  it('refuses an overlay that names an unknown policy, and a policy set with a failing golden test', () => {
    const dir = tmp('pol-');
    cpSync(POLICIES, dir, { recursive: true });
    mkdirSync(join(dir, 'env'), { recursive: true });
    writeFileSync(join(dir, 'env', 'uat.yaml'), 'disabled: [nope]\n');
    expect(() => loadPolicies(dir, reg, 'uat')).toThrow(/unknown policy nope/);
    writeFileSync(join(dir, 'examples', 'critical-app-review.golden.yaml'), 'cases:\n  - { name: wrong, asset: { criticality: low, status: live }, expect: true }\n  - { name: x, asset: { criticality: critical, status: live }, expect: false }\n');
    expect(() => loadPolicies(dir, reg, 'local')).toThrow(PolicyError);
  });

  it('disabled policies are not loaded', () => {
    const dir = tmp('pol-');
    cpSync(POLICIES, dir, { recursive: true });
    writeFileSync(join(dir, 'env', 'prod.yaml'), 'disabled: [critical-app-review]\n');
    expect(loadPolicies(dir, reg, 'prod').map((p) => p.id)).not.toContain('critical-app-review');
  });

  it('indexes by type so a signal loads only the policies that can match', () => {
    const idx = new PolicyIndex(loadPolicies(POLICIES, reg, 'local'));
    expect(idx.forType('Application').map((p) => p.id).sort()).toEqual(['application-has-owner', 'critical-app-review']);
    expect(idx.forType('Integration').map((p) => p.id)).toEqual(['integration-has-dataset']);
    expect(idx.forType('Column').map((p) => p.id).sort()).toEqual(['classification-proposed', 'required-trust-tier']);
    expect(idx.forType('CrossBorderTransfer').map((p) => p.id)).toEqual(['cross-border-covered']);
  });

  it('stores shadow results, raises nothing, and skips enforced policies', async () => {
    const idx = new PolicyIndex(loadPolicies(POLICIES, reg, 'local'));
    const evals = evaluateAsset(idx.forType('Application'), { qualified_name: 'servicenow.APP1', criticality: 'critical', status: 'live' });
    expect(evals.map((e) => [e.policy.id, e.matched])).toEqual(expect.arrayContaining([['application-has-owner', true], ['critical-app-review', true]]));
    expect(await recordShadow(admin, 'node/app-1', evals)).toBe(1); // only critical-app-review is shadow locally
    await recordShadow(admin, 'node/app-1', evals); // re-evaluation updates, never duplicates
    expect(await shadowSummary(admin)).toEqual([{ policyId: 'critical-app-review', evaluated: 1, matched: 1, errors: 0 }]);
    const err = evaluateAsset(idx.forType('Integration'), { qualified_name: 'x' }); // missing edge: an error, recorded as such
    await recordShadow(admin, 'node/int-9', [{ ...err[0]!, policy: { ...err[0]!.policy, mode: 'shadow' } }]);
    expect((await shadowSummary(admin, 'integration-has-dataset'))[0]).toMatchObject({ evaluated: 1, matched: 0, errors: 1 });
  });
});
