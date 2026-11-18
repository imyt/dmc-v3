import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Test files run in parallel and each starts its own embedded Postgres on a fixed port (docs/adr/0001).
// Two files sharing a port collide, and the loser fails or hangs. The same port repeated inside one file is fine.
describe('embedded Postgres test ports', () => {
  it('no two test files use the same 54xxx port', () => {
    const dir = import.meta.dirname;
    const byPort = new Map<string, string[]>();
    for (const f of readdirSync(dir).filter((n) => /\.(ts|mjs)$/.test(n) && n !== 'ports.test.ts')) {
      const ports = new Set(readFileSync(join(dir, f), 'utf8').match(/\b54\d{3}\b/g) ?? []);
      for (const p of ports) byPort.set(p, [...(byPort.get(p) ?? []), f]);
    }
    const clashes = [...byPort].filter(([, files]) => files.length > 1)
      .map(([port, files]) => `port ${port} is used by ${files.join(', ')}`);
    expect(clashes, `Postgres ports must be unique per test file:\n${clashes.join('\n')}`).toEqual([]);
  });
});
