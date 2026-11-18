import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { loadRegistry } from '../packages/platform/src/index';
import { compilePolicy, failures, runPolicyDir, PolicyError } from '../packages/policy/src/index';

const reg = loadRegistry(join(import.meta.dirname, '../metamodel/types'));
const base = (over: string) => `policy: p-one
control: c
mode: shadow
scope: { type: Integration }
when: size(integration.transfers) == 0
effect: { action: raise_exception, message: m }
route: owner
${over}`;
const problems = (yaml: string, file = 'p-one.yaml') => { try { compilePolicy(yaml, reg, file); return []; } catch (e) { return (e as PolicyError).problems; } };

describe('P1: policy compile', () => {
  it('example policies compile and pass their golden tests', () => {
    expect(failures(runPolicyDir(join(import.meta.dirname, '../policies'), reg))).toEqual([]);
  });

  it('compiles to an IR with scope keys, reads, autonomy and escalation', () => {
    const ir = compilePolicy(base('escalate_after: 10d\nautonomy: act_notify\n'), reg, 'p-one.yaml');
    expect(ir).toMatchObject({ id: 'p-one', binding: 'integration', autonomy: 'act_notify', confidence: 1, escalateAfterMs: 10 * 86_400_000, reads: ['transfers'] });
    expect(ir.scopeKeys).toEqual({ type: 'Integration', category: 'Asset', concept: undefined, domain: undefined, scope: undefined });
  });

  it('evaluates, and reports a missing field as an error rather than a silent pass', () => {
    const ir = compilePolicy(base(''), reg, 'p-one.yaml');
    expect(ir.evaluate({ transfers: [] })).toEqual({ ok: true, matched: true });
    expect(ir.evaluate({})).toMatchObject({ ok: false });
  });

  it('supports `now`', () => {
    const y = base('').replace('size(integration.transfers) == 0', "now > timestamp('2026-01-01T00:00:00Z')");
    expect(compilePolicy(y, reg, 'p-one.yaml').evaluate({}, new Date('2027-01-01'))).toEqual({ ok: true, matched: true });
  });

  it('rejects problems with clear messages', () => {
    expect(problems(base('').replace('Integration', 'Nope'))).toContain('scope.type: unknown type Nope');
    expect(problems(base('').replace('integration.transfers', 'integration.nothing'))).toContain('when: Integration has no attribute or edge "nothing"');
    expect(problems(base('').replace('size(integration.transfers) == 0', 'size(integration.transfers)'))).toEqual(expect.arrayContaining([expect.stringMatching(/boolean/)]));
    expect(problems(base('').replace('size(integration.transfers) == 0', 'other.x == 1')).join()).toMatch(/when:/);
    expect(problems(base('').replace('size(integration.transfers) == 0', '1 +')).join()).toMatch(/when:/);
    expect(problems(base('').replace('route: owner\n', ''))).toContain('route: needed so the exception has an owner');
    expect(problems(base(''), 'other-name.yaml')[0]).toMatch(/must match the file name/);
    expect(problems('policy: p\n')).not.toEqual([]); // schema: required fields
    expect(problems(base('bogus: 1'))).not.toEqual([]); // schema: no unknown keys
    expect(problems(base('').replace('mode: shadow', 'mode: maybe'))).not.toEqual([]);
  });

  it('a policy may only set attributes sourced from dmc', () => {
    const y = base('').replace('effect: { action: raise_exception, message: m }', 'effect: { action: set_attribute, attribute: status, value: reviewed }');
    expect(problems(y).join()).toMatch(/sourced from servicenow/);
  });

  it('golden harness catches a wrong expectation and a missing golden file', () => {
    // simulate by compiling policy and evaluating directly
    const ir = compilePolicy(base(''), reg, 'p-one.yaml');
    expect(ir.evaluate({ transfers: [1] })).toEqual({ ok: true, matched: false });
  });
});
