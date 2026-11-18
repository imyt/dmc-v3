import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateModule, provisionModule, type Logger } from '../packages/platform/src/index';
import { ExceptionService, MemoryScheduler, QUEUES, TaskNotifications, WorkflowEngine, routeResolver } from '../packages/workflow/src/index';
import { EmailNotifications, Recipients, SmtpMailer, jsonTransport, loadRecipientConfig, mailNotify } from '../apps/worker/src/index';
import type { MailMessage, MailSender } from '../packages/contracts/src/index';

const root = join(import.meta.dirname, '..');
let server: EmbeddedPostgres; let admin: pg.Client; let db: pg.Client;
const sched = new MemoryScheduler();
let clock = new Date('2026-11-17T09:00:00Z');
const engine = new WorkflowEngine(sched, routeResolver, () => clock);
const exceptions = new ExceptionService(engine);
const logs: string[] = [];
const log = { info: (m: string) => logs.push(`info ${m}`), warn: (m: string, f?: unknown) => logs.push(`warn ${m} ${JSON.stringify(f)}`), error: (m: string) => logs.push(`error ${m}`), debug() {}, child() { return log; } } as unknown as Logger;
const sent: MailMessage[] = []; let failNext = false;
const mail: MailSender = { async send(m) { if (failNext) { failNext = false; throw new Error('smtp down'); } sent.push(m); } };
const people = { listByType: async () => [{ attributes: { staff_id: 'S9', email: 'sue@example.test' } }] } as never;
const recipients = new Recipients({ store: people, db: db as never, users: [{ staffID: '43000001', email: 'amy.adams@example.test' }], routes: { 'data-steward': ['stewards@example.test', 'lead@example.test'], 'governance-lead': ['gov@example.test'] }, now: () => clock });
let notifier: EmailNotifications;
const raise = (route: string, subjectRef: string, escalateAfter?: string) => exceptions.raise(db as never, { kind: 'k', severity: 'high', subjectRef, message: `Fix ${subjectRef}`, route, policyId: `p-${route}`, actor: 'system/decision', ...(escalateAfter ? { escalateAfter } : {}) });

beforeAll(async () => {
  server = new EmbeddedPostgres({ databaseDir: mkdtempSync(join(tmpdir(), 'dmc-nt-')), user: 'postgres', password: 'pw', port: 54403, persistent: false });
  await server.initialise(); await server.start();
  admin = new pg.Client({ host: 'localhost', port: 54403, user: 'postgres', password: 'pw', database: 'postgres' });
  await admin.connect();
  await provisionModule(admin, 'workflow', { password: 'wf' });
  await migrateModule(admin, 'workflow', join(root, 'packages/workflow/migrations'));
  await admin.query('grant all on all tables in schema workflow to dmc_workflow');
  db = new pg.Client({ host: 'localhost', port: 54403, user: 'dmc_workflow', password: 'wf', database: 'postgres' });
  await db.connect();
  await exceptions.install(db as never);
  notifier = new EmailNotifications({ tasks: new TaskNotifications(db as never, () => clock), mail, recipients, publicUrl: 'http://dmc.test/', log });
}, 120_000);
afterAll(async () => { try { await db?.end(); await admin?.end(); } finally { await server?.stop(); } });

