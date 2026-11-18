// Minimal structural lint for F1; real linting rules arrive with the first feature tasks.
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

let bad = 0;
for (const group of ['packages', 'apps']) {
  for (const name of readdirSync(group)) {
    const dir = join(group, name);
    if (!statSync(dir).isDirectory()) continue;
    const pj = join(dir, 'package.json');
    if (!existsSync(pj)) { console.error(`${dir}: missing package.json`); bad++; continue; }
    const { name: pkgName } = JSON.parse(readFileSync(pj, 'utf8'));
    const expected = group === 'apps' ? `@dmc/app-${name}` : `@dmc/${name}`;
    if (pkgName !== expected) { console.error(`${dir}: package name must be ${expected}`); bad++; }
    if (!existsSync(join(dir, 'src', 'index.ts'))) { console.error(`${dir}: missing src/index.ts`); bad++; }
  }
}
if (bad) process.exit(1);
console.log('Lint passed');
