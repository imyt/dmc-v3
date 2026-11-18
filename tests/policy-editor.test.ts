import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Authz, loadRegistry, migrateModule, provisionModule } from '../packages/platform/src/index';
import { CatalogStore } from '../packages/catalog/src/index';
import { compilePolicy, checkDraft, renderReport } from '../packages/policy/src/index';
import { checkResponse, loadSpec } from '../packages/contracts/src/index';
import { createApi, devAuthenticator, FileChangeRequests } from '../apps/api/src/index';

const root = join(import.meta.dirname, '..');
const registry = loadRegistry(join(root, 'metamodel/types'));
const store = new CatalogStore(registry);
const spec = loadSpec();
const YAML = `policy: app-needs-description
control: metadata
implements: TCR-0009
mode: shadow
scope: { type: Application }
when: "!has(application.description) || application.description == ''"
effect: { action: raise_exception, message: Add a description }
route: application-owner
`;
const GOLDEN = `cases:
  - name: no description matches
    asset: { qualified_name: a1, name: A }
    expect: true
  - name: with description does not
    asset: { qualified_name: a2, name: B, description: Payments }
    expect: false
`;
const existing = [compilePolicy(readFileSync(join(root, 'policies/examples/application-has-owner.yaml'), 'utf8'), registry, 'application-has-owner.yaml')];

describe('P3: checking a draft', () => {
  it('a good draft passes and reports a dry run', () => {
    const r = checkDraft(YAML, GOLDEN, registry, existing, { Application: [{ qualified_name: 'x', name: 'X' }, { qualified_name: 'y', name: 'Y', description: 'ok' }] });
    expect(r).toMatchObject({ ok: true, problems: [], conflicts: [], dryRun: { sampled: 2, matched: 1, errors: 0, matches: ['x'] } });
    expect(renderReport(r)).toContain('passed');
  });
  it('compile problems, missing golden cases and failing cases are reported', () => {
    expect(checkDraft('policy: x', GOLDEN, registry, existing).ok).toBe(false);
    expect(checkDraft(YAML, undefined, registry, existing).problems[0]).toContain('golden');
    const bad = checkDraft(YAML, GOLDEN.replace('expect: true', 'expect: false'), registry, existing);
    expect(bad.ok).toBe(false);
    expect(bad.cases.filter((c) => !c.pass)).toHaveLength(1);
    expect(renderReport(bad)).toContain('FAILED');
  });
  it('a policy that contradicts one in force is blocked', () => {
    const set = (v: string) => `policy: set-${v}\ncontrol: c\nmode: shadow\nscope: { type: Application }\nwhen: "application.status == 'live'"\neffect: { action: set_attribute, attribute: description, value: ${v} }\nroute: application-owner\n`;
    const a = compilePolicy(set('one'), registry, 'set-one.yaml');
    const r = checkDraft(set('two'), 'cases:\n  - { name: m, asset: { qualified_name: a, status: live }, expect: true }\n  - { name: n, asset: { qualified_name: b, status: retired }, expect: false }\n', registry, [a]);
    expect(r.ok).toBe(false);
    expect(r.conflicts).toHaveLength(1);
  });
});

