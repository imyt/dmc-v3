import type { InboxItem, InboxPort, TaskStatus } from '@dmc/contracts';
import type { Queryable } from '@dmc/platform';
import type { WorkflowEngine } from './engine.js';
import type { WorkflowDef } from './definition.js';

const M = 'workflow';

interface Row {
  id: string; assignee: string; due_at: Date | null; escalated_at: Date | null; created_at: Date; step_id: string; name: string; version: number;
  subject_ref: string; context: Record<string, unknown>; doc: unknown; kind: string | null; severity: string | null; message: string | null; exception_id: string | null;
}

/** The inbox: every open task, with the context a person needs to decide it in one action. */
export class WorkflowInbox implements InboxPort {
  constructor(private readonly engine: WorkflowEngine, private readonly connect: () => Promise<Queryable & { release(): void }>) {}

  private async withDb<R>(fn: (db: Queryable) => Promise<R>): Promise<R> {
    const c = await this.connect();
    try { return await fn(c); } finally { c.release(); }
  }

  private static item(r: Row): InboxItem {
    const step = (r.doc as WorkflowDef).steps[r.step_id] as { title?: string; decisions?: Record<string, string> } | undefined;
    const ctx = r.context as { message?: string; severity?: string };
    return {
      id: r.id, assignee: r.assignee,
      ...(r.exception_id && { exceptionId: r.exception_id }),
      kind: r.kind ?? r.name,
      ...((r.severity ?? ctx.severity) && { severity: (r.severity ?? ctx.severity) as InboxItem['severity'] }),
      title: step?.title ?? r.step_id,
      message: r.message ?? ctx.message ?? '',
      subjectRef: r.subject_ref,
      decisions: Object.keys(step?.decisions ?? {}),
      raisedAt: r.created_at.toISOString(),
      ...(r.due_at && { dueAt: r.due_at.toISOString() }),
      escalated: r.escalated_at !== null,
    };
  }

  private static readonly SELECT = `
    select r.id, r.assignee, r.due_at, r.escalated_at, r.created_at, r.step_id, i.name, i.version, i.subject_ref, i.context, d.doc,
           e.kind, e.severity, e.message, e.id as exception_id
    from ${M}.step_run r
    join ${M}.instance i on i.id = r.instance_id
    join ${M}.definition d on d.name = i.name and d.version = i.version
    left join ${M}.exception e on e.instance_id = i.id
    where r.kind = 'task' and r.status = 'pending' and i.status = 'running'`;

  async list(assignees: string[]): Promise<InboxItem[]> {
    if (assignees.length === 0) return [];
    return this.withDb(async (db) =>
      (await db.query<Row>(`${WorkflowInbox.SELECT} and r.assignee = any($1) order by (r.escalated_at is not null) desc, r.due_at nulls last, r.created_at`, [assignees])).rows.map(WorkflowInbox.item));
  }

  async forSubject(subjectRef: string, workflow: string): Promise<TaskStatus[]> {
    return this.withDb(async (db) => (await db.query<{ id: string; assignee: string; status: string; decision: string | null; due_at: Date | null; escalated_at: Date | null; context: Record<string, unknown>; istatus: string }>(
      `select r.id, r.assignee, r.status, r.decision, r.due_at, r.escalated_at, i.context, i.status as istatus
       from ${M}.step_run r join ${M}.instance i on i.id = r.instance_id
       where r.kind = 'task' and i.subject_ref = $1 and i.name = $2 order by r.created_at`, [subjectRef, workflow])).rows.map((r) => ({
      id: r.id, assignee: r.assignee, status: r.istatus === 'cancelled' ? 'cancelled' as const : r.status === 'done' ? 'done' as const : 'open' as const,
      ...(r.decision ? { decision: r.decision } : {}), ...(r.due_at ? { dueAt: r.due_at.toISOString() } : {}), escalated: r.escalated_at !== null, context: r.context,
    })));
  }

  async get(taskId: string): Promise<InboxItem | undefined> {
    return this.withDb(async (db) => {
      const r = (await db.query<Row>(`${WorkflowInbox.SELECT} and r.id = $1`, [taskId])).rows[0];
      return r ? WorkflowInbox.item(r) : undefined;
    });
  }

  async decide(req: { taskId: string; decision: string; actor: string; assignees: string[]; key?: string }): Promise<{ replayed: boolean }> {
    return this.withDb((db) => this.engine.decide(db, req));
  }
}
