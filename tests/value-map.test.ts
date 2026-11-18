import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { loadRegistry } from '../packages/platform/src/index';
import { SyncDefError, checkJobAgainstMetamodel, compileJob, mapRecord } from '../packages/connectors/src/index';

const registry = loadRegistry(join(import.meta.dirname, '..', 'metamodel/types'));
const job = (map: string, type = 'Scope') => `
job: scopes-x
connection: x
schedule: "0 3 * * *"
source: { query: "q", mode: full }
target:
  type: ${type}
  key: id
  source: scope-sources
  map: ${map}
`;

describe('ADR 0024: value map in the job target mapping', () => {
  it('a plain map still compiles and maps as before (backwards compatible)', () => {
    const d = compileJob(job('{ name: title, kind: type }'));
    expect(mapRecord({ id: 'a', title: 'A', type: 'report' }, d.target)).toMatchObject({ attrs: { name: 'A', kind: 'report' } });
  });

  it('a value map renames the source value; the other fields are unchanged', () => {
    const d = compileJob(job('{ name: title, kind: { from: type, values: { ProcessX: business-process, Return: regulatory-return } } }'));
    expect(mapRecord({ id: 'a', title: 'A', type: 'ProcessX' }, d.target)).toMatchObject({ key: 'a', attrs: { name: 'A', kind: 'business-process' } });
    expect(mapRecord({ id: 'a', title: 'A', type: 'Return' }, d.target)).toMatchObject({ attrs: { kind: 'regulatory-return' } });
  });

  it('a value with no entry is an error that names the value, never dropped', () => {
    const d = compileJob(job('{ name: title, kind: { from: type, values: { ProcessX: business-process } } }'));
    expect(mapRecord({ id: 'a', title: 'A', type: 'Other' }, d.target)).toEqual({ error: 'value "Other" of "type" has no mapping for kind' });
    // an inherited property name is not a mapping
    expect(mapRecord({ id: 'a', title: 'A', type: 'constructor' }, d.target)).toHaveProperty('error');
  });

  it('a field the record does not have is skipped, as for a plain map', () => {
    const d = compileJob(job('{ name: title, kind: { from: type, values: { ProcessX: business-process } } }'));
    expect(mapRecord({ id: 'a', title: 'A' }, d.target)).toMatchObject({ attrs: { name: 'A' } });
  });

  it('the job schema refuses a malformed value map', () => {
    expect(() => compileJob(job('{ kind: { from: type } }'))).toThrow(SyncDefError);
    expect(() => compileJob(job('{ kind: { values: { a: b } } }'))).toThrow(SyncDefError);
    expect(() => compileJob(job('{ kind: { from: type, values: {} } }'))).toThrow(SyncDefError);
    expect(() => compileJob(job('{ kind: { from: type, values: { a: b }, extra: 1 } }'))).toThrow(SyncDefError);
  });

  it('at load, every target value must be a value of the metamodel enum', () => {
    const ok = compileJob(job('{ kind: { from: type, values: { ProcessX: business-process, R: report } } }'));
    expect(checkJobAgainstMetamodel(ok, registry)).toEqual([]);
    const bad = compileJob(job('{ kind: { from: type, values: { ProcessX: business-proces } } }'));
    expect(checkJobAgainstMetamodel(bad, registry)).toEqual([expect.stringContaining('"business-proces" is not a value of Scope.kind')]);
    const noAttr = compileJob(job('{ nope: { from: type, values: { a: b } } }'));
    expect(checkJobAgainstMetamodel(noAttr, registry)).toEqual([expect.stringContaining('has no attribute nope')]);
    expect(checkJobAgainstMetamodel(compileJob(job('{ kind: type }', 'Nothing')), registry)).toEqual([]); // no value map: nothing to check
    expect(checkJobAgainstMetamodel(compileJob(job('{ kind: { from: type, values: { a: b } } }', 'Nothing')), registry)).toEqual([expect.stringContaining('unknown type')]);
  });
});
