import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActionRequest, CatalogWritePort, RaiseExceptionRequest } from '../packages/contracts/src/index';
import { provisionModule, migrateModule } from '../packages/platform/src/index';
import { ActionService } from '../packages/actions/src/index';

let server: EmbeddedPostgres;
let admin: pg.Client;
let db: pg.Client;

// a tiny in-memory catalog
const values = new Map<string, unknown>();
const sources: Record<string, string> = { business_context: 'dmc', owner: 'servicenow', classification: 'classifier' };
const catalog: CatalogWritePort = {
  async getAttribute(s, a) { return values.get(`${s}|${a}`); },
  async setAttribute(s, a, v) { const k = `${s}|${a}`; const previous = values.get(k); values.set(k, v); return { previous, changed: previous !== v }; },
  async sourceOf(_s, a) { return sources[a]; },
};
const sent: string[] = [];
const tasks: { route: string; attribute: string; expected: unknown }[] = [];
const raised: RaiseExceptionRequest[] = [];
const withdrawn: { policyId: string; subjectRef: string }[] = [];
const svc = () => new ActionService(db, {
  catalog,
  exceptions: { async raise(r) { raised.push(r); return { id: `e${raised.length}`, created: true }; }, async withdraw(w) { withdrawn.push(w); return true; } },
  notify: { async send(r) { sent.push(`${r.route}:${r.subjectRef}`); } },
  tasks: { async create(r) { tasks.push({ route: r.route, attribute: r.attribute, expected: r.expected }); return { id: `t${tasks.length}` }; } },
});
let n = 0;
const req = (over: Partial<ActionRequest> = {}): ActionRequest => ({
  idempotencyKey: `k${++n}`, decisionId: `d${n}`, policyId: 'p-1', subjectRef: 'node/ds-1',
  effect: { action: 'set_attribute', attribute: 'business_context', value: 'reviewed' }, notify: false, route: 'dataset-owner', ...over,
});
const row = async (id: string) => (await admin.query('select * from actions.action where id = $1', [id])).rows[0];

beforeAll(async () => {
  server = new EmbeddedPostgres({ databaseDir: mkdtempSync(join(tmpdir(), 'dmc-act-')), user: 'postgres', password: 'pw', port: 54339, persistent: false });
  await server.initialise(); await server.start();
  admin = new pg.Client({ host: 'localhost', port: 54339, user: 'postgres', password: 'pw', database: 'postgres' });
  await admin.connect();
  await provisionModule(admin, 'actions', { password: 'act' });
  await migrateModule(admin, 'actions', join(import.meta.dirname, '../packages/actions/migrations'));
  await admin.query('grant all on all tables in schema actions to dmc_actions');
  db = new pg.Client({ host: 'localhost', port: 54339, user: 'dmc_actions', password: 'act', database: 'postgres' });
  await db.connect();
}, 120_000);
afterAll(async () => { try { await db?.end(); await admin?.end(); } finally { await server?.stop(); } });

