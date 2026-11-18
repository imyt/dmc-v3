import type { Connector, ExceptionPort, Signal, SignalSink } from '@dmc/contracts';
import { writeOutbox, type Queryable } from '@dmc/platform';
import type { ResolvedJob } from './definition.js';
import { mapRecord, splitEdgeKey } from './mapping.js';

const M = 'connectors';
const DEFAULT_PAGE = 1000;

export type RunStatus = 'running' | 'succeeded' | 'failed' | 'paused_limit' | 'discarded' | 'skipped';
export interface RunResult {
  runId: string; status: RunStatus; complete: boolean; note?: string;
  read: number; created: number; updated: number; unchanged: number; deprecated: number; errors: number;
}
export interface Deps {
  connectors: Record<string, Connector>;
  signals: SignalSink;
  exceptions: ExceptionPort;
  now?: () => Date;
  /** replaced in tests so retries do not wait */
  sleep?: (ms: number) => Promise<void>;
}
interface Pending { key: string; change: 'created' | 'updated' | 'missing'; hash: string | null; attrs: Record<string, unknown> | null }

const subjectOf = (environment: string, job: string) => `sync/${environment}/${job}`;

/**
 * Runs sync jobs. Everything a run finds is held in `staging` until the whole run is read and passes its limit check.
 * Only then do signals go out and the record state move, so a failed or partial run changes nothing.
 */
export class SyncService {
  constructor(private readonly d: Deps) {}

  async upsertConnection(db: Queryable, c: { name: string; environment: string; type: string; config: Record<string, unknown>; secretRef: string }): Promise<void> {
    await db.query(
      `insert into ${M}.connection (name, environment, type, config, secret_ref) values ($1,$2,$3,$4,$5)
       on conflict (name, environment) do update set type = excluded.type, config = excluded.config, secret_ref = excluded.secret_ref`,
      [c.name, c.environment, c.type, JSON.stringify(c.config), c.secretRef]);
  }

  /** Stores the resolved job for its environment. Bumps the version only when the definition changed. */
  async installJob(db: Queryable, r: ResolvedJob): Promise<{ version: number }> {
    const def = JSON.stringify({ ...r.def, resolved: { query: r.query } });
    const cur = await db.query<{ version: number; definition: unknown }>(`select version, definition from ${M}.job where name = $1 and environment = $2`, [r.def.job, r.environment]);
    const row = cur.rows[0];
    const same = row && JSON.stringify(row.definition) === JSON.stringify(JSON.parse(def));
    const version = row ? (same ? row.version : row.version + 1) : 1;
    await db.query(
      `insert into ${M}.job (name, environment, version, definition, connection, schedule, enabled) values ($1,$2,$3,$4,$5,$6,$7)
       on conflict (name, environment) do update set version = excluded.version, definition = excluded.definition,
         connection = excluded.connection, schedule = excluded.schedule, enabled = excluded.enabled`,
      [r.def.job, r.environment, version, def, r.connection, r.schedule, r.enabled]);
    return { version };
  }

  /** The source name this job writes as (the metamodel's `source`). A signal carries only the job name. */
  async writerSource(db: Queryable, job: string): Promise<string> {
    const r = await db.query<{ definition: { target?: { source?: string } } }>(`select definition from ${M}.job where name = $1 order by version desc limit 1`, [job]);
    return r.rows[0]?.definition.target?.source ?? job;
  }

  async setPaused(db: Queryable, job: string, environment: string, paused: boolean, actor: string): Promise<void> {
    await db.query(`update ${M}.job set paused = $3 where name = $1 and environment = $2`, [job, environment, paused]);
    await writeOutbox(db, M, { type: paused ? 'sync.job.paused' : 'sync.job.resumed', subjectRef: subjectOf(environment, job), actor, payload: {} });
  }

