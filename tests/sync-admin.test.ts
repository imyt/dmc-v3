import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import { PgBoss } from 'pg-boss';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Authz, loadRegistry, migrateModule, provisionModule } from '../packages/platform/src/index';
import { CatalogStore } from '../packages/catalog/src/index';
import { checkResponse, loadSpec } from '../packages/contracts/src/index';
import { SyncAdmin } from '../packages/connectors/src/index';
import { createApi, devAuthenticator } from '../apps/api/src/index';

// S12: the sync admin API. Requirement refs: SEN-6 (change limit pause and review), system design "Admin screen: jobs per environment, last run, counts, errors, run now, pause".
const root = join(import.meta.dirname, '..');
const registry = loadRegistry(join(root, 'metamodel/types'));
const spec = loadSpec();
const PORT = 54600;
let server: EmbeddedPostgres; let admin: pg.Client; let pool: pg.Pool; let boss: PgBoss; let app: NestFastifyApplication;
const idem = new Map<string, { bodyHash: string; response: unknown }>();
const as = (u: string, groups = '') => ({ 'x-dmc-user': u, 'x-dmc-groups': groups });
const ADM = as('anil', 'dmc-platform-admin');
const AGENT = { 'x-dmc-user': 'bot', 'x-dmc-kind': 'service', 'x-dmc-acting-for': 'anil', 'x-dmc-groups': 'dmc-platform-admin' };
const key = () => `k-${Math.random().toString(36).slice(2)}-xx`;
const inj = (method: 'GET' | 'POST', url: string, headers: Record<string, string>, payload?: unknown, extra: Record<string, string> = {}) =>
  app.getHttpAdapter().getInstance().inject({ method, url, headers: { ...headers, ...(method === 'GET' ? {} : { 'idempotency-key': key() }), ...extra }, payload: payload as never });
const contract = (path: string, m: string, status: number, body: unknown) => expect(checkResponse(spec, path, m, status, body)).toEqual([]);
const outbox = async (type: string) => (await admin.query('select actor, subject_ref, payload from connectors.outbox where event_type = $1 order by id', [type])).rows as { actor: string; subject_ref: string; payload: Record<string, unknown> }[];
const queued = async (queue: string) => (await admin.query(`select data from pgboss.job where name = $1 and state in ('created','retry','active')`, [queue])).rows.map((r) => r.data as Record<string, unknown>);
let bigRun = ''; let appsLastRun = '';

const DEF = JSON.stringify({ job: 'x', source: { mode: 'full' }, limits: { max_changes_pct: 10 }, resolved: { query: 'SELECT secret_column FROM private.table' } });
const job = (name: string, over: { enabled?: boolean; connection?: string } = {}) =>
  admin.query(`insert into connectors.job (name, environment, version, definition, connection, schedule, enabled) values ($1,'uat',3,$2,$3,'0 3 * * *',$4)`, [name, DEF, over.connection ?? 'snow', over.enabled ?? true]);
const run = async (jobName: string, status: string, startedAt: string, cols: Record<string, unknown> = {}) => {
  const c = { trigger: 'schedule', complete: status === 'succeeded', read_count: 0, created: 0, updated: 0, unchanged: 0, deprecated: 0, errors: 0, note: null, ...cols };
  return (await admin.query(
    `insert into connectors.run (job, environment, trigger, status, mode, complete, started_at, finished_at, read_count, created, updated, unchanged, deprecated, errors, note)
     values ($1,'uat',$2,$3,'full',$4,$5::timestamptz,case when $3 = 'running' then null else $5::timestamptz + interval '1 minute' end,$6,$7,$8,$9,$10,$11,$12) returning id`,
    [jobName, c.trigger, status, c.complete, startedAt, c.read_count, c.created, c.updated, c.unchanged, c.deprecated, c.errors, c.note])).rows[0].id as string;
};