describe('U4: email notifications', () => {
  it('a raised exception is mailed to the route’s addresses, once', async () => {
    await raise('data-steward', 'Column:c1', '2d');
    expect(await notifier.sweep()).toEqual({ sent: 1, noRecipient: 0, failed: 0 });
    expect(sent[0]).toMatchObject({ to: ['stewards@example.test', 'lead@example.test'], subject: '[DMC] Exception raised: Resolve or accept this exception', key: expect.stringMatching(/^assigned:/) });
    expect(sent[0]!.text).toContain('Fix Column:c1');
    expect(sent[0]!.text).toContain('Severity: high');
    expect(sent[0]!.text).toContain('Due: 2026-11-19');
    expect(sent[0]!.text).toContain('http://dmc.test/inbox');
    expect(await notifier.sweep()).toEqual({ sent: 0, noRecipient: 0, failed: 0 });   // not twice
    expect(sent).toHaveLength(1);
  });

  it('people are found by staff ID in the user list or the Person records, and by address', async () => {
    await raise('43000001', 'Column:c2');
    await raise('S9', 'Column:c3');
    await raise('someone@bank.test', 'Column:c4');
    expect(await notifier.sweep()).toMatchObject({ sent: 3 });
    expect(sent.slice(1).map((m) => m.to[0]).sort()).toEqual(['amy.adams@example.test', 'someone@bank.test', 'sue@example.test']);
  });

  it('an assignee with no address is logged once, not every minute', async () => {
    await raise('mystery-team', 'Column:c5');
    expect(await notifier.sweep()).toEqual({ sent: 0, noRecipient: 1, failed: 0 });
    expect(await notifier.sweep()).toEqual({ sent: 0, noRecipient: 0, failed: 0 });
    expect(logs.filter((l) => l.includes('no email address') && l.includes('mystery-team'))).toHaveLength(1);
  });

  it('a task due within a day gets one reminder', async () => {
    clock = new Date('2026-11-18T09:30:00Z');
    expect(await notifier.sweep()).toEqual({ sent: 1, noRecipient: 0, failed: 0 });
    expect(sent.at(-1)).toMatchObject({ subject: '[DMC] Due within a day: Resolve or accept this exception', key: expect.stringMatching(/^reminder:/) });
    expect(await notifier.sweep()).toMatchObject({ sent: 0 });
  });

  it('an escalation goes to the new assignee', async () => {
    clock = new Date('2026-11-19T09:00:01Z');
    const timer = sched.jobs.filter((j) => j.queue === QUEUES.timer).at(-1)!;
    expect(await engine.onTimer(db as never, timer.payload.stepRunId as string)).toBe('escalated');
    expect(await notifier.sweep()).toEqual({ sent: 1, noRecipient: 0, failed: 0 });
    expect(sent.at(-1)).toMatchObject({ to: ['gov@example.test'], subject: '[DMC] Escalated to you: Resolve or accept this exception', key: expect.stringMatching(/^escalated:/) });
  });

  it('a failed send is retried on the next sweep, and sent once', async () => {
    await raise('43000001', 'Column:c6');
    failNext = true;
    expect(await notifier.sweep()).toEqual({ sent: 0, noRecipient: 0, failed: 1 });
    const n = sent.length;
    expect(await notifier.sweep()).toEqual({ sent: 1, noRecipient: 0, failed: 0 });
    expect(sent).toHaveLength(n + 1);
    expect(await notifier.sweep()).toMatchObject({ sent: 0 });
  });

  it('two workers sweeping at the same moment send each event once', async () => {
    await raise('43000001', 'Column:c7');
    const other = new EmailNotifications({ tasks: new TaskNotifications(db as never, () => clock), mail, recipients, publicUrl: '', log });
    const n = sent.length;
    const [a, b] = [await notifier.sweep(), await other.sweep()];
    expect(a.sent + b.sent).toBe(1);
    expect(sent).toHaveLength(n + 1);
  });

  it('a task that is decided is not mailed any more', async () => {
    const e = await raise('43000001', 'Column:c8');
    await exceptions.decide(db as never, { id: e.id, decision: 'resolve', actor: '43000001' });
    const n = sent.length;
    expect(await notifier.sweep()).toMatchObject({ sent: 0 });
    expect(sent).toHaveLength(n);
  });
});

describe('U4: the SMTP sender and route notifications', () => {
  it('hands the message to the transport with sender, recipients and the event key', async () => {
    const transport = jsonTransport();
    const mailer = new SmtpMailer({ host: 'x', port: 25, secure: false, from: 'dmc@example.test', transport });
    let out: { messageId?: string; message?: string } = {};
    const orig = transport.sendMail.bind(transport);
    transport.sendMail = (async (o: never) => { out = (await orig(o)) as never; return out; }) as never;
    await mailer.send({ to: ['a@x.test', 'b@x.test'], subject: 'Hello', text: 'Body', key: 'assigned:1' });
    const m = JSON.parse(out.message!);
    expect(m).toMatchObject({ subject: 'Hello', text: 'Body', from: { address: 'dmc@example.test' }, to: [{ address: 'a@x.test' }, { address: 'b@x.test' }] });
    expect(JSON.stringify(m.headers)).toContain('assigned:1');
  });

  it('route notifications are logged and, where the route has addresses, mailed', async () => {
    const before = sent.length;
    await mailNotify(mail, recipients, log).send({ route: 'governance-lead', subjectRef: 'ledger/main', message: 'Ledger verification failed', actor: 'system/verifier' });
    await mailNotify(mail, recipients, log).send({ route: 'nobody', subjectRef: 'x', message: 'm', actor: 'a' });
    expect(sent).toHaveLength(before + 1);
    expect(sent.at(-1)).toMatchObject({ to: ['gov@example.test'], subject: '[DMC] ledger/main' });
  });

  it('the shipped configuration lists the routes and the local users’ addresses', () => {
    const c = loadRecipientConfig(root);
    expect(c.routes['platform-governance']).toBeDefined();
    expect(c.users.every((u) => typeof u.email === 'string')).toBe(true);
  });
});
