import { ApiError, writeOutbox, type Queryable } from '@dmc/platform';
import type { WorkflowEngine } from './engine.js';

/** The built-in workflow every exception follows. Published like any other definition. */
export const EXCEPTION_WORKFLOW = `
workflow: exception-handling
version: 1
start: review
steps:
  review:
    type: task
    title: Resolve or accept this exception
    assignee: route
    sla_context: escalate_after
    escalate_to: governance-lead
    decisions: { resolve: resolved, accept_risk: risk_accepted, dismiss: dismissed }
  resolved: { type: end, outcome: resolved }
  risk_accepted: { type: end, outcome: risk_accepted }
  dismissed: { type: end, outcome: dismissed }
`;

export interface RaiseException {
  kind: string; severity: 'low' | 'medium' | 'high' | 'critical';
  subjectRef: string; message: string; route: string;
  policyId?: string; escalateAfter?: string; actor: string;
}
export interface ExceptionRow {
  id: string; kind: string; severity: string; subject_ref: string; policy_id: string | null; message: string; route: string;
  instance_id: string; raised_at: Date; due_at: Date | null; status: 'open' | 'escalated' | 'resolved' | 'risk_accepted' | 'dismissed' | 'withdrawn';
}

const M = 'workflow';

export class ExceptionService {
  constructor(private readonly engine: WorkflowEngine) {}

  async install(db: Queryable): Promise<void> { await this.engine.registerDefinition(db, EXCEPTION_WORKFLOW); }

  /** Raise an exception. The same policy raising on the same subject again returns the open one instead of a duplicate. */
  async raise(db: Queryable, a: RaiseException): Promise<{ id: string; created: boolean }> {
    const dedupeKey = `${a.policyId ?? a.kind}|${a.subjectRef}`;
    const open = await db.query<{ id: string }>(`select id from ${M}.exception_view where dedupe_key = $1 and status in ('open', 'escalated')`, [dedupeKey]);
    if (open.rows[0]) return { id: open.rows[0].id, created: false };
    // a closed exception frees its key, so the same problem can come back as a new exception
    await db.query(`update ${M}.exception set dedupe_key = dedupe_key || '#' || id::text where dedupe_key = $1`, [dedupeKey]);

    const { id: instanceId } = await this.engine.startInstance(db, {
      workflow: 'exception-handling', subjectRef: a.subjectRef, actor: a.actor,
      context: { route: a.route, message: a.message, severity: a.severity, ...(a.escalateAfter && { escalate_after: a.escalateAfter }) },
    });
    const due = a.escalateAfter ? (await db.query<{ due_at: Date | null }>(`select due_at from ${M}.step_run where instance_id = $1 and kind = 'task'`, [instanceId])).rows[0]?.due_at ?? null : null;
    const r = await db.query<{ id: string }>(
      `insert into ${M}.exception (kind, severity, subject_ref, policy_id, message, route, dedupe_key, instance_id, due_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
      [a.kind, a.severity, a.subjectRef, a.policyId ?? null, a.message, a.route, dedupeKey, instanceId, due]);
    await writeOutbox(db, M, { type: 'exception.raised', subjectRef: a.subjectRef, actor: a.actor,
      payload: { exception: r.rows[0]!.id, kind: a.kind, severity: a.severity, policy: a.policyId, route: a.route } });
    return { id: r.rows[0]!.id, created: true };
  }

  async get(db: Queryable, id: string): Promise<ExceptionRow | undefined> {
    return (await db.query<ExceptionRow>(`select * from ${M}.exception_view where id = $1`, [id])).rows[0];
  }

  async list(db: Queryable, f: { status?: ExceptionRow['status'][]; subjectRef?: string } = {}): Promise<ExceptionRow[]> {
    return (await db.query<ExceptionRow>(
      `select * from ${M}.exception_view where ($1::text[] is null or status = any($1)) and ($2::text is null or subject_ref = $2) order by raised_at desc`,
      [f.status ?? null, f.subjectRef ?? null])).rows;
  }

  /** The assignee closes it: resolve, accept_risk or dismiss. */
  async decide(db: Queryable, a: { id: string; decision: 'resolve' | 'accept_risk' | 'dismiss'; actor: string; key?: string }): Promise<{ replayed: boolean }> {
    const ex = await this.get(db, a.id);
    if (!ex) throw new ApiError('not_found', 'No such exception');
    const t = await db.query<{ id: string }>(`select id from ${M}.step_run where instance_id = $1 and kind = 'task'`, [ex.instance_id]);
    return this.engine.decide(db, { taskId: t.rows[0]!.id, decision: a.decision, actor: a.actor, key: a.key });
  }

  /** The condition stopped being true (the next evaluation no longer matches): withdraw it. */
  async withdraw(db: Queryable, a: { policyId?: string; kind?: string; subjectRef: string; actor: string }): Promise<boolean> {
    const key = `${a.policyId ?? a.kind}|${a.subjectRef}`;
    const open = await db.query<{ instance_id: string }>(`select instance_id from ${M}.exception_view where dedupe_key = $1 and status in ('open','escalated')`, [key]);
    if (!open.rows[0]) return false;
    await this.engine.cancel(db, open.rows[0].instance_id, a.actor);
    return true;
  }
}
