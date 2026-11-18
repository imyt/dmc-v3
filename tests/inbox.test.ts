import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { provisionModule, migrateModule } from '../packages/platform/src/index';
import { ExceptionService, MemoryScheduler, WorkflowEngine, WorkflowInbox } from '../packages/workflow/src/index';

let server: EmbeddedPostgres; let admin: pg.Client; let pool: pg.Pool;
const clock = new Date('2026-11-17T09:00:00Z');
const engine = new WorkflowEngine(new MemoryScheduler(), { resolve: async (_rule, { context }) => String(context.route) }, () => clock);
const svc = new ExceptionService(engine);
let inbox: WorkflowInbox;
const raise = async (subject: string, route: string, extra: Record<string, unknown> = {}) => {
  const c = await pool.connect();
  try { return await svc.raise(c, { kind: 'missing-owner', severity: 'high', subjectRef: subject, message: `Fix ${subject}`, route, policyId: `p-${subject}`, actor: 'system/decision', ...extra }); } finally { c.release(); }
};

beforeAll(async () => {
  server = new EmbeddedPostgres({ databaseDir: mkdtempSync(join(tmpdir(), 'dmc-inbox-')), user: 'postgres', password: 'pw', port: 54347, persistent: false });
  await server.initialise(); await server.start();
  admin = new pg.Client({ host: 'localhost', port: 54347, user: 'postgres', password: 'pw', database: 'postgres' });
  await admin.connect();
  await provisionModule(admin, 'workflow', { password: 'wf' });
  await migrateModule(admin, 'workflow', join(import.meta.dirname, '../packages/workflow/migrations'));
  await admin.query('grant all on all tables in schema workflow to dmc_workflow');
  pool = new pg.Pool({ host: 'localhost', port: 54347, user: 'dmc_workflow', password: 'wf', database: 'postgres', max: 3 });
  const c = await pool.connect(); try { await svc.install(c); } finally { c.release(); }
  inbox = new WorkflowInbox(engine, async () => { const x = await pool.connect(); return { query: (s: string, p?: unknown[]) => x.query(s, p) as never, release: () => x.release() }; });
}, 120_000);
afterAll(async () => { try { await pool?.end(); await admin?.end(); } finally { await server?.stop(); } });

describe('W2: inbox', () => {
  it('lists what is assigned to the person or to their groups, with the context to decide', async () => {
    await raise('a', 'alice');
    await raise('b', 'stewards');
    await raise('c', 'bob');
    const mine = await inbox.list(['alice', 'stewards']);
    expect(mine.map((i) => i.subjectRef).sort()).toEqual(['a', 'b']);
    expect(mine[0]).toMatchObject({ kind: 'missing-owner', severity: 'high', title: 'Resolve or accept this exception', escalated: false });
    expect([...mine[0]!.decisions].sort()).toEqual(['accept_risk', 'dismiss', 'resolve']);
    expect(mine.find((i) => i.subjectRef === 'a')!.message).toBe('Fix a');
    expect(await inbox.list([])).toEqual([]);
  });

  it('puts the one due first', async () => {
    await raise('late', 'dana', { escalateAfter: '10d' });
    await raise('early', 'dana', { escalateAfter: '1d' });
    expect((await inbox.list(['dana'])).map((i) => i.subjectRef)).toEqual(['early', 'late']);
  });

  it('lets a group member decide, once, and the task leaves the queue', async () => {
    const [t] = await inbox.list(['stewards']);
    expect(await inbox.decide({ taskId: t!.id, decision: 'resolve', actor: 'carol', assignees: ['carol', 'stewards'], key: 'k-1' })).toEqual({ replayed: false });
    expect(await inbox.decide({ taskId: t!.id, decision: 'resolve', actor: 'carol', assignees: ['carol', 'stewards'], key: 'k-1' })).toEqual({ replayed: true });
    expect(await inbox.list(['stewards'])).toEqual([]);
    expect(await inbox.get(t!.id)).toBeUndefined();
  });

  it('refuses someone it is not assigned to, and a decision the step does not offer', async () => {
    const [t] = await inbox.list(['bob']);
    await expect(inbox.decide({ taskId: t!.id, decision: 'resolve', actor: 'mallory', assignees: ['mallory'] })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(inbox.decide({ taskId: t!.id, decision: 'maybe', actor: 'bob', assignees: ['bob'] })).rejects.toMatchObject({ code: 'validation_failed' });
    expect(await inbox.list(['bob'])).toHaveLength(1);
  });
});
