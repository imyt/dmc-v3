import { ApiError, writeOutbox, type Queryable } from '@dmc/platform';
import { createHash } from 'node:crypto';
import { compileWorkflow, pickBranch, slaMs, type Step, type WorkflowDef } from './definition.js';

export interface Scheduler {
  enqueue(queue: string, payload: Record<string, unknown>, opts?: { runAt?: Date; singletonKey?: string }): Promise<void>;
}
export interface AssigneeResolver {
  resolve(rule: string, ctx: { subjectRef: string; context: Record<string, unknown> }): Promise<string>;
}

export const QUEUES = { step: 'workflow.step', timer: 'workflow.timer' } as const;
const M = 'workflow';
const LEASE_MS = 5 * 60_000;

interface Instance { id: string; name: string; version: number; subject_ref: string; status: string; context: Record<string, unknown> }
interface Run { id: string; instance_id: string; step_id: string; kind: string; status: string; assignee: string | null; decision: string | null; decided_by: string | null; root: string; claimed_at: Date | null; escalated_at: Date | null }
type Effect = () => Promise<void>;

export class WorkflowEngine {
  constructor(private readonly scheduler: Scheduler, private readonly resolver: AssigneeResolver, private readonly now: () => Date = () => new Date()) {}

  /** Run one unit of work in a transaction; queue jobs are sent only after it commits. */
  private async unit<R>(db: Queryable, fn: (effects: Effect[]) => Promise<R>): Promise<R> {
    const effects: Effect[] = [];
    await db.query('begin');
    let r: R;
    try { r = await fn(effects); await db.query('commit'); }
    catch (e) { await db.query('rollback'); throw e; }
    for (const f of effects) await f();
    return r;
  }

  async registerDefinition(db: Queryable, yaml: string): Promise<WorkflowDef> {
    const def = compileWorkflow(yaml);
    const checksum = createHash('sha256').update(JSON.stringify(def)).digest('hex');
    const have = await db.query<{ checksum: string }>(`select checksum from ${M}.definition where name = $1 and version = $2`, [def.workflow, def.version]);
    if (have.rows[0]) {
      if (have.rows[0].checksum !== checksum) throw new ApiError('conflict', `${def.workflow} v${def.version} already exists with different content; publish a new version`);
      return def;
    }
    await db.query(`insert into ${M}.definition (name, version, doc, checksum) values ($1,$2,$3,$4)`, [def.workflow, def.version, JSON.stringify(def), checksum]);
    return def;
  }

  async startInstance(db: Queryable, a: { workflow: string; version?: number; subjectRef: string; context?: Record<string, unknown>; actor: string }): Promise<{ id: string }> {
    return this.unit(db, async (fx) => {
      const d = await db.query<{ version: number; doc: WorkflowDef }>(
        `select version, doc from ${M}.definition where name = $1 and ($2::int is null or version = $2) order by version desc limit 1`, [a.workflow, a.version ?? null]);
      if (!d.rows[0]) throw new ApiError('not_found', `No workflow ${a.workflow}`);
      const { version, doc } = d.rows[0];
      const ins = await db.query<{ id: string }>(
        `insert into ${M}.instance (name, version, subject_ref, status, context, started_by) values ($1,$2,$3,'running',$4,$5) returning id`,
        [a.workflow, version, a.subjectRef, JSON.stringify(a.context ?? {}), a.actor]);
      const id = ins.rows[0]!.id;
      await writeOutbox(db, M, { type: 'workflow.started', subjectRef: a.subjectRef, actor: a.actor, payload: { instance: id, workflow: a.workflow, version } });
      const inst: Instance = { id, name: a.workflow, version, subject_ref: a.subjectRef, status: 'running', context: a.context ?? {} };
      await this.enter(db, fx, inst, doc, doc.start, '', a.actor);
      return { id };
    });
  }

