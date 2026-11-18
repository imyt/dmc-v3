import type { Queryable } from '@dmc/platform';

const M = 'workflow';
const DAY = 86_400_000;

/** Something a person should be told about a task. */
export interface TaskEvent {
  key: string;
  kind: 'task.assigned' | 'exception.raised' | 'task.escalated' | 'task.reminder';
  assignee: string;
  title: string;
  message: string;
  subjectRef: string;
  severity?: string;
  dueAt?: Date;
  taskId: string;
}

interface Row { id: string; assignee: string; due_at: Date | null; escalated_at: Date | null; step_id: string; subject_ref: string; context: Record<string, unknown>; doc: { steps: Record<string, { title?: string }> }; exception_id: string | null; severity: string | null; message: string | null }

/**
 * U4. Finds the task events nobody has been told about yet, and keeps the record of who was. It never sends anything itself:
 * the worker turns events into emails, claiming each key first so one event is one email.
 */
export class TaskNotifications {
  constructor(private readonly db: Queryable, private readonly now: () => Date = () => new Date()) {}

  /** Events for every open task that have not been claimed: new, escalated, and due within a day. Oldest first. */
  async due(limit = 200): Promise<TaskEvent[]> {
    const now = this.now();
    const rows = (await this.db.query<Row>(
      `select r.id, r.assignee, r.due_at, r.escalated_at, r.step_id, i.subject_ref, i.context, d.doc, e.id as exception_id, e.severity, e.message
         from ${M}.step_run r join ${M}.instance i on i.id = r.instance_id join ${M}.definition d on d.name = i.name and d.version = i.version
         left join ${M}.exception e on e.instance_id = i.id
        where r.kind = 'task' and r.status = 'pending' and i.status = 'running' and r.assignee is not null
        order by r.created_at limit $1`, [limit])).rows;
    const events: TaskEvent[] = [];
    for (const r of rows) {
      const title = r.doc.steps[r.step_id]?.title ?? r.step_id;
      const message = r.message ?? (typeof r.context.message === 'string' ? r.context.message : '');
      const base = { assignee: r.assignee, title, message, subjectRef: r.subject_ref, taskId: r.id, ...(r.severity ? { severity: r.severity } : {}), ...(r.due_at ? { dueAt: r.due_at } : {}) };
      events.push({ ...base, key: `assigned:${r.id}`, kind: r.exception_id ? 'exception.raised' : 'task.assigned' });
      if (r.escalated_at) events.push({ ...base, key: `escalated:${r.id}`, kind: 'task.escalated' });
      else if (r.due_at && r.due_at.getTime() - now.getTime() <= DAY && r.due_at.getTime() > now.getTime()) events.push({ ...base, key: `reminder:${r.id}`, kind: 'task.reminder' });
    }
    if (!events.length) return [];
    const seen = new Set((await this.db.query<{ event_key: string }>(`select event_key from ${M}.notification where event_key = any($1)`, [events.map((e) => e.key)])).rows.map((x) => x.event_key));
    return events.filter((e) => !seen.has(e.key));
  }

  /** True the first time a key is claimed; false when another worker (or an earlier run) already has it. */
  async claim(key: string, kind: string, recipient: string, status: 'sent' | 'no_recipient' = 'sent'): Promise<boolean> {
    const r = await this.db.query(`insert into ${M}.notification (event_key, kind, recipient, status) values ($1,$2,$3,$4) on conflict do nothing`, [key, kind, recipient, status]);
    return r.rowCount === 1;
  }

  /** A send that failed gives its claim back, so the next sweep tries again. */
  async release(key: string): Promise<void> { await this.db.query(`delete from ${M}.notification where event_key = $1 and status = 'sent'`, [key]); }
}