  async run(db: Queryable, job: string, environment: string, opts: { trigger?: 'schedule' | 'manual'; actor?: string } = {}): Promise<RunResult> {
    const trigger = opts.trigger ?? 'schedule';
    const actor = opts.actor ?? `sync:${job}`;
    const j = (await db.query<{ definition: any; connection: string; enabled: boolean; paused: boolean }>(
      `select definition, connection, enabled, paused from ${M}.job where name = $1 and environment = $2`, [job, environment])).rows[0];
    if (!j) throw new Error(`Unknown job ${job} in ${environment}`);
    const def = j.definition as import('./definition.js').JobDef & { resolved: { query: string } };
    const zero = { read: 0, created: 0, updated: 0, unchanged: 0, deprecated: 0, errors: 0 };

    const skip = async (note: string): Promise<RunResult> => {
      const id = (await db.query<{ id: string }>(`insert into ${M}.run (job, environment, trigger, status, mode, finished_at, note) values ($1,$2,$3,'skipped',$4,now(),$5) returning id`, [job, environment, trigger, def.source.mode, note])).rows[0]!.id;
      return { runId: id, status: 'skipped', complete: false, note, ...zero };
    };
    if (!j.enabled) return skip('job is disabled');
    if (j.paused) return skip('job is paused');
    const waiting = await db.query(`select 1 from ${M}.run where job = $1 and environment = $2 and status = 'paused_limit'`, [job, environment]);
    if (waiting.rowCount) return skip('a run is waiting for review');

    const conn = (await db.query<{ type: string; config: Record<string, unknown>; secret_ref: string }>(`select type, config, secret_ref from ${M}.connection where name = $1 and environment = $2`, [j.connection, environment])).rows[0];
    if (!conn) throw new Error(`Connection ${j.connection} is not set up in ${environment}`);
    const connector = this.d.connectors[conn.type];
    if (!connector) throw new Error(`No connector for type ${conn.type}`);
    const config = { ...conn.config, secretRef: conn.secret_ref };

    const runId = (await db.query<{ id: string }>(`insert into ${M}.run (job, environment, trigger, status, mode) values ($1,$2,$3,'running',$4) returning id`, [job, environment, trigger, def.source.mode])).rows[0]!.id;
    const full = def.source.mode === 'full';
    const since = full ? null : (await db.query<{ value: string }>(`select value from ${M}.cursor where job = $1 and environment = $2`, [job, environment])).rows[0]?.value ?? null;

    const known = new Map<string, { hash: string; state: string }>();
    for (const r of (await db.query<{ key: string; hash: string; state: string }>(`select key, hash, state from ${M}.record_state where job = $1 and environment = $2`, [job, environment])).rows) known.set(r.key, { hash: r.hash, state: r.state });
    const activeBefore = [...known.values()].filter((k) => k.state === 'active').length;
    // records the catalog refused in the last run come back as created/updated/missing again; they are not new changes (ADR 0027)
    const lastRefused = new Set<string>(((await db.query<{ refused_keys: string[] | null }>(
      `select refused_keys from ${M}.run where job = $1 and environment = $2 and status = 'succeeded' order by started_at desc limit 1`, [job, environment])).rows[0]?.refused_keys) ?? []);

    const seen = new Set<string>();
    const pending: Pending[] = [];
    const counts = { ...zero };
    let highWater: string | null = since;
    let pageCursor: string | null = null;
    let readAll = false;
    let failure: string | null = null;
    const errorNotes: string[] = [];
    const retries = def.retries?.max ?? 3;
    const backoff = (def.retries?.backoff_seconds ?? 5) * 1000;
    const sleep = this.d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

    pages: while (true) {
      let page; let attempt = 0;
      while (true) {
        try { page = await connector.read(config, { text: def.resolved.query, cursorField: def.source.cursor, pageSize: def.source.page_size ?? DEFAULT_PAGE }, pageCursor, since); break; }
        catch (e) {
          if (attempt >= retries) { failure = `read failed after ${attempt + 1} attempts: ${(e as Error).message}`; break pages; }
          attempt++; await sleep(backoff * 2 ** (attempt - 1));
        }
      }
      for (const rec of page.records) {
        counts.read++;
        const m = mapRecord(rec, def.target);
        if ('error' in m) { counts.errors++; if (errorNotes.length < 3) errorNotes.push(m.error); continue; }
        if (seen.has(m.key)) continue; // a later duplicate of the same key in one run is ignored
        seen.add(m.key);
        const prev = known.get(m.key);
        if (!prev) { counts.created++; pending.push({ key: m.key, change: 'created', hash: m.hash, attrs: m.attrs }); }
        else if (prev.hash !== m.hash || prev.state === 'deprecated') { counts.updated++; pending.push({ key: m.key, change: 'updated', hash: m.hash, attrs: m.attrs }); }
        else counts.unchanged++;
      }
      if (page.highWater && (highWater === null || page.highWater > highWater)) highWater = page.highWater;
      if (page.done) { readAll = true; break; }
      if (page.nextCursor === pageCursor) { failure = 'connector returned the same page cursor twice'; break; }
      pageCursor = page.nextCursor;
    }

    // Complete means every page was read and every record had a key. Only a complete full run may deprecate.
    const complete = readAll && counts.errors === 0 && failure === null;
    if (full && complete && def.target.on_missing !== 'ignore') {
      for (const [key, k] of known) if (k.state === 'active' && !seen.has(key)) { counts.deprecated++; pending.push({ key, change: 'missing', hash: null, attrs: null }); }
    }

    const finish = async (status: RunStatus, note?: string, pendingCursor?: string | null) => {
      await db.query(
        `update ${M}.run set status=$2, complete=$3, finished_at=now(), read_count=$4, created=$5, updated=$6, unchanged=$7, deprecated=$8, errors=$9, note=$10, pending_cursor=$11 where id=$1`,
        [runId, status, complete, counts.read, counts.created, counts.updated, counts.unchanged, counts.deprecated, counts.errors, note ?? null, pendingCursor ?? null]);
      await writeOutbox(db, M, { type: `sync.run.${status}`, subjectRef: subjectOf(environment, job), actor, payload: { runId, ...counts, complete, note: note ?? null } });
    };
    const result = (status: RunStatus, note?: string): RunResult => ({ runId, status, complete, note, ...counts });

    if (failure) { await finish('failed', failure); return result('failed', failure); }

    const changes = pending.filter((p) => !lastRefused.has(p.key)).length;
    const max = def.limits?.max_changes_pct;
    if (max !== undefined && activeBefore > 0 && (changes / activeBefore) * 100 > max) {
      for (const p of pending) await db.query(`insert into ${M}.staging (run_id, key, change, hash, attrs) values ($1,$2,$3,$4,$5)`, [runId, p.key, p.change, p.hash, p.attrs ? JSON.stringify(p.attrs) : null]);
      const note = `${changes} of ${activeBefore} records would change (limit ${max}%)`;
      await finish('paused_limit', note, counts.errors ? null : highWater); // a row that did not map holds the cursor back (ADR 0027)
      await this.d.exceptions.raise({ kind: 'sync.change_limit', severity: 'high', subjectRef: subjectOf(environment, job), message: `${job} paused: ${note}`, route: 'platform-admin', actor });
      return result('paused_limit', note);
    }

    const refusedKeys = await this.commit(db, { runId, job, environment, def, pending, highWater: counts.errors ? null : highWater, since, actor });
    const refused = refusedKeys.length;
    if (refused) await db.query(`update ${M}.run set refused_keys = $2 where id = $1`, [runId, JSON.stringify(refusedKeys)]);
    const rnote = [
      counts.errors ? `${counts.errors} record${counts.errors === 1 ? '' : 's'} not mapped (${errorNotes.join('; ')}${counts.errors > errorNotes.length ? '; ...' : ''})` : '',
      refused ? `${refused} record${refused === 1 ? '' : 's'} refused by the catalog; they are sent again next run` : '',
    ].filter(Boolean).join('; ') || undefined;
    await finish('succeeded', rnote);
    return result('succeeded', rnote);
  }

