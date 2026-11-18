import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExceptionPort, Signal, SourceRecord } from '../packages/contracts/src/index';
import { loadRegistry, loadSourceOfTruth, migrateModule, provisionModule } from '../packages/platform/src/index';
import { CatalogStore } from '../packages/catalog/src/index';
import { CatalogIngest, PersonRefResolver } from '../apps/worker/src/index';
import {
  SyncService, compileJob, compileOverlay, parseReconcileMapping, reconcile, resolveJob, restConnector,
  type CatalogSnapshot, type CollibraExport, type JobDef,
} from '../packages/connectors/src/index';

const root = join(import.meta.dirname, '..');
const fx = (name: string) => JSON.parse(readFileSync(join(root, 'sync/fixtures/collibra', name), 'utf8')) as { total: number; results: SourceRecord[] };
const registry = loadRegistry(join(root, 'metamodel/types'));
const mapping = parseReconcileMapping(readFileSync(join(root, 'sync/collibra-reconciliation.yaml'), 'utf8'));
const JOBS = ['collibra-data-domains', 'collibra-data-categories', 'collibra-business-terms'];
// S5 follow-up: relations (part_of) and responsibilities (owned_by, stewarded_by) as edge jobs; they run after the nodes
const EDGE_JOBS = ['collibra-term-categories', 'collibra-category-domains', 'collibra-owners', 'collibra-stewards'];
const TYPE_IDS = { dataDomainTypeId: 'tid-domain', dataCategoryTypeId: 'tid-category', businessTermTypeId: 'tid-term' };
const EDGE_IDS = { termCategoryRelationTypeId: 'rt-term-category', categoryDomainRelationTypeId: 'rt-category-domain', ownerRoleId: 'role-owner', stewardRoleId: 'role-steward' };
// which role name each id stands for: the names the Collibra admin has yet to confirm, taken from the reconciliation mapping, never from code
const ROLE_OF_RELATION_TYPE: Record<string, string> = { 'rt-term-category': mapping.relations.find((r) => r.from === 'BusinessTerm')!.role, 'rt-category-domain': mapping.relations.find((r) => r.from === 'DataCategory')!.role };
const ROLE_OF_ROLE_ID: Record<string, string> = { 'role-owner': Object.keys(mapping.responsibilities).find((k) => mapping.responsibilities[k] === 'owned_by')!, 'role-steward': Object.keys(mapping.responsibilities).find((k) => mapping.responsibilities[k] === 'stewarded_by')! };
// every user in the responsibilities fixture and the staff ID the identity provider gives them (strings, with leading zeros)
const STAFF = new Map([...new Set(fx('responsibilities.json').results.map((r) => (r.owner as { emailAddress: string }).emailAddress))].sort().map((e, i) => [e, `0430${String(i + 1).padStart(4, '0')}`] as const));
const FILE_BY_TYPE: Record<string, string> = { 'tid-domain': 'data-domains.json', 'tid-category': 'data-categories.json', 'tid-term': 'business-terms.json' };

