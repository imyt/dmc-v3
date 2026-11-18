// Usage: vite-node scripts/metamodel-diff.ts <baseTypesDir> <headTypesDir> [--database-url=...]
// Prints the change report; exits 1 if a breaking change is still in use. Without a database, breaking changes count as blocked.
import pg from 'pg';
import { diffRegistries, countAffected, formatReport } from '../packages/catalog/src/index';
import { loadRegistry } from '../packages/platform/src/index';

const [base, head] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!base || !head) { console.error('usage: metamodel-diff <base> <head> [--database-url=URL]'); process.exit(2); }
let changes = diffRegistries(loadRegistry(base), loadRegistry(head));
const url = process.argv.find((a) => a.startsWith('--database-url='))?.split('=').slice(1).join('=');
if (url) {
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  changes = await countAffected(db, changes);
  await db.end();
} else changes = changes.map((c) => ({ ...c, blocked: c.breaking }));
console.log(formatReport(changes));
process.exit(changes.some((c) => c.blocked) ? 1 : 0);
