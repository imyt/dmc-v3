// `pnpm run seed`: loads synthetic data into the local catalog. Local only.
import { join } from 'node:path';
import { loadConfig, loadRuntime, modulePool } from '../packages/platform/src/index';
import { CatalogStore } from '../packages/catalog/src/index';
import { seed } from './seed-lib';

const cfg = loadConfig();
if (cfg.environment !== 'local') { console.error(`seed refuses to run in ${cfg.environment}: synthetic data is for local only`); process.exit(1); }
const { registry } = loadRuntime(cfg);
const pool = modulePool(cfg, 'catalog', 1);
const db = await pool.connect();
try {
  const r = await seed(new CatalogStore(registry), db, join(import.meta.dirname, '..'));
  console.log(`seeded ${r.nodes} nodes and ${r.edges} edges (re-running changes nothing)`);
  console.log('mock login users: config/local-users.json');
} finally { db.release(); await pool.end(); }