describe('D2: actions', () => {
  it('applies a DMC-side change and undo restores the prior state', async () => {
    values.set('node/ds-1|business_context', 'draft');
    const { id } = await svc().dispatch(req());
    expect(values.get('node/ds-1|business_context')).toBe('reviewed');
    expect(await row(id)).toMatchObject({ status: 'done', kind: 'dmc_change', undo: { attribute: 'business_context', previous: 'draft', applied: 'reviewed' } });
    await svc().undo(id, 'user:alice');
    expect(values.get('node/ds-1|business_context')).toBe('draft');
    expect(await row(id)).toMatchObject({ status: 'undone', undone_by: 'user:alice' });
    await svc().undo(id, 'user:alice'); // undoing twice is harmless
  });

  it('undo is refused when the value changed since, and for actions that cannot be undone', async () => {
    values.set('node/ds-2|business_context', 'a');
    const { id } = await svc().dispatch(req({ subjectRef: 'node/ds-2' }));
    values.set('node/ds-2|business_context', 'edited by a person');
    await expect(svc().undo(id, 'u')).rejects.toMatchObject({ code: 'conflict' });
    expect(values.get('node/ds-2|business_context')).toBe('edited by a person');
    const n = await svc().dispatch(req({ effect: { action: 'notify', message: 'hi' } }));
    await expect(svc().undo(n.id, 'u')).rejects.toMatchObject({ code: 'conflict' });
  });

  it('the same idempotency key does it once', async () => {
    const r = req({ subjectRef: 'node/ds-3' });
    const a = await svc().dispatch(r);
    values.set('node/ds-3|business_context', 'changed later');
    const b = await svc().dispatch(r);
    expect(b.id).toBe(a.id);
    expect(values.get('node/ds-3|business_context')).toBe('changed later'); // not applied again
  });

  it('a kill switch stops dispatch and records the action as blocked; release and retry finish it', async () => {
    const s = svc();
    await s.pause('policy:p-stop', 'bad data in source', 'user:admin');
    const r = req({ policyId: 'p-stop', subjectRef: 'node/ds-4' });
    const { id } = await s.dispatch(r);
    expect(await row(id)).toMatchObject({ status: 'blocked', switch_scope: 'policy:p-stop' });
    expect(values.has('node/ds-4|business_context')).toBe(false);
    expect(await s.retryBlocked()).toBe(0); // still paused
    await s.release('policy:p-stop', 'user:admin');
    expect(await s.retryBlocked()).toBe(1);
    expect(values.get('node/ds-4|business_context')).toBe('reviewed');
    expect((await row(id)).status).toBe('done');
  });

  it('"all" and per-effect switches work too, and are evidenced', async () => {
    const s = svc();
    await s.pause('all', 'incident 42', 'user:admin');
    expect((await row((await s.dispatch(req({ subjectRef: 'node/ds-5' }))).id)).status).toBe('blocked');
    await s.release('all', 'user:admin');
    await s.pause('effect:notify', 'mail relay down', 'user:admin');
    expect((await row((await s.dispatch(req({ effect: { action: 'notify', message: 'x' } }))).id)).status).toBe('blocked');
    expect((await row((await s.dispatch(req({ subjectRef: 'node/ds-6' }))).id)).status).toBe('done'); // other effects still run
    await s.release('effect:notify', 'user:admin');
    const ev = await admin.query("select distinct event_type from actions.outbox");
    expect(ev.rows.map((x) => x.event_type)).toEqual(expect.arrayContaining(['switch.paused', 'switch.released', 'action.blocked', 'action.done', 'action.undone']));
  });

  it('a classification becomes a task for the owning tool, with a pending change to confirm on sync', async () => {
    const { id } = await svc().dispatch(req({ subjectRef: 'node/col-1', effect: { action: 'classify', concept: 'PII', message: 'Classify as PII' } }));
    expect(await row(id)).toMatchObject({ status: 'pending_confirmation', kind: 'tool_task' });
    expect(tasks.at(-1)).toMatchObject({ route: 'dataset-owner', attribute: 'PII' });
    const pc = await admin.query('select state, subject_ref from actions.pending_change where action_id = $1', [id]);
    expect(pc.rows).toEqual([{ state: 'pending', subject_ref: 'node/col-1' }]);
  });

  it('refuses to write an attribute owned by another source, and a retry is possible', async () => {
    const r = req({ subjectRef: 'node/ds-7', effect: { action: 'set_attribute', attribute: 'owner', value: 'x' } });
    await expect(svc().dispatch(r)).rejects.toMatchObject({ code: 'validation_failed' });
    expect((await admin.query('select status from actions.action where idempotency_key = $1', [r.idempotencyKey])).rows[0].status).toBe('failed');
  });

  it('notify=true also tells the route', async () => {
    sent.length = 0;
    await svc().dispatch(req({ subjectRef: 'node/ds-8', notify: true }));
    expect(sent).toEqual(['dataset-owner:node/ds-8']);
  });
});

