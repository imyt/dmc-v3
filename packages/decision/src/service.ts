import { createHash } from 'node:crypto';
import { writeOutbox, type Queryable } from '@dmc/platform';
import type { ActionPort, ExceptionPort, PolicyEvaluation, PolicyPort, Signal } from '@dmc/contracts';
import { DEFAULT_THRESHOLDS, STATE_CHANGING, resolveAutonomy, type Thresholds } from './autonomy.js';

const M = 'decision';
/** A process that only receives signals (the API) wires `policies`; carrying decisions out needs the other two and happens in the worker. */
export interface Ports { policies: PolicyPort; exceptions?: ExceptionPort; actions?: ActionPort }
export interface DecisionRow {
  id: string; signal_id: string; policy_id: string; route: string | null; escalate_after: string | null; mode: string; matched: boolean | null; outcome: string; reason: string | null;
  effect: PolicyEvaluation['effect']; confidence: number; inputs_hash: string; status: string; attempts: number;
}
const SYSTEM = 'system/decision';

export class DecisionService {
  constructor(private readonly ports: Ports, private readonly thresholds: Thresholds = DEFAULT_THRESHOLDS) {}

  /**
   * One signal in, decisions out. Step 1 (one transaction): store the signal and every decision as `planned`, with evidence.
   * Step 2: carry out the planned decisions through the ports; each is idempotent, so a retry finishes what is left.
   * Delivering the same signal twice does not decide twice.
   */
  async handle(db: Queryable, s: Signal): Promise<{ signalId: string; decisions: DecisionRow[]; replayed: boolean }> {
    const planned = await this.plan(db, s);
    await this.carryOut(db, planned.signalId, s);
    const decisions = (await db.query<DecisionRow>(`select * from ${M}.decision where signal_id = $1 order by policy_id`, [planned.signalId])).rows;
    return { signalId: planned.signalId, decisions, replayed: planned.replayed };
  }

  /**
   * Store the signal and plan its decisions, nothing more. The worker's housekeeping (`resume`) carries them out within a minute.
   * This is what the API uses, so a request never waits on a tool or a notification.
   */
  async intake(db: Queryable, s: Signal): Promise<{ signalId: string; replayed: boolean }> { return this.plan(db, s); }

  private need<K extends 'exceptions' | 'actions'>(k: K): NonNullable<Ports[K]> {
    const p = this.ports[k];
    if (!p) throw new Error(`${k} are not wired in this process: decisions are carried out by the worker`);
    return p as NonNullable<Ports[K]>;
  }

