import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRegistry, migrateModule, provisionModule } from '../packages/platform/src/index';
import { CatalogStore } from '../packages/catalog/src/index';
import { MemoryScheduler, QUEUES, WorkflowEngine, WorkflowInbox, routeResolver } from '../packages/workflow/src/index';
import { ScopeLinkTasks } from '../apps/worker/src/index';

const root = join(import.meta.dirname, '..');
const store = new CatalogStore(loadRegistry(join(root, 'metamodel/types')));
let server: EmbeddedPostgres; let admin: pg.Client; let cat: pg.Client; let wf: pg.Client;
const sched = new MemoryScheduler();
let clock = new Date('2026-11-17T09:00:00Z');
const engine = new WorkflowEngine(sched, routeResolver, () => clock);
let sweeper: ScopeLinkTasks; let inbox: WorkflowInbox;
const sn = { kind: 'sync', source: 'servicenow' } as const;
const node = (type: string, qn: string, attributes: Record<string, unknown>, writer: { kind: 'sync'; source: string } | { kind: 'user' } = sn) => store.tx(cat, () => store.applyNode(cat, { type, qualifiedName: qn, attributes, writer, actor: 'test' }));
const instances = async () => (await admin.query("select context->>'app' as app, context->>'route' as route, (context->>'version')::int as version, status from workflow.instance where name = 'scope-links' order by 1, 3")).rows;

beforeAll(async () => {
  server = new EmbeddedPostgres({ databaseDir: mkdtempSync(join(tmpdir(), 'dmc-sl-')), user: 'postgres', password: 'pw', port: 54350, persistent: false });
  await server.initialise(); await server.start();
  admin = new pg.Client({ host: 'localhost', port: 54350, user: 'postgres', password: 'pw', database: 'postgres' });
  await admin.connect();
  for (const m of ['catalog', 'workflow']) {
    await provisionModule(admin, m, { password: m });
    await migrateModule(admin, m, join(root, `packages/${m}/migrations`));
    await admin.query(`grant all on all tables in schema ${m} to dmc_${m}`); await admin.query(`grant all on all sequences in schema ${m} to dmc_${m}`);
  }
  const client = (m: string) => new pg.Client({ host: 'localhost', port: 54350, user: `dmc_${m}`, password: m, database: 'postgres' });
  cat = client('catalog'); wf = client('workflow'); await cat.connect(); await wf.connect();
  await engine.registerDefinition(wf, readFileSync(join(root, 'workflows/scope-links.yaml'), 'utf8'));
  sweeper = new ScopeLinkTasks(store, engine, { catalog: cat, workflow: wf });
  inbox = new WorkflowInbox(engine, async () => ({ query: (s: string, p?: unknown[]) => wf.query(s, p) as never, release() {} }));

  await node('Scope', 's1', { name: 'PRA110', owner: 'olive', kind: 'report' }, { kind: 'sync', source: 'scope-sources' });
  for (const [qn, o] of [['app-a', 'amy'], ['app-b', 'ben']] as const) await node('Application', qn, { name: qn, owner: o, hosting_country: 'GB', criticality: 'low' });
  await node('Integration', 'int-1', { status: 'live' });
  await store.tx(cat, async () => {
    await store.link(cat, { name: 'source_of', fromQn: 'app-a', toQn: 'int-1', source: 'servicenow', actor: 't' });
    await store.link(cat, { name: 'target_of', fromQn: 'app-b', toQn: 'int-1', source: 'servicenow', actor: 't' });
    await store.link(cat, { name: 'flows_through', fromQn: 's1', toQn: 'int-1', source: 'dmc', actor: 't' });
  });
}, 120_000);
afterAll(async () => { try { await cat?.end(); await wf?.end(); await admin?.end(); } finally { await server?.stop(); } });

describe('C3: link tasks', () => {
  it('opens nothing until the scope is submitted', async () => {
    expect(await sweeper.sweep()).toEqual({ opened: 0, withdrawn: 0 });
  });

  it('opens one task per application on the flows when it is submitted, routed to each app owner, and only once', async () => {
    await node('Scope', 's1', { version: 1, status: 'submitted' }, { kind: 'user' });
    expect(await sweeper.sweep()).toEqual({ opened: 2, withdrawn: 0 });
    expect(await instances()).toEqual([
      { app: 'app-a', route: 'amy', version: 1, status: 'running' },
      { app: 'app-b', route: 'ben', version: 1, status: 'running' },
    ]);
    expect(await sweeper.sweep()).toEqual({ opened: 0, withdrawn: 0 });
    const mine = await inbox.list(['amy']);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ title: 'Link your tables and columns to this scope', subjectRef: 'Scope:s1' });
    expect([...mine[0]!.decisions].sort()).toEqual(['done', 'none_held']);
    expect(mine[0]!.message).toContain('app-a');
  });

  it('the owner decides; it shows in the task status', async () => {
    const [a] = await inbox.list(['amy']);
    await inbox.decide({ taskId: a!.id, decision: 'done', actor: 'amy', assignees: ['amy'] });
    await expect(inbox.decide({ taskId: (await inbox.list(['ben']))[0]!.id, decision: 'done', actor: 'amy', assignees: ['amy'] })).rejects.toMatchObject({ code: 'forbidden' });
    const st = await inbox.forSubject('Scope:s1', 'scope-links');
    expect(st.map((t) => [t.context.app, t.status])).toEqual(expect.arrayContaining([['app-a', 'done'], ['app-b', 'open']]));
  });

  it('an overdue task escalates to the scope owner', async () => {
    clock = new Date('2026-12-01T09:00:01Z');
    const timers = sched.jobs.filter((j) => j.queue === QUEUES.timer);
    expect(timers.length).toBeGreaterThan(0);
    for (const t of timers) await engine.onTimer(wf, (t.payload as { stepRunId: string }).stepRunId);
    const open = await inbox.list(['olive']);
    expect(open.map((i) => [i.subjectRef, i.escalated])).toEqual([['Scope:s1', true]]);
  });

  it('an amendment withdraws the open tasks; submitting again opens them for the new version', async () => {
    await node('Scope', 's1', { version: 2, status: 'amended' }, { kind: 'user' });
    const r = await sweeper.sweep();
    expect(r.withdrawn).toBe(1);
    expect((await inbox.list(['olive']))).toEqual([]);
    await node('Scope', 's1', { status: 'submitted' }, { kind: 'user' });
    expect((await sweeper.sweep()).opened).toBe(2);
    expect((await instances()).filter((i) => i.version === 2)).toHaveLength(2);
    const v2 = (await inbox.forSubject('Scope:s1', 'scope-links')).filter((t) => t.context.version === 2 && t.status === 'open');
    expect(v2).toHaveLength(2);
    const [b2] = await inbox.list(['ben']);
    await inbox.decide({ taskId: b2!.id, decision: 'none_held', actor: 'ben', assignees: ['ben'] });
    expect((await inbox.forSubject('Scope:s1', 'scope-links')).find((t) => t.context.app === 'app-b' && t.context.version === 2)).toMatchObject({ status: 'done', decision: 'none_held' });
  });
});