describe('D3: confirm on sync, else escalate', () => {
  const dispatchTask = async (escalateAfter = '10d', attr = 'classification', value: unknown = 'restricted', subjectRef = 'node/app-1') => {
    raised.length = 0; withdrawn.length = 0;
    return svc().dispatch(req({ subjectRef, escalateAfter, effect: { action: 'classify', attribute: attr, value }, route: 'classification-admins' }));
  };
  const pending = async (id: string) => (await admin.query('select p.* from actions.pending_change p where p.action_id = $1', [id])).rows[0];

  it('stores the deadline from the policy when it creates the task', async () => {
    const before = Date.now();
    const { id } = await dispatchTask('2d');
    const p = await pending(id);
    expect(p.state).toBe('pending');
    expect(p.due_by.getTime() - before).toBeGreaterThan(2 * 86_400_000 - 5_000);
    expect(p.due_by.getTime() - before).toBeLessThan(2 * 86_400_000 + 60_000);
  });

  it('a sync that shows the expected value from the owning source confirms the change', async () => {
    const { id } = await dispatchTask('10d', 'classification', 'restricted', 'node/app-2');
    expect((await svc().confirmOnSync('classifier', [{ subjectRef: 'node/app-2', attributes: { classification: 'public' } }])).confirmed).toBe(0);
    expect((await pending(id)).state).toBe('pending'); // value still differs
    expect((await svc().confirmOnSync('git', [{ subjectRef: 'node/app-2', attributes: { classification: 'restricted' } }])).confirmed).toBe(0); // not the owning source
    expect((await svc().confirmOnSync('classifier', [{ subjectRef: 'node/app-2', attributes: { classification: 'restricted' } }])).confirmed).toBe(1);
    expect(await pending(id)).toMatchObject({ state: 'confirmed' });
    expect(await row(id)).toMatchObject({ status: 'done' });
    expect((await admin.query("select 1 from actions.outbox where event_type = 'action.confirmed' and subject_ref = 'node/app-2'")).rowCount).toBe(1);
    expect((await svc().confirmOnSync('classifier', [{ subjectRef: 'node/app-2', attributes: { classification: 'restricted' } }])).confirmed).toBe(0); // replay is harmless
  });

  it('escalates at the deadline, once, to the route that owns the tool', async () => {
    const { id } = await dispatchTask('1d', 'classification', 'restricted', 'node/app-3');
    const later = new Date(Date.now() + 25 * 3_600_000);
    expect(await svc().escalateOverdue(new Date(Date.now() + 3_600_000))).toBe(0); // not due yet
    expect(await svc().escalateOverdue(later)).toBe(1);
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({ kind: 'pending_change.overdue', route: 'classification-admins', subjectRef: 'node/app-3', policyId: 'p-1' });
    expect((await pending(id)).state).toBe('escalated');
    expect(await svc().escalateOverdue(later)).toBe(0); // already escalated
    expect(raised).toHaveLength(1);
  });

  it('an escalated change that is later confirmed withdraws its exception', async () => {
    await dispatchTask('1d', 'classification', 'restricted', 'node/app-4');
    await svc().escalateOverdue(new Date(Date.now() + 25 * 3_600_000));
    await svc().confirmOnSync('classifier', [{ subjectRef: 'node/app-4', attributes: { classification: 'restricted' } }]);
    expect(withdrawn).toEqual([expect.objectContaining({ policyId: 'p-1', subjectRef: 'node/app-4' })]);
  });

  it('changes with no deadline are never escalated', async () => {
    const { id } = await dispatchTask('', 'classification', 'restricted', 'node/app-5');
    expect((await pending(id)).due_by).toBeNull();
    await svc().escalateOverdue(new Date(Date.now() + 365 * 86_400_000));
    expect((await pending(id)).state).toBe('pending');
  });
});

