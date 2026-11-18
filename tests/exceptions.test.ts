import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { provisionModule, migrateModule } from '../packages/platform/src/index';
import { ExceptionService, MemoryScheduler, QUEUES, WorkflowEngine } from '../packages/workflow/src/index';

let server: EmbeddedPostgres;
let admin: pg.Client;
let db: pg.Client;
const sched = new MemoryScheduler();
let clock = new Date('2026-11-17T09:00:00Z');
const engine = new WorkflowEngine(sched, {
  resolve: async (rule, { context }) => (rule === 'route' ? `role:${context.route}` : `role:${rule}`),
}, () => clock);
const svc = new ExceptionService(engine);
const base = { kind: 'integration-without-dataset', severity: 'medium' as const, subjectRef: 'node/int-1', message: 'Link a dataset', route: 'application-owner', policyId: 'integration-has-dataset', actor: 'system/decision' };

beforeAll(async () => {
  server = new EmbeddedPostgres({ databaseDir: mkdtempSync(join(tmpdir(), 'dmc-ex-')), user: 'postgres', password: 'pw', port: 54336, persistent: false });
  await server.initialise(); await server.start();
  admin = new pg.Client({ host: 'localhost', port: 54336, user: 'postgres', password: 'pw', database: 'postgres' });
  await admin.connect();
  await provisionModule(admin, 'workflow', { password: 'wf' });
  await migrateModule(admin, 'workflow', join(import.meta.dirname, '../packages/workflow/migrations'));
  await admin.query('grant all on all tables in schema workflow to dmc_workflow');
  db = new pg.Client({ host: 'localhost', port: 54336, user: 'dmc_workflow', password: 'wf', database: 'postgres' });
  await db.connect();
  await svc.install(db);
}, 120_000);
afterAll(async () => { try { await db?.end(); await admin?.end(); } finally { await server?.stop(); } });

describe('W3: exceptions', () => {
  it('raises once per policy and subject, routed to the policy route', async () => {
    const a = await svc.raise(db, { ...base, escalateAfter: '10d' });
    const b = await svc.raise(db, { ...base, escalateAfter: '10d' });
    expect(a.created).toBe(true);
    expect(b).toEqual({ id: a.id, created: false });
    const ex = (await svc.get(db, a.id))!;
    expect(ex).toMatchObject({ status: 'open', route: 'application-owner', severity: 'medium' });
    expect(ex.due_at!.toISOString()).toBe('2026-11-27T09:00:00.000Z');
    const t = await admin.query("select assignee from workflow.step_run where instance_id = $1 and kind = 'task'", [ex.instance_id]);
    expect(t.rows[0].assignee).toBe('role:application-owner');
  });

  it('escalates on its SLA, then the new assignee resolves it', async () => {
    const [timer] = sched.jobs.filter((j) => j.queue === QUEUES.timer && j.runAt?.toISOString() === '2026-11-27T09:00:00.000Z');
    expect(timer).toBeDefined(); // the policy's escalate_after became the timer
    clock = new Date('2026-11-27T09:00:01Z');
    const [ex] = await svc.list(db, { subjectRef: base.subjectRef });
    expect(await engine.onTimer(db, timer!.payload.stepRunId as string)).toBe('escalated');
    expect((await svc.get(db, ex!.id))!.status).toBe('escalated');
    await expect(svc.decide(db, { id: ex!.id, decision: 'resolve', actor: 'role:application-owner' })).rejects.toMatchObject({ code: 'forbidden' });
    await svc.decide(db, { id: ex!.id, decision: 'resolve', actor: 'role:governance-lead' });
    expect((await svc.get(db, ex!.id))!.status).toBe('resolved');
  });

  it('after it is closed, the same problem can be raised again as a new exception', async () => {
    const again = await svc.raise(db, { ...base });
    expect(again.created).toBe(true);
    expect(await svc.list(db, { subjectRef: base.subjectRef })).toHaveLength(2);
  });

  it('accepting a risk and dismissing are distinct outcomes', async () => {
    const x = await svc.raise(db, { ...base, subjectRef: 'node/int-2' });
    await svc.decide(db, { id: x.id, decision: 'accept_risk', actor: 'role:application-owner' });
    expect((await svc.get(db, x.id))!.status).toBe('risk_accepted');
    const y = await svc.raise(db, { ...base, subjectRef: 'node/int-3' });
    await svc.decide(db, { id: y.id, decision: 'dismiss', actor: 'role:application-owner' });
    expect((await svc.get(db, y.id))!.status).toBe('dismissed');
  });

  it('withdraws when the condition stops being true', async () => {
    const x = await svc.raise(db, { ...base, subjectRef: 'node/int-4' });
    expect(await svc.withdraw(db, { policyId: base.policyId, subjectRef: 'node/int-4', actor: 'system/decision' })).toBe(true);
    expect((await svc.get(db, x.id))!.status).toBe('withdrawn');
    expect(await svc.withdraw(db, { policyId: base.policyId, subjectRef: 'node/int-4', actor: 'system/decision' })).toBe(false);
  });

  it('filters by status and records evidence', async () => {
    expect((await svc.list(db, { status: ['open'] })).every((e) => e.status === 'open')).toBe(true);
    const ev = await admin.query("select count(*)::int n from workflow.outbox where event_type = 'exception.raised'");
    expect(ev.rows[0].n).toBeGreaterThanOrEqual(5);
  });

  it('rejects an invalid duration', async () => {
    await expect(svc.raise(db, { ...base, subjectRef: 'node/int-5', escalateAfter: 'soon' })).rejects.toMatchObject({ code: 'validation_failed' });
  });
});
