import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExceptionPort, RaiseExceptionRequest, Signal } from '../packages/contracts/src/index';
import { loadRegistry, migrateModule, provisionModule } from '../packages/platform/src/index';
import { CatalogStore } from '../packages/catalog/src/index';
import { SyncService, compileJob, compileOverlay, resolveJob, restConnector } from '../packages/connectors/src/index';
import { CatalogIngest } from '../apps/worker/src/ingest';
import { ScopeOwnerCheck } from '../apps/worker/src/scope-owners';
import { PersonRefResolver } from '../apps/worker/src/person-refs';

const root = join(import.meta.dirname, '..');
const registry = loadRegistry(join(root, 'metamodel/types'));
const store = new CatalogStore(registry);
const overlay = compileOverlay(readFileSync(join(root, 'sync/overlays/local.yaml'), 'utf8'));
const JOBS = ['aris-scopes', 'rris-scopes', 'bcbs-scopes'];

// the recorded inventories are served the way the mock source server does; a test can replace one to simulate a change at the source
const served = new Map<string, unknown>();
const fixture = (name: string) => JSON.parse(readFileSync(join(root, 'sync/fixtures', `${name}.json`), 'utf8')) as { records: Record<string, unknown>[] };
let http: Server; let base = '';
let server: EmbeddedPostgres; let admin: pg.Client; let cdb: pg.Client; let sdb: pg.Client; let pool: pg.Pool; let svc: SyncService;
const raised: RaiseExceptionRequest[] = []; const withdrawn: string[] = []; const forwarded: Signal[] = [];
const exceptions: ExceptionPort = { async raise(r) { raised.push(r); return { id: 'x', created: true }; }, async withdraw(r) { withdrawn.push(r.subjectRef); return true; } };
const idp = { kind: 'sync', source: 'idp' } as const;
const rejects: { key: string; reason: string }[] = [];
const run = (job: string) => svc.run(sdb, job, 'local');

