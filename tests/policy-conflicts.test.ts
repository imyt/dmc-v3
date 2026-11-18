import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { loadRegistry } from '../packages/platform/src/index';
import { compilePolicy, dryRun, findConflicts, formatDryRun } from '../packages/policy/src/index';

const reg = loadRegistry(join(import.meta.dirname, '../metamodel/types'));
const mk = (id: string, when: string, value: string, scope = '', mode = 'shadow') => compilePolicy(`policy: ${id}
control: c
mode: ${mode}
scope: { type: Dataset${scope} }
when: "${when}"
effect: { action: set_attribute, attribute: business_context, value: ${value} }
`, reg, `${id}.yaml`);

describe('P4: conflicts and dry run', () => {
  it('contradicting policies on overlapping scopes are flagged; unrelated ones are not', () => {
    const a = mk('set-a', 'true', 'one');
    expect(findConflicts([a, mk('set-b', 'true', 'two')])).toMatchObject([{ a: 'set-a', b: 'set-b', overlap: 'possible' }]);
    expect(findConflicts([a, mk('set-c', 'true', 'one')])).toEqual([]); // same value
    expect(findConflicts([mk('set-d', 'true', 'one', ', domain: finance'), mk('set-e', 'true', 'two', ', domain: risk')])).toEqual([]); // different domains
  });

  it('a sample of real assets removes overlaps that cannot occur', () => {
    const a = mk('set-a', "dataset.name == 'x'", 'one');
    const b = mk('set-b', "dataset.name == 'y'", 'two');
    expect(findConflicts([a, b])).toHaveLength(1); // no sample: possible
    expect(findConflicts([a, b], { Dataset: [{ name: 'x' }, { name: 'y' }] })).toEqual([]); // nobody is both
    const c = mk('set-c', "dataset.name.startsWith('x')", 'two');
    expect(findConflicts([a, c], { Dataset: [{ name: 'x' }] })).toMatchObject([{ overlap: 'confirmed' }]);
  });

  it('dry run reports matches, errors and blocks on conflicts, without raising anything', () => {
    const cand = mk('set-new', "dataset.name.startsWith('x')", 'two');
    const existing = [mk('set-old', 'true', 'one', '', 'enforced')];
    const assets = [{ qualified_name: 'ds.1', name: 'x1' }, { qualified_name: 'ds.2', name: 'z' }, { qualified_name: 'ds.3' }];
    const r = dryRun(cand, assets, { others: existing });
    expect(r).toMatchObject({ evaluated: 3, matched: 1, errors: 1, examples: ['ds.1'], blocked: true });
    expect(formatDryRun(r)).toMatch(/1 would match[\s\S]*Blocked: conflicts[\s\S]*set-old/);
    expect(dryRun(cand, assets).blocked).toBe(false);
  });
});
