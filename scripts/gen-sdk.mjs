// Generates packages/sdk/src/schema.d.ts from the OpenAPI contract. `--check` fails if the committed file is stale.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const out = 'packages/sdk/src/schema.d.ts';
// On Windows the bin is a .cmd shim, which needs a shell to launch.
const gen = execFileSync('npx', ['openapi-typescript', 'packages/contracts/openapi/dmc.yaml'], { encoding: 'utf8', maxBuffer: 1 << 26, shell: process.platform === 'win32' });
if (process.argv.includes('--check')) {
  if (!existsSync(out) || readFileSync(out, 'utf8') !== gen) {
    console.error(`${out} is out of date; run pnpm run gen:sdk`);
    process.exit(1);
  }
  console.log('SDK is up to date');
} else {
  writeFileSync(out, gen);
  console.log(`wrote ${out}`);
}