beforeAll(async () => {
  http = createServer((req, res) => {
    const name = /^\/v1\/([\w-]+)/.exec(req.url ?? '')?.[1] ?? '';
    const body = served.get(name) ?? fixture(name);
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body));
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}/`;

  server = new EmbeddedPostgres({ databaseDir: mkdtempSync(join(tmpdir(), 'dmc-s11-')), user: 'postgres', password: 'pw', port: 54421, persistent: false });
  await server.initialise(); await server.start();
  admin = new pg.Client({ host: 'localhost', port: 54421, user: 'postgres', password: 'pw', database: 'postgres' }); await admin.connect();
  for (const [m, pw] of [['catalog', 'cat'], ['connectors', 'con']] as const) {
    await provisionModule(admin, m, { password: pw });
    await migrateModule(admin, m, join(root, `packages/${m}/migrations`));
    await admin.query(`grant all on all tables in schema ${m} to dmc_${m}`);
    await admin.query(`grant all on all sequences in schema ${m} to dmc_${m}`);
  }
  cdb = new pg.Client({ host: 'localhost', port: 54421, user: 'dmc_catalog', password: 'cat', database: 'postgres' }); await cdb.connect();
  sdb = new pg.Client({ host: 'localhost', port: 54421, user: 'dmc_connectors', password: 'con', database: 'postgres' }); await sdb.connect();
  pool = new pg.Pool({ host: 'localhost', port: 54421, user: 'dmc_catalog', password: 'cat', database: 'postgres', max: 2 });
  const connect = async () => { const x = await pool.connect(); return { query: (q: string, p?: unknown[]) => x.query(q, p) as never, release: () => x.release() }; };
  const owners = new ScopeOwnerCheck({ store, connect, exceptions, next: { async submit(s) { forwarded.push(...s); } } });
  const ingest = new CatalogIngest({ store, connect, sourceOf: (job) => svc.writerSource(sdb, job), next: owners });
  svc = new SyncService({ connectors: { rest: restConnector({ async resolveSecret() { return 'none'; } }) }, signals: new PersonRefResolver({ store, registry, connect, next: ingest, onReject: (s, reason) => { rejects.push({ key: s.subjectRef, reason }); } }), exceptions, sleep: async () => {} });

  // the three source connections of the local overlay, pointed at the in-process server
  for (const [name, c] of Object.entries(overlay.connections ?? {})) {
    if (!/^mock-(aris|rris|bcbs)$/.test(name)) continue;
    const { secret, type: _t, ...config } = c as { secret: string; type?: string; [k: string]: unknown };
    await svc.upsertConnection(sdb, { name, environment: 'local', type: 'rest', config: { ...config, baseUrl: base }, secretRef: secret });
  }
  for (const j of JOBS) await svc.installJob(sdb, resolveJob(compileJob(readFileSync(join(root, `sync/jobs/${j}.yaml`), 'utf8')), overlay, 'local'));
  // people as the identity provider would supply them (staff id as qualified name); two owners in the inventories are deliberately absent
  for (const [id, email] of [['43000004', 'olive@bank.example'], ['43000002', 'ben@bank.example']]) {
    await store.tx(cdb, () => store.applyNode(cdb, { type: 'Person', qualifiedName: id!, attributes: { email: email!, name: id! }, writer: idp, actor: 'idp' }));
  }
}, 150_000);
afterAll(async () => { try { http?.close(); await sdb?.end(); await cdb?.end(); await pool?.end(); await admin?.end(); } finally { await server?.stop(); } });

describe('S11: ARIS, RRIS and BCBS inventory jobs', () => {
  it('S11 CAT-9: one job per source, each resolved by the local overlay, all onto the Scope type', () => {
    for (const j of JOBS) {
      const r = resolveJob(compileJob(readFileSync(join(root, `sync/jobs/${j}.yaml`), 'utf8')), overlay, 'local');
      expect(r).toMatchObject({ enabled: true, connection: `mock-${j.replace('-scopes', '')}` });
      expect(r.def.target).toMatchObject({ type: 'Scope', source: 'scope-sources' });
      // metamodel is data: every mapped attribute exists on Scope and is owned by the scope sources
      const attrs = registry.get('Scope').attributes as Record<string, { source?: string }>;
      for (const attr of Object.keys(r.def.target.map)) expect(attrs[attr]?.source).toBe('scope-sources');
    }
  });

  it('S11 CAT-9: a first run of each job puts every scope in the catalog with name, owner and kind, written by the scope sources', async () => {
    for (const j of JOBS) expect(await run(j)).toMatchObject({ status: 'succeeded', created: 4, errors: 0 });
    const aris = await store.getNode(cdb, 'aris-proc-0101');
    expect(aris).toMatchObject({ type: 'Scope', lifecycle: 'discovered', attributes: { name: 'Customer onboarding', owner: '43000004', kind: 'business-process' } });
    expect(aris!.provenance.owner!.by).toBe('scope-sources');
    expect((await store.getNode(cdb, 'rris-pra110'))!.attributes).toMatchObject({ name: 'PRA110 Cash flow mismatch', owner: '43000004', kind: 'regulatory-return' });
    expect((await store.getNode(cdb, 'bcbs-met-ead'))!.attributes).toMatchObject({ name: 'Exposure at default', owner: '43000004', kind: 'report-metric' });
    expect((await store.getNode(cdb, 'bcbs-rpt-liquidity'))!.attributes.kind).toBe('report');
    const all = await store.listByType(cdb, 'Scope', { limit: 100 });
    expect(all).toHaveLength(12);
  });

  it('S11 CAT-9: known owners raise nothing; unknown owners raise an exception to the platform admin and the run still succeeds', () => {
    expect(raised.map((r) => r.subjectRef).sort()).toEqual(['Scope:aris-proc-0104', 'Scope:rris-hkma-liq']);
    expect(raised.every((r) => r.kind === 'scope.owner_unknown' && r.route === 'platform-admin' && r.policyId === 'scope-owner-unknown')).toBe(true);
    expect(raised.find((r) => r.subjectRef === 'Scope:rris-hkma-liq')!.message).toContain('43000098');
    // every signal still reached the decision path
    expect(forwarded.filter((s) => s.subjectType === 'Scope')).toHaveLength(12);
  });

  it('S11 CAT-9 / ADR 0026: an owner may also be given as an email (resolved to the staff ID); the exception is withdrawn when the source names a known owner', async () => {
    const rris = fixture('rris-returns');
    rris.records = rris.records.map((r) => (r.return_id === 'rris-hkma-liq' ? { ...r, owner: { staff_id: 'OLIVE@bank.example' } } : r));
    served.set('rris-returns', rris);
    raised.length = 0; withdrawn.length = 0;
    expect(await run('rris-scopes')).toMatchObject({ status: 'succeeded', updated: 1, unchanged: 3 });
    expect(raised).toHaveLength(0);
    expect(withdrawn).toContain('Scope:rris-hkma-liq');
    // ADR 0026: the email was resolved to the Person's key, the staff ID; that is what is stored
    expect((await store.getNode(cdb, 'rris-hkma-liq'))!.attributes.owner).toBe('43000004');
  });

  it('S11 CAT-9: an unchanged inventory writes nothing; an owner change at the source updates the scope', async () => {
    forwarded.length = 0;
    expect(await run('aris-scopes')).toMatchObject({ status: 'succeeded', unchanged: 4, created: 0, updated: 0 });
    expect(forwarded).toHaveLength(0);
    const aris = fixture('aris-processes');
    aris.records = aris.records.map((r) => (r.process_id === 'aris-proc-0104' ? { ...r, process_owner_sid: '43000002' } : r));
    served.set('aris-processes', aris);
    raised.length = 0; withdrawn.length = 0;
    await run('aris-scopes');
    expect((await store.getNode(cdb, 'aris-proc-0104'))!.attributes.owner).toBe('43000002');
    expect(withdrawn).toContain('Scope:aris-proc-0104');
  });

  it('S11 rule 9: scope name, owner and kind are read-only in DMC; a user write is refused, DMC-owned attributes are not', async () => {
    await expect(store.tx(cdb, () => store.applyNode(cdb, { type: 'Scope', qualifiedName: 'aris-proc-0101', attributes: { owner: '43000002' }, writer: { kind: 'user' }, actor: 'olive' }))).rejects.toMatchObject({ code: 'validation_failed' });
    await store.tx(cdb, () => store.applyNode(cdb, { type: 'Scope', qualifiedName: 'aris-proc-0101', attributes: { required_tier: 'gold' }, writer: { kind: 'user' }, actor: 'olive' }));
    expect((await store.getNode(cdb, 'aris-proc-0101'))!.attributes).toMatchObject({ required_tier: 'gold', owner: '43000004' });
  });

  it('S11 CAT-9: a scope that leaves its inventory is deprecated, not deleted, and its owner exception is withdrawn', async () => {
    const bcbs = fixture('bcbs-inventory');
    bcbs.records = bcbs.records.filter((r) => r['Report ID'] !== 'bcbs-met-lcr');
    served.set('bcbs-inventory', bcbs);
    withdrawn.length = 0;
    // one of four records gone is 25%, under the job's 30% limit
    expect(await run('bcbs-scopes')).toMatchObject({ status: 'succeeded', deprecated: 1 });
    expect((await store.getNode(cdb, 'bcbs-met-lcr'))!.lifecycle).toBe('deprecated');
    expect(withdrawn).toContain('Scope:bcbs-met-lcr');
  });
});