  /** Signals first (delivery is idempotent by source + key), then state. A crash in between replays safely. */
  private async commit(db: Queryable, a: { runId: string; job: string; environment: string; def: import('./definition.js').JobDef; pending: Pending[]; highWater: string | null; since: string | null; actor: string }): Promise<string[]> {
    const edge = a.def.target.edge;
    // An end of an edge goes before a new one starts: an owner transfer on a many-to-one edge is "unlink old, link new" in one run (ADR 0027). Stable, so the rest keeps its order.
    const ordered = [...a.pending.filter((p) => p.change === 'missing'), ...a.pending.filter((p) => p.change !== 'missing')];
    const signals: Signal[] = ordered.map((p): Signal => {
      if (!edge) return {
        source: a.job,
        key: p.change === 'missing' ? `${p.key}@missing:${a.runId}` : `${p.key}@${p.hash}`,
        kind: p.change === 'missing' ? 'sync.missing' : 'sync.upsert',
        subjectRef: `${a.def.target.type}:${p.key}`,
        subjectType: a.def.target.type,
        asset: p.change === 'missing' ? { lifecycle: 'deprecated' } : { ...p.attrs },
        actor: a.actor,
      };
      // an edge record becomes a link (or an unlink when the edge has gone from a complete run); the ingest applies it to the catalog
      const [from, to] = splitEdgeKey(p.key);
      // a NULL edge attribute is no attribute (it is still part of the hash, so clearing one re-describes the edge)
      const attributes = Object.fromEntries(Object.entries(p.attrs ?? {}).filter(([k, v]) => k !== 'from' && k !== 'to' && v !== null));
      return {
        source: a.job,
        key: p.change === 'missing' ? `${p.key}@missing:${a.runId}` : `${p.key}@${p.hash}`,
        kind: p.change === 'missing' ? 'sync.unlink' : 'sync.link',
        subjectRef: `${a.def.target.type}:${p.key}`,
        subjectType: a.def.target.type,
        asset: p.change === 'missing' ? { edge: edge.name, from, to } : { edge: edge.name, from, to, attributes },
        actor: a.actor,
      };
    });
    // a record the sink refused (for example an edge whose end is not in the catalog yet) is not recorded as seen: the next run sends it again (ADR 0024)
    const res = signals.length ? await this.d.signals.submit(signals) : undefined;
    const refusedKeys = new Set(res?.rejected ?? []);
    const refused = signals.length ? ordered.filter((_p, i) => refusedKeys.has(signals[i]!.key)) : [];
    const accepted = ordered.filter((p) => !refused.includes(p));
    await db.query('begin');
    try {
      for (const p of accepted) {
        await db.query(
          `insert into ${M}.record_state (job, environment, key, hash, state, last_run) values ($1,$2,$3,$4,$5,$6)
           on conflict (job, environment, key) do update set hash = coalesce($4, ${M}.record_state.hash), state = $5, last_run = $6`,
          [a.job, a.environment, p.key, p.hash ?? '', p.change === 'missing' ? 'deprecated' : 'active', a.runId]);
      }
      // with a refused record the cursor stays where it was, so an incremental job reads the record again (unchanged ones are skipped by hash)
      if (!refused.length && a.def.source.mode === 'incremental' && a.highWater && a.highWater !== a.since) {
        await db.query(`insert into ${M}.cursor (job, environment, value) values ($1,$2,$3) on conflict (job, environment) do update set value = excluded.value, updated_at = now()`, [a.job, a.environment, a.highWater]);
      }
      await db.query(`delete from ${M}.staging where run_id = $1`, [a.runId]);
      await db.query('commit');
    } catch (e) { await db.query('rollback'); throw e; }
    return refused.map((p) => p.key);
  }

