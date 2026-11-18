import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';
import { PgBoss } from 'pg-boss';
import type { Queryable, Registry } from '@dmc/platform';
import { createLogger, loadConfig, loadRuntime, passwordFor, repoPath, roleFor, secretFromEnv, type AppConfig, type Logger, type ModuleName } from '@dmc/platform';
import type { Connector, NotifyPort } from '@dmc/contracts';
import { bigQueryConnector, googleBigQuery, checkJobAgainstMetamodel,compileJob, compileOverlay, resolveJob, SyncDefError, manifestConnector, restConnector, type ResolvedJob } from '@dmc/connectors';
import { singleWriterProblems } from '@dmc/connectors';
import { PolicyIndex, loadPolicies } from '@dmc/policy';
import { CatalogStore } from '@dmc/catalog';
import { PgBossScheduler, TaskNotifications, WorkflowEngine, routeResolver, startWorkflowWorkers } from '@dmc/workflow';
import { SmtpMailer, logMailer } from './mail.js';
import { EmailNotifications, Recipients, loadRecipientConfig, mailNotify } from './notifications.js';
import { OUTBOX_MODULES, compose, type Composition, type Connections } from './compose.js';
import { migrateAll } from './migrate.js';
import { startWorker } from './run.js';

export interface StartedWorker { composition: Composition; close(): Promise<void> }

/** Notifications are email when DMC_SMTP_HOST is set (U4), and log lines otherwise, so nothing is silently dropped. */
export const logNotify = (log: Logger): NotifyPort => ({ async send(r) { log.info('notification', { route: r.route, subject: r.subjectRef, message: r.message }); } });

/**
 * Jobs live in `sync/jobs/*.yaml` with one overlay per environment in `sync/overlays/<environment>.yaml`.
 * An overlay connection may name its connector with `type` (default `rest`); its other fields, except `secret`, are the connector's configuration.
 */
export function loadSyncJobs(cfg: AppConfig, registry?: Registry): { jobs: ResolvedJob[]; connections: { name: string; type: string; config: Record<string, unknown>; secret: string }[] } {
  const dir = repoPath(cfg, 'sync');
  const overlayFile = join(dir, 'overlays', `${cfg.environment}.yaml`);
  const jobDir = join(dir, 'jobs');
  if (!existsSync(jobDir) || !existsSync(overlayFile)) return { jobs: [], connections: [] };
  const overlay = compileOverlay(readFileSync(overlayFile, 'utf8'));
  const jobs = readdirSync(jobDir).filter((f) => /\.ya?ml$/.test(f)).sort().map((f) => {
    const def = compileJob(readFileSync(join(jobDir, f), 'utf8'));
    const problems = registry ? checkJobAgainstMetamodel(def, registry) : []; // value maps must name values the metamodel has (ADR 0024)
    if (problems.length) throw new SyncDefError(problems.map((p) => `${f}: ${p}`));
    return resolveJob(def, overlay, cfg.environment);
  });
  const clashes = singleWriterProblems(jobs); // S6: the REST stand-in and the BigQuery job must not both be on
  if (clashes.length) throw new SyncDefError(clashes);
  const connections = Object.entries(overlay.connections ?? {}).map(([name, { secret, type, ...config }]) => ({ name, type: typeof type === 'string' ? type : 'rest', config, secret }));
  return { jobs, connections };
}

/** Registers every workflow definition in `workflows/` (data, like policies). An existing version with different content stops the start: publish a new version instead. */
export async function installWorkflows(engine: WorkflowEngine, db: Queryable, dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const names: string[] = [];
  for (const f of readdirSync(dir).filter((x) => /\.ya?ml$/.test(x)).sort()) names.push((await engine.registerDefinition(db, readFileSync(join(dir, f), 'utf8'))).workflow);
  return names;
}