beforeAll(async () => {
  server = new EmbeddedPostgres({ databaseDir: mkdtempSync(join(tmpdir(), 'dmc-syad-')), user: 'postgres', password: 'pw', port: PORT, persistent: false });
  await server.initialise(); await server.start();
  admin = new pg.Client({ host: 'localhost', port: PORT, user: 'postgres', password: 'pw', database: 'postgres' });
  await admin.connect();
  await provisionModule(admin, 'connectors', { password: 'cn' });
  await migrateModule(admin, 'connectors', join(root, 'packages/connectors/migrations'));
  await admin.query('grant all on all tables in schema connectors to dmc_connectors'); await admin.query('grant all on all sequences in schema connectors to dmc_connectors');
  pool = new pg.Pool({ host: 'localhost', port: PORT, user: 'dmc_connectors', password: 'cn', database: 'postgres', max: 4 });
  boss = new PgBoss(`postgres://postgres:pw@localhost:${PORT}/postgres`);
  boss.on('error', () => undefined);
  await boss.start();

  // the connection's configuration holds values that must never leave the module
  await admin.query(`insert into connectors.connection (name, environment, type, config, secret_ref) values ('snow','uat','bigquery','{"project":"p-secret-project","dataset":"hidden-dataset"}','sm/very-secret-ref')`);
  await job('apps'); await job('big'); await job('busy'); await job('off', { enabled: false }); await job('never', { connection: 'ghost' });
  await run('apps', 'succeeded', '2026-11-10T03:00:00Z', { read_count: 100, created: 3, updated: 5, unchanged: 92 });
  await run('apps', 'failed', '2026-11-11T03:00:00Z', { note: 'read failed after 3 attempts: 503 from source' });
  appsLastRun = await run('apps', 'succeeded', '2026-11-12T03:00:00Z', { trigger: 'manual', read_count: 120, created: 4, updated: 6, unchanged: 100, deprecated: 10, errors: 2, note: '2 records not mapped (no key); 3 records refused by the catalog; they are sent again next run' });
  bigRun = await run('big', 'paused_limit', '2026-11-12T03:00:00Z', { read_count: 50, created: 30, updated: 0, unchanged: 20, note: '30 of 50 records would change (limit 10%)' });
  await run('busy', 'running', '2026-11-12T04:00:00Z');

  const lease = async () => { const x = await pool.connect(); return { query: (s: string, a?: unknown[]) => x.query(s, a) as never, release: () => x.release() }; };
  const unused = async () => { throw new Error('the sync endpoints do not read the catalog'); };
  app = await createApi({
    version: '1.0.0', registry, store: new CatalogStore(registry), authz: Authz.load(readFileSync(join(root, 'config/authz.yaml'), 'utf8')), authenticate: devAuthenticator('local'),
    connect: unused as never, connectEvidence: unused as never, policies: () => [],
    exceptions: { async raise() { return { id: 'e', created: true }; }, async withdraw() { return true; } },
    inbox: { async forSubject() { return []; }, async list() { return []; }, async get() { return undefined; }, async decide() { return { replayed: false }; } },
    signals: { async submit() {} }, idempotency: { async get(k) { return idem.get(k); }, async put(k, e) { idem.set(k, e); } },
    sync: new SyncAdmin({ connect: lease, boss }),
  });
}, 150_000);
afterAll(async () => { try { await app?.close(); await boss?.stop({ graceful: false }); await pool?.end(); await admin?.end(); } finally { await server?.stop(); } });

describe('S12 who may use the sync endpoints', () => {
  const calls: [string, 'GET' | 'POST', string][] = [
    ['jobs', 'GET', '/v1/sync/jobs'], ['job', 'GET', '/v1/sync/jobs/uat/apps'], ['runs', 'GET', '/v1/sync/jobs/uat/apps/runs'], ['run', 'GET', `/v1/sync/runs/00000000-0000-4000-8000-000000000000`],
    ['pause', 'POST', '/v1/sync/jobs/uat/apps/pause'], ['run now', 'POST', '/v1/sync/jobs/uat/apps/run'], ['approve', 'POST', '/v1/sync/runs/00000000-0000-4000-8000-000000000000/approve'],
  ];
  for (const [name, m, url] of calls) {
    it(`${name}: refuses a viewer, a steward, a control owner, an auditor and an agent acting for an admin; needs a sign-in`, async () => {
      const body = m === 'POST' ? { paused: true } : undefined;
      for (const who of [as('vera'), as('sam', 'dmc-steward-finance'), as('carl', 'dmc-control-owner-privacy'), as('ann', 'dmc-auditor'), as('pat', 'dmc-policy-author'), AGENT]) {
        const r = await inj(m, url, who, body, { 'if-match': '*' });
        expect(r.statusCode, `${name} as ${JSON.stringify(who)}`).toBe(403);
        contract(url.replace(/\/uat\/apps/, '/{environment}/{name}').replace(/\/runs\/[0-9a-f-]{36}/, '/runs/{id}'), m.toLowerCase(), 403, r.json());
      }
      expect((await app.getHttpAdapter().getInstance().inject({ method: m, url, payload: body as never })).statusCode).toBe(401);
    });
  }
  it('an administrator is allowed (the 403 above is the role, not the route)', async () => {
    expect((await inj('GET', '/v1/sync/jobs', ADM)).statusCode).toBe(200);
  });
  it('nothing was queued or paused by the refused presses', async () => {
    expect(await queued('sync.run')).toEqual([]);
    expect((await admin.query(`select count(*)::int as n from connectors.job where paused`)).rows[0].n).toBe(0);
    expect(await outbox('sync.job.paused')).toEqual([]);
  });
});

