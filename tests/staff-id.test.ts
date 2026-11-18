import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from '../packages/connectors/node_modules/yaml';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Signal } from '../packages/contracts/src/index';
import { Authz, loadRegistry, migrateModule, provisionModule } from '../packages/platform/src/index';
import { CatalogStore, diffRegistries, countAffected } from '../packages/catalog/src/index';
import { classifyPersonRef, compileJob, compileOverlay, emailIndex, mapRecord, parseReconcileMapping, reconcile, resolveJob, resolvePersonRef, staffIdPattern, type CollibraExport, type JobDef } from '../packages/connectors/src/index';
import { PersonRefResolver } from '../apps/worker/src/person-refs';
import { createApi, devAuthenticator } from '../apps/api/src/index';
import { parseCsv } from '../apps/api/src/csv';
import { seed } from '../scripts/seed-lib';

// ADR 0026: the Person key is the STAFF ID, a string of exactly 8 digits that often starts with zeros (00123456, 04300004).
const root = join(import.meta.dirname, '..');
const registry = loadRegistry(join(root, 'metamodel/types'));
const store = new CatalogStore(registry);
const pattern = staffIdPattern(registry);
const idp = { kind: 'sync', source: 'idp' } as const;
const ZERO = '00123456'; const ZERO2 = '04300004';
const PORT = 54530;

let pgDir: string; let server: EmbeddedPostgres; let admin: pg.Client; let pool: pg.Pool; let app: NestFastifyApplication;
const conn = async () => { const x = await pool.connect(); return { query: (q: string, p?: unknown[]) => x.query(q, p) as never, release: () => x.release() }; };

