import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { provisionModule, migrateModule } from '../packages/platform/src/index';
import { MemoryScheduler, WorkflowEngine, WorkflowDefError, compileWorkflow, QUEUES } from '../packages/workflow/src/index';

let server: EmbeddedPostgres;
let admin: pg.Client;
let db: pg.Client;   // dmc_workflow
let db2: pg.Client;  // a second connection, for races
const sched = new MemoryScheduler();
const engine = new WorkflowEngine(sched, { resolve: async (rule) => `user:${rule}` });

const TERM = `
workflow: term-approval
version: 1
start: draft_review
steps:
  draft_review:
    type: task
    assignee: steward
    sla: 5d
    escalate_to: governance-lead
    decisions: { approve: check, reject: rejected }
  check:
    type: branch
    branches:
      - { when: "ctx.criticality == 'high'", next: second_review }
    default: publish
  second_review:
    type: task
    assignee: owner
    decisions: { approve: publish, reject: rejected }
  publish: { type: action, action: publish_term, next: approved }
  approved: { type: end, outcome: approved }
  rejected: { type: end, outcome: rejected }
`;
const PAR = `
workflow: dual-review
version: 1
start: fan
steps:
  fan: { type: parallel, branches: [legal, privacy] }
  legal: { type: task, assignee: legal, decisions: { ok: j } }
  privacy: { type: task, assignee: privacy, decisions: { ok: j } }
  j: { type: join, parallel: fan, next: done }
  done: { type: end, outcome: complete }
`;

const state = async (id: string) => (await admin.query('select status, outcome from workflow.instance where id = $1', [id])).rows[0];
const tasks = async (id: string) => (await admin.query("select id, step_id, assignee, status from workflow.step_run where instance_id = $1 and kind = 'task' order by created_at, step_id", [id])).rows;
const taskId = async (id: string, step: string) => (await tasks(id)).find((t) => t.step_id === step)!.id as string;

beforeAll(async () => {
  server = new EmbeddedPostgres({ databaseDir: mkdtempSync(join(tmpdir(), 'dmc-wf-')), user: 'postgres', password: 'pw', port: 54334, persistent: false });
  await server.initialise(); await server.start();
  const conn = (user: string, password: string) => new pg.Client({ host: 'localhost', port: 54334, user, password, database: 'postgres' });
  admin = conn('postgres', 'pw'); await admin.connect();
  await provisionModule(admin, 'workflow', { password: 'wf' });
  await migrateModule(admin, 'workflow', join(import.meta.dirname, '../packages/workflow/migrations'));
  await admin.query('grant all on all tables in schema workflow to dmc_workflow');
  db = conn('dmc_workflow', 'wf'); await db.connect();
  db2 = conn('dmc_workflow', 'wf'); await db2.connect();
  await engine.registerDefinition(db, TERM);
  await engine.registerDefinition(db, PAR);
}, 120_000);
afterAll(async () => { try { await db?.end(); await db2?.end(); await admin?.end(); } finally { await server?.stop(); } });

