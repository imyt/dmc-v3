// Generates TS types and JSON Schemas from metamodel/types into @dmc/contracts. `--check` fails if stale.
// Run through vite-node so the TypeScript registry can be used directly.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { generateTypes, generateSchemas } from '../packages/catalog/src/index';
import { loadRegistry } from '../packages/platform/src/index';

const reg = loadRegistry('metamodel/types');
const files: [string, string][] = [
  ['packages/contracts/src/generated/metamodel.ts', generateTypes(reg)],
  ['packages/contracts/openapi/metamodel.generated.json', JSON.stringify({ components: { schemas: generateSchemas(reg) } }, null, 2) + '\n'],
];
let stale = 0;
for (const [path, content] of files) {
  if (process.argv.includes('--check')) {
    if (!existsSync(path) || readFileSync(path, 'utf8') !== content) { console.error(`${path} is out of date; run pnpm run gen:metamodel`); stale++; }
  } else { writeFileSync(path, content); console.log(`wrote ${path}`); }
}
if (stale) process.exit(1);
if (process.argv.includes('--check')) console.log('Metamodel outputs are up to date');