describe('P3: the editor API', () => {
  let server: EmbeddedPostgres; let admin: pg.Client; let pool: pg.Pool; let evPool: pg.Pool; let app: NestFastifyApplication;
  const prs = mkdtempSync(join(tmpdir(), 'dmc-pr-'));
  const author = { 'x-dmc-user': 'pat', 'x-dmc-groups': 'dmc-policy-author' };
  const inj = (url: string, headers: Record<string, string>, payload: unknown) => app.getHttpAdapter().getInstance().inject({ method: 'POST', url, headers, payload: payload as never });
  beforeAll(async () => {
    server = new EmbeddedPostgres({ databaseDir: mkdtempSync(join(tmpdir(), 'dmc-pe-')), user: 'postgres', password: 'pw', port: 54361, persistent: false });
    await server.initialise(); await server.start();
    admin = new pg.Client({ host: 'localhost', port: 54361, user: 'postgres', password: 'pw', database: 'postgres' }); await admin.connect();
    for (const m of ['catalog', 'evidence']) {
      await provisionModule(admin, m, { password: m }); await migrateModule(admin, m, join(root, `packages/${m}/migrations`));
      await admin.query(`grant all on all tables in schema ${m} to dmc_${m}`); await admin.query(`grant all on all sequences in schema ${m} to dmc_${m}`);
    }
    pool = new pg.Pool({ host: 'localhost', port: 54361, user: 'dmc_catalog', password: 'catalog', database: 'postgres', max: 3 });
    evPool = new pg.Pool({ host: 'localhost', port: 54361, user: 'dmc_evidence', password: 'evidence', database: 'postgres', max: 2 });
    const c = await pool.connect();
    try { await store.tx(c, () => store.applyNode(c, { type: 'Application', qualifiedName: 'app-1', attributes: { name: 'One', owner: 'amy', hosting_country: 'GB' }, writer: { kind: 'sync', source: 'servicenow' }, actor: 't' })); } finally { c.release(); }
    const lease = (p: pg.Pool) => async () => { const x = await p.connect(); return { query: (s: string, a?: unknown[]) => x.query(s, a) as never, release: () => x.release() }; };
    app = await createApi({
      version: '0.1.0', registry, store, authz: Authz.load(readFileSync(join(root, 'config/authz.yaml'), 'utf8')), authenticate: devAuthenticator('local'),
      connect: lease(pool), connectEvidence: lease(evPool), policies: () => [], policyEditor: { existing: () => existing }, changeRequests: new FileChangeRequests(prs),
      exceptions: { async raise() { return { id: 'e', created: true }; }, async withdraw() { return true; } },
      inbox: { async forSubject() { return []; }, async list() { return []; }, async get() { return undefined; }, async decide() { return { replayed: false }; } },
      signals: { async submit() {} }, idempotency: { async get() { return undefined; }, async put() {} },
    });
  }, 150_000);
  afterAll(async () => { try { await app?.close(); await pool?.end(); await evPool?.end(); await admin?.end(); } finally { try { await server?.stop(); } finally { rmSync(prs, { recursive: true, force: true }); } } });

  it('checks a draft against sample assets from the catalog', async () => {
    const r = await inj('/v1/policies/check', author, { yaml: YAML, golden: GOLDEN });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, dryRun: { sampled: 1, matched: 1 } });
    expect(checkResponse(spec, '/v1/policies/check', 'post', 200, r.json())).toEqual([]);
  });
  it('only policy authors, and only people', async () => {
    expect((await inj('/v1/policies/check', { 'x-dmc-user': 'eve' }, { yaml: YAML, golden: GOLDEN })).statusCode).toBe(403);
    expect((await inj('/v1/policies/propose', { 'x-dmc-user': 'bot', 'x-dmc-kind': 'service', 'x-dmc-groups': 'dmc-policy-author' }, { yaml: YAML, golden: GOLDEN })).statusCode).toBe(403);
    expect((await inj('/v1/policies/check', author, {})).statusCode).toBe(422);
  });
  it('saving a passing draft opens a pull request with the report attached', async () => {
    const r = await inj('/v1/policies/propose', author, { yaml: YAML, golden: GOLDEN, message: 'Require descriptions' });
    expect(r.statusCode).toBe(201);
    expect(checkResponse(spec, '/v1/policies/propose', 'post', 201, r.json())).toEqual([]);
    const dir = r.json().url.replace('file://', '');
    expect(readFileSync(join(dir, 'PULL_REQUEST.md'), 'utf8')).toContain('DMC dry-run report: passed');
    expect(existsSync(join(dir, 'files/policies/app-needs-description.yaml'))).toBe(true);
    expect(existsSync(join(dir, 'files/policies/app-needs-description.golden.yaml'))).toBe(true);
  });
  it('a failing draft opens nothing', async () => {
    const before = (await import('node:fs')).readdirSync(prs).length;
    const r = await inj('/v1/policies/propose', author, { yaml: YAML, golden: GOLDEN.replace('expect: true', 'expect: false') });
    expect(r.statusCode).toBe(422);
    expect((await import('node:fs')).readdirSync(prs).length).toBe(before);
  });
});