describe('S12 reading', () => {
  it('lists the jobs of every environment with state, schedule and the last run', async () => {
    const r = await inj('GET', '/v1/sync/jobs', ADM);
    expect(r.statusCode).toBe(200);
    contract('/v1/sync/jobs', 'get', 200, r.json());
    const items = r.json().items as { name: string; enabled: boolean; paused: boolean; connection: string; connection_type: string | null; max_changes_pct: number | null; awaiting_review: string | null; last_run: { status: string; counts: Record<string, number> } | null; last_success_at: string | null }[];
    expect(items.map((j) => j.name)).toEqual(['apps', 'big', 'busy', 'never', 'off']);
    const by = Object.fromEntries(items.map((j) => [j.name, j]));
    expect(by.apps).toMatchObject({ enabled: true, paused: false, connection: 'snow', connection_type: 'bigquery', max_changes_pct: 10, awaiting_review: null, last_success_at: '2026-11-12T03:01:00.000Z' });
    expect(by.apps!.last_run).toMatchObject({ status: 'succeeded', trigger: 'manual', counts: { read: 120, created: 4, updated: 6, unchanged: 100, missing: 10, errors: 2, refused: 3 } });
    expect(by.big).toMatchObject({ awaiting_review: bigRun, last_run: { status: 'paused_limit' } });
    expect(by.busy!.last_run!.status).toBe('running');
    expect(by.never).toMatchObject({ last_run: null, last_success_at: null, connection_type: null });
    expect(by.off!.enabled).toBe(false);
  });

  it('never returns a connection configuration, a secret reference or a query (rule 8)', async () => {
    const text = (await inj('GET', '/v1/sync/jobs', ADM)).body + (await inj('GET', '/v1/sync/jobs/uat/apps', ADM)).body + (await inj('GET', '/v1/sync/jobs/uat/apps/runs', ADM)).body;
    for (const secret of ['p-secret-project', 'hidden-dataset', 'sm/very-secret-ref', 'secret_column', 'private.table']) expect(text).not.toContain(secret);
  });

  it('gets one job with its ETag, and 404 for one that is not there', async () => {
    const r = await inj('GET', '/v1/sync/jobs/uat/apps', ADM);
    expect(r.statusCode).toBe(200);
    contract('/v1/sync/jobs/{environment}/{name}', 'get', 200, r.json());
    expect(r.headers.etag).toBe(r.json().etag);
    const nf = await inj('GET', '/v1/sync/jobs/uat/nope', ADM);
    expect(nf.statusCode).toBe(404); contract('/v1/sync/jobs/{environment}/{name}', 'get', 404, nf.json());
    expect((await inj('GET', '/v1/sync/jobs/prod/apps', ADM)).statusCode).toBe(404);
  });

  it('lists runs newest first, a page at a time', async () => {
    const p1 = await inj('GET', '/v1/sync/jobs/uat/apps/runs?limit=2', ADM);
    expect(p1.statusCode).toBe(200);
    contract('/v1/sync/jobs/{environment}/{name}/runs', 'get', 200, p1.json());
    expect(p1.json().items.map((x: { status: string }) => x.status)).toEqual(['succeeded', 'failed']);
    expect(p1.json().items[1].note).toBe('read failed after 3 attempts: 503 from source');
    const p2 = await inj('GET', `/v1/sync/jobs/uat/apps/runs?limit=2&cursor=${p1.json().next_cursor}`, ADM);
    expect(p2.json().items).toHaveLength(1);
    expect(p2.json().items[0]).toMatchObject({ status: 'succeeded', counts: { created: 3, updated: 5 } });
    expect(p2.json().next_cursor).toBeNull();
    expect((await inj('GET', '/v1/sync/jobs/uat/apps/runs?limit=0', ADM)).statusCode).toBe(422);
    expect((await inj('GET', '/v1/sync/jobs/uat/apps/runs?cursor=!!', ADM)).statusCode).toBe(422);
    expect((await inj('GET', `/v1/sync/jobs/uat/apps/runs?cursor=${Buffer.from('{"startedAt":"x","id":"y"}').toString('base64url')}`, ADM)).statusCode).toBe(422);
    expect((await inj('GET', '/v1/sync/jobs/uat/nope/runs', ADM)).statusCode).toBe(404);
    expect((await inj('GET', '/v1/sync/jobs/uat/never/runs', ADM)).json()).toEqual({ items: [], next_cursor: null });
  });

  it('gets one run, with its counts and notes', async () => {
    const r = await inj('GET', `/v1/sync/runs/${appsLastRun}`, ADM);
    expect(r.statusCode).toBe(200);
    contract('/v1/sync/runs/{id}', 'get', 200, r.json());
    expect(r.json().note).toContain('not mapped');
    expect(r.headers.etag).toBe(r.json().etag);
    expect((await inj('GET', '/v1/sync/runs/00000000-0000-4000-8000-000000000000', ADM)).statusCode).toBe(404);
    expect((await inj('GET', '/v1/sync/runs/not-a-uuid', ADM)).statusCode).toBe(404);
  });
});