describe('W1: workflow engine', () => {
  it('runs sequence, branch and action to completion', async () => {
    const { id } = await engine.startInstance(db, { workflow: 'term-approval', subjectRef: 'term/1', context: { criticality: 'low' }, actor: 'u' });
    await engine.decide(db, { taskId: await taskId(id, 'draft_review'), decision: 'approve', actor: 'user:steward' });
    const [job] = sched.take(QUEUES.step);
    const ran: string[] = [];
    expect(await engine.runAction(db, job!.stepRunId as string, async (a) => void ran.push(a))).toBe('done');
    expect(ran).toEqual(['publish_term']);
    expect(await state(id)).toEqual({ status: 'completed', outcome: 'approved' });
  });

  it('a CEL branch routes high-criticality terms to a second review', async () => {
    const { id } = await engine.startInstance(db, { workflow: 'term-approval', subjectRef: 'term/2', context: { criticality: 'high' }, actor: 'u' });
    await engine.decide(db, { taskId: await taskId(id, 'draft_review'), decision: 'approve', actor: 'user:steward' });
    expect((await tasks(id)).map((t) => t.step_id)).toContain('second_review');
    await engine.decide(db, { taskId: await taskId(id, 'second_review'), decision: 'reject', actor: 'user:owner' });
    expect(await state(id)).toEqual({ status: 'completed', outcome: 'rejected' });
  });

  it('parallel steps join only when every branch is done, then continue once', async () => {
    const { id } = await engine.startInstance(db, { workflow: 'dual-review', subjectRef: 'term/3', actor: 'u' });
    expect((await tasks(id)).map((t) => t.step_id).sort()).toEqual(['legal', 'privacy']);
    await engine.decide(db, { taskId: await taskId(id, 'legal'), decision: 'ok', actor: 'user:legal' });
    expect((await state(id)).status).toBe('running');
    await engine.decide(db, { taskId: await taskId(id, 'privacy'), decision: 'ok', actor: 'user:privacy' });
    expect(await state(id)).toEqual({ status: 'completed', outcome: 'complete' });
    const ends = await admin.query("select count(*)::int n from workflow.step_run where instance_id = $1 and kind = 'end'", [id]);
    expect(ends.rows[0].n).toBe(1);
  });

  it('only the assignee may decide, and only with an allowed decision', async () => {
    const { id } = await engine.startInstance(db, { workflow: 'term-approval', subjectRef: 'term/4', actor: 'u' });
    const t = await taskId(id, 'draft_review');
    await expect(engine.decide(db, { taskId: t, decision: 'approve', actor: 'user:someone-else' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(engine.decide(db, { taskId: t, decision: 'maybe', actor: 'user:steward' })).rejects.toMatchObject({ code: 'validation_failed' });
    expect((await tasks(id))[0]!.status).toBe('pending');
  });

  it('retries never double-advance', async () => {
    const { id } = await engine.startInstance(db, { workflow: 'term-approval', subjectRef: 'term/5', context: { criticality: 'low' }, actor: 'u' });
    const t = await taskId(id, 'draft_review');
    const a = { taskId: t, decision: 'approve', actor: 'user:steward', key: 'req-0001' };
    expect(await engine.decide(db, a)).toEqual({ replayed: false });
    expect(await engine.decide(db, a)).toEqual({ replayed: true });                                   // same key
    expect(await engine.decide(db, { ...a, key: undefined })).toEqual({ replayed: true });            // same decision, no key
    await expect(engine.decide(db, { ...a, key: undefined, decision: 'reject' })).rejects.toMatchObject({ code: 'conflict' });
    const actions = await admin.query("select count(*)::int n from workflow.step_run where instance_id = $1 and kind = 'action'", [id]);
    expect(actions.rows[0].n).toBe(1);
    const decided = await admin.query("select count(*)::int n from workflow.outbox where event_type = 'workflow.task.decided' and payload->>'instance' = $1", [id]);
    expect(decided.rows[0].n).toBe(1);
  });

  it('two simultaneous decisions on one task: one wins, the instance advances once', async () => {
    const { id } = await engine.startInstance(db, { workflow: 'term-approval', subjectRef: 'term/6', context: {}, actor: 'u' });
    const t = await taskId(id, 'draft_review');
    const results = await Promise.allSettled([
      engine.decide(db, { taskId: t, decision: 'approve', actor: 'user:steward' }),
      engine.decide(db2, { taskId: t, decision: 'reject', actor: 'user:steward' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const ends = await admin.query("select count(*)::int n from workflow.step_run where instance_id = $1 and kind in ('end','action')", [id]);
    expect(ends.rows[0].n).toBe(1);
  });

  it('an action delivered twice runs once', async () => {
    sched.take(QUEUES.step); // drop jobs left by earlier tests
    const { id } = await engine.startInstance(db, { workflow: 'term-approval', subjectRef: 'term/7', context: {}, actor: 'u' });
    await engine.decide(db, { taskId: await taskId(id, 'draft_review'), decision: 'approve', actor: 'user:steward' });
    const [job] = sched.take(QUEUES.step);
    let runs = 0;
    const exec = async () => { runs++; await new Promise((r) => setTimeout(r, 30)); };
    const out = await Promise.all([engine.runAction(db, job!.stepRunId as string, exec), engine.runAction(db2, job!.stepRunId as string, exec)]);
    expect(runs).toBe(1);
    expect(out.sort()).toEqual(['done', 'skipped']);
    expect(await engine.runAction(db, job!.stepRunId as string, exec)).toBe('skipped');
    expect(await state(id)).toEqual({ status: 'completed', outcome: 'approved' });
  });

  it('escalates a pending task when its SLA timer fires, and only once', async () => {
    sched.take(QUEUES.timer);
    const { id } = await engine.startInstance(db, { workflow: 'term-approval', subjectRef: 'term/8', actor: 'u' });
    const [timer] = sched.take(QUEUES.timer);
    expect(timer).toBeDefined();
    const t = await taskId(id, 'draft_review');
    expect(await engine.onTimer(db, t)).toBe('escalated');
    expect(await engine.onTimer(db, t)).toBe('skipped');
    expect((await tasks(id))[0]!.assignee).toBe('user:governance-lead');
    await expect(engine.decide(db, { taskId: t, decision: 'approve', actor: 'user:steward' })).rejects.toMatchObject({ code: 'forbidden' });
    await engine.decide(db, { taskId: t, decision: 'reject', actor: 'user:governance-lead' });
    expect(await state(id)).toEqual({ status: 'completed', outcome: 'rejected' });
  });

  it('a timer for a task that was already decided does nothing', async () => {
    sched.take(QUEUES.timer);
    const { id } = await engine.startInstance(db, { workflow: 'term-approval', subjectRef: 'term/9', actor: 'u' });
    const t = await taskId(id, 'draft_review');
    await engine.decide(db, { taskId: t, decision: 'reject', actor: 'user:steward' });
    expect(await engine.onTimer(db, t)).toBe('skipped');
  });

  it('running instances stay on the version they started with', async () => {
    const { id } = await engine.startInstance(db, { workflow: 'term-approval', subjectRef: 'term/10', actor: 'u' });
    await engine.registerDefinition(db, TERM.replace('version: 1', 'version: 2').replace('assignee: steward', 'assignee: new-steward'));
    expect((await tasks(id))[0]!.assignee).toBe('user:steward');
    const { id: id2 } = await engine.startInstance(db, { workflow: 'term-approval', subjectRef: 'term/11', actor: 'u' });
    expect((await tasks(id2))[0]!.assignee).toBe('user:new-steward');
    await expect(engine.registerDefinition(db, TERM.replace('assignee: steward', 'assignee: other'))).rejects.toMatchObject({ code: 'conflict' }); // v1 changed
  });

  it('writes evidence (outbox) for every transition', async () => {
    const r = await admin.query("select distinct event_type from workflow.outbox order by 1");
    expect(r.rows.map((x) => x.event_type)).toEqual(expect.arrayContaining(['workflow.started', 'workflow.task.created', 'workflow.task.decided', 'workflow.task.escalated', 'workflow.action.done', 'workflow.completed']));
  });

  it('cancel stops a running instance', async () => {
    const { id } = await engine.startInstance(db, { workflow: 'term-approval', subjectRef: 'term/12', actor: 'u' });
    await engine.cancel(db, id, 'u');
    await expect(engine.decide(db, { taskId: await taskId(id, 'draft_review'), decision: 'approve', actor: 'user:steward' })).rejects.toMatchObject({ code: 'conflict' });
  });
});

describe('W1: definition checks', () => {
  const bad = (y: string) => { try { compileWorkflow(y); return []; } catch (e) { return (e as WorkflowDefError).problems; } };
  it('rejects cycles, unknown steps, unreachable steps, bad conditions and mismatched joins', () => {
    expect(bad(`workflow: a\nversion: 1\nstart: x\nsteps:\n  x: { type: action, action: a, next: y }\n  y: { type: action, action: b, next: x }\n  z: { type: end, outcome: o }\n`).join()).toMatch(/cycle/);
    expect(bad(`workflow: a\nversion: 1\nstart: x\nsteps:\n  x: { type: action, action: a, next: nope }\n`).join()).toMatch(/unknown step nope/);
    expect(bad(`workflow: a\nversion: 1\nstart: x\nsteps:\n  x: { type: end, outcome: o }\n  y: { type: end, outcome: p }\n`).join()).toMatch(/not reachable/);
    expect(bad(`workflow: a\nversion: 1\nstart: b\nsteps:\n  b: { type: branch, branches: [{ when: "ctx.x ==", next: e }], default: e }\n  e: { type: end, outcome: o }\n`).join()).toMatch(/does not compile|not a valid/);
    expect(bad(PAR.replace('next: done', 'next: done').replace('legal: { type: task, assignee: legal, decisions: { ok: j } }', 'legal: { type: task, assignee: legal, decisions: { ok: done } }')).join()).toMatch(/never reaches join|without joining/);
    expect(bad(TERM.replace('escalate_to: governance-lead', '').replace('sla: 5d', '')).length).toBe(0);
    expect(bad(TERM.replace(/ *sla: 5d\n/, ''))).toContain('draft_review: escalate_to needs an sla');
  });
});
