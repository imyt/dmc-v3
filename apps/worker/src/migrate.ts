import { migrateModule, provisionModule, passwordFor, repoPath, MODULES, adminClient, type AppConfig } from '@dmc/platform';
import pg from 'pg';
import { grantRelay, provisionAudit } from '@dmc/evidence';
import { OUTBOX_MODULES } from './compose.js';

/**
 * Creates every module's schema and role and applies its migrations, as the admin role. Safe to run on every deploy:
 * applied migrations are never re-run, and an edited one stops the run. Run it before the API and the worker start.
 */
export async function migrateAll(cfg: AppConfig, root = cfg): Promise<{ module: string; applied: string[] }[]> {
  const admin = adminClient(cfg);
  await admin.connect();
  const out: { module: string; applied: string[] }[] = [];
  try {
    for (const m of MODULES) {
      await provisionModule(admin, m, { password: passwordFor(cfg, m) });
      const applied = await migrateModule(admin, m, repoPath(root, 'packages', m, 'migrations'));
      // tables created by the admin role belong to the module's role
      await admin.query(`grant all on all tables in schema "${m}" to "dmc_${m}"`);
      await admin.query(`grant all on all sequences in schema "${m}" to "dmc_${m}"`);
      out.push({ module: m, applied });
    }
    await grantRelay(admin, OUTBOX_MODULES);
  } finally { await admin.end(); }
  if (cfg.audit?.writerPassword) {
    const a = new pg.Client({ host: cfg.audit.host, port: cfg.audit.port, database: cfg.audit.name, user: cfg.audit.adminUser, password: cfg.audit.adminPassword });
    await a.connect();
    try { await provisionAudit(a, { writerPassword: cfg.audit.writerPassword, sqlFile: repoPath(root, 'packages', 'evidence', 'audit', '0001_anchor.sql') }); out.push({ module: 'audit', applied: ['0001_anchor'] }); } finally { await a.end(); }
  }
  return out;
}
