import type { PgBoss } from 'pg-boss';
import type { ExceptionPort, SignalSink, SyncAdminPort, SyncJobView, SyncRunView } from '@dmc/contracts';
import { etagOf, writeOutbox, type Queryable } from '@dmc/platform';
import { SYNC_APPROVE_QUEUE, SYNC_QUEUE, type SyncApproveData, type SyncJobData } from './schedule.js';
import { SyncService } from './service.js';

const M = 'connectors';
const subjectOf = (environment: string, job: string) => `sync/${environment}/${job}`;
const iso = (d: Date | string | null | undefined): string | null => (d == null ? null : new Date(d).toISOString());
const notHere = () => { throw new Error('Not available in the API process: runs and approvals happen in the worker'); };

interface RunRow {
  id: string; job: string; environment: string; trigger: 'schedule' | 'manual'; status: SyncRunView['status']; mode: string; complete: boolean;
  started_at: Date; finished_at: Date | null; read_count: number; created: number; updated: number; deprecated: number; unchanged: number; errors: number; note: string | null;
}
const STATUSES = ['running', 'succeeded', 'failed', 'paused_limit', 'discarded', 'skipped'];

/** The run table keeps no count of records the catalog refused; the run's note says it ("N records refused by the catalog"). */
export const refusedIn = (note: string | null): number => Number(/(\d+) records? refused/.exec(note ?? '')?.[1] ?? 0);

export const toRunView = (r: RunRow): SyncRunView => ({
  id: r.id, job: r.job, environment: r.environment, trigger: r.trigger, status: r.status, mode: r.mode, complete: r.complete,
  startedAt: iso(r.started_at)!, finishedAt: iso(r.finished_at),
  counts: { read: r.read_count, created: r.created, updated: r.updated, unchanged: r.unchanged, missing: r.deprecated, errors: r.errors, refused: refusedIn(r.note) },
  note: r.note, etag: etagOf(r.id, STATUSES.indexOf(r.status)),
});

/** The version of a job's state that an If-Match refers to: its definition version, whether it is enabled and whether it is paused. */
export const jobEtag = (environment: string, name: string, j: { version: number; enabled: boolean; paused: boolean }): string =>
  etagOf(`${environment}/${name}`, j.version * 4 + (j.paused ? 2 : 0) + (j.enabled ? 1 : 0));

/**
 * S12. Reads of the connectors schema for the admin screen, the pause switch, and requests that go to the worker through pg-boss
 * (run now uses the queue the schedule uses; approval has a queue of its own). Never returns a connection's configuration or secret reference.
 */
export class SyncAdmin implements SyncAdminPort {
  private readonly svc: SyncService;
  constructor(private readonly d: { connect(): Promise<Queryable & { release(): void }>; boss: PgBoss }) {
    // only setPaused is used here; a run needs the worker's connectors and sinks
    this.svc = new SyncService({ connectors: {}, signals: { submit: notHere } as SignalSink, exceptions: { raise: notHere, withdraw: notHere } as unknown as ExceptionPort });
  }

  private async withDb<R>(fn: (db: Queryable) => Promise<R>): Promise<R> {
    const c = await this.d.connect();
    try { return await fn(c); } finally { c.release(); }
  }

  async jobs(): Promise<SyncJobView[]> { return this.withDb((db) => this.load(db)); }
  async job(environment: string, name: string): Promise<SyncJobView | undefined> { return this.withDb(async (db) => (await this.load(db, environment, name))[0]); }

  private async load(db: Queryable, environment?: string, name?: string): Promise<SyncJobView[]> {
    const r = await db.query<{ name: string; environment: string; version: number; enabled: boolean; paused: boolean; schedule: string; connection: string; mode: string | null; max_pct: string | null; ctype: string | null; awaiting: string | null; last_success: Date | null } & Partial<RunRow> & { run_id: string | null }>(
      `select j.name, j.environment, j.version, j.enabled, j.paused, j.schedule, j.connection,
              j.definition #>> '{source,mode}' as mode, j.definition #>> '{limits,max_changes_pct}' as max_pct, c.type as ctype,
              (select id from ${M}.run w where w.job = j.name and w.environment = j.environment and w.status = 'paused_limit' order by started_at limit 1) as awaiting,
              (select max(finished_at) from ${M}.run s where s.job = j.name and s.environment = j.environment and s.status = 'succeeded') as last_success,
              r.id as run_id, r.trigger, r.status, r.complete, r.started_at, r.finished_at, r.read_count, r.created, r.updated, r.deprecated, r.unchanged, r.errors, r.note, r.mode as run_mode
         from ${M}.job j
         left join ${M}.connection c on c.name = j.connection and c.environment = j.environment
         left join lateral (select * from ${M}.run x where x.job = j.name and x.environment = j.environment order by x.started_at desc, x.id desc limit 1) r on true
        where ($1::text is null or j.environment = $1) and ($2::text is null or j.name = $2)
        order by j.environment, j.name`, [environment ?? null, name ?? null]);
    return r.rows.map((j) => ({
      name: j.name, environment: j.environment, version: j.version, enabled: j.enabled, paused: j.paused, schedule: j.schedule,
      connection: j.connection, connectionType: j.ctype, mode: j.mode ?? 'full', maxChangesPct: j.max_pct == null ? null : Number(j.max_pct),
      lastRun: j.run_id ? toRunView({ id: j.run_id, job: j.name, environment: j.environment, trigger: j.trigger!, status: j.status!, mode: (j as { run_mode?: string }).run_mode ?? j.mode ?? 'full', complete: j.complete!, started_at: j.started_at!, finished_at: j.finished_at ?? null, read_count: j.read_count!, created: j.created!, updated: j.updated!, deprecated: j.deprecated!, unchanged: j.unchanged!, errors: j.errors!, note: j.note ?? null }) : null,
      lastSuccessAt: iso(j.last_success), awaitingReview: j.awaiting, etag: jobEtag(j.environment, j.name, j),
    }));
  }

