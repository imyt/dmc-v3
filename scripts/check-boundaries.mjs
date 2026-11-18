import { resolve } from 'node:path';
import { checkBoundaries } from './lib/boundaries.mjs';

const root = resolve(process.argv[2] ?? '.');
const violations = checkBoundaries(root);
if (violations.length) {
  console.error(`Boundary check failed: ${violations.length} violation(s)`);
  for (const v of violations) console.error(`  ${v.file}: '${v.spec}' — ${v.rule}`);
  process.exit(1);
}
console.log('Boundary check passed');