  /** A person decides a task. Retrying with the same key, or the same decision by the same person, returns the first result. */
  async decide(db: Queryable, a: { taskId: string; decision: string; actor: string; /** identities that may decide it: the actor and their groups (default: the actor) */ assignees?: string[]; key?: string; context?: Record<string, unknown> }): Promise<{ replayed: boolean }> {
    return this.unit(db, async (fx) => {
      const { run, inst, def } = await this.lock(db, a.taskId);
      if (a.key) {
        const seen = await db.query(`select 1 from ${M}.decision_key where key = $1`, [a.key]);
        if (seen.rowCount) return { replayed: true };
      }
      const step = def.steps[run.step_id]!;
      if (step.type !== 'task') throw new ApiError('conflict', 'Not a task');
      if (run.status === 'done') {
        if (run.decision === a.decision && run.decided_by === a.actor) return { replayed: true };
        throw new ApiError('conflict', `Already decided (${run.decision})`);
      }
      if (inst.status !== 'running') throw new ApiError('conflict', `Workflow is ${inst.status}`);
      if (!run.assignee || !(a.assignees ?? [a.actor]).includes(run.assignee)) throw new ApiError('forbidden', 'This task is assigned to someone else');
      const next = step.decisions[a.decision];
      if (!next) throw new ApiError('validation_failed', `Decision must be one of ${Object.keys(step.decisions).join(', ')}`);

      await db.query(`update ${M}.step_run set status='done', decision=$2, decided_by=$3, done_at=$4 where id=$1`, [run.id, a.decision, a.actor, this.now()]);
      if (a.key) await db.query(`insert into ${M}.decision_key (key, step_run_id) values ($1,$2) on conflict do nothing`, [a.key, run.id]);
      if (a.context) {
        inst.context = { ...inst.context, ...a.context };
        await db.query(`update ${M}.instance set context = $2 where id = $1`, [inst.id, JSON.stringify(inst.context)]);
      }
      await writeOutbox(db, M, { type: 'workflow.task.decided', subjectRef: inst.subject_ref, actor: a.actor, payload: { instance: inst.id, step: run.step_id, decision: a.decision } });
      await this.enter(db, fx, inst, def, next, run.root, a.actor);
      return { replayed: false };
    });
  }

  /** Worker entry for `workflow.step`: runs an action step once, however many times the job is delivered. */
  async runAction(db: Queryable, stepRunId: string, exec: (action: string, ctx: { subjectRef: string; context: Record<string, unknown>; stepRunId: string }) => Promise<void>): Promise<'done' | 'skipped'> {
    const claim = await this.unit(db, async () => {
      const { run, inst, def } = await this.lock(db, stepRunId);
      const stale = run.status === 'running' && run.claimed_at && this.now().getTime() - run.claimed_at.getTime() > LEASE_MS;
      if (!(run.status === 'pending' || stale) || inst.status !== 'running') return undefined;
      await db.query(`update ${M}.step_run set status='running', claimed_at=$2 where id=$1`, [run.id, this.now()]);
      return { action: (def.steps[run.step_id] as Extract<Step, { type: 'action' }>).action, subjectRef: inst.subject_ref, context: inst.context };
    });
    if (!claim) return 'skipped';
    await exec(claim.action, { subjectRef: claim.subjectRef, context: claim.context, stepRunId });
    return this.unit(db, async (fx) => {
      const { run, inst, def } = await this.lock(db, stepRunId);
      if (run.status === 'done') return 'skipped';
      await db.query(`update ${M}.step_run set status='done', done_at=$2 where id=$1`, [run.id, this.now()]);
      await writeOutbox(db, M, { type: 'workflow.action.done', subjectRef: inst.subject_ref, actor: 'system/workflow', payload: { instance: inst.id, step: run.step_id } });
      await this.enter(db, fx, inst, def, (def.steps[run.step_id] as Extract<Step, { type: 'action' }>).next, run.root, 'system/workflow');
      return 'done';
    });
  }

  /** Worker entry for `workflow.timer`: escalate a task that is still pending past its SLA. */
  async onTimer(db: Queryable, stepRunId: string): Promise<'escalated' | 'skipped'> {
    return this.unit(db, async () => {
      const { run, inst, def } = await this.lock(db, stepRunId);
      const step = def.steps[run.step_id];
      if (!step || step.type !== 'task' || run.status !== 'pending' || run.escalated_at || !step.escalate_to || inst.status !== 'running') return 'skipped';
      const to = await this.resolver.resolve(step.escalate_to, { subjectRef: inst.subject_ref, context: inst.context });
      await db.query(`update ${M}.step_run set assignee=$2, escalated_at=$3 where id=$1`, [run.id, to, this.now()]);
      await writeOutbox(db, M, { type: 'workflow.task.escalated', subjectRef: inst.subject_ref, actor: 'system/workflow', payload: { instance: inst.id, step: run.step_id, from: run.assignee, to } });
      return 'escalated';
    });
  }

  async cancel(db: Queryable, instanceId: string, actor: string): Promise<void> {
    await this.unit(db, async () => {
      const r = await db.query<Instance>(`select * from ${M}.instance where id = $1 for update`, [instanceId]);
      if (!r.rows[0]) throw new ApiError('not_found', 'No such workflow instance');
      if (r.rows[0].status !== 'running') return;
      await db.query(`update ${M}.instance set status='cancelled', ended_at=$2 where id=$1`, [instanceId, this.now()]);
      await writeOutbox(db, M, { type: 'workflow.cancelled', subjectRef: r.rows[0].subject_ref, actor, payload: { instance: instanceId } });
    });
  }

  // ---- internals ----