// A stand-in for the Collibra REST API v2: the recorded fixtures, paged with offset and limit in Collibra's own envelope.
let server: Server; let base = ''; const asked: string[] = [];
const dropped = new Set<string>(); // Collibra record ids the stand-in server pretends are gone
beforeAll(async () => {
  server = createServer((req, res) => {
    const u = new URL(req.url!, 'http://x'); asked.push(`${u.pathname}${u.search}`);
    const file = u.pathname === '/rest/2.0/assets' ? FILE_BY_TYPE[u.searchParams.get('typeId') ?? ''] : u.pathname === '/rest/2.0/relations' ? 'relations.json' : u.pathname === '/rest/2.0/responsibilities' ? 'responsibilities.json' : undefined;
    if (!file) { res.writeHead(404); res.end('{}'); return; }
    let all = fx(file).results;
    const relType = u.searchParams.get('relationTypeId'); const roleId = u.searchParams.get('roleIds');
    if (relType) all = all.filter((r) => (r.type as { role: string }).role === ROLE_OF_RELATION_TYPE[relType]);
    if (roleId) all = all.filter((r) => (r.role as { name: string }).name === ROLE_OF_ROLE_ID[roleId]);
    all = all.filter((r) => !dropped.has(String(r.id)));
    const o = Number(u.searchParams.get('offset') ?? 0); const l = Number(u.searchParams.get('limit') ?? 1000);
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ total: all.length, offset: o, limit: l, results: all.slice(o, o + l) }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise((r) => server.close(r)); });

const secrets = { async resolveSecret() { return 'S3CRET'; } };
const connConfig = () => ({ baseUrl: base, allowInsecure: true, auth: { type: 'bearer' }, recordsPath: 'results', paging: { style: 'offset' } });
const overlay = () => compileOverlay(`connections:\n  collibra: { secret: sm/collibra, ${Object.entries({ ...TYPE_IDS, ...EDGE_IDS, ownerKeyField: 'emailAddress' }).map(([k, v]) => `${k}: ${v}`).join(', ')} }\n`);
const loadJob = (name: string): JobDef => ({ ...compileJob(readFileSync(join(root, 'sync/jobs', `${name}.yaml`), 'utf8')) });

/** every record of a list, read through the REST connector page by page, as the jobs read it */
async function readAll(path: string, pageSize = 5): Promise<SourceRecord[]> {
  const c = restConnector(secrets); const out: SourceRecord[] = []; let cursor: string | null = null;
  for (;;) { const p = await c.read({ ...connConfig(), secretRef: 'sm/collibra' }, { text: path, pageSize }, cursor, null); out.push(...p.records); if (p.done) return out; cursor = p.nextCursor; }
}

describe('S5: Collibra job definitions', () => {
  it('S5/CAT-5 resolve against the overlay and read the glossary types the metamodel says Collibra owns', () => {
    for (const name of JOBS) {
      const def = loadJob(name);
      const r = resolveJob(def, overlay(), 'uat');
      expect(r.query).toMatch(/^\/rest\/2\.0\/assets\?typeId=tid-(domain|category|term)&/);
      const attrs = registry.get(def.target.type).attributes as Record<string, { source?: string }>;
      expect(def.target.source).toBe('collibra');
      // never hard-coded: every mapped attribute is in the registry and Collibra owns it
      for (const a of Object.keys(def.target.map)) expect(attrs[a]?.source, `${def.target.type}.${a}`).toBe('collibra');
    }
  });
  it('S5 a type id missing from the overlay fails when the job is resolved, and the local overlay keeps the jobs off', () => {
    expect(() => resolveJob(loadJob(JOBS[0]!), compileOverlay('connections: { collibra: { secret: s } }'), 'uat')).toThrow(/dataDomainTypeId/);
    const local = compileOverlay(readFileSync(join(root, 'sync/overlays/local.yaml'), 'utf8'));
    for (const name of JOBS) expect(resolveJob(loadJob(name), local, 'local').enabled).toBe(false);
  });
  it('S5 fixtures are shaped like Collibra REST v2: an envelope with total, and assets with typed references', () => {
    const t = fx('business-terms.json');
    expect(t.total).toBe(t.results.length);
    expect(t.results[0]).toMatchObject({ resourceType: 'Asset', type: { name: 'Business Term' }, status: { name: expect.any(String) }, domain: { resourceType: 'Domain' } });
  });
});

describe('S5: Collibra edge job definitions', () => {
  it('S5/CAT-5 resolve against the overlay; each names an edge the metamodel allows between the node types it links', () => {
    const want: Record<string, [string, string, string, string]> = {
      'collibra-term-categories': ['part_of', 'BusinessTerm', 'DataCategory', 'relations'], 'collibra-category-domains': ['part_of', 'DataCategory', 'DataDomain', 'relations'],
      'collibra-owners': ['owned_by', 'BusinessTerm', 'Person', 'responsibilities'], 'collibra-stewards': ['stewarded_by', 'BusinessTerm', 'Person', 'responsibilities'],
    };
    for (const name of EDGE_JOBS) {
      const def = loadJob(name); const [edge, from, to, path] = want[name]!;
      expect(def.target.edge!.name).toBe(edge);
      expect(def.target.source).toBe('collibra');
      expect(registry.canLink(from, edge, to), `${from} ${edge} ${to}`).toBe(true);
      if (path === 'responsibilities') for (const t of ['BusinessTerm', 'DataCategory', 'DataDomain']) expect(registry.canLink(t, edge, 'Person')).toBe(true);
      const r = resolveJob(def, overlay(), 'uat');
      expect(r.query).toMatch(new RegExp(String.raw`^/rest/2\.0/${path}\?(relationTypeId|roleIds)=(rt|role)-`));
      expect(def.target.map).not.toHaveProperty('name'); // edge attributes are only the Collibra id of the link
    }
    // the role names are assumptions kept in the mapping, not in code: the mapping names an edge the jobs write, for every role
    expect(Object.values(mapping.responsibilities).sort()).toEqual(['owned_by', 'stewarded_by']);
    expect(mapping.relations.map((r) => r.edge)).toEqual(['part_of', 'part_of']);
  });
  it('S5 a missing role or relation type id fails when the job is resolved, and the local overlay keeps the edge jobs off', () => {
    expect(() => resolveJob(loadJob('collibra-owners'), compileOverlay('connections: { collibra: { secret: s } }'), 'uat')).toThrow(/ownerRoleId/);
    const local = compileOverlay(readFileSync(join(root, 'sync/overlays/local.yaml'), 'utf8'));
    for (const name of EDGE_JOBS) expect(resolveJob(loadJob(name), local, 'local').enabled).toBe(false);
  });
});

describe('S5: full sync (nodes, then edges) into a real catalog, then reconcile against Collibra', () => {
  const signals: Signal[] = [];
  const rejected: { kind: string; key: string; reason: string }[] = [];
  const store = new CatalogStore(registry);
  let admin: pg.Client; let db: pg.Client; let cdb: pg.Client; let pgServer: EmbeddedPostgres; let svc: SyncService;
  const exceptions: ExceptionPort = { async raise() { return { id: 'x', created: true }; }, async withdraw() { return true; } };
  const idp = { kind: 'sync', source: 'idp' } as const;
  const catalogConn = () => ({ query: (q: string, p?: unknown[]) => cdb.query(q, p) as never, release() {} });
  const ingestFor = (st: CatalogStore, sourceOf: (job: string) => Promise<string>) => new CatalogIngest({
    store: st, connect: async () => catalogConn(), sourceOf, onReject: (s, reason) => { rejected.push({ kind: s.kind, key: s.subjectRef, reason }); },
  });
  // ADR 0026: in front of the ingest, as in the worker: an owner named by email is resolved to the staff ID before the edge is written
  const frontFor = (st: CatalogStore, ingest: CatalogIngest) => new PersonRefResolver({ store: st, registry, connect: async () => catalogConn(), next: ingest, onReject: (sg, reason) => { rejected.push({ kind: sg.kind, key: sg.subjectRef, reason }); } });
  const installAll = async (s: SyncService, environment: string, names: string[]) => {
    for (const name of names) {
      const def = loadJob(name); def.source.page_size = 5; // several pages per list
      await s.installJob(db, resolveJob(def, overlay(), environment));
    }
  };
  const exported = async (): Promise<CollibraExport> => ({
    jobs: await Promise.all(JOBS.map(async (n) => { const def = loadJob(n); return { def, records: await readAll(resolveJob(def, overlay(), 'uat').query) }; })),
    relations: await readAll('/rest/2.0/relations'), responsibilities: await readAll('/rest/2.0/responsibilities'),
  });
  /** what the catalog really holds after the ingest applied the signals */
  const snapshot = async (): Promise<CatalogSnapshot> => {
    const nodes: CatalogSnapshot['nodes'] = [];
    for (const type of ['DataDomain', 'DataCategory', 'BusinessTerm']) {
      let after: string | undefined;
      for (;;) {
        const page = await store.listByType(cdb, type, { limit: 50, afterQn: after });
        for (const n of page.slice(0, 50)) nodes.push({ type, qualifiedName: n.qualifiedName, attributes: n.attributes, lifecycle: n.lifecycle });
        if (page.length <= 50) break;
        after = page[49]!.qualifiedName;
      }
    }
    const e = await admin.query<{ name: string; f: string; t: string }>(`select e.name, f.qualified_name as f, t.qualified_name as t from catalog.edge e join catalog.node f on f.id = e.from_id join catalog.node t on t.id = e.to_id
      where e.name in ('part_of','owned_by','stewarded_by') and e.valid_to is null and e.recorded_to is null order by 1, 2, 3`);
    const people = (await store.listByType(cdb, 'Person', { limit: 500 })).map((p) => ({ qualifiedName: p.qualifiedName, email: String(p.attributes.email) }));
    return { nodes, edges: e.rows.map((r) => ({ name: r.name, from: r.f, to: r.t })), people };
  };
  const liveEdges = async (name: string) => (await admin.query<{ f: string; t: string; source: string }>(`select f.qualified_name as f, t.qualified_name as t, e.source from catalog.edge e join catalog.node f on f.id = e.from_id join catalog.node t on t.id = e.to_id
    where e.name = $1 and e.valid_to is null and e.recorded_to is null order by 1, 2`, [name])).rows;
  const totalEdgeRows = async () => (await admin.query<{ n: number }>('select count(*)::int as n from catalog.edge')).rows[0]!.n;

  beforeAll(async () => {
    pgServer = new EmbeddedPostgres({ databaseDir: mkdtempSync(join(tmpdir(), 'dmc-collibra-')), user: 'postgres', password: 'pw', port: 54460, persistent: false });
    await pgServer.initialise(); await pgServer.start();
    admin = new pg.Client({ host: 'localhost', port: 54460, user: 'postgres', password: 'pw', database: 'postgres' }); await admin.connect();
    for (const [m, pw] of [['catalog', 'cat'], ['connectors', 'con']] as const) {
      await provisionModule(admin, m, { password: pw });
      await migrateModule(admin, m, join(root, `packages/${m}/migrations`));
      await admin.query(`grant all on all tables in schema ${m} to dmc_${m}`);
      await admin.query(`grant all on all sequences in schema ${m} to dmc_${m}`);
    }
    db = new pg.Client({ host: 'localhost', port: 54460, user: 'dmc_connectors', password: 'con', database: 'postgres' }); await db.connect();
    cdb = new pg.Client({ host: 'localhost', port: 54460, user: 'dmc_catalog', password: 'cat', database: 'postgres' }); await cdb.connect();
    const ingest = ingestFor(store, (job) => svc.writerSource(db, job));
    const front = frontFor(store, ingest);
    svc = new SyncService({ connectors: { rest: restConnector(secrets) }, signals: { async submit(x) { signals.push(...x); return front.submit(x); } }, exceptions, sleep: async () => {} });
    await svc.upsertConnection(db, { name: 'collibra', environment: 'uat', type: 'rest', secretRef: 'sm/collibra', config: connConfig() });
    await installAll(svc, 'uat', [...JOBS, ...EDGE_JOBS]);
    // the people as the identity provider would hold them: keyed by the STAFF ID (8 digits, leading zeros kept, ADR 0026), the email an attribute; Collibra names them by email
    await store.tx(cdb, async () => { for (const [e, id] of STAFF) await store.applyNode(cdb, { type: 'Person', qualifiedName: id, attributes: { email: e, staff_id: id, name: e }, writer: idp, actor: 'idp' }); });
    // the whole sync: nodes first, then the edges between them
    for (const name of [...JOBS, ...EDGE_JOBS]) expect(await svc.run(db, name, 'uat'), name).toMatchObject({ status: 'succeeded', complete: true, errors: 0 });
  }, 120_000);
  afterAll(async () => {
    try {
      await db?.end(); await cdb?.end(); await admin?.end();
    } finally {
      try { await pgServer?.stop(); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EBUSY') throw e; }
    }
  });

  it('S5/CAT-5 the three node jobs create every Collibra domain, category and term, and only those', () => {
    const by = (t: string) => signals.filter((s) => s.subjectType === t && s.kind === 'sync.upsert');
    expect([by('DataDomain').length, by('DataCategory').length, by('BusinessTerm').length]).toEqual([3, 5, 12]);
    expect(signals.filter((s) => s.kind === 'sync.upsert').every((s) => ['DataDomain', 'DataCategory', 'BusinessTerm'].includes(s.subjectType))).toBe(true);
    expect(by('BusinessTerm').find((s) => s.asset.name === 'Closing balance')!.asset).toEqual({ name: 'Closing balance', definition: 'Balance at the end of the day', status: 'Approved' });
    expect(by('BusinessTerm').find((s) => s.asset.name === 'Loss given default')!.asset).toEqual({ name: 'Loss given default', status: 'Candidate' }); // no definition in Collibra, none sent
    expect(asked.some((q) => q.includes('typeId=tid-term') && q.includes('offset=5'))).toBe(true); // paged
    expect(JSON.stringify(signals)).not.toMatch(/S3CRET/);
  });

  it('S5/CAT-5 the edge jobs link terms to categories to domains and assets to their people, all owned by Collibra, none refused', async () => {
    expect(rejected).toEqual([]);
    const partOf = await liveEdges('part_of');
    expect(partOf).toHaveLength(17);
    expect(partOf.every((e) => e.source === 'collibra')).toBe(true);
    const owned = await liveEdges('owned_by'); const stewarded = await liveEdges('stewarded_by');
    expect(owned.length + stewarded.length).toBe(20);
    expect(owned.every((e) => /^0430\d{4}$/.test(e.t) && [...STAFF.values()].includes(e.t) && e.source === 'collibra')).toBe(true); // the staff ID, zeros kept, never the email
    expect(stewarded.every((e) => [...STAFF.values()].includes(e.t))).toBe(true);
    // metadata only: an edge carries the Collibra id of the link and nothing else
    const attrs = (await admin.query<{ attributes: Record<string, unknown> }>("select attributes from catalog.edge where name = 'owned_by' limit 1")).rows[0]!.attributes;
    expect(Object.keys(attrs)).toEqual(['responsibility']);
  });

  it('S5/CAT-5 a full sync reconciles to zero differences: nodes, relations and responsibilities', async () => {
    const report = reconcile(registry, await exported(), await snapshot(), mapping);
    expect(report.types.map((t) => [t.type, t.collibra, t.catalog])).toEqual([['DataDomain', 3, 3], ['DataCategory', 5, 5], ['BusinessTerm', 12, 12]]);
    expect(report.types.every((t) => t.matches && !t.missing.length && !t.extra.length && !t.diffs.length && !t.unkeyed)).toBe(true);
    expect(report.relations).toEqual([expect.objectContaining({ edge: 'part_of', collibra: 17, catalog: 17, missing: [], extra: [], matches: true })]);
    expect(report.outOfScope).toBe(0);
    expect(report.unmodelled).toEqual([]);
    expect(report.responsibilities.map((e) => [e.edge, e.collibra, e.catalog])).toEqual([['owned_by', 8, 8], ['stewarded_by', 12, 12]]);
    expect(report.responsibilities.every((e) => e.matches)).toBe(true);
    expect(report.matches).toBe(true);
  });

  it('S5 a second full sync changes nothing: no edge row, no outbox event', async () => {
    const edgeRows = await totalEdgeRows();
    const outbox = (await admin.query<{ n: number }>('select count(*)::int as n from catalog.outbox')).rows[0]!.n;
    for (const name of [...JOBS, ...EDGE_JOBS]) expect(await svc.run(db, name, 'uat'), name).toMatchObject({ status: 'succeeded', created: 0, updated: 0, deprecated: 0, errors: 0 });
    expect(await totalEdgeRows()).toBe(edgeRows);
    expect((await admin.query<{ n: number }>('select count(*)::int as n from catalog.outbox')).rows[0]!.n).toBe(outbox);
  });

  it('S5 a relation Collibra drops ends the edge on the next complete run, and a relation that comes back is linked again', async () => {
    const victim = fx('relations.json').results.find((r) => (r.type as { role: string }).role === ROLE_OF_RELATION_TYPE['rt-term-category'])!;
    const from = (victim.source as { id: string }).id; const to = (victim.target as { id: string }).id;
    dropped.add(String(victim.id));
    expect(await svc.run(db, 'collibra-term-categories', 'uat')).toMatchObject({ status: 'succeeded', deprecated: 1, created: 0 });
    expect((await liveEdges('part_of')).some((e) => e.f === from && e.t === to)).toBe(false);
    expect(reconcile(registry, await exported(), await snapshot(), mapping).matches).toBe(true); // Collibra and the catalog agree again
    dropped.clear();
    expect(await svc.run(db, 'collibra-term-categories', 'uat')).toMatchObject({ status: 'succeeded', updated: 1 });
    expect((await liveEdges('part_of')).some((e) => e.f === from && e.t === to)).toBe(true);
    expect(reconcile(registry, await exported(), await snapshot(), mapping).matches).toBe(true);
  });

  it('S5 the report names a missing node, an extra node, an attribute diff and a missing relation', async () => {
    const snap = await snapshot();
    const dropIdx = snap.nodes.findIndex((n) => n.type === 'BusinessTerm' && n.attributes.name === 'Trade date');
    const droppedKey = snap.nodes[dropIdx]!.qualifiedName;
    snap.nodes.splice(dropIdx, 1);
    snap.nodes.find((n) => n.attributes.name === 'Closing balance')!.attributes = { name: 'Closing balance', definition: 'edited in DMC', status: 'Approved' };
    snap.nodes.push({ type: 'DataCategory', qualifiedName: 'stray', attributes: { name: 'Stray' }, lifecycle: 'discovered' });
    snap.nodes.push({ type: 'DataCategory', qualifiedName: 'gone', attributes: { name: 'Gone' }, lifecycle: 'deprecated' }); // deprecated nodes are not counted
    snap.edges = snap.edges.filter((e) => e.from !== droppedKey);
    const report = reconcile(registry, await exported(), snap, mapping);
    const term = report.types.find((t) => t.type === 'BusinessTerm')!;
    expect(term).toMatchObject({ collibra: 12, catalog: 11, missing: [droppedKey], matches: false });
    expect(term.diffs).toEqual([expect.objectContaining({ attribute: 'definition', collibra: 'Balance at the end of the day', catalog: 'edited in DMC' })]);
    expect(report.types.find((t) => t.type === 'DataCategory')).toMatchObject({ collibra: 5, catalog: 6, extra: ['stray'] });
    expect(report.relations[0]).toMatchObject({ collibra: 17, matches: false });
    expect(report.relations[0]!.catalog).toBeLessThan(17);
    expect(report.matches).toBe(false);
  });

  it('S5 a missing part_of or owned_by edge is a mismatch even when every node matches', async () => {
    const snap = await snapshot();
    const noPartOf = reconcile(registry, await exported(), { ...snap, edges: snap.edges.filter((e) => e.name !== 'part_of') }, mapping);
    expect(noPartOf.types.every((t) => t.matches)).toBe(true);
    expect(noPartOf.relations[0]).toMatchObject({ collibra: 17, catalog: 0, matches: false });
    const noOwners = reconcile(registry, await exported(), { ...snap, edges: snap.edges.filter((e) => e.name !== 'owned_by') }, mapping);
    expect(noOwners.responsibilities.find((e) => e.edge === 'owned_by')).toMatchObject({ collibra: 8, catalog: 0, matches: false });
    expect(noOwners.matches).toBe(false);
  });

  it('S5/ADR 0018 a type switched to DMC is not compared; the others still are', async () => {
    const sot = loadSourceOfTruth(join(root, 'config/source-of-truth.yaml'));
    expect(Object.values(sot).every((v) => v === 'collibra')).toBe(true); // today nothing is switched
    const after = registry.withSourceOfTruth({ BusinessTerm: 'dmc' });
    const snap = await snapshot(); snap.nodes = snap.nodes.filter((n) => n.type !== 'BusinessTerm');
    const report = reconcile(after, await exported(), snap, mapping);
    expect(report.types.find((t) => t.type === 'BusinessTerm')).toMatchObject({ switchedToDmc: true, matches: true });
    expect(report.types.find((t) => t.type === 'DataCategory')).toMatchObject({ switchedToDmc: false, matches: true });
  });

  it('S5/ADR 0018 once a type is switched to DMC the sync never overwrites its edges, and keeps syncing the others', async () => {
    // a steward in DMC takes over one term's steward: the edge is DMC's now
    const termIds = new Set(fx('business-terms.json').results.map((r) => String(r.id)));
    const term = (await liveEdges('stewarded_by')).find((e) => termIds.has(e.f))!;
    await store.tx(cdb, async () => {
      await store.applyNode(cdb, { type: 'Person', qualifiedName: '04300099', attributes: { email: 'dmc.person@example.com', staff_id: '04300099', name: 'DMC person' }, writer: idp, actor: 'idp' });
      await store.unlink(cdb, { name: 'stewarded_by', fromQn: term.f, toQn: term.t, actor: 'steward' });
      await store.link(cdb, { name: 'stewarded_by', fromQn: term.f, toQn: '04300099', source: 'dmc', actor: 'steward' });
    });
    // Collibra's job never ends an edge it does not own, even on an ordinary registry
    expect(await store.tx(cdb, () => store.unlink(cdb, { name: 'stewarded_by', fromQn: term.f, toQn: '04300099', actor: 'sync/collibra', source: 'collibra' }))).toEqual({ changed: false });

    // the service as it runs after the flip: the registry switched, so Collibra's writes to BusinessTerm edges are refused; a fresh environment sends every record again
    const switched = new CatalogStore(registry.withSourceOfTruth({ BusinessTerm: 'dmc' }));
    let svc2: SyncService;
    const ingest2 = ingestFor(switched, (job) => svc2.writerSource(db, job));
    svc2 = new SyncService({ connectors: { rest: restConnector(secrets) }, signals: frontFor(switched, ingest2), exceptions, sleep: async () => {} });
    await svc2.upsertConnection(db, { name: 'collibra', environment: 'uat2', type: 'rest', secretRef: 'sm/collibra', config: connConfig() });
    await installAll(svc2, 'uat2', EDGE_JOBS);
    const before = await totalEdgeRows(); rejected.length = 0;
    for (const name of EDGE_JOBS) expect(await svc2.run(db, name, 'uat2'), name).toMatchObject({ status: 'succeeded', errors: 0 });
    const termEdges = fx('relations.json').results.filter((r) => termIds.has((r.source as { id: string }).id)).length
      + fx('responsibilities.json').results.filter((r) => termIds.has((r.baseResource as { id: string }).id)).length;
    expect(rejected).toHaveLength(termEdges);
    expect(rejected.every((r) => /maintained in DMC/.test(r.reason))).toBe(true);
    expect(await totalEdgeRows()).toBe(before); // nothing written: DataCategory and DataDomain edges were already as Collibra says
    expect((await liveEdges('stewarded_by')).find((e) => e.f === term.f)).toMatchObject({ t: '04300099', source: 'dmc' });
    // an unlink from Collibra is refused the same way
    const ended = await switched.tx(cdb, () => switched.unlink(cdb, { name: 'stewarded_by', fromQn: term.f, toQn: '04300099', actor: 'sync/collibra', source: 'collibra' }).catch((e: { code?: string }) => e.code));
    expect(ended).toBe('conflict');
  });
});
