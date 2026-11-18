import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActionPort, ActionRequest, Signal } from '../packages/contracts/src/index';
import { provisionModule, migrateModule, loadRegistry } from '../packages/platform/src/index';
import { PolicyIndex, PolicyService, compilePolicy, loadPolicies } from '../packages/policy/src/index';
import { ExceptionService, MemoryScheduler, WorkflowEngine } from '../packages/workflow/src/index';
import { DecisionService, resolveAutonomy } from '../packages/decision/src/index';

const reg = loadRegistry(join(import.meta.dirname, '../metamodel/types'));
let server: EmbeddedPostgres;
let admin: pg.Client;
const client = (user: string, pw: string) => new pg.Client({ host: 'localhost', port: 54338, user, password: pw, database: 'postgres' });
let dDb: pg.Client, wDb: pg.Client, pDb: pg.Client;

const dispatched: ActionRequest[] = [];
let failActions = false;
const actions: ActionPort = {
  async dispatch(r) { if (failActions) throw new Error('adapter down'); dispatched.push(r); return { id: r.idempotencyKey }; },
};

const engine = new WorkflowEngine(new MemoryScheduler(), { resolve: async (rule, { context }) => `role:${rule === 'route' ? context.route : rule}` });
const exceptions = new ExceptionService(engine);
let svc: DecisionService;

const setNote = (id: string, mode: string, autonomy: string, confidence = 1, when = "dataset.name == 'x'") => compilePolicy(`policy: ${id}
control: c
mode: ${mode}
scope: { type: Dataset }
when: "${when}"
effect: { action: set_attribute, attribute: business_context, value: reviewed }
route: dataset-owner
autonomy: ${autonomy}
confidence: ${confidence}
`, reg, `${id}.yaml`);

const sig = (key: string, asset: Record<string, unknown>, type = 'Dataset', subject = 'node/ds-1', confidence?: number): Signal =>
  ({ source: 'test', key, kind: 'changed', subjectRef: subject, subjectType: type, asset, confidence });

beforeAll(async () => {
  server = new EmbeddedPostgres({ databaseDir: mkdtempSync(join(tmpdir(), 'dmc-dec-')), user: 'postgres', password: 'pw', port: 54338, persistent: false });
  await server.initialise(); await server.start();
  admin = client('postgres', 'pw'); await admin.connect();
  for (const m of ['decision', 'workflow', 'policy']) {
    await provisionModule(admin, m, { password: m });
    await migrateModule(admin, m, join(import.meta.dirname, `../packages/${m}/migrations`));
    await admin.query(`grant all on all tables in schema ${m} to dmc_${m}`);
  }
  dDb = client('dmc_decision', 'decision'); wDb = client('dmc_workflow', 'workflow'); pDb = client('dmc_policy', 'policy');
  await Promise.all([dDb.connect(), wDb.connect(), pDb.connect()]);
  await exceptions.install(wDb);
}, 120_000);
afterAll(async () => { try { await Promise.all([dDb?.end(), wDb?.end(), pDb?.end()]); await admin?.end(); } finally { await server?.stop(); } });

const build = (policies = loadPolicies(join(import.meta.dirname, '../policies'), reg, 'local')) =>
  new DecisionService({
    policies: new PolicyService(pDb, new PolicyIndex(policies)),
    exceptions: {
      raise: (r) => exceptions.raise(wDb, r),
      withdraw: (r) => exceptions.withdraw(wDb, r),
    },
    actions,
  });
const decisions = async (subject: string) => (await admin.query(
  `select d.policy_id, d.outcome, d.status, d.mode from decision.decision d join decision.signal s on s.id = d.signal_id where s.subject_ref = $1 order by d.decided_at, d.policy_id`, [subject])).rows;

