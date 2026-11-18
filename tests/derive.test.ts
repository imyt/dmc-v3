import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRegistry, migrateModule, provisionModule } from '../packages/platform/src/index';
import { CatalogStore } from '../packages/catalog/src/index';
import type { Signal } from '../packages/contracts/src/index';
import { Derivations } from '../apps/worker/src/index';

const root = join(import.meta.dirname, '..');
const store = new CatalogStore(loadRegistry(join(root, 'metamodel/types')));
let server: EmbeddedPostgres; let admin: pg.Client; const clients: pg.Client[] = []; let db: Record<string, pg.Client> = {};
let clock = new Date('2026-11-18T09:00:00Z');
const sent: Signal[] = [];
let d: Derivations;
const W = (source: string) => ({ kind: 'sync', source }) as const;
const node = (type: string, qn: string, attributes: Record<string, unknown>, source = 'servicenow') => store.tx(db.catalog!, () => store.applyNode(db.catalog!, { type, qualifiedName: qn, attributes, writer: source === 'user' ? { kind: 'user' } : W(source), actor: 't' })).catch((e) => { throw new Error(qn + ' ' + JSON.stringify((e as {errors?: unknown}).errors ?? e.message)); });
const link = (name: string, from: string, to: string, source = 'servicenow', attributes?: Record<string, unknown>) => store.tx(db.catalog!, () => store.link(db.catalog!, { name, fromQn: from, toQn: to, source, actor: 't', ...(attributes ? { attributes } : {}) }));
const take = () => sent.splice(0, sent.length);

beforeAll(async () => {
  server = new EmbeddedPostgres({ databaseDir: mkdtempSync(join(tmpdir(), 'dmc-der-')), user: 'postgres', password: 'pw', port: 54360, persistent: false });
  await server.initialise(); await server.start();
  admin = new pg.Client({ host: 'localhost', port: 54360, user: 'postgres', password: 'pw', database: 'postgres' }); await admin.connect();
  for (const m of ['catalog', 'trust', 'workflow', 'actions']) {
    await provisionModule(admin, m, { password: m });
    await migrateModule(admin, m, join(root, `packages/${m}/migrations`));
    await admin.query(`grant all on all tables in schema ${m} to dmc_${m}`); await admin.query(`grant all on all sequences in schema ${m} to dmc_${m}`);
    db[m] = new pg.Client({ host: 'localhost', port: 54360, user: `dmc_${m}`, password: m, database: 'postgres' }); await db[m]!.connect(); clients.push(db[m]!);
  }
  d = new Derivations(store, db as never, { async submit(s) { sent.push(...s); } }, () => clock);
}, 150_000);
afterAll(async () => { try { await Promise.all(clients.map((c) => c.end())); await admin?.end(); } finally { await server?.stop(); } });

describe('L4: cross-border sweep', () => {
  beforeAll(async () => {
    await node('Application', 'app-a', { name: 'A', owner: 'amy', hosting_country: 'GB' });
    await node('Application', 'app-b', { name: 'B', owner: 'ben', hosting_country: 'US' });
    await node('Integration', 'int-x', { status: 'live' });
    await link('source_of', 'app-a', 'int-x'); await link('target_of', 'app-b', 'int-x');
    await node('DataCategory', 'gl:pii', { name: 'Personal data' }, 'collibra');
    await node('Dataset', 'int-x--accounts', { name: 'Accounts' }, 'user');
    await link('transfers', 'int-x', 'int-x--accounts', 'dmc'); await link('in_category', 'int-x--accounts', 'gl:pii', 'dmc');
  });
  it('an integration with no assessment is reported missing, once', async () => {
    expect(await d.crossBorder()).toEqual({ transfers: 1, changed: 1 });
    const s = take();
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ subjectRef: 'CrossBorderTransfer:int-x--gb-us', asset: { status: 'missing', problem: 'no_assessment', from_country: 'GB', to_country: 'US' } });
    expect((await store.getNode(db.catalog!, 'int-x--gb-us'))?.attributes.status).toBe('missing');
    expect(await d.crossBorder()).toEqual({ transfers: 1, changed: 0 });
    expect(take()).toEqual([]);
  });
  it('an assessment requiring a DataVisa with none on file is reported', async () => {
    await node('Assessment', 'as-1', { outcome: 'datavisa-required', assessed_on: '2026-01-01' }, 'datavisa-tool');
    await link('assessed_by', 'int-x', 'as-1', 'datavisa-tool');
    await d.crossBorder();
    expect(take()[0]!.asset).toMatchObject({ status: 'missing', problem: 'no_datavisa' });
  });
  it('a valid DataVisa covers it, matched by category name; when it lapses it is expired', async () => {
    await node('DataVisa', 'dv-1', { source_country: 'GB', target_country: 'US', data_categories: ['Personal data'], valid_from: '2026-01-01', valid_to: '2026-12-31', status: 'active' }, 'datavisa-tool');
    await d.crossBorder();
    expect(take()[0]!.asset).toMatchObject({ status: 'covered', uncovered: [] });
    expect((await store.namedEdgesOf(db.catalog!, 'int-x--gb-us', { name: 'covered_by', direction: 'out' })).map((e) => e.toQn)).toEqual(['dv-1']);
    clock = new Date('2027-02-01T09:00:00Z');
    await d.crossBorder();
    expect(take()[0]!.asset).toMatchObject({ status: 'expired', problem: 'datavisa_expired' });
    clock = new Date('2026-11-18T09:00:00Z');
  });
  it('same-country integrations are left alone', async () => {
    await node('Application', 'app-c', { name: 'C', owner: 'cat', hosting_country: 'GB' });
    await node('Integration', 'int-y', { status: 'live' });
    await link('source_of', 'app-a', 'int-y'); await link('target_of', 'app-c', 'int-y');
    await d.crossBorder();
    expect(await store.getNode(db.catalog!, 'int-y--gb-gb')).toBeUndefined();
  });
});

