import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExceptionPort, Signal, SourceRecord } from '../packages/contracts/src/index';
import { loadRegistry, migrateModule, provisionModule } from '../packages/platform/src/index';
import { CatalogStore } from '../packages/catalog/src/index';
import { CatalogIngest, PersonRefResolver } from '../apps/worker/src/index';
import { SyncService, compileJob, compileOverlay, resolveJob, restConnector, type JobDef } from '../packages/connectors/src/index';

/**
 * The IdP people job (ADR 0026, closes its open item): Person nodes keyed by the staff ID. The IdP's API is NOT known: the stand-in server below serves an INVENTED fixture
 * (sync/fixtures/idp/users.json) shaped like a typical paged directory API. The real endpoint, auth, paging and field names must come from the identity team.
 */
const root = join(import.meta.dirname, '..');
const registry = loadRegistry(join(root, 'metamodel/types'));
const FIXTURE = (JSON.parse(readFileSync(join(root, 'sync/fixtures/idp/users.json'), 'utf8')) as { users: SourceRecord[] }).users;
const user = (employeeId: unknown, mail: string, displayName = 'Test Person', department = 'Test Dept'): SourceRecord => ({ employeeId, mail, displayName, department, phone: '000-0000', manager: '00123456' });

// the stand-in directory: the recorded users, paged with startAt/maxResults; a test can drop users (leavers) or add records the directory might hold
let server: Server; let base = ''; const asked: string[] = [];
const dropped = new Set<string>(); let extra: SourceRecord[] = [];
const stable: SourceRecord[] = []; // records that stay in the directory once a test has added them
beforeAll(async () => {
  server = createServer((req, res) => {
    const u = new URL(req.url!, 'http://x'); asked.push(`${u.pathname}${u.search}`);
    if (u.pathname !== '/v1/users') { res.writeHead(404); res.end('{}'); return; }
    const all = [...FIXTURE.filter((r) => !dropped.has(String(r.employeeId))), ...stable, ...extra];
    const o = Number(u.searchParams.get('startAt') ?? 0); const l = Number(u.searchParams.get('maxResults') ?? 100);
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ totalResults: all.length, users: all.slice(o, o + l) }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const secrets = { async resolveSecret() { return 'S3CRET'; } };
const connConfig = () => ({ baseUrl: base, allowInsecure: true, auth: { type: 'bearer' }, recordsPath: 'users', paging: { style: 'offset', offsetParam: 'startAt', limitParam: 'maxResults' } });
const overlay = () => compileOverlay('connections:\n  idp: { secret: sm/idp, peoplePath: "/v1/users" }\n');
const loadJob = (): JobDef => compileJob(readFileSync(join(root, 'sync/jobs/idp-people.yaml'), 'utf8'));
const idp = { kind: 'sync', source: 'idp' } as const;

describe('IdP people job definition', () => {
  it('resolves against the overlay, maps only the four Person attributes the IdP owns, and is off locally', () => {
    const def = loadJob();
    expect(def.target).toMatchObject({ type: 'Person', key: 'employeeId', source: 'idp', on_missing: 'deprecate' });
    expect(Object.keys(def.target.map).sort()).toEqual(['department', 'email', 'name', 'staff_id']); // no phone, address or manager chain
    const attrs = registry.get('Person').attributes as Record<string, { source?: string }>;
    for (const a of Object.keys(def.target.map)) expect(attrs[a]?.source, `Person.${a}`).toBe('idp'); // never hard-coded: the registry says the IdP owns them
    expect(resolveJob(def, overlay(), 'uat')).toMatchObject({ query: '/v1/users', enabled: true });
    expect(() => resolveJob(def, compileOverlay('connections: { idp: { secret: s } }'), 'uat')).toThrow(/peoplePath/);
    const local = compileOverlay(readFileSync(join(root, 'sync/overlays/local.yaml'), 'utf8'));
    expect(resolveJob(def, local, 'local').enabled).toBe(false); // local people come from the seed
  });
  it('the fixture is invented and says so; every staff ID in it is a string of 8 digits, and leading zeros are present', () => {
    expect(readFileSync(join(root, 'sync/fixtures/idp/users.json'), 'utf8')).toMatch(/INVENTED/);
    expect(FIXTURE.every((r) => typeof r.employeeId === 'string' && /^\d{8}$/.test(r.employeeId))).toBe(true);
    expect(FIXTURE.some((r) => String(r.employeeId).startsWith('0'))).toBe(true);
  });
});

describe('IdP people sync into a real catalog', () => {
  const rejected: { kind: string; key: string; reason: string }[] = [];
  const store = new CatalogStore(registry);
  let admin: pg.Client; let db: pg.Client; let cdb: pg.Client; let pgServer: EmbeddedPostgres; let svc: SyncService;
  const exceptions: ExceptionPort & { raised: string[] } = { raised: [], async raise(e) { this.raised.push(e.kind); return { id: 'x', created: true }; }, async withdraw() { return true; } };
  const catalogConn = () => ({ query: (q: string, p?: unknown[]) => cdb.query(q, p) as never, release() {} });
  let front: PersonRefResolver;
  const people = async () => (await store.listByType(cdb, 'Person', { limit: 500 }));
  const counts = async () => ({
    versions: (await admin.query<{ n: number }>('select count(*)::int as n from catalog.node_version')).rows[0]!.n,
    outbox: (await admin.query<{ n: number }>('select count(*)::int as n from catalog.outbox')).rows[0]!.n,
    edges: (await admin.query<{ n: number }>('select count(*)::int as n from catalog.edge')).rows[0]!.n,
  });
  const run = (env = 'uat') => svc.run(db, 'idp-people', env);

  beforeAll(async () => {
    pgServer = new EmbeddedPostgres({ databaseDir: mkdtempSync(join(tmpdir(), 'dmc-idp-')), user: 'postgres', password: 'pw', port: 54540, persistent: false });
    await pgServer.initialise(); await pgServer.start();
    admin = new pg.Client({ host: 'localhost', port: 54540, user: 'postgres', password: 'pw', database: 'postgres' }); await admin.connect();
    for (const [m, pw] of [['catalog', 'cat'], ['connectors', 'con']] as const) {
      await provisionModule(admin, m, { password: pw });
      await migrateModule(admin, m, join(root, `packages/${m}/migrations`));
      await admin.query(`grant all on all tables in schema ${m} to dmc_${m}`);
      await admin.query(`grant all on all sequences in schema ${m} to dmc_${m}`);
    }
    db = new pg.Client({ host: 'localhost', port: 54540, user: 'dmc_connectors', password: 'con', database: 'postgres' }); await db.connect();
    cdb = new pg.Client({ host: 'localhost', port: 54540, user: 'dmc_catalog', password: 'cat', database: 'postgres' }); await cdb.connect();
    const onReject = (s: Signal, reason: string) => { rejected.push({ kind: s.kind, key: s.subjectRef, reason }); };
    const ingest = new CatalogIngest({ store, connect: async () => catalogConn(), sourceOf: (job) => svc.writerSource(db, job), onReject });
    // as in the worker: the resolver sits in front of the ingest
    front = new PersonRefResolver({ store, registry, connect: async () => catalogConn(), next: ingest, onReject });
    svc = new SyncService({ connectors: { rest: restConnector(secrets) }, signals: front, exceptions, sleep: async () => {} });
    for (const env of ['uat', 'uat-limit']) await svc.upsertConnection(db, { name: 'idp', environment: env, type: 'rest', secretRef: 'sm/idp', config: connConfig() });
    const def = loadJob(); def.source.page_size = 4; // several pages
    // 'uat' runs with the change limit lifted so a test can add several records at once; 'uat-limit' keeps the job's own limit
    await svc.installJob(db, resolveJob({ ...def, limits: { max_changes_pct: 100 } }, overlay(), 'uat'));
    await svc.installJob(db, resolveJob(def, overlay(), 'uat-limit'));
  }, 120_000);
  afterAll(async () => {
    await db?.end(); await cdb?.end(); await admin?.end();
    try { await pgServer?.stop(); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EBUSY') throw e; }
  });

  it('PRV-4 first run: creates a Person for every user, keyed by the staff ID with its leading zeros, with the four attributes and nothing else', async () => {
    expect(await run()).toMatchObject({ status: 'succeeded', complete: true, read: 10, created: 10, errors: 0 });
    expect(asked.some((q) => q.includes('startAt=4') && q.includes('maxResults=4'))).toBe(true); // paged
    expect(rejected).toEqual([]);
    const all = await people();
    expect(all.map((p) => p.qualifiedName).sort()).toEqual(FIXTURE.map((r) => String(r.employeeId)).sort());
    for (const key of ['00123456', '00000007', '04300004', '00000100']) expect(all.find((p) => p.qualifiedName === key), key).toBeDefined(); // zeros survive: never 123456, 7, 4300004
    const alice = all.find((p) => p.qualifiedName === '00123456')!;
    expect(alice.attributes).toEqual({ email: 'alice.archer@example.test', staff_id: '00123456', name: 'Alice Archer', department: 'Finance' });
    for (const p of all) {
      expect(typeof p.attributes.staff_id).toBe('string');
      expect(p.attributes.staff_id).toBe(p.qualifiedName);
      expect(Object.keys(p.attributes).sort()).toEqual(['department', 'email', 'name', 'staff_id']); // metadata only: no phone, no manager
    }
    expect(JSON.stringify(all)).not.toMatch(/phone|manager|000-00|S3CRET/);
  });

  it('PRV-4 a rerun changes nothing: no new node version, no outbox event, no edge', async () => {
    const before = await counts();
    expect(await run()).toMatchObject({ status: 'succeeded', complete: true, created: 0, updated: 0, unchanged: 10, deprecated: 0, errors: 0 });
    expect(await counts()).toEqual(before);
    expect(rejected).toEqual([]);
  });

  it('a Collibra or ServiceNow style owner email resolves to the staff ID after this job has run, whatever its case', async () => {
    // ServiceNow style: an application whose owner is an email (a person attribute)
    const app: Signal = { source: 'servicenow', key: 'app-1@h', kind: 'sync.upsert', subjectRef: 'Application:app-1', subjectType: 'Application', actor: 'sync/servicenow',
      asset: { name: 'App One', owner: 'A.Owner@Example.COM', hosting_country: 'GB' } };
    // Collibra style: a steward and an owner edge from a glossary term to the user, named by email
    await store.tx(cdb, () => store.applyNode(cdb, { type: 'BusinessTerm', qualifiedName: 'gl:term-1', attributes: { name: 'Term one', status: 'Approved' }, writer: { kind: 'sync', source: 'collibra' }, actor: 'test' }));
    const link = (edge: string, to: string): Signal => ({ source: 'collibra-owners', key: `gl:term-1->${to}@${edge}`, kind: 'sync.link', subjectRef: `BusinessTerm:gl:term-1->${to}`, subjectType: 'BusinessTerm', actor: 'sync/collibra', asset: { edge, from: 'gl:term-1', to, attributes: { responsibility: 'r1' } } });
    expect(await front.submit([app, link('stewarded_by', 'b.steward@example.com'), link('owned_by', '00999999')])).toEqual({});
    expect((await store.getNode(cdb, 'app-1'))!.attributes.owner).toBe('00450012'); // not the email, not a number, zeros kept
    const edges = (await store.namedEdgesOf(cdb, 'gl:term-1')).map((e) => [e.name, e.toQn]);
    expect(edges).toEqual(expect.arrayContaining([['stewarded_by', '00450013'], ['owned_by', '00999999']]));
    // an email nobody has, and a number that lost its zeros, are refused and never padded
    rejected.length = 0;
    const bad = await front.submit([link('owned_by', 'nobody@example.com'), { ...app, key: 'app-2@h', subjectRef: 'Application:app-2', asset: { ...app.asset, owner: '123456' } }]);
    expect(bad.rejected).toHaveLength(2);
    expect(rejected.map((r) => r.reason).join('\n')).toMatch(/no Person has the email nobody@example.com[\s\S]*leading zeros/);
    expect(await store.getNode(cdb, 'app-2')).toBeUndefined();
  });

  it('PRV-4 a bad staff ID goes through the reject path: refused and reported, never padded or trimmed, and a refused record is sent again next run', async () => {
    const bads = [user('4300012', 'seven.digits@example.test'), user(4300013, 'a.number@example.test'), user('abc12345', 'letters@example.test'), user(' 00000555', 'space@example.test'), user('123456789', 'nine@example.test')];
    extra = bads; rejected.length = 0;
    const before = (await people()).length;
    const r = await run();
    expect(r).toMatchObject({ status: 'succeeded', complete: true, deprecated: 0 }); // a refused record was read: it must not make anyone a leaver
    expect(r.note).toMatch(/5 records refused by the catalog/);
    expect(rejected).toHaveLength(5);
    expect(rejected.every((x) => /not a valid Person key/.test(x.reason))).toBe(true);
    expect((await people()).length).toBe(before);
    for (const k of ['4300012', '04300012', '00430012', '4300013', '04300013', '00000555', '123456789']) expect(await store.getNode(cdb, k), k).toBeUndefined();
    // still bad, still reported (not silent), and still nobody deprecated
    rejected.length = 0;
    expect(await run()).toMatchObject({ status: 'succeeded', created: 5, deprecated: 0 });
    expect(rejected).toHaveLength(5);
    // fixed at the source: created at once, with its zeros
    extra = [user('00430012', 'seven.digits@example.test', 'Fixed Person')]; rejected.length = 0;
    expect(await run()).toMatchObject({ status: 'succeeded', created: 1 });
    expect(rejected).toEqual([]);
    expect((await store.getNode(cdb, '00430012'))!.attributes.name).toBe('Fixed Person');
    stable.push(...extra); extra = [];
  });

  it('PRV-4 an email another person already has, or two people share in one run, is reported as an error and not written', async () => {
    extra = [user('00777771', 'ALICE.archer@example.test', 'Clash With Existing'), user('00777772', 'twin@example.test', 'Twin One'), user('00777773', 'Twin@example.test', 'Twin Two'), user('00777774', 'unique@example.test', 'Fine')];
    rejected.length = 0;
    const r = await run();
    expect(r).toMatchObject({ status: 'succeeded', deprecated: 0 });
    expect(r.note).toMatch(/refused by the catalog/);
    const reasons = Object.fromEntries(rejected.map((x) => [x.key, x.reason]));
    expect(reasons['Person:00777771']).toMatch(/already belongs to Person 00123456/);
    expect(reasons['Person:00777772']).toMatch(/more than one Person in this run/);
    expect(reasons['Person:00777773']).toMatch(/more than one Person in this run/);
    expect(Object.keys(reasons)).toHaveLength(3);
    for (const k of ['00777771', '00777772', '00777773']) expect(await store.getNode(cdb, k), k).toBeUndefined();
    expect((await store.getNode(cdb, '00777774'))!.attributes.email).toBe('unique@example.test');
    expect((await store.getNode(cdb, '00123456'))!.attributes.name).toBe('Alice Archer'); // the existing holder is untouched
    // the email still resolves to exactly one person
    const app: Signal = { source: 'servicenow', key: 'app-3@h', kind: 'sync.upsert', subjectRef: 'Application:app-3', subjectType: 'Application', actor: 'sync/servicenow', asset: { name: 'App Three', owner: 'alice.archer@example.test', hosting_country: 'GB' } };
    expect(await front.submit([app])).toEqual({});
    expect((await store.getNode(cdb, 'app-3'))!.attributes.owner).toBe('00123456');
    stable.push(extra[3]!); extra = [];
  });

  it('PRV-4 a leaver (missing from a complete full run) is deprecated, never deleted; back in the directory, the person is live again', async () => {
    // the ownership edge created above points at this person (owned_by 00999999)
    dropped.add('00999999');
    const before = (await people()).length;
    // the first run after the fixture additions above left some pending records; settle them first so the counts below are about the leaver
    const r = await run();
    expect(r).toMatchObject({ status: 'succeeded', complete: true, deprecated: 1 });
    const gone = (await store.getNode(cdb, '00999999'))!;
    expect(gone.lifecycle).toBe('deprecated');
    expect(gone.attributes).toMatchObject({ email: 'dara.doyle@example.test', name: 'Dara Doyle' }); // kept: history, evidence
    expect((await people()).length).toBe(before); // not deleted
    expect((await people()).filter((p) => p.lifecycle === 'deprecated').map((p) => p.qualifiedName)).toEqual(['00999999']);
    // rerun: nothing more
    const c = await counts();
    expect(await run()).toMatchObject({ status: 'succeeded', created: 0, updated: 0, deprecated: 0 });
    expect(await counts()).toEqual(c);

    // OWNERSHIP EDGES (reported, not changed): the owned_by edge to the deprecated Person stays live and is not ended or flagged by the sync
    const live = await admin.query<{ to: string; lifecycle: string }>(`select t.qualified_name as to, v.lifecycle from catalog.edge e join catalog.node t on t.id = e.to_id join catalog.node_version v on v.node_id = t.id and v.valid_to is null and v.recorded_to is null
      where e.name = 'owned_by' and e.valid_to is null and e.recorded_to is null and t.qualified_name = '00999999'`);
    expect(live.rows).toEqual([{ to: '00999999', lifecycle: 'deprecated' }]);
    // and an owner email still resolves to the deprecated Person (the resolver and the scope owner check look up the key and ignore the lifecycle)
    const app: Signal = { source: 'servicenow', key: 'app-4@h', kind: 'sync.upsert', subjectRef: 'Application:app-4', subjectType: 'Application', actor: 'sync/servicenow', asset: { name: 'App Four', owner: 'dara.doyle@example.test', hosting_country: 'GB' } };
    expect(await front.submit([app])).toEqual({});
    expect((await store.getNode(cdb, 'app-4'))!.attributes.owner).toBe('00999999');

    // back in the directory: live again (discovered), same key
    dropped.delete('00999999');
    expect(await run()).toMatchObject({ status: 'succeeded', updated: 1, deprecated: 0 });
    expect((await store.getNode(cdb, '00999999'))!.lifecycle).toBe('discovered');
  });

  it('a directory that answers with a truncated list does not mass-deprecate: the change limit pauses the run and raises an exception', async () => {
    expect(await run('uat-limit')).toMatchObject({ status: 'succeeded', complete: true }); // first load of this environment: never limited
    for (const r of FIXTURE.slice(2)) dropped.add(String(r.employeeId));
    const r = await run('uat-limit');
    expect(r).toMatchObject({ status: 'paused_limit', deprecated: 8 });
    expect(exceptions.raised).toContain('sync.change_limit');
    expect((await people()).filter((p) => p.lifecycle === 'deprecated')).toHaveLength(0);
    dropped.clear();
  });

  it('a record that the REST connector cannot map (no staff ID) is an error and blocks deprecation for that run', async () => {
    extra = [{ mail: 'nokey@example.test', displayName: 'No Key', department: 'X' }]; dropped.add('00000100');
    const r = await run();
    expect(r).toMatchObject({ status: 'succeeded', complete: false, errors: 1, deprecated: 0 });
    expect(r.note).toMatch(/no value for key field "employeeId"/);
    expect((await store.getNode(cdb, '00000100'))!.lifecycle).not.toBe('deprecated');
    extra = []; dropped.clear(); void idp;
  });
});