  private async plan(db: Queryable, s: Signal): Promise<{ signalId: string; replayed: boolean }> {
    const evals = await this.ports.policies.evaluate(s.subjectType, s.subjectRef, s.asset); // may record shadow results
    await db.query('begin');
    try {
      const ins = await db.query<{ id: string }>(
        `insert into ${M}.signal (source, key, kind, subject_ref, subject_type, confidence, change, actor) values ($1,$2,$3,$4,$5,$6,$7,$8)
         on conflict (source, key) do nothing returning id`, [s.source, s.key, s.kind, s.subjectRef, s.subjectType, s.confidence ?? 1, s.change ? JSON.stringify(s.change) : null, s.actor ?? null]);
      if (!ins.rows[0]) {
        const old = await db.query<{ id: string }>(`select id from ${M}.signal where source = $1 and key = $2`, [s.source, s.key]);
        await db.query('commit');
        return { signalId: old.rows[0]!.id, replayed: true };
      }
      const signalId = ins.rows[0].id;
      await writeOutbox(db, M, { type: 'signal.received', subjectRef: s.subjectRef, actor: s.actor ?? SYSTEM, payload: { signal: signalId, source: s.source, kind: s.kind } });

      for (const e of evals) {
        const confidence = Math.min(s.confidence ?? 1, e.confidence);
        const { outcome, reason } = this.outcomeFor(e, confidence);
        const status = outcome === 'drop' || outcome === 'shadow' || outcome === 'error' ? 'none' : 'planned';
        // an enforced policy that no longer matches clears what it raised before
        const needsClear = outcome === 'cleared';
        const d = await db.query<{ id: string }>(
          `insert into ${M}.decision (signal_id, policy_id, mode, matched, outcome, reason, effect, route, escalate_after, confidence, inputs_hash, status)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
          [signalId, e.policyId, e.mode, e.matched, outcome, reason ?? null, JSON.stringify(e.effect), e.route ?? null, e.escalateAfter ?? null, confidence, e.inputsHash, needsClear ? 'planned' : status]);
        await writeOutbox(db, M, { type: 'decision.made', subjectRef: s.subjectRef, actor: s.actor ?? SYSTEM,
          payload: { decision: d.rows[0]!.id, signal: signalId, policy: e.policyId, mode: e.mode, matched: e.matched, outcome, inputs_hash: e.inputsHash, ...(reason && { reason }) } });
      }
      await db.query('commit');
      return { signalId, replayed: false };
    } catch (e) { await db.query('rollback'); throw e; }
  }

  private outcomeFor(e: PolicyEvaluation, confidence: number): { outcome: DecisionRow['outcome']; reason?: string } {
    if (e.mode === 'shadow') return { outcome: 'shadow', reason: 'shadow policies are reported, never acted on' };
    if (e.matched === null) return { outcome: 'error', reason: e.error };
    if (!e.matched) return e.effect.action === 'raise_exception' ? { outcome: 'cleared', reason: 'condition no longer holds' } : { outcome: 'drop', reason: 'no match' };
    const reversible = STATE_CHANGING.has(e.effect.action) ? true : undefined;
    const outcome = resolveAutonomy(e.autonomy, confidence, { reversible, thresholds: this.thresholds });
    return { outcome, reason: outcome === 'drop' ? `confidence ${confidence} is below what policy allows` : undefined };
  }

  /** Carry out planned (or previously failed) decisions for a signal. Safe to call again. */
  async carryOut(db: Queryable, signalId: string, s: Pick<Signal, 'subjectRef' | 'actor'>): Promise<void> {
    const todo = await db.query<DecisionRow>(`select * from ${M}.decision where signal_id = $1 and status in ('planned','failed') order by policy_id`, [signalId]);
    const change = (await db.query<{ change: Signal['change'] | null }>(`select change from ${M}.signal where id = $1`, [signalId])).rows[0]?.change ?? undefined;
    for (const d of todo.rows) {
      try {
        await this.apply(d, s.subjectRef, s.actor ?? SYSTEM, change);
        await db.query(`update ${M}.decision set status='applied', applied_at=now(), attempts=attempts+1, last_error=null where id=$1`, [d.id]);
        await writeOutbox(db, M, { type: 'decision.applied', subjectRef: s.subjectRef, actor: SYSTEM, payload: { decision: d.id, outcome: d.outcome } });
      } catch (e) {
        await db.query(`update ${M}.decision set status='failed', attempts=attempts+1, last_error=$2 where id=$1`, [d.id, (e as Error).message]);
      }
    }
  }

  /** Re-run decisions that failed or were planned but not finished (a crash between the two steps). */
  async resume(db: Queryable, limit = 100): Promise<number> {
    const r = await db.query<{ signal_id: string; subject_ref: string; actor: string | null }>(
      `select distinct d.signal_id, s.subject_ref, s.actor from ${M}.decision d join ${M}.signal s on s.id = d.signal_id where d.status in ('planned','failed') limit $1`, [limit]);
    for (const x of r.rows) await this.carryOut(db, x.signal_id, { subjectRef: x.subject_ref, actor: x.actor ?? undefined });
    return r.rows.length;
  }

  private async apply(d: DecisionRow, subjectRef: string, actor: string, change?: Signal['change']): Promise<void> {
    // apply_change: the write comes with the signal, so it becomes the effect's attribute and value
    const e = d.effect.action === 'apply_change' && change ? { ...d.effect, attribute: change.attribute, value: change.value } : d.effect;
    if (d.effect.action === 'apply_change' && !change) return; // a write that was already applied (by a person) has nothing left to apply
    const route = d.route ?? 'platform-governance';
    if (d.outcome === 'cleared') {
      await this.need('exceptions').withdraw({ policyId: d.policy_id, subjectRef, actor });
      return;
    }
    const stateChanging = STATE_CHANGING.has(e.action);
    if (d.outcome === 'propose' || !stateChanging) {
      // a human decides: a task on the policy's route (human-facing effects always go this way)
      await this.need('exceptions').raise({
        kind: stateChanging ? `proposal:${e.action}` : e.action, severity: 'medium', subjectRef, policyId: d.policy_id, actor, route,
        message: e.message ?? (change ? `Proposed change: ${e.attribute} = ${JSON.stringify(e.value)}` : `${e.action} ${e.attribute ?? e.concept ?? ''}`.trim()), escalateAfter: d.escalate_after ?? undefined,
      });
      if (d.outcome === 'act_notify' && !stateChanging) await this.dispatch(d, e, subjectRef, true, route);
      return;
    }
    await this.dispatch(d, e, subjectRef, d.outcome === 'act_notify', route);
  }

  private async dispatch(d: DecisionRow, effect: DecisionRow['effect'], subjectRef: string, notify: boolean, route: string) {
    await this.need('actions').dispatch({ idempotencyKey: `decision:${d.id}`, decisionId: d.id, policyId: d.policy_id, subjectRef, effect, notify, route, escalateAfter: d.escalate_after ?? undefined });
  }
}

export const hashInputs = (policyHash: string, asset: unknown): string => createHash('sha256').update(policyHash + JSON.stringify(asset)).digest('hex');