  /** Locks the instance (so advances are serial per instance) and loads a step run with its definition. */
  private async lock(db: Queryable, stepRunId: string): Promise<{ run: Run; inst: Instance; def: WorkflowDef }> {
    const r = await db.query<Run>(`select * from ${M}.step_run where id = $1`, [stepRunId]);
    if (!r.rows[0]) throw new ApiError('not_found', 'No such task');
    const i = await db.query<Instance>(`select * from ${M}.instance where id = $1 for update`, [r.rows[0].instance_id]);
    const fresh = await db.query<Run>(`select * from ${M}.step_run where id = $1`, [stepRunId]); // re-read after the lock
    const d = await db.query<{ doc: WorkflowDef }>(`select doc from ${M}.definition where name = $1 and version = $2`, [i.rows[0]!.name, i.rows[0]!.version]);
    return { run: fresh.rows[0]!, inst: i.rows[0]!, def: d.rows[0]!.doc };
  }

  /** Marks a step as entered. Returns the new run id, or undefined if it was already entered. */
  private async mark(db: Queryable, inst: Instance, stepId: string, kind: string, status: string, root: string, extra: { assignee?: string; dueAt?: Date; decision?: string } = {}): Promise<string | undefined> {
    const r = await db.query<{ id: string }>(
      `insert into ${M}.step_run (instance_id, step_id, kind, status, root, assignee, due_at, decision, done_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8, case when $4 = 'done' then now() end) on conflict (instance_id, step_id) do nothing returning id`,
      [inst.id, stepId, kind, status, root, extra.assignee ?? null, extra.dueAt ?? null, extra.decision ?? null]);
    return r.rows[0]?.id;
  }

  private async enter(db: Queryable, fx: Effect[], inst: Instance, def: WorkflowDef, stepId: string, root: string, actor: string): Promise<void> {
    const step = def.steps[stepId]!;
    switch (step.type) {
      case 'task': {
        const assignee = await this.resolver.resolve(step.assignee, { subjectRef: inst.subject_ref, context: inst.context });
        const slaText = (step.sla_context ? inst.context[step.sla_context] : undefined) ?? step.sla;
        if (slaText !== undefined && !/^[1-9][0-9]*[mhd]$/.test(String(slaText))) throw new ApiError('validation_failed', `Invalid duration "${slaText}" for ${stepId}`);
        const dueAt = slaText ? new Date(this.now().getTime() + slaMs(String(slaText))) : undefined;
        const id = await this.mark(db, inst, stepId, 'task', 'pending', root, { assignee, dueAt });
        if (!id) return;
        await writeOutbox(db, M, { type: 'workflow.task.created', subjectRef: inst.subject_ref, actor, payload: { instance: inst.id, step: stepId, assignee, task: id } });
        if (dueAt && step.escalate_to) fx.push(() => this.scheduler.enqueue(QUEUES.timer, { stepRunId: id }, { runAt: dueAt, singletonKey: `escalate:${id}` }));
        return;
      }
      case 'action': {
        const id = await this.mark(db, inst, stepId, 'action', 'pending', root);
        if (id) fx.push(() => this.scheduler.enqueue(QUEUES.step, { stepRunId: id }, { singletonKey: `action:${id}` }));
        return;
      }
      case 'branch': {
        const next = pickBranch(step, inst.context);
        if (!(await this.mark(db, inst, stepId, 'branch', 'done', root, { decision: next }))) return;
        return this.enter(db, fx, inst, def, next, root, actor);
      }
      case 'parallel': {
        if (!(await this.mark(db, inst, stepId, 'parallel', 'done', root))) return;
        for (const b of step.branches) await this.enter(db, fx, inst, def, b, b, actor);
        return;
      }
      case 'join': {
        await db.query(`insert into ${M}.join_arrival (instance_id, join_step, root) values ($1,$2,$3) on conflict do nothing`, [inst.id, stepId, root]);
        const n = Number((await db.query<{ n: string }>(`select count(*) n from ${M}.join_arrival where instance_id=$1 and join_step=$2`, [inst.id, stepId])).rows[0]!.n);
        const need = (def.steps[step.parallel] as Extract<Step, { type: 'parallel' }>).branches.length;
        if (n < need) return;
        const parent = await db.query<{ root: string }>(`select root from ${M}.step_run where instance_id=$1 and step_id=$2`, [inst.id, step.parallel]);
        if (!(await this.mark(db, inst, stepId, 'join', 'done', parent.rows[0]?.root ?? ''))) return; // someone else already fired it
        return this.enter(db, fx, inst, def, step.next, parent.rows[0]?.root ?? '', actor);
      }
      case 'end': {
        if (!(await this.mark(db, inst, stepId, 'end', 'done', root))) return;
        await db.query(`update ${M}.instance set status='completed', outcome=$2, ended_at=$3 where id=$1 and status='running'`, [inst.id, step.outcome, this.now()]);
        await writeOutbox(db, M, { type: 'workflow.completed', subjectRef: inst.subject_ref, actor, payload: { instance: inst.id, outcome: step.outcome } });
        return;
      }
    }
  }
}