describe('D1: decision worker', () => {
  it('resolves autonomy as min(ceiling, level allowed by confidence), capped for irreversible effects', () => {
    expect(resolveAutonomy('act', 1)).toBe('act');
    expect(resolveAutonomy('act', 0.85)).toBe('act_notify');
    expect(resolveAutonomy('act', 0.6)).toBe('propose');
    expect(resolveAutonomy('act', 0.3)).toBe('drop');
    expect(resolveAutonomy('propose', 1)).toBe('propose');
    expect(resolveAutonomy('act', 1, { reversible: false })).toBe('propose');
  });

  it('act: a state change is dispatched as an action, once, and evidenced', async () => {
    svc = build([setNote('p-act', 'enforced', 'act')]);
    const r = await svc.handle(dDb, sig('s1', { name: 'x', qualified_name: 'ds.1' }));
    expect(r.decisions).toMatchObject([{ policy_id: 'p-act', outcome: 'act', status: 'applied' }]);
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({ policyId: 'p-act', notify: false, subjectRef: 'node/ds-1' });
    const ev = await admin.query("select event_type from decision.outbox order by id");
    expect(ev.rows.map((x) => x.event_type)).toEqual(expect.arrayContaining(['signal.received', 'decision.made', 'decision.applied']));
  });

  it('act_notify dispatches with notify; propose raises a task on the policy route instead of changing anything', async () => {
    dispatched.length = 0;
    svc = build([setNote('p-an', 'enforced', 'act_notify'), setNote('p-pr', 'enforced', 'propose')]);
    await svc.handle(dDb, sig('s2', { name: 'x' }, 'Dataset', 'node/ds-2'));
    expect(dispatched).toMatchObject([{ policyId: 'p-an', notify: true }]); // only the act_notify policy dispatched
    const [ex] = await exceptions.list(wDb, { subjectRef: 'node/ds-2' });
    expect(ex).toMatchObject({ kind: 'proposal:set_attribute', route: 'dataset-owner', policy_id: 'p-pr', status: 'open' });
  });

  it('drop: low confidence is recorded and nothing happens', async () => {
    dispatched.length = 0;
    svc = build([setNote('p-low', 'enforced', 'act', 0.2)]);
    const r = await svc.handle(dDb, sig('s3', { name: 'x' }, 'Dataset', 'node/ds-3'));
    expect(r.decisions[0]).toMatchObject({ outcome: 'drop', status: 'none' });
    expect(dispatched).toHaveLength(0);
    expect(await exceptions.list(wDb, { subjectRef: 'node/ds-3' })).toHaveLength(0);
  });

  it('shadow: results are stored, no exception and no action', async () => {
    dispatched.length = 0;
    svc = build([setNote('p-sh', 'shadow', 'act')]);
    const r = await svc.handle(dDb, sig('s4', { name: 'x' }, 'Dataset', 'node/ds-4'));
    expect(r.decisions[0]).toMatchObject({ outcome: 'shadow', mode: 'shadow', status: 'none' });
    expect(dispatched).toHaveLength(0);
    const s = await admin.query("select matched from policy.shadow_result where policy_id = 'p-sh' and subject_ref = 'node/ds-4'");
    expect(s.rows[0].matched).toBe(true);
  });

  it('a signal delivered twice is decided once', async () => {
    dispatched.length = 0;
    svc = build([setNote('p-dup', 'enforced', 'act')]);
    const s = sig('s5', { name: 'x' }, 'Dataset', 'node/ds-5');
    const a = await svc.handle(dDb, s);
    const b = await svc.handle(dDb, s);
    expect(b.replayed).toBe(true);
    expect(b.signalId).toBe(a.signalId);
    expect(dispatched).toHaveLength(1);
    expect(await decisions('node/ds-5')).toHaveLength(1);
  });

  it('a failed dispatch is kept and finished by resume, without deciding again', async () => {
    dispatched.length = 0;
    svc = build([setNote('p-fail', 'enforced', 'act')]);
    failActions = true;
    const r = await svc.handle(dDb, sig('s6', { name: 'x' }, 'Dataset', 'node/ds-6'));
    expect(r.decisions[0]).toMatchObject({ status: 'failed', attempts: 1 });
    failActions = false;
    expect(await svc.resume(dDb)).toBeGreaterThanOrEqual(1);
    expect((await decisions('node/ds-6'))[0]).toMatchObject({ status: 'applied' });
    expect(dispatched).toHaveLength(1);
  });

  it('an exception is raised for a matching raise_exception policy, and withdrawn when it stops matching', async () => {
    svc = build(); // example policies: integration-has-dataset is shadow locally, application-has-owner is enforced
    const bad = sig('s7', { qualified_name: 'servicenow.APP9', name: 'Pay' }, 'Application', 'node/app-9');
    await svc.handle(dDb, bad);
    const [ex] = await exceptions.list(wDb, { subjectRef: 'node/app-9' });
    expect(ex).toMatchObject({ policy_id: 'application-has-owner', status: 'open', route: 'platform-governance' });
    await svc.handle(dDb, sig('s8', { qualified_name: 'servicenow.APP9', owner: 'alice@x' }, 'Application', 'node/app-9'));
    expect((await exceptions.get(wDb, ex!.id))!.status).toBe('withdrawn');
    expect((await decisions('node/app-9')).map((d) => d.outcome)).toEqual(expect.arrayContaining(['act_notify', 'cleared']));
  });

  it('an evaluation error is recorded as an error decision and does nothing', async () => {
    svc = build();
    const r = await svc.handle(dDb, sig('s9', { qualified_name: 'servicenow.INT1' }, 'Integration', 'node/int-1')); // missing edge
    expect(r.decisions.find((d) => d.policy_id === 'integration-has-dataset')).toMatchObject({ outcome: 'shadow' });
    const svc2 = build(loadPolicies(join(import.meta.dirname, '../policies'), reg, 'local').map((p) => ({ ...p, mode: 'enforced' as const })));
    const r2 = await svc2.handle(dDb, sig('s10', { qualified_name: 'servicenow.INT1' }, 'Integration', 'node/int-1'));
    expect(r2.decisions.find((d) => d.policy_id === 'integration-has-dataset')).toMatchObject({ outcome: 'error', status: 'none' });
  });
});

