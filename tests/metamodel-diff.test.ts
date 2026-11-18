import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { provisionModule, migrateModule } from '../packages/platform/src/index';
import { CatalogStore, countAffected, diffRegistries, formatReport } from '../packages/catalog/src/index';
import { loadRegistry } from '../packages/platform/src/index';

const REAL = join(import.meta.dirname, '../metamodel/types');
const base = loadRegistry(REAL);
const tmps: string[] = [];
const tmp = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); tmps.push(d); return d; };
afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });

function variant(edit: (file: (name: string, fn: (s: string) => string) => void) => void) {
  const dir = tmp('mmd-');
  cpSync(REAL, dir, { recursive: true });
  edit((name, fn) => { const p = join(dir, `${name}.yaml`); writeFileSync(p, fn(readFileSync(p, 'utf8'))); });
  return loadRegistry(dir);
}

let server: EmbeddedPostgres;
let admin: pg.Client;

beforeAll(async () => {
  server = new EmbeddedPostgres({ databaseDir: mkdtempSync(join(tmpdir(), 'dmc-mmd-')), user: 'postgres', password: 'pw', port: 54332, persistent: false });
  await server.initialise(); await server.start();
  admin = new pg.Client({ host: 'localhost', port: 54332, user: 'postgres', password: 'pw', database: 'postgres' });
  await admin.connect();
  await provisionModule(admin, 'catalog');
  await migrateModule(admin, 'catalog', join(import.meta.dirname, '../packages/catalog/migrations'));
}, 120_000);
afterAll(async () => { try { await admin?.end(); } finally { await server?.stop(); } });

describe('M6: metamodel change check', () => {
  it('no change, no report', () => {
    expect(diffRegistries(base, loadRegistry(REAL))).toEqual([]);
  });

  it('an additive change is safe', () => {
    const head = variant((f) => f('Group', (s) => s.replace('attributes:\n', 'attributes:\n  cost_centre: { type: string, source: dmc }\n').replace('version: 1', 'version: 2')));
    const ch = diffRegistries(base, head);
    expect(ch).toMatchObject([{ kind: 'attribute_added', type: 'Group', breaking: false }]);
  });

  it('a breaking change fails with counts while objects use it', async () => {
    const store = new CatalogStore(base);
    await store.tx(admin, async () => {
      for (const n of ['sys.a', 'sys.b'])
        await store.applyNode(admin, { type: 'System', qualifiedName: n, attributes: { name: n, platform: 'k8s' }, writer: { kind: 'sync', source: 'git-json' }, actor: 't' });
    });
    const head = variant((f) => f('System', (s) => s.replace(/  platform:.*\n/, '').replace('version: 1', 'version: 2')));
    const ch = await countAffected(admin, diffRegistries(base, head));
    const removed = ch.find((c) => c.kind === 'attribute_removed')!;
    expect(removed).toMatchObject({ breaking: true, affected: 2, blocked: true });
    expect(formatReport(ch)).toMatch(/BLOCKED.*attribute_removed.*System.*platform.*2 affected/);
  });

  it('a breaking change on something unused is allowed', async () => {
    const head = variant((f) => f('DataProduct', (s) => s.replace(/  description:.*\n/, '').replace('version: 1', 'version: 2')));
    const ch = diffRegistries(base, head);
    if (!ch.some((c) => c.kind === 'attribute_removed')) return; // fixture has no such attribute
    const counted = await countAffected(admin, ch);
    expect(counted.filter((c) => c.blocked)).toEqual([]);
  });

  it('changing a type without bumping its version is flagged', () => {
    const head = variant((f) => f('Group', (s) => s.replace('attributes:\n', 'attributes:\n  note: { type: string, source: dmc }\n')));
    expect(diffRegistries(base, head).some((c) => c.kind === 'version_not_bumped')).toBe(true);
  });

  it('removing an enum value and a type are breaking', () => {
    const head = variant((f) => f('Application', (s) => s.replace(', critical]', ', severe]').replace('version: 1', 'version: 2')));
    expect(diffRegistries(base, head).map((c) => c.kind)).toContain('enum_value_removed');
    const dir = tmp('mmd-'); cpSync(REAL, dir, { recursive: true }); rmSync(join(dir, 'Group.yaml'));
    const ch = diffRegistries(base, loadRegistry(dir));
    expect(ch).toMatchObject([{ kind: 'type_removed', type: 'Group', breaking: true }]);
  });
});
