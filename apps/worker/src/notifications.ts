import { readFileSync, existsSync } from 'node:fs';
import { parse } from 'yaml';
import type { MailSender, NotifyPort } from '@dmc/contracts';
import type { Logger, Queryable } from '@dmc/platform';
import type { CatalogStore } from '@dmc/catalog';
import type { TaskEvent, TaskNotifications } from '@dmc/workflow';

/** Who an assignee is, as email addresses: a route's list, an address, or a person (by staff ID or by their Person record). */
export class Recipients {
  private byStaff?: { at: number; map: Map<string, string> };
  constructor(private readonly o: { store: CatalogStore; db: Queryable; users?: { staffID: string; email?: string }[]; routes?: Record<string, string[]>; now?: () => Date; ttlMs?: number }) {}

  private async staffMap(): Promise<Map<string, string>> {
    const now = (this.o.now?.() ?? new Date()).getTime();
    if (this.byStaff && now - this.byStaff.at < (this.o.ttlMs ?? 300_000)) return this.byStaff.map;
    const map = new Map<string, string>();
    for (const p of await this.o.store.listByType(this.o.db, 'Person', { limit: 5000 }))
      if (typeof p.attributes.email === 'string') for (const k of [p.qualifiedName, p.attributes.staff_id]) if (typeof k === 'string') map.set(k, p.attributes.email); // ADR 0026: the Person key is the staff ID
    this.byStaff = { at: now, map };
    return map;
  }

  async resolve(assignee: string): Promise<string[]> {
    const route = this.o.routes?.[assignee];
    if (route?.length) return route;
    if (assignee.includes('@')) return [assignee];
    const staff = (await this.staffMap()).get(assignee);
    if (staff) return [staff];
    const local = this.o.users?.find((u) => u.staffID === assignee)?.email;
    if (local) return [local];
    return [];
  }
}

export function loadRecipientConfig(root: string): { users: { staffID: string; email?: string }[]; routes: Record<string, string[]> } {
  const read = (f: string) => (existsSync(`${root}/config/${f}`) ? readFileSync(`${root}/config/${f}`, 'utf8') : undefined);
  const users = read('local-users.json');
  const routes = read('notifications.yaml');
  return { users: users ? JSON.parse(users) : [], routes: routes ? ((parse(routes) as { routes?: Record<string, string[]> })?.routes ?? {}) : {} };
}

const SUBJECT: Record<TaskEvent['kind'], string> = { 'task.assigned': 'New task', 'exception.raised': 'Exception raised', 'task.escalated': 'Escalated to you', 'task.reminder': 'Due within a day' };

export function compose(e: TaskEvent, publicUrl: string): { subject: string; text: string } {
  const lines = [e.message || e.title, '', `About: ${e.subjectRef}`, ...(e.severity ? [`Severity: ${e.severity}`] : []), ...(e.dueAt ? [`Due: ${e.dueAt.toISOString().slice(0, 10)}`] : []), ...(publicUrl ? ['', `Open your inbox: ${publicUrl.replace(/\/$/, '')}/inbox`] : [])];
  return { subject: `[DMC] ${SUBJECT[e.kind]}: ${e.title}`, text: lines.join('\n') };
}

/**
 * U4. Emails people about their tasks, once each. Housekeeping runs it every minute; an event is claimed in the workflow
 * module's own table before it is sent, so nothing is mailed twice, and a failed send is retried on the next run.
 */
export class EmailNotifications {
  constructor(private readonly o: { tasks: TaskNotifications; mail: MailSender; recipients: Recipients; publicUrl: string; log: Logger }) {}

  async sweep(): Promise<{ sent: number; noRecipient: number; failed: number }> {
    let sent = 0; let noRecipient = 0; let failed = 0;
    for (const e of await this.o.tasks.due()) {
      const to = await this.o.recipients.resolve(e.assignee);
      if (to.length === 0) {
        if (await this.o.tasks.claim(e.key, e.kind, e.assignee, 'no_recipient')) { noRecipient++; this.o.log.warn('no email address for assignee', { assignee: e.assignee, subject: e.subjectRef, event: e.key }); }
        continue;
      }
      if (!(await this.o.tasks.claim(e.key, e.kind, to.join(','), 'sent'))) continue;
      try { await this.o.mail.send({ to, key: e.key, ...compose(e, this.o.publicUrl) }); sent++; }
      catch (err) { failed++; await this.o.tasks.release(e.key); this.o.log.error('email failed', { event: e.key, error: (err as Error).message }); }
    }
    return { sent, noRecipient, failed };
  }
}

/** The route-based notifications (a verified-ledger failure, an action that changed something) go by email too, and are always logged. */
export function mailNotify(mail: MailSender, recipients: Recipients, log: Logger): NotifyPort {
  return {
    async send(r) {
      log.info('notification', { route: r.route, subject: r.subjectRef, message: r.message });
      const to = await recipients.resolve(r.route);
      if (!to.length) return;
      try { await mail.send({ to, key: `notify:${r.route}:${r.subjectRef}:${r.message}`.slice(0, 200), subject: `[DMC] ${r.subjectRef}`, text: `${r.message}\n\nRoute: ${r.route}` }); }
      catch (e) { log.error('email failed', { route: r.route, error: (e as Error).message }); }
    },
  };
}
