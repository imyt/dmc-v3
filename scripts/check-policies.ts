// Compiles every policy under policies/ and runs its golden cases. Exit 1 on any problem.
import { loadRegistry } from '../packages/platform/src/index';
import { runPolicyDir, failures } from '../packages/policy/src/index';

const reports = runPolicyDir(process.argv[2] ?? 'policies', loadRegistry('metamodel/types'));
const bad = failures(reports);
for (const b of bad) console.error(b);
console.log(`${reports.length} policies, ${reports.reduce((n, r) => n + r.cases.length, 0)} golden cases, ${bad.length} problems`);
process.exit(bad.length ? 1 : 0);