/** Starts the worker: housekeeping, sync schedules, workflow timers and the ledger verifier, all from configuration. */
export async function startWorkerProcess(cfg: AppConfig, opts: { log?: Logger; connectors?: Record<string, Connector>; env?: Record<string, string | undefined> } = {}): Promise<StartedWorker> {
  const log = opts.log ?? createLogger({ module: 'worker' });
  const { registry } = loadRuntime(cfg);
  const policies = new PolicyIndex(loadPolicies(repoPath(cfg, 'policies'), registry, cfg.environment));

  // one connection per module as its own role; each module's work runs one thing at a time on it
  const clients: pg.Client[] = [];
  const db: Partial<Connections> = {};
  for (const m of [...OUTBOX_MODULES, 'evidence'] as ModuleName[]) {
    const c = new pg.Client({ host: cfg.db.host, port: cfg.db.port, database: cfg.db.name, user: roleFor(m), password: passwordFor(cfg, m) });
    c.on('error', (e) => log.error('database connection error', { module: m, error: e.message }));
    await c.connect(); clients.push(c); db[m as keyof Connections] = c as never;
  }
  let audit: pg.Client | undefined;
  if (cfg.audit?.writerPassword) {
    audit = new pg.Client({ host: cfg.audit.host, port: cfg.audit.port, database: cfg.audit.name, user: 'dmc_audit_writer', password: cfg.audit.writerPassword });
    audit.on('error', (e) => log.error('audit database connection error', { error: e.message }));
    await audit.connect(); clients.push(audit);
  } else log.warn('no audit database configured: the chain hash is not being copied (set DMC_AUDIT_DB_HOST)');
  const boss = new PgBoss({ host: cfg.db.host, port: cfg.db.port, database: cfg.db.name, user: cfg.db.adminUser, password: cfg.db.adminPassword });
  boss.on('error', (e: Error) => log.error('queue error', { error: e.message }));
  await boss.start();

  const engine = new WorkflowEngine(new PgBossScheduler(boss), routeResolver);
  const secrets = secretFromEnv(opts.env);
  const mail = cfg.smtp
    ? new SmtpMailer({ host: cfg.smtp.host, port: cfg.smtp.port, secure: cfg.smtp.secure, from: cfg.smtp.from, ...(cfg.smtp.user ? { user: cfg.smtp.user, password: cfg.smtp.passwordRef ? await secrets(cfg.smtp.passwordRef) : '' } : {}) })
    : logMailer(log);
  const recipients = new Recipients({ store: new CatalogStore(registry), db: db.catalog!, ...loadRecipientConfig(cfg.root) });
  if (!cfg.smtp) log.warn('no SMTP configured: emails are written to the log (set DMC_SMTP_HOST)');
  const c = compose({
    db: db as Connections, ...(audit ? { audit: audit as never } : {}), registry, policies, engine, notify: mailNotify(mail, recipients, log),
    emails: new EmailNotifications({ tasks: new TaskNotifications(db.workflow!), mail, recipients, publicUrl: cfg.publicUrl, log }),
    connectors: opts.connectors ?? { rest: restConnector({ resolveSecret: secretFromEnv(opts.env) }), manifest: manifestConnector(), bigquery: bigQueryConnector({ ...googleBigQuery({ resolveSecret: secretFromEnv(opts.env) }), log: (m, f) => log.info(m, f) }) },
    onReject: (s, reason) => log.warn('source record refused', { subject: s.subjectRef, source: s.source, reason }),
  });
  await c.exceptions.install(db.workflow!);
  await installWorkflows(engine, db.workflow!, repoPath(cfg, 'workflows'));

  const { jobs, connections } = loadSyncJobs(cfg, registry);
  for (const k of connections) await c.sync.upsertConnection(db.connectors!, { name: k.name, environment: cfg.environment, type: k.type, config: k.config, secretRef: k.secret });
  for (const j of jobs) await c.sync.installJob(db.connectors!, j);

  const sinks = async () => ({ db: db.connectors!, release() {} });
  await startWorkflowWorkers(boss, engine, async () => ({ db: db.workflow!, release() {} }), async (action) => { log.warn('workflow action has no handler', { action }); });
  await startWorker(boss, c, jobs, sinks, (r) => { if (r.resumed || r.retried || r.escalated || r.delegationsEnded || r.remindersRaised) log.info('housekeeping', r); });
  // E2: copy the chain's head hash to the audit database every 5 seconds (and at once when 5,000 entries have gone by)
  const anchorTimer = audit ? setInterval(() => { void c.anchor().catch((e: Error) => log.error('anchoring failed', { error: e.message })); }, 5000) : undefined;
  log.info('worker started', { environment: cfg.environment, jobs: jobs.length, policies: policies.policies.length });

  return { composition: c, async close() { if (anchorTimer) clearInterval(anchorTimer); await boss.stop({ graceful: true }); await Promise.all(clients.map((x) => x.end())); } };
}

/** `pnpm run migrate` and `pnpm run worker`. */
export async function main(argv = process.argv.slice(2)): Promise<void> {
  const cfg = loadConfig();
  if (argv[0] === 'migrate') {
    for (const r of await migrateAll(cfg)) createLogger({ module: 'migrate' }).info(r.applied.length ? 'applied' : 'up to date', { module: r.module, applied: r.applied });
    return;
  }
  const w = await startWorkerProcess(cfg);
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.once(sig, () => { void w.close().then(() => process.exit(0)); });
}
