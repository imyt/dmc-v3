import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeWriteValidator, generateTypes } from '../packages/catalog/src/index';
import { loadRegistry } from '../packages/platform/src/index';

const REAL = join(import.meta.dirname, '../metamodel/types');
const tmps: string[] = [];
const tmp = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); tmps.push(d); return d; };
afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });
const reg = loadRegistry(REAL);
const validate = makeWriteValidator(reg);
const user = { kind: 'user' } as const;

describe('M2: write validators from the metamodel', () => {
  it('rejects unknown attributes, wrong enums and missing required fields', () => {
    const p = validate('Application', { name: 'x', criticality: 'huge', bogus: 1 }, { kind: 'sync', source: 'servicenow' });
    const paths = p.map((x) => x.path);
    expect(paths).toContain('criticality');
    expect(paths).toContain('bogus');
    expect(paths).toContain('owner'); // required, missing
  });
  it('a user cannot set a synced attribute; the owning sync can', () => {
    expect(validate('Application', { name: 'x' }, user, { partial: true }).map((p) => p.message).join()).toMatch(/read-only/);
    expect(validate('Application', { name: 'x' }, { kind: 'sync', source: 'servicenow' }, { partial: true })).toEqual([]);
    expect(validate('Application', { name: 'x' }, { kind: 'sync', source: 'collibra' }, { partial: true })).not.toEqual([]);
  });
  it('a user can set dmc-sourced attributes', () => {
    const t = reg.all().find((x) => Object.values(x.attributes).some((a) => a.source === 'dmc'))!;
    const [name, a] = Object.entries(t.attributes).find(([, a]) => a.source === 'dmc')!;
    const sample = a.type === 'enum' ? a.values![0] : a.type === 'boolean' ? true : a.type === 'integer' ? 1 : a.type === 'string-list' ? ['x'] : a.type === 'date' ? '2026-01-01' : a.type === 'datetime' ? '2026-01-01T00:00:00Z' : a.type === 'country' ? 'GB' : a.type === 'url' ? 'https://x.example' : 'x';
    expect(validate(t.type, { [name]: sample }, user, { partial: true })).toEqual([]);
  });
  it('adding an attribute in YAML needs no code change', () => {
    const dir = tmp('mm-');
    cpSync(REAL, dir, { recursive: true });
    const f = join(dir, 'Group.yaml');
    const src = require('node:fs').readFileSync(f, 'utf8') as string;
    writeFileSync(f, src.replace('attributes:\n', 'attributes:\n  cost_centre: { type: string, source: dmc }\n'));
    const r2 = loadRegistry(dir);
    expect(validate.name).toBeDefined();
    expect(makeWriteValidator(r2)('Group', { cost_centre: 'CC1' }, user, { partial: true })).toEqual([]);
    expect(generateTypes(r2)).toContain('cost_centre?: string;');
  });
  it('generation is deterministic', () => {
    expect(generateTypes(reg)).toBe(generateTypes(loadRegistry(REAL)));
  });
});