  async runs(environment: string, name: string, page: { limit: number; before?: { startedAt: string; id: string } }): Promise<SyncRunView[]> {
    return this.withDb(async (db) => (await db.query<RunRow>(
      `select * from ${M}.run where job = $1 and environment = $2 and ($3::timestamptz is null or (started_at, id) < ($3::timestamptz, $4::uuid))
        order by started_at desc, id desc limit $5`, [name, environment, page.before?.startedAt ?? null, page.before?.id ?? null, page.limit])).rows.map(toRunView));
  }

  async run(id: string): Promise<SyncRunView | undefined> {
    return this.withDb(async (db) => { const r = (await db.query<RunRow>(`select * from ${M}.run where id = $1`, [id])).rows[0]; return r ? toRunView(r) : undefined; });
  }

  async setPaused(environment: string, name: string, paused: boolean, actor: string): Promise<boolean> {
    return this.withDb(async (db) => {
      await db.query('begin');   // the switch and its outbox row are one transaction (rule 6)
      try {
        const cur = (await db.query<{ paused: boolean }>(`select paused from ${M}.job where name = $1 and environment = $2 for update`, [name, environment])).rows[0];
        if (!cur) throw new Error(`Unknown job ${name} in ${environment}`);
        if (cur.paused === paused) { await db.query('rollback'); return false; }
        await this.svc.setPaused(db, name, environment, paused, actor);
        await db.query('commit');
        return true;
      } catch (e) { await db.query('rollback').catch(() => undefined); throw e; }
    });
  }

  async runNow(environment: string, name: string, actor: string): Promise<{ queued: true; queueId: string } | { queued: false; conflict: string }> {
    const j = await this.job(environment, name);
    if (!j) throw new Error(`Unknown job ${name} in ${environment}`);
    if (!j.enabled) return { queued: false, conflict: 'The job is disabled in this environment.' };
    if (j.paused) return { queued: false, conflict: 'The job is paused. Resume it first.' };
    if (j.awaitingReview) return { queued: false, conflict: 'A run is waiting for review. Approve it first.' };
    if (j.lastRun?.status === 'running') return { queued: false, conflict: 'A run is already in progress.' };
    await this.d.boss.createQueue(SYNC_QUEUE);
    if (await this.isQueued(SYNC_QUEUE, `${environment}/${name}`)) return { queued: false, conflict: 'A run is already queued.' };
    const id = await this.d.boss.send(SYNC_QUEUE, { job: name, environment, trigger: 'manual', actor } satisfies SyncJobData, { singletonKey: `${environment}/${name}` });
    if (!id) return { queued: false, conflict: 'A run is already queued.' };
    await this.record('sync.run.requested', environment, name, actor, { queueId: id });
    return { queued: true, queueId: id };
  }

  async approve(runId: string, actor: string): Promise<{ queued: true } | { queued: false; conflict: string }> {
    const run = await this.run(runId);
    if (!run) throw new Error(`Unknown run ${runId}`);
    if (run.status !== 'paused_limit') return { queued: false, conflict: 'The run is not waiting for review.' };
    await this.d.boss.createQueue(SYNC_APPROVE_QUEUE);
    if (await this.isQueued(SYNC_APPROVE_QUEUE, runId)) return { queued: false, conflict: 'The approval is already queued.' };
    const id = await this.d.boss.send(SYNC_APPROVE_QUEUE, { runId, actor } satisfies SyncApproveData, { singletonKey: runId });
    if (!id) return { queued: false, conflict: 'The approval is already queued.' };
    await this.record('sync.run.approval_requested', run.environment, run.job, actor, { runId });
    return { queued: true };
  }

  /** A standard pg-boss queue does not refuse a second job with the same singleton key, so look first. */
  private async isQueued(queue: string, key: string): Promise<boolean> {
    return (await this.d.boss.findJobs(queue, { key, queued: true, limit: 1 })).length > 0;
  }

  /** A press that only queues work is still on the record, with who pressed it. */
  private async record(type: string, environment: string, job: string, actor: string, payload: Record<string, unknown>): Promise<void> {
    await this.withDb(async (db) => {
      await db.query('begin');
      try { await writeOutbox(db, M, { type, subjectRef: subjectOf(environment, job), actor, payload }); await db.query('commit'); }
      catch (e) { await db.query('rollback').catch(() => undefined); throw e; }
    });
  }
}
