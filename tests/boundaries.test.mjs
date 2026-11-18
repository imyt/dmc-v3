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