beforeAll(async () => {
  server = new EmbeddedPostgres({ databaseDir: (pgDir = mkdtempSync(join(tmpdir(), 'dmc-staffid-'))), user: 'postgres', password: 'pw', port: PORT, persistent: false });
  await server.initialise(); await server.start();
  admin = new pg.Client({ host: 'localhost', port: PORT, user: 'postgres', password: 'pw', database: 'postgres' }); await admin.connect();
  await provisionModule(admin, 'catalog', { password: 'cat' });
  await migrateModule(admin, 'catalog', join(root, 'packages/catalog/migrations'));
  await admin.query('grant all on all tables in schema catalog to dmc_catalog'); await admin.query('grant all on all sequences in schema catalog to dmc_catalog');
  pool = new pg.Pool({ host: 'localhost', port: PORT, user: 'dmc_catalog', password: 'cat', database: 'postgres', max: 4 });
  app = await createApi({
    version: '0.1.0', registry, store, authz: Authz.load(readFileSync(join(root, 'config/authz.yaml'), 'utf8')), authenticate: devAuthenticator('local'),
    connectEvidence: async () => { throw new Error('not used'); }, policies: () => [],
    exceptions: { async raise() { return { id: 'e', created: true }; }, async withdraw() { return true; } },
    inbox: { async forSubject() { return []; }, async list() { return []; }, async get() { return undefined; }, async decide() { return { replayed: false }; } },
    signals: { async submit() {} }, idempotency: { async get() { return undefined; }, async put() {} }, connect: conn,
  });
}, 150_000);
afterAll(async () => {
  try {
    await app?.close(); await pool?.end(); await admin?.end();
  } finally {
    try { await server?.stop(); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EBUSY') throw e; } finally { if (pgDir) rmSync(pgDir, { recursive: true, force: true }); }
  }
});

describe('ADR 0026: the staff ID rule is data in the metamodel', () => {
  it('CAT-9 Person is keyed by the staff ID with the pattern in its YAML; the email stays an attribute', () => {
    const t = registry.get('Person');
    expect(t.identity).toEqual({ qualified_name: 'idp.staff_id', pattern: '^\\d{8}$' });
    expect(t.attributes.email).toMatchObject({ type: 'string', required: true });
    expect(t.attributes.staff_id!.pattern).toBe('^\\d{8}$');
    expect(pattern.test(ZERO)).toBe(true);
    for (const bad of ['1234567', '123456789', '0123456a', ' 00123456', '', '0012345\n']) expect(pattern.test(bad), JSON.stringify(bad)).toBe(false);
    // the generated API schema carries the pattern too
    const gen = JSON.parse(readFileSync(join(root, 'packages/contracts/openapi/metamodel.generated.json'), 'utf8')) as { components: { schemas: Record<string, { properties: Record<string, { pattern?: string }> }> } };
    expect(gen.components.schemas.PersonAttributes!.properties.staff_id!.pattern).toBe('^\\d{8}$');
  });

  it('M6 changing the identity of a type is a breaking change, counted against the nodes whose key no longer conforms', async () => {
    const old = loadRegistry(join(root, 'metamodel/types'));
    const types = old.all().map((t) => (t.type === 'Person' ? { ...t, version: 1, identity: { qualified_name: 'idp.email' } } : t));
    const { Registry } = await import('../packages/platform/src/index');
    const before = new Registry(types.map((t) => (t.type === 'Person' ? { ...t, attributes: { ...t.attributes, staff_id: { type: 'string', source: 'idp' } } } : t)));
    const changes = diffRegistries(before, registry);
    expect(changes.filter((c) => c.type === 'Person').map((c) => c.kind).sort()).toEqual(['attribute_pattern_changed', 'identity_changed']);
    expect(changes.filter((c) => c.type !== 'Person')).toEqual([]);
    expect(changes.every((c) => c.breaking)).toBe(true);
    // no Person node uses an old key yet (none exists): nothing is blocked; with one, it is
    const clean = await countAffected(admin, changes);
    expect(clean.every((c) => !c.blocked)).toBe(true);
    const oldStore = new CatalogStore(before); // the registry as it was: an email key was valid then
    await oldStore.tx(admin, () => oldStore.applyNode(admin, { type: 'Person', qualifiedName: 'old.person@example.com', attributes: { email: 'old.person@example.com' }, writer: idp, actor: 'idp' }));
    const used = await countAffected(admin, changes);
    expect(used.find((c) => c.kind === 'identity_changed')).toMatchObject({ affected: 1, blocked: true });
  });
});

describe('ADR 0026: a staff ID is a string on every path, leading zeros survive', () => {
  it('JSON: a fixture value round-trips as text; YAML: a quoted value is text, an unquoted one is a number that lost its zeros', () => {
    expect(JSON.parse('{"owner":"00123456"}').owner).toBe(ZERO);
    expect(parse('owner: "00123456"').owner).toBe(ZERO);
    expect(parse('owner: 00123456').owner).not.toBe(ZERO); // why every YAML and fixture must quote it
    expect(typeof parse('owner: 00123456').owner).toBe('number');
  });

  it('every fixture, job and config file holds staff IDs as quoted strings', () => {
    const users = JSON.parse(readFileSync(join(root, 'config/local-users.json'), 'utf8')) as { staffID: unknown }[];
    expect(users.every((u) => typeof u.staffID === 'string' && pattern.test(u.staffID))).toBe(true);
    expect(users.some((u) => String(u.staffID).startsWith('0'))).toBe(true);
    for (const f of ['applications', 'aris-processes', 'rris-returns', 'bcbs-inventory']) {
      const text = readFileSync(join(root, 'sync/fixtures', `${f}.json`), 'utf8');
      expect(text, f).not.toMatch(/"(owned_by|process_owner_sid|staff_id|Report Owner SID)"\s*:\s*\d/); // never a bare number
    }
  });

  it('CSV: a staff ID read from a CSV stays text', () => {
    expect(parseCsv('reference_id,owner\nDM-9,00123456\nDM-10,04300004\n')).toEqual([['reference_id', 'owner'], ['DM-9', ZERO], ['DM-10', ZERO2]]);
  });

  it('sync mapping: the owner of a source record is carried as the string it was', () => {
    const def = compileJob('job: j\nconnection: c\nschedule: "* * * * *"\nsource: { query: /x, mode: full }\ntarget: { type: Application, key: sys_id, source: servicenow, map: { owner: owned_by } }\n');
    expect(mapRecord({ sys_id: 'a', owned_by: ZERO }, def.target)).toMatchObject({ attrs: { owner: ZERO } });
    // a source that sent a number: the zeros are gone and it is refused later (a number is not a staff ID)
    expect(classifyPersonRef(123456, pattern)).toMatchObject({ kind: 'error' });
  });

  it('DB round trip: a Person keyed 00123456 is stored and read back as text, and found by its key', async () => {
    const c = await conn();
    await store.tx(c, () => store.applyNode(c, { type: 'Person', qualifiedName: ZERO, attributes: { email: 'zero@bank.example', staff_id: ZERO, name: 'Zero' }, writer: idp, actor: 'idp' }));
    await store.tx(c, () => store.applyNode(c, { type: 'Person', qualifiedName: ZERO2, attributes: { email: 'zero2@bank.example', staff_id: ZERO2, name: 'Zero Two' }, writer: idp, actor: 'idp' }));
    c.release();
    const db = await conn();
    const n = await store.getNode(db, ZERO);
    expect(n).toMatchObject({ type: 'Person', qualifiedName: ZERO, attributes: { staff_id: ZERO, email: 'zero@bank.example' } });
    expect((await admin.query<{ q: string; t: string }>("select qualified_name q, pg_typeof(qualified_name)::text t from catalog.node where qualified_name = $1", [ZERO])).rows).toEqual([{ q: ZERO, t: 'text' }]);
    expect((await admin.query<{ s: string }>("select v.attributes ->> 'staff_id' s from catalog.node_version v join catalog.node n on n.id = v.node_id where n.qualified_name = $1", [ZERO])).rows[0]!.s).toBe(ZERO);
    db.release();
  });

  it('API: the node response and the signed-in principal carry the staff ID as text; an owner with zeros is an owner', async () => {
    const c = await conn();
    await store.tx(c, () => store.applyNode(c, { type: 'Application', qualifiedName: 'app-zero', attributes: { name: 'Zero app', owner: ZERO2, hosting_country: 'GB' }, writer: { kind: 'sync', source: 'servicenow' }, actor: 'sync' }));
    c.release();
    const get = (url: string, user = ZERO2) => app.getHttpAdapter().getInstance().inject({ method: 'GET', url, headers: { 'x-dmc-user': user, 'x-dmc-groups': '' } });
    const person = await get(`/v1/nodes/${ZERO}`);
    expect(person.statusCode).toBe(200);
    expect(person.json()).toMatchObject({ type: 'Person', qualified_name: ZERO, attributes: { staff_id: ZERO } });
    expect((await get('/v1/nodes/app-zero')).json().attributes.owner).toBe(ZERO2);
    const me = (await get('/v1/auth/me')).json();
    expect(me.id).toBe(ZERO2);
    expect(me.roles).toContain('app-owner'); // the principal id equals the owner string: no number parsing anywhere
    expect((await get('/v1/auth/me', '4300004')).json().roles).not.toContain('app-owner'); // the number that lost its zeros is somebody else
  });

  it('seed: the local people are Person nodes keyed by their staff ID, leading zeros kept, and re-seeding changes nothing', async () => {
    const c = await conn();
    const r = await seed(store, c, root);
    expect(r.nodes).toBeGreaterThan(50);
    expect(await store.getNode(c, '04300011')).toMatchObject({ type: 'Person', attributes: { email: 'zoe.zeroes@example.test', staff_id: '04300011' } });
    const owners = (await store.listByType(c, 'Scope', { limit: 50 })).map((s) => s.attributes.owner);
    for (const o of owners) expect((await store.getNode(c, String(o)))?.type).toBe('Person'); // every seeded scope owner is a known person
    const before = (await admin.query('select count(*)::int n from catalog.node')).rows[0].n;
    await seed(store, c, root);
    expect((await admin.query('select count(*)::int n from catalog.node')).rows[0].n).toBe(before);
    c.release();
  });
});

describe('ADR 0026: the Person key is checked on create', () => {
  const create = async (qn: string) => { const c = await conn(); try { return await store.tx(c, () => store.applyNode(c, { type: 'Person', qualifiedName: qn, attributes: { email: `${qn}@x.test` }, writer: idp, actor: 'idp' })); } finally { c.release(); } };
  it('CAT-9 a 7-digit, 9-digit, non-digit or padded key is refused with a clear message; nothing is stored', async () => {
    await expect(create('1234567')).rejects.toMatchObject({ code: 'validation_failed', message: expect.stringContaining('^\\d{8}$') });
    await expect(create('1234567')).rejects.toMatchObject({ errors: [{ path: 'qualified_name', message: expect.stringContaining('leading zeros may have been lost') }] });
    for (const bad of ['123456789', 'ab123456', 'alice@bank.example', '0012345 ']) await expect(create(bad)).rejects.toMatchObject({ code: 'validation_failed' });
    expect((await admin.query("select count(*)::int n from catalog.node where type = 'Person' and qualified_name in ('1234567','123456789','ab123456','alice@bank.example','0012345 ')")).rows[0].n).toBe(0);
  });
  it('CAT-9 the staff_id attribute is checked too', async () => {
    const c = await conn();
    await expect(store.tx(c, () => store.applyNode(c, { type: 'Person', qualifiedName: '00000009', attributes: { email: 'n@x.test', staff_id: '9' }, writer: idp, actor: 'idp' }))).rejects.toMatchObject({ code: 'validation_failed', errors: [{ path: 'staff_id', message: expect.stringContaining('leading zeros may have been lost') }] });
    c.release();
  });
});

describe('ADR 0026: owners that arrive as an email resolve to the staff ID; short numbers are data errors', () => {
  it('pure rules: a staff ID is kept as given, an email is looked up, a short or odd value is an error and is never padded', () => {
    const idx = emailIndex([{ qualifiedName: ZERO, email: 'Zero@Bank.example' }, { qualifiedName: '00000002', email: 'dup@bank.example' }, { qualifiedName: '00000003', email: 'dup@bank.example' }]);
    expect(resolvePersonRef(ZERO, pattern, idx)).toEqual({ id: ZERO });
    expect(resolvePersonRef(' 00123456 ', pattern, idx)).toEqual({ id: ZERO });
    expect(resolvePersonRef('ZERO@bank.example', pattern, idx)).toEqual({ id: ZERO });
    expect(resolvePersonRef('123456', pattern, idx)).toMatchObject({ error: expect.stringContaining('not padded') });
    expect(resolvePersonRef('123456789', pattern, idx)).toMatchObject({ error: expect.stringContaining('all digits') });
    expect(resolvePersonRef('nobody@bank.example', pattern, idx)).toMatchObject({ error: expect.stringContaining('no Person has the email') });
    expect(resolvePersonRef('dup@bank.example', pattern, idx)).toMatchObject({ error: expect.stringContaining('more than one Person') });
    expect(resolvePersonRef('amy', pattern, idx)).toMatchObject({ error: expect.stringContaining('neither a staff ID') });
  });

  const rejected: { key: string; reason: string }[] = []; const passed: Signal[] = [];
  const front = () => new PersonRefResolver({ store, registry, connect: conn, next: { async submit(s) { passed.push(...s); return { rejected: s.filter((x) => x.key === 'next-refuses').map((x) => x.key) }; } }, onReject: (s, reason) => { rejected.push({ key: s.key, reason }); } });
  const upsert = (key: string, type: string, asset: Record<string, unknown>): Signal => ({ source: 'j', key, kind: 'sync.upsert', subjectRef: `${type}:${key}`, subjectType: type, asset, actor: 'sync' });
  const link = (key: string, edge: string, from: string, to: string): Signal => ({ source: 'j', key, kind: 'sync.link', subjectRef: `Edge:${key}`, subjectType: 'BusinessTerm', asset: { edge, from, to, attributes: { responsibility: key } }, actor: 'sync' });

  it('an owner given as an email (any case) becomes the Person key; a staff ID passes untouched; the other attributes are not changed', async () => {
    rejected.length = 0; passed.length = 0;
    const r = await front().submit([
      upsert('a1', 'Application', { name: 'A1', owner: 'ZERO@bank.example' }),
      upsert('a2', 'Scope', { name: 'S2', owner: ZERO2 }),
      upsert('a3', 'Scope', { name: 'S3', owner: '' }), // no owner at all is the owner check's business
    ]);
    expect(r).toEqual({});
    expect(passed.map((s) => s.asset)).toEqual([{ name: 'A1', owner: ZERO }, { name: 'S2', owner: ZERO2 }, { name: 'S3', owner: '' }]);
    expect(rejected).toEqual([]);
  });

  it('a short number, an unknown email and a number type are refused through the reject path, named by key, and never reach the catalog', async () => {
    rejected.length = 0; passed.length = 0;
    const r = await front().submit([
      upsert('short', 'Application', { name: 'X', owner: '123456' }),
      upsert('unk', 'Scope', { name: 'Y', owner: 'nobody@bank.example' }),
      upsert('num', 'Scope', { name: 'Z', owner: 123456 }),
      upsert('ok', 'Scope', { name: 'W', owner: ZERO }),
    ]);
    expect(r).toEqual({ rejected: ['short', 'unk', 'num'] });
    expect(passed.map((s) => s.key)).toEqual(['ok']);
    expect(rejected.find((x) => x.key === 'short')!.reason).toMatch(/owner: "123456" is all digits but not a valid staff ID.*not padded/);
    expect(rejected.find((x) => x.key === 'unk')!.reason).toMatch(/no Person has the email nobody@bank.example/);
    expect(rejected.find((x) => x.key === 'num')!.reason).toMatch(/never a number/);
  });

  it('CAT-5 owner and steward edges: the email end of the edge lands on the right Person; a group end and a short number behave as said', async () => {
    const c = await conn();
    await store.tx(c, () => store.applyNode(c, { type: 'BusinessTerm', qualifiedName: 'term-1', attributes: { name: 'T1', status: 'Approved' }, writer: { kind: 'sync', source: 'collibra' }, actor: 'sync' }));
    c.release();
    rejected.length = 0; passed.length = 0;
    const r = await front().submit([
      link('o1', 'owned_by', 'term-1', 'zero@bank.example'), link('s1', 'stewarded_by', 'term-1', 'zero2@bank.example'),
      link('s2', 'stewarded_by', 'term-1', ZERO2), link('bad', 'owned_by', 'term-1', '4300004'), link('grp', 'owned_by', 'term-1', 'Finance Group'),
      { ...link('u1', 'owned_by', 'term-1', 'ZERO@bank.example'), kind: 'sync.unlink' },
    ]);
    expect(r).toEqual({ rejected: ['bad'] });
    expect(passed.map((s) => [s.key, (s.asset as { to: string }).to])).toEqual([['o1', ZERO], ['s1', ZERO2], ['s2', ZERO2], ['grp', 'Finance Group'], ['u1', ZERO]]);
    expect(rejected[0]!.reason).toMatch(/owned_by term-1: "4300004" is all digits but not a valid staff ID/);
  });

  it('a refusal by the next sink is passed on with the resolver\'s own', async () => {
    const r = await front().submit([upsert('next-refuses', 'Scope', { name: 'N', owner: ZERO }), upsert('bad2', 'Scope', { name: 'M', owner: '12' })]);
    expect(r).toEqual({ rejected: ['bad2', 'next-refuses'] });
  });
});

describe('ADR 0026: Collibra owner and steward jobs and the reconciliation', () => {
  const load = (n: string): JobDef => compileJob(readFileSync(join(root, 'sync/jobs', `${n}.yaml`), 'utf8'));
  const overlay = (field: string) => compileOverlay(`connections:\n  collibra: { secret: s, ownerRoleId: r1, stewardRoleId: r2, ownerKeyField: ${field} }\n`);

  it('the person field of the edge is an overlay parameter: emailAddress now, userName if Collibra user names are the staff IDs', () => {
    for (const n of ['collibra-owners', 'collibra-stewards']) {
      expect(load(n).target.edge!.to_qualified_name).toBe('{${ownerKeyField}}');
      expect(resolveJob(load(n), overlay('emailAddress'), 'uat').def.target.edge!.to_qualified_name).toBe('{emailAddress}');
      const u = resolveJob(load(n), overlay('userName'), 'uat').def;
      expect(mapRecord({ id: 'r', baseResource: { id: 'a' }, owner: { userName: ZERO, emailAddress: 'z@x' } }, u.target)).toMatchObject({ key: `a->${ZERO}` });
      expect(() => resolveJob(load(n), compileOverlay('connections: { collibra: { secret: s, ownerRoleId: r1, stewardRoleId: r2 } }'), 'uat')).toThrow(/ownerKeyField/);
    }
    expect(readFileSync(join(root, 'sync/overlays/local.yaml'), 'utf8')).toContain('ownerKeyField: emailAddress');
  });

  const mapping = parseReconcileMapping(readFileSync(join(root, 'sync/collibra-reconciliation.yaml'), 'utf8'));
  const exp = (owner: Record<string, string>): CollibraExport => ({
    jobs: [{ def: load('collibra-business-terms'), records: [{ id: 'T1', name: 'Term', status: { name: 'Approved' }, domain: { id: 'd' } }] }],
    relations: [], responsibilities: [{ id: 'r1', role: { name: 'Owner' }, owner, baseResource: { id: 'T1' } }],
  });
  const snap = (to: string) => ({ nodes: [{ type: 'BusinessTerm', qualifiedName: 'T1', attributes: { name: 'Term', status: 'Approved' }, lifecycle: 'discovered' }], edges: [{ name: 'owned_by', from: 'T1', to }],
    people: [{ qualifiedName: ZERO, email: 'zero@bank.example' }] });

  it('reconciliation: an owner Collibra names by email matches the edge to the staff ID; a wrong Person or a lost zero is a difference', () => {
    const ok = reconcile(registry, exp({ emailAddress: 'Zero@Bank.example' }), snap(ZERO), mapping);
    expect(ok.responsibilities).toEqual([expect.objectContaining({ edge: 'owned_by', collibra: 1, catalog: 1, matches: true })]);
    expect(ok.unresolvedPeople).toEqual([]);
    expect(ok.types.every((t) => t.matches) && ok.matches).toBe(true);
    const wrong = reconcile(registry, exp({ emailAddress: 'zero@bank.example' }), snap('00000002'), mapping);
    expect(wrong.responsibilities[0]).toMatchObject({ missing: [`T1|${ZERO}`], extra: ['T1|00000002'], matches: false });
    const lost = reconcile(registry, exp({ emailAddress: 'zero@bank.example' }), snap('123456'), mapping);
    expect(lost.matches).toBe(false);
  });

  it('reconciliation: a Collibra user whose staff ID lost its zeros, or an email nobody has, is reported as a data error, not silently matched', () => {
    const short = reconcile(registry, exp({ emailAddress: '123456' }), snap(ZERO), mapping);
    expect(short.unresolvedPeople).toEqual([expect.objectContaining({ asset: 'T1', value: '123456', reason: expect.stringContaining('not padded') })]);
    expect(short.matches).toBe(false);
    const unknown = reconcile(registry, exp({ emailAddress: 'who@bank.example' }), snap(ZERO), mapping);
    expect(unknown.unresolvedPeople[0]!.reason).toMatch(/no Person has the email/);
    // with userName as the key field (Collibra user names are staff IDs) the staff ID is compared as it is
    const byName = reconcile(registry, exp({ userName: ZERO }), snap(ZERO), { ...mapping, personKeyField: 'userName' });
    expect(byName.matches).toBe(true);
  });
});