describe('D4: apply_change', () => {
  const applyPolicy = (id: string, autonomy: string) => compilePolicy(`policy: ${id}
control: c
mode: enforced
scope: { type: Dataset }
when: "dataset.name == 'x'"
effect: { action: apply_change }
route: dataset-owner
autonomy: ${autonomy}
`, reg, `${id}.yaml`);
  const write = (key: string, actor: string, subject: string): Signal =>
    ({ ...sig(key, { name: 'x', qualified_name: `ds.${key}` }, 'Dataset', subject), kind: 'write.proposed', actor, change: { attribute: 'business_context', value: 'new text' } });

  it('with autonomy act, the proposed write is applied through the action port', async () => {
    dispatched.length = 0;
    svc = build([applyPolicy('p-apply', 'act')]);
    const r = await svc.handle(dDb, write('w1', 'agent:doc-bot', 'node/ds-d4a'));
    expect(r.decisions).toMatchObject([{ outcome: 'act', status: 'applied' }]);
    expect(dispatched[0]).toMatchObject({ subjectRef: 'node/ds-d4a', effect: { action: 'apply_change', attribute: 'business_context', value: 'new text' } });
  });

  it('with autonomy propose, nothing is written and a review task is raised', async () => {
    dispatched.length = 0;
    svc = build([applyPolicy('p-apply2', 'propose')]);
    const r = await svc.handle(dDb, write('w2', 'agent:doc-bot', 'node/ds-d4b'));
    expect(r.decisions).toMatchObject([{ outcome: 'propose', status: 'applied' }]);
    expect(dispatched).toHaveLength(0);
    const ex = await exceptions.list(wDb, { subjectRef: 'node/ds-d4b' });
    expect(ex[0]).toMatchObject({ kind: 'proposal:apply_change' });
    expect(JSON.stringify(ex[0])).toContain('business_context');
  });

  it('the same signal twice is decided once', async () => {
    svc = build([applyPolicy('p-apply3', 'act')]);
    dispatched.length = 0;
    await svc.handle(dDb, write('w3', 'user:alice', 'node/ds-d4c'));
    const again = await svc.handle(dDb, write('w3', 'user:alice', 'node/ds-d4c'));
    expect(again.replayed).toBe(true);
    expect(dispatched).toHaveLength(1);
  });
});
