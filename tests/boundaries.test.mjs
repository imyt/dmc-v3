import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkBoundaries } from '../scripts/lib/boundaries.mjs';

let root;
const put = (rel, body) => {
  const p = join(root, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, body);
};

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'dmc-boundaries-')); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('boundary check (F1: a cross-module import fails CI)', () => {
  it('passes when modules only use contracts and platform', () => {
    put('packages/catalog/src/a.ts', `import { X } from '@dmc/contracts';\nimport { Y } from '@dmc/platform';\nimport './b';`);
    put('packages/catalog/src/b.ts', `export const b = 1;`);
    expect(checkBoundaries(root)).toEqual([]);
  });

  it('fails when one module imports another module', () => {
    put('packages/catalog/src/a.ts', `import { x } from '@dmc/policy';`);
    const v = checkBoundaries(root);
    expect(v).toHaveLength(1);
    expect(v[0].rule).toMatch(/may not import @dmc\/policy/);
  });

  it('fails on a relative import that leaves the package', () => {
    put('packages/catalog/src/a.ts', `import { x } from '../../policy/src/index';`);
    expect(checkBoundaries(root)[0].rule).toMatch(/relative import leaves its package/);
  });

  it('fails on deep imports into another package', () => {
    put('packages/catalog/src/a.ts', `import { x } from '@dmc/contracts/src/internal';`);
    expect(checkBoundaries(root)[0].rule).toMatch(/deep import/);
  });

  it('lets deployables compose modules but keeps web to the sdk', () => {
    put('apps/api/src/a.ts', `import { x } from '@dmc/catalog';\nimport { y } from '@dmc/platform';`);
    put('apps/web/src/a.ts', `import { x } from '@dmc/sdk';`);
    expect(checkBoundaries(root)).toEqual([]);
    put('apps/web/src/b.ts', `import { x } from '@dmc/catalog';`);
    expect(checkBoundaries(root)).toHaveLength(1);
  });

  it('keeps contracts free of other packages', () => {
    put('packages/contracts/src/a.ts', `import { x } from '@dmc/platform';`);
    expect(checkBoundaries(root)).toHaveLength(1);
  });
});

describe('R1: shared code only through package names (a relative import across deployables fails CI)', () => {
  it('fails when one deployable reaches into another by relative path', () => {
    put('apps/api/src/a.ts', `import { w } from '../../worker/src/jobs';`);
    const v = checkBoundaries(root);
    expect(v).toHaveLength(1);
    expect(v[0]).toMatchObject({ file: 'apps/api/src/a.ts', rule: expect.stringMatching(/relative import leaves its package/) });
  });

  it('fails when a deployable reaches into packages/*/src by relative path, even into a module it may import by name', () => {
    put('apps/worker/src/a.ts', `import { x } from '../../../packages/catalog/src/index';`);
    put('apps/api/src/b.ts', `export { y } from '../../../packages/platform/src/authz';`);
    put('apps/connectors/src/c.ts', `const m = await import('../../../packages/contracts/src/index');`);
    expect(checkBoundaries(root).map((x) => x.file).sort()).toEqual(['apps/api/src/b.ts', 'apps/connectors/src/c.ts', 'apps/worker/src/a.ts']);
  });

  it('fails when a package imports a deployable, by relative path or by name', () => {
    put('packages/platform/src/a.ts', `import { x } from '../../../apps/api/src/server';`);
    put('packages/catalog/src/b.ts', `import { x } from '@dmc/app-api';`);
    put('packages/contracts/src/c.ts', `import { x } from '@dmc/app-worker';`);
    expect(checkBoundaries(root)).toHaveLength(3);
  });

  it('fails when a deployable imports another deployable by package name', () => {
    put('apps/api/src/a.ts', `import { x } from '@dmc/app-worker';`);
    expect(checkBoundaries(root)[0].rule).toMatch(/may not import @dmc\/app-worker/);
  });

  it('fails on an absolute path import', () => {
    put('apps/api/src/a.ts', `import { x } from '/repo/packages/catalog/src/index';`);
    put('apps/api/src/b.ts', `import { x } from 'C:\\repo\\apps\\worker\\x';`);
    expect(checkBoundaries(root)).toHaveLength(2);
  });

  it('allows relative imports that stay inside one deployable', () => {
    put('apps/api/src/a.ts', `import { x } from './b';\nimport { y } from '../test/helper';`);
    put('apps/api/test/helper.ts', `export const y = 1;`);
    expect(checkBoundaries(root)).toEqual([]);
  });

  it('does not scan the top-level tests/ directory (it exercises packages by relative path on purpose)', () => {
    put('tests/a.test.ts', `import { x } from '../packages/catalog/src/index';\nimport { y } from '../apps/api/src/index';`);
    expect(checkBoundaries(root)).toEqual([]);
  });
});