describe('S12 pause and resume', () => {
  const url = '/v1/sync/jobs/uat/apps/pause';
  it('needs a valid body and the job to be there', async () => {
    const etag = (await inj('GET', '/v1/sync/jobs/uat/apps', ADM)).headers.etag as string;
    expect((await inj('POST', url, ADM, { paused: 'yes' }, { 'if-match': etag })).statusCode).toBe(422);
    expect((await inj('POST', '/v1/sync/jobs/uat/nope/pause', ADM, { paused: true }, { 'if-match': etag })).statusCode).toBe(404);
    expect((await inj('POST', url, ADM, { paused: true }, { 'idempotency-key': 'short' })).statusCode).toBe(422);   // Idempotency-Key is required
  });

  it('needs If-Match: 428 without it, 412 when the job has changed since it was read', async () => {
    const no = await inj('POST', url, ADM, { paused: true });
    expect(no.statusCode).toBe(428); contract('/v1/sync/jobs/{environment}/{name}/pause', 'post', 428, no.json());
    const stale = await inj('POST', url, ADM, { paused: true }, { 'if-match': 'W/"uat/apps-0"' });
    expect(stale.statusCode).toBe(412); contract('/v1/sync/jobs/{environment}/{name}/pause', 'post', 412, stale.json());
    expect((await inj('GET', '/v1/sync/jobs/uat/apps', ADM)).json().paused).toBe(false);
  });

  it('pauses with who did it in the outbox; the same key answers the same; a stale ETag is then refused', async () => {
    const before = (await inj('GET', '/v1/sync/jobs/uat/apps', ADM)).json();
    const k = key();
    const r = await inj('POST', url, ADM, { paused: true }, { 'if-match': before.etag, 'idempotency-key': k });
    expect(r.statusCode).toBe(200);
    contract('/v1/sync/jobs/{environment}/{name}/pause', 'post', 200, r.json());
    expect(r.json()).toMatchObject({ name: 'apps', paused: true });
    expect(r.json().etag).not.toBe(before.etag);
    expect(r.headers.etag).toBe(r.json().etag);
    expect(await outbox('sync.job.paused')).toEqual([{ actor: 'anil', subject_ref: 'sync/uat/apps', payload: {} }]);
    const again = await inj('POST', url, ADM, { paused: true }, { 'if-match': before.etag, 'idempotency-key': k });
    expect(again.statusCode).toBe(200); expect(again.json()).toEqual(r.json());
    expect(await outbox('sync.job.paused')).toHaveLength(1);
    expect((await inj('POST', url, ADM, { paused: true }, { 'if-match': before.etag })).statusCode).toBe(412);
    expect((await inj('POST', url, ADM, { paused: false }, { 'if-match': before.etag, 'idempotency-key': k })).statusCode).toBe(422);   // same key, different body
  });

  it('cannot run a paused job now', async () => {
    const r = await inj('POST', '/v1/sync/jobs/uat/apps/run', ADM);
    expect(r.statusCode).toBe(409); contract('/v1/sync/jobs/{environment}/{name}/run', 'post', 409, r.json());
    expect(r.json().detail).toContain('paused');
    expect(await queued('sync.run')).toEqual([]);
  });

  it('resumes, again with its outbox row', async () => {
    const cur = (await inj('GET', '/v1/sync/jobs/uat/apps', ADM)).json();
    const r = await inj('POST', url, ADM, { paused: false }, { 'if-match': cur.etag });
    expect(r.json().paused).toBe(false);
    expect((await outbox('sync.job.resumed')).map((o) => o.actor)).toEqual(['anil']);
  });
});

