import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRegistry, loadSourceOfTruth, MetamodelError } from '../packages/platform/src/index';

const REAL = join(import.meta.dirname, '../metamodel/types');
const tmps: string[] = [];
const tmp = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); tmps.push(d); return d; };
afterAll(() => { for (const d of tmps) rmSync(d, { recursive: true, force: true }); });

function withFile(name: string, body: string) {
  const dir = tmp('mm-');
  writeFileSync(join(dir, name), body);
  return dir;
}

describe('metamodel registry', () => {
  it('loads every real type', () => {
    const files = readdirSync(REAL).filter((f) => f.endsWith('.yaml'));
    const reg = loadRegistry(REAL);
    expect(reg.all().length).toBe(files.length);
    expect(reg.get('System').parent).toBe('Asset');
  });

  it('resolves category and Any edge targets', () => {
    const reg = loadRegistry(REAL);
    expect(reg.canLink('System', 'owned_by', 'Person')).toBe(true);
    expect(reg.canLink('System', 'owned_by', 'Table')).toBe(false);
  });

  it('rejects an unknown parent', () => {
    const dir = withFile('X.yaml', 'type: X\nversion: 1\nparent: Thing\nidentity: { qualified_name: a.x }\nattributes: {}\nlifecycle: default\ncontrols: []\n');
    expect(() => loadRegistry(dir)).toThrow(MetamodelError);
  });

  it('rejects an edge to an unknown type', () => {
    const dir = withFile('X.yaml', 'type: X\nversion: 1\nparent: Asset\nidentity: { qualified_name: a.x }\nattributes: {}\nedges:\n  uses:\n    - { to: Nope, cardinality: many-to-one }\nlifecycle: default\ncontrols: []\n');
    expect(() => loadRegistry(dir)).toThrow(/unknown type Nope/);
  });

  it('rejects an attribute with no source', () => {
    const dir = withFile('X.yaml', 'type: X\nversion: 1\nparent: Asset\nidentity: { qualified_name: a.x }\nattributes:\n  name: { type: string }\nlifecycle: default\ncontrols: []\n');
    expect(() => loadRegistry(dir)).toThrow(MetamodelError);
  });
});

describe('source of truth per type (cutover)', () => {
  const file = join(import.meta.dirname, '../config/source-of-truth.yaml');
  it('the shipped file names the three glossary types and is valid against the metamodel', () => {
    const sw = loadSourceOfTruth(file);
    expect(sw).toEqual({ BusinessTerm: 'collibra', DataCategory: 'collibra', DataDomain: 'collibra' });
    const reg = loadRegistry(REAL).withSourceOfTruth(sw);
    expect(reg.get('BusinessTerm').attributes.definition!.source).toBe('collibra');
  });
  it('flipping a type moves only that type', () => {
    const reg = loadRegistry(REAL).withSourceOfTruth({ BusinessTerm: 'dmc', DataCategory: 'collibra' });
    expect(reg.get('BusinessTerm').attributes.definition!.source).toBe('dmc');
    expect(reg.get('DataCategory').attributes.definition!.source).toBe('collibra');
    expect(() => loadRegistry(REAL).withSourceOfTruth({ BusinessTerm: 'confluence' })).toThrow(MetamodelError);
  });
});

