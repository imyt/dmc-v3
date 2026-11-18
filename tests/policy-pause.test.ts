import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadRegistry, migrateModule, provisionModule } from '../packages/platform/src/index';
import { PolicyControl, PolicyIndex, PolicyService, compilePolicy } from '../packages/policy/src/index';
import { DecisionService } from '../packages/decision/src/index';
import type { Signal } from '../packages/contracts/src/index';

const root = join(import.meta.dirname, '..');
const reg = loadRegistry(join(root, 'metamodel/types'));
let server: EmbeddedPostgres; let admin: pg.Client; let pol: pg.Client; let dec: pg.Client;
const raised: string[] = []; const withdrawn: string[] = [];
const index = new PolicyIndex([compilePolicy(readFileSync(join(root, 'policies/examples/application-has-owner.yaml'), 'utf8'), reg, 'application-has-owner.yaml')]);
const service = new DecisionService({
  policies: new PolicyService({ query: (s: string, p?: unknown[]) => pol.query(s, p) as never }, index),
  exceptions: { async raise(r) { raised.push(r.subjectRef); return { id: 'x', created: true }; }, async withdraw(r) { withdrawn.push(r.subjectRef); return true; } },
  actions: { async dispatch() { return { status: 'done' } as never; } } as never,
});
let n = 0;
const signal = (ref: string, asset: Record<string, unknown>): Signal => ({ source: 'test', key: `k${++n}`, kind: 'sync.upsert', subjectRef: ref, subjectType: 'Application', asset, actor: 't' });
const control = () => new PolicyControl(pol as never);

beforeAll(async () => {
  server = new EmbeddedPostgres({ databaseDir: mkdtempSync(join(tmpdir(), 'dmc-pp-')), user: 'postgres', password: 'pw', port: 54402, persistent: false });
  await server.initialise(); await server.start();
  admin = new pg.Client({ host: 'localhost', port: 54402, user: 'postgres', password: 'pw', database: 'postgres' });
  await admin.connect();
  for (const m of ['policy', 'decision']) {
    await provisionModule(admin, m, { password: m });
    await migrateModule(admin, m, join(root, `packages/${m}/migrations`));
    await admin.query(`grant all on all tables in schema ${m} to dmc_${m}`); await admin.query(`grant all on all sequences in schema ${m} to dmc_${m}`);
  }
  pol = new pg.Client({ host: 'localhost', port: 54402, user: 'dmc_policy', password: 'policy', database: 'postgres' });
  dec = new pg.Client({ host: 'localhost', port: 54402, user: 'dmc_decision', password: 'decision', database: 'postgres' });
  await pol.connect(); await dec.connect();
}, 120_000);
afterAll(async () => { try { await pol?.end(); await dec?.end(); await admin?.end(); } finally { await server?.stop(); } });

const decide = async (ref: string, asset: Record<string, unknown>) => (await service.handle(dec as never, signal(ref, asset))).decisions[0]!;
const outbox = async () => (await admin.query("select event_type, subject_ref, actor from policy.outbox order by id")).rows;

describe('U2: pausing enforcement', () => {
  it('an enforced policy raises its exception', async () => {
    expect(await decide('Application:a1', { name: 'A', owner: '' })).toMatchObject({ mode: 'enforced', outcome: 'act_notify' });
    expect(raised).toEqual(['Application:a1']);
    expect(await control().state()).toEqual({ enforcementPaused: false, pausedPolicies: [] });
  });

  it('while paused it is judged as shadow: recorded, nothing raised or cleared', async () => {
    expect(await control().setEnforcement(true, 'anil')).toBe(true);
    expect(await control().setEnforcement(true, 'anil')).toBe(false);   // already so: nothing written
    expect(await decide('Application:a2', { name: 'B', owner: '' })).toMatchObject({ mode: 'shadow', outcome: 'shadow', status: 'none' });
    expect(await decide('Application:a1', { name: 'A', owner: 'amy' })).toMatchObject({ mode: 'shadow', outcome: 'shadow' });   // would have cleared; paused, so it leaves the exception alone
    expect(raised).toEqual(['Application:a1']);
    expect(withdrawn).toEqual([]);
    const shadow = (await admin.query("select subject_ref, matched from policy.shadow_result where policy_id = 'application-has-owner' order by subject_ref")).rows;
    expect(shadow).toEqual([{ subject_ref: 'Application:a1', matched: false }, { subject_ref: 'Application:a2', matched: true }]);
  });

  it('resuming brings enforcement back', async () => {
    expect(await control().setEnforcement(false, 'anil')).toBe(true);
    expect(await decide('Application:a3', { name: 'C', owner: '' })).toMatchObject({ mode: 'enforced', outcome: 'act_notify' });
    expect(raised).toEqual(['Application:a1', 'Application:a3']);
  });

  it('one policy can be paused alone', async () => {
    await control().setPolicy('application-has-owner', true, 'carl');
    expect(await control().state()).toEqual({ enforcementPaused: false, pausedPolicies: ['application-has-owner'] });
    expect(await decide('Application:a4', { name: 'D', owner: '' })).toMatchObject({ mode: 'shadow', outcome: 'shadow' });
    await control().setPolicy('application-has-owner', false, 'carl');
    expect(await decide('Application:a5', { name: 'E', owner: '' })).toMatchObject({ mode: 'enforced' });
  });

  it('every change is in the policy outbox, so it reaches the ledger', async () => {
    expect(await outbox()).toEqual([
      { event_type: 'policy.enforcement.paused', subject_ref: 'control/enforcement', actor: 'anil' },
      { event_type: 'policy.enforcement.resumed', subject_ref: 'control/enforcement', actor: 'anil' },
      { event_type: 'policy.paused', subject_ref: 'Policy:application-has-owner', actor: 'carl' },
      { event_type: 'policy.resumed', subject_ref: 'Policy:application-has-owner', actor: 'carl' },
    ]);
  });
});