describe('S12 run now', () => {
  const run = (name: string, extra: Record<string, string> = {}) => inj('POST', `/v1/sync/jobs/uat/${name}/run`, ADM, undefined, extra);
  it('refuses a job that is running, disabled, waiting for review, or unknown', async () => {
    for (const [name, word] of [['busy', 'in progress'], ['off', 'disabled'], ['big', 'review']] as const) {
      const r = await run(name);
      expect(r.statusCode, name).toBe(409); expect(r.json().detail).toContain(word);
      contract('/v1/sync/jobs/{environment}/{name}/run', 'post', 409, r.json());
    }
    expect((await run('nope')).statusCode).toBe(404);
    expect((await inj('POST', '/v1/sync/jobs/uat/apps/run', ADM, undefined, { 'idempotency-key': 'x' })).statusCode).toBe(422);
    expect(await queued('sync.run')).toEqual([]);
  });

  it('queues a run on the queue the schedule uses, as the admin', async () => {
    const k = key();
    const r = await run('apps', { 'idempotency-key': k });
    expect(r.statusCode).toBe(202); expect(r.json()).toEqual({ queued: true });
    contract('/v1/sync/jobs/{environment}/{name}/run', 'post', 202, r.json());
    expect(await queued('sync.run')).toEqual([{ job: 'apps', environment: 'uat', trigger: 'manual', actor: 'anil' }]);
    expect(await outbox('sync.run.requested')).toMatchObject([{ actor: 'anil', subject_ref: 'sync/uat/apps' }]);
    const replay = await run('apps', { 'idempotency-key': k });
    expect(replay.statusCode).toBe(202);
    expect(await queued('sync.run')).toHaveLength(1);
  });

  it('a second press, with a new key, while one is queued is a conflict', async () => {
    const r = await run('apps');
    expect(r.statusCode).toBe(409); expect(r.json().detail).toContain('queued');
    expect(await queued('sync.run')).toHaveLength(1);
  });
});

describe('S12 approve a run the change limit held', () => {
  const url = () => `/v1/sync/runs/${bigRun}/approve`;
  it('refuses a run that is not waiting for review', async () => {
    const r = await inj('POST', `/v1/sync/runs/${appsLastRun}/approve`, ADM, undefined, { 'if-match': '*' });
    expect(r.statusCode).toBe(409); contract('/v1/sync/runs/{id}/approve', 'post', 409, r.json());
    expect((await inj('POST', '/v1/sync/runs/00000000-0000-4000-8000-000000000000/approve', ADM, undefined, { 'if-match': '*' })).statusCode).toBe(404);
    expect((await inj('POST', '/v1/sync/runs/nope/approve', ADM, undefined, { 'if-match': '*' })).statusCode).toBe(404);
  });
  it('needs If-Match, and the run as it was read', async () => {
    expect((await inj('POST', url(), ADM)).statusCode).toBe(428);
    expect((await inj('POST', url(), ADM, undefined, { 'if-match': 'W/"stale"' })).statusCode).toBe(412);
    expect(await queued('sync.approve')).toEqual([]);
  });
  it('queues the approval for the worker, as the admin', async () => {
    const etag = (await inj('GET', `/v1/sync/runs/${bigRun}`, ADM)).headers.etag as string;
    const k = key();
    const r = await inj('POST', url(), ADM, undefined, { 'if-match': etag, 'idempotency-key': k });
    expect(r.statusCode).toBe(202); expect(r.json()).toEqual({ queued: true });
    contract('/v1/sync/runs/{id}/approve', 'post', 202, r.json());
    expect(await queued('sync.approve')).toEqual([{ runId: bigRun, actor: 'anil' }]);
    expect(await outbox('sync.run.approval_requested')).toMatchObject([{ actor: 'anil', subject_ref: 'sync/uat/big', payload: { runId: bigRun } }]);
    expect((await inj('POST', url(), ADM, undefined, { 'if-match': etag, 'idempotency-key': k })).statusCode).toBe(202);   // same press, same answer
    const again = await inj('POST', url(), ADM, undefined, { 'if-match': etag });
    expect(again.statusCode).toBe(409); expect(again.json().detail).toContain('queued');
    expect(await queued('sync.approve')).toHaveLength(1);
  });
});