describe('L3: trust tiers sweep', () => {
  beforeAll(async () => {
    take();
    await node('Column', 'git.s/p/t/c1', { name: 'c1', description: 'balance' }, 'git-json');
    await node('Scope', 'sc-1', { name: 'PRA110', owner: 'olive', kind: 'regulatory-return' }, 'scope-sources');
    await node('Scope', 'sc-1', { version: 1, status: 'submitted', required_tier: 'gold' }, 'user');
    await node('ScopeGroup', 'sc-1--g', { name: 'G', order: 1 }, 'user'); await node('BusinessElement', 'sc-1--g--e', { name: 'E' }, 'user');
    await link('includes', 'sc-1', 'sc-1--g', 'dmc'); await link('includes', 'sc-1--g', 'sc-1--g--e', 'dmc');
    await link('implemented_by', 'sc-1--g--e', 'git.s/p/t/c1', 'dmc', { app: 'app-a', state: 'confirmed' });
  });
  it('grades an asset a submitted scope depends on, stores it, and flags a shortfall once', async () => {
    expect(await d.trustTiers()).toEqual({ graded: 1, changed: 1, short: 1 });
    const s = take();
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ subjectRef: 'Column:git.s/p/t/c1', asset: { trust_tier: 'unverified', required_tier: 'gold', trust_shortfall: true } });
    const stored = (await db.trust!.query("select tier, required_tier, weakest from trust.grade where subject_ref = 'Column:git.s/p/t/c1'")).rows[0];
    expect(stored).toMatchObject({ tier: 'unverified', required_tier: 'gold' });
    expect(stored.weakest).toContain('lineage');
    expect((await db.trust!.query("select event_type from trust.outbox")).rows.map((r) => r.event_type)).toEqual(['trust.graded']);
    expect(await d.trustTiers()).toEqual({ graded: 1, changed: 0, short: 1 });
    expect(take()).toEqual([]);
  });
  it('a scope that is not submitted requires nothing', async () => {
    await node('Scope', 'sc-1', { status: 'amended', version: 2 }, 'user');
    expect((await d.trustTiers()).graded).toBe(0);
    await node('Scope', 'sc-1', { status: 'submitted' }, 'user');
  });
});

describe('L2: classification sweep', () => {
  beforeAll(async () => {
    await node('Classification', 'pii:email', { code: 'email', name: 'Email', scheme: 'pii' }, 'classification-tool');
    await node('Classification', 'pii:name', { code: 'name', name: 'Name', scheme: 'pii' }, 'classification-tool');
    for (const c of ['src', 'mid', 'own', 'leaf']) await node('Column', `col-${c}`, { name: c }, 'git-json');
    await link('classified_as', 'col-src', 'pii:email', 'classification-tool');
    await link('classified_as', 'col-own', 'pii:name', 'classification-tool');
    take();
    await link('derives_from', 'col-mid', 'col-src', 'git-json'); await link('derives_from', 'col-own', 'col-mid', 'git-json'); await link('derives_from', 'col-leaf', 'col-mid', 'git-json');
  });
  it('proposes to downstream columns, never to one the tool already classified, and only once', async () => {
    expect(await d.classifications()).toEqual({ proposed: 2, changed: 2 });
    const s = take();
    expect(s.map((x) => [x.subjectRef, (x.asset as { proposed_classification: string[] }).proposed_classification]).sort()).toEqual([['Column:col-leaf', ['pii:email']], ['Column:col-mid', ['pii:email']]]);
    expect((await store.getNode(db.catalog!, 'col-own'))?.attributes.proposed_classification).toBeUndefined();
    expect(await d.classifications()).toEqual({ proposed: 2, changed: 0 });
    expect(take()).toEqual([]);
  });
  it('a proposal that no longer applies is cleared', async () => {
    await link('classified_as', 'col-leaf', 'pii:email', 'dmc');
    await d.classifications();
    const s = take();
    expect(s.map((x) => [x.subjectRef, (x.asset as { proposed_classification: string[] }).proposed_classification])).toEqual([['Column:col-leaf', []]]);
  });
});
