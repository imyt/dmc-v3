import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { PgBoss } from 'pg-boss';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { provisionModule, migrateModule } from '../packages/platform/src/index';
import { PgBossScheduler, WorkflowEngine, startWorkflowWorkers } from '../packages/workflow/src/index';

let server: EmbeddedPostgres;
let admin: pg.Client;
let boss: PgBoss;
const pool = () => new pg.Pool({ host: 'localhost', port: 54335, user: 'dmc_workflow', password: 'wf', database: 'postgres', max: 4 });
let wfPool: pg.Pool;

const FLOW = `
workflow: quick
version: 1
start: review
steps:
  review: { type: task, assignee: a, sla: 1m, escalate_to: boss, decisions: { ok: publish } }
  publish: { type: action, action: do_it, next: done }
  done: { type: end, outcome: ok }
`;

beforeAll(async () => {
  server = new EmbeddedPostgres({ databaseDir: mkdtempSync(join(tmpdir(), 'dmc-wfb-')), user: 'postgres', password: 'pw', port: 54335, persistent: false });
  await server.initialise(); await server.start();
  admin = new pg.Client({ host: 'localhost', port: 54335, user: 'postgres', password: 'pw', database: 'postgres' });
  await admin.connect();
  await provisionModule(admin, 'workflow', { password: 'wf' });
  await migrateModule(admin, 'workflow', join(import.meta.dirname, '../packages/workflow/migrations'));
  await admin.query('grant all on all tables in schema workflow to dmc_workflow');
  wfPool = pool();
  boss = new PgBoss('postgres://postgres:pw@localhost:54335/postgres');
  boss.on('error', () => {});
  await boss.start();
}, 120_000);
afterAll(async () => { try { await boss?.stop({ graceful: false }); await wfPool?.end(); await admin?.end(); } finally { await server?.stop(); } });

describe('W1: pg-boss timers and actions', () => {
  it('runs an action job and fires an escalation timer from the queue', async () => {
    const ran: string[] = [];
    const engine = new WorkflowEngine(new PgBossScheduler(boss), { resolve: async (r) => `user:${r}` }, () => new Date());
    await startWorkflowWorkers(boss, engine, async () => { const c = await wfPool.connect(); return { db: c, release: () => c.release() }; }, async (a) => void ran.push(a));

    const c = await wfPool.connect();
    await engine.registerDefinition(c, FLOW);
    // timer: SLA is 1 minute, so shorten it by making the engine think it is 59.9s later
    const { id } = await engine.startInstance(c, { workflow: 'quick', subjectRef: 'x/1', actor: 'u' });
    const task = (await admin.query("select id from workflow.step_run where instance_id=$1 and kind='task'", [id])).rows[0].id as string;
    const delayed = await admin.query("select count(*)::int n from pgboss.job where name = 'workflow.timer' and state = 'created' and start_after > now()");
    expect(delayed.rows[0].n).toBe(1); // timer is stored, waiting
    await admin.query("update pgboss.job set start_after = now() where name = 'workflow.timer'"); // time passes
    await expect.poll(async () => (await admin.query('select assignee from workflow.step_run where id=$1', [task])).rows[0].assignee, { timeout: 30_000, interval: 500 }).toBe('user:boss');

    await engine.decide(c, { taskId: task, decision: 'ok', actor: 'user:boss' });
    await expect.poll(async () => (await admin.query('select status from workflow.instance where id=$1', [id])).rows[0].status, { timeout: 30_000, interval: 500 }).toBe('completed');
    expect(ran).toEqual(['do_it']);
    c.release();
  }, 90_000);
});