  /** An admin accepts a paused run: its held changes go out as signals. */
  async approve(db: Queryable, runId: string, actor: string): Promise<RunResult> {
    const r = (await db.query<any>(`select * from ${M}.run where id = $1`, [runId])).rows[0];
    if (!r || r.status !== 'paused_limit') throw new Error('Run is not waiting for review');
    const job = (await db.query<{ definition: any }>(`select definition from ${M}.job where name = $1 and environment = $2`, [r.job, r.environment])).rows[0]!;
    const pending = (await db.query<{ key: string; change: Pending['change']; hash: string | null; attrs: Record<string, unknown> | null }>(`select key, change, hash, attrs from ${M}.staging where run_id = $1`, [runId])).rows;
    const refusedKeys = await this.commit(db, { runId, job: r.job, environment: r.environment, def: job.definition, pending, highWater: r.pending_cursor, since: null, actor });
    if (refusedKeys.length) await db.query(`update ${M}.run set refused_keys = $2 where id = $1`, [runId, JSON.stringify(refusedKeys)]);
    await db.query(`update ${M}.run set status = 'succeeded', note = $2 where id = $1`, [runId, `approved by ${actor}`]);
    await writeOutbox(db, M, { type: 'sync.run.approved', subjectRef: subjectOf(r.environment, r.job), actor, payload: { runId } });
    return { runId, status: 'succeeded', complete: r.complete, read: r.read_count, created: r.created, updated: r.updated, unchanged: r.unchanged, deprecated: r.deprecated, errors: r.errors };
  }

  /** An admin rejects a paused run: nothing is applied and the next run starts clean. */
  async discard(db: Queryable, runId: string, actor: string): Promise<void> {
    const r = (await db.query<any>(`select job, environment, status from ${M}.run where id = $1`, [runId])).rows[0];
    if (!r || r.status !== 'paused_limit') throw new Error('Run is not waiting for review');
    await db.query(`delete from ${M}.staging where run_id = $1`, [runId]);
    await db.query(`update ${M}.run set status = 'discarded', note = $2 where id = $1`, [runId, `discarded by ${actor}`]);
    await writeOutbox(db, M, { type: 'sync.run.discarded', subjectRef: subjectOf(r.environment, r.job), actor, payload: { runId } });
  }

  /** Jobs with no successful run inside `maxAgeHours`: input for the sync-freshness dimension and the admin alert. */
  async stale(db: Queryable, maxAgeHours = 24): Promise<{ job: string; environment: string; lastSuccess: Date | null }[]> {
    const now = (this.d.now ?? (() => new Date()))();
    const r = await db.query<{ name: string; environment: string; last: Date | null }>(
      `select j.name, j.environment, (select max(finished_at) from ${M}.run r where r.job = j.name and r.environment = j.environment and r.status = 'succeeded') as last
         from ${M}.job j where j.enabled`);
    return r.rows.filter((x) => !x.last || now.getTime() - x.last.getTime() > maxAgeHours * 3_600_000).map((x) => ({ job: x.name, environment: x.environment, lastSuccess: x.last }));
  }
}
