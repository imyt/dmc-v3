import { FileChangeRequests } from './file-change-requests.js';
import { PgBoss } from 'pg-boss';
import { connect, createLogger, loadConfig, loadRuntime, modulePool, repoPath, type AppConfig, type Logger } from '@dmc/platform';
import { CatalogStore, PostgresIdempotency } from '@dmc/catalog';
import { DecisionService } from '@dmc/decision';
import { PolicyControl, PolicyIndex, PolicyService, loadPolicies } from '@dmc/policy';
import { ExceptionService, PgBossScheduler, WorkflowEngine, WorkflowInbox, routeResolver } from '@dmc/workflow';
import { createApi } from './app.js';
import { cookieAuthenticator } from './auth.js';
import type { ApiDeps } from './context.js';

export interface StartedApi { url: string; close(): Promise<void> }

/**
 * Wires the API from configuration and starts listening. Identity comes from `authenticate`: in `local` that defaults to the header
 * authenticator; UAT and prod must pass the corporate SSO verifier (task F4b), and refuse to start without one.
 */
export async function startApi(cfg: AppConfig, opts: { authenticate?: ApiDeps['authenticate']; log?: Logger; boss?: PgBoss } = {}): Promise<StartedApi> {
  const log = opts.log ?? createLogger({ module: 'api' });
  const session = { environment: cfg.environment, ...(process.env.DMC_SECRET_SESSION ? { secret: process.env.DMC_SECRET_SESSION } : {}) };
  const authenticate = opts.authenticate ?? cookieAuthenticator(session);   // throws outside local without DMC_SECRET_SESSION

  const { registry, authz } = loadRuntime(cfg);
  const policies = loadPolicies(repoPath(cfg, 'policies'), registry, cfg.environment);
  const index = new PolicyIndex(policies);

  const pools = { catalog: modulePool(cfg, 'catalog'), evidence: modulePool(cfg, 'evidence', 2), decision: modulePool(cfg, 'decision'), policy: modulePool(cfg, 'policy'), workflow: modulePool(cfg, 'workflow') };
  const own = !opts.boss;
  const boss = opts.boss ?? new PgBoss({ host: cfg.db.host, port: cfg.db.port, database: cfg.db.name, user: cfg.db.adminUser, password: cfg.db.adminPassword });
  if (own) { boss.on('error', (e: Error) => log.error('queue error', { error: e.message })); await boss.start(); }

  const connectCatalog = connect(pools.catalog);
  const connectWorkflow = connect(pools.workflow);
  const engine = new WorkflowEngine(new PgBossScheduler(boss), routeResolver);
  const exceptions = new ExceptionService(engine);
  const withWorkflow = async <R>(fn: (db: Awaited<ReturnType<typeof connectWorkflow>>) => Promise<R>): Promise<R> => { const c = await connectWorkflow(); try { return await fn(c); } finally { c.release(); } };

  // the API only records signals; the worker carries the decisions out
  const signals = {
    async submit(batch: Parameters<DecisionService['intake']>[1][]) {
      const [d, p] = await Promise.all([connect(pools.decision)(), connect(pools.policy)()]);
      try {
        const decisions = new DecisionService({ policies: new PolicyService(p, index) });
        for (const s of batch) await decisions.intake(d, s);
      } finally { d.release(); p.release(); }
    },
  };

  const app = await createApi({
    version: process.env.npm_package_version ?? '0.0.0', registry, authz, authenticate, session,
    store: new CatalogStore(registry), connect: connectCatalog, connectEvidence: connect(pools.evidence),
    policies: () => policies.map((p) => ({ id: p.id, implements: p.implements, control: p.control, mode: p.mode })),
    exceptions: { raise: (r) => withWorkflow((db) => exceptions.raise(db, r)), withdraw: (r) => withWorkflow((db) => exceptions.withdraw(db, r)) },
    inbox: new WorkflowInbox(engine, connectWorkflow),
    signals, idempotency: new PostgresIdempotency(connectCatalog),
    admin: (() => {
      const withPolicy = async <R>(fn: (c: PolicyControl) => Promise<R>): Promise<R> => { const c = await connect(pools.policy)(); try { return await fn(new PolicyControl(c)); } finally { c.release(); } };
      return { state: () => withPolicy((c) => c.state()), setEnforcement: (p, a) => withPolicy((c) => c.setEnforcement(p, a)), setPolicy: (i, p, a) => withPolicy((c) => c.setPolicy(i, p, a)) };
    })(),
    stats: async () => {
      const [w, dc] = [await connectWorkflow(), await connect(pools.decision)()];
      try {
        const ex = await w.query<{ age: string; overdue: boolean }>(`select extract(epoch from (now() - raised_at)) / 86400 as age, coalesce(due_at < now(), false) as overdue from workflow.exception_view where status in ('open', 'escalated')`);
        const de = await dc.query<{ outcome: string; n: string }>(`select outcome, count(*) as n from decision.decision where status = 'applied' and mode = 'enforced' group by outcome`);
        const n = (o: string[]) => de.rows.filter((r) => o.includes(r.outcome)).reduce((a, r) => a + Number(r.n), 0);
        return { exceptions: { openAgesDays: ex.rows.map((r) => Number(r.age)), overdue: ex.rows.filter((r) => r.overdue).length }, decisions: { automatic: n(['act', 'act_notify', 'cleared']), byPerson: n(['propose']) } };
      } finally { w.release(); dc.release(); }
    },
    policyEditor: { existing: () => policies }, changeRequests: new FileChangeRequests(repoPath(cfg, 'pull-requests')),
  });
  await app.listen(cfg.http.port, cfg.http.host);
  const url = await app.getUrl();
  log.info('api listening', { url, environment: cfg.environment, policies: policies.length });
  return {
    url,
    async close() {
      await app.close();
      if (own) await boss.stop({ graceful: false });
      await Promise.all(Object.values(pools).map((p) => p.end()));
    },
  };
}

/** `pnpm run api`: start, and stop cleanly on SIGTERM. */
export async function main(): Promise<void> {
  const api = await startApi(loadConfig());
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.once(sig, () => { void api.close().then(() => process.exit(0)); });
}
