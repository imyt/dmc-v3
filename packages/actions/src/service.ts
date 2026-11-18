import { ApiError, writeOutbox, type Queryable } from '@dmc/platform';
import type { ActionPort, ActionRequest, CatalogWritePort, ExceptionPort, NotifyPort, ToolTaskPort } from '@dmc/contracts';

const M = 'actions';
const SYSTEM = 'system/actions';

export interface Ports { catalog: CatalogWritePort; notify: NotifyPort; tasks: ToolTaskPort; exceptions: ExceptionPort }

const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
/** "10d" -> milliseconds. Returns undefined for anything else. */
export const durationMs = (s: string | undefined): number | undefined => {
  const m = /^(\d+)([mhd])$/.exec(s ?? '');
  return m ? Number(m[1]) * UNIT_MS[m[2] as keyof typeof UNIT_MS] : undefined;
};
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** What a sync run saw: the record it read, with the attributes it mapped. */
export interface Observation { subjectRef: string; attributes: Record<string, unknown> }
interface PendingRow { id: string; action_id: string; subject_ref: string; attribute: string; expected: unknown; route: string; due_by: Date | null; state: string; policy_id: string }
export interface ActionRow { id: string; idempotency_key: string; policy_id: string; subject_ref: string; kind: string; effect: Record<string, unknown>; status: string; switch_scope: string | null; undo: { attribute: string; previous: unknown; applied: unknown } | null }

export const scopes = (policyId: string, effect: string): string[] => ['all', `policy:${policyId}`, `effect:${effect}`];

export class ActionService implements ActionPort {
  constructor(private readonly db: Queryable, private readonly ports: Ports) {}

  // ---- kill switches ----

  async pause(scope: string, reason: string, actor: string): Promise<void> {
    await this.db.query(`insert into ${M}.kill_switch (scope, reason, set_by) values ($1,$2,$3) on conflict (scope) do update set reason = excluded.reason, set_by = excluded.set_by, set_at = now()`, [scope, reason, actor]);
    await writeOutbox(this.db, M, { type: 'switch.paused', subjectRef: `switch/${scope}`, actor, payload: { scope, reason } });
  }
  async release(scope: string, actor: string): Promise<void> {
    const r = await this.db.query(`delete from ${M}.kill_switch where scope = $1`, [scope]);
    if (r.rowCount) await writeOutbox(this.db, M, { type: 'switch.released', subjectRef: `switch/${scope}`, actor, payload: { scope } });
  }
  async switches(): Promise<{ scope: string; reason: string; set_by: string }[]> {
    return (await this.db.query<{ scope: string; reason: string; set_by: string }>(`select scope, reason, set_by from ${M}.kill_switch order by scope`)).rows;
  }
  private async blockedBy(policyId: string, effect: string): Promise<string | undefined> {
    const r = await this.db.query<{ scope: string }>(`select scope from ${M}.kill_switch where scope = any($1) limit 1`, [scopes(policyId, effect)]);
    return r.rows[0]?.scope;
  }

  // ---- dispatch ----

  /** Carries out one action. The same idempotency key returns the first result. A kill switch records the action as blocked and does nothing else. */
  async dispatch(req: ActionRequest): Promise<{ id: string }> {
    const kind = this.kindOf(req);
    const ins = await this.db.query<{ id: string }>(
      `insert into ${M}.action (idempotency_key, decision_id, policy_id, subject_ref, kind, effect, status, actor)
       values ($1,$2,$3,$4,$5,$6,'failed',$7) on conflict (idempotency_key) do nothing returning id`,
      [req.idempotencyKey, req.decisionId, req.policyId, req.subjectRef, kind, JSON.stringify(req.effect), SYSTEM]);
    if (!ins.rows[0]) {
      const old = await this.db.query<ActionRow>(`select * from ${M}.action where idempotency_key = $1`, [req.idempotencyKey]);
      const a = old.rows[0]!;
      if (a.status === 'blocked' || a.status === 'failed') return this.run(a, req); // re-attempt: still idempotent underneath
      return { id: a.id };
    }
    const a = (await this.db.query<ActionRow>(`select * from ${M}.action where id = $1`, [ins.rows[0].id])).rows[0]!;
    return this.run(a, req);
  }

  private kindOf(req: ActionRequest): 'dmc_change' | 'tool_task' | 'notify' {
    if (req.effect.action === 'notify') return 'notify';
    if (req.effect.action === 'classify') return 'tool_task'; // classes come from the classification tool; DMC asks its owner
    return 'dmc_change';
  }

  private async run(a: ActionRow, req: ActionRequest): Promise<{ id: string }> {
    const sw = await this.blockedBy(a.policy_id, String(a.effect.action));
    if (sw) {
      await this.db.query(`update ${M}.action set status='blocked', switch_scope=$2 where id=$1`, [a.id, sw]);
      await writeOutbox(this.db, M, { type: 'action.blocked', subjectRef: a.subject_ref, actor: SYSTEM, payload: { action: a.id, policy: a.policy_id, switch: sw } });
      return { id: a.id };
    }
    try {
      if (a.kind === 'dmc_change') await this.dmcChange(a, req);
      else if (a.kind === 'tool_task') await this.toolTask(a, req);
      else await this.ports.notify.send({ route: req.route ?? 'platform-governance', subjectRef: a.subject_ref, message: String(a.effect.message ?? ''), actor: SYSTEM });
      if (req.notify && a.kind !== 'notify')
        await this.ports.notify.send({ route: req.route ?? 'platform-governance', subjectRef: a.subject_ref, message: `${a.policy_id} changed ${a.subject_ref}`, actor: SYSTEM });
    } catch (e) {
      await this.db.query(`update ${M}.action set status='failed' where id=$1`, [a.id]);
      throw e;
    }
    return { id: a.id };
  }

  private async dmcChange(a: ActionRow, req: ActionRequest): Promise<void> {
    const attribute = String(a.effect.attribute);
    const source = await this.ports.catalog.sourceOf(a.subject_ref, attribute);
    if (source !== 'dmc') throw new ApiError('validation_failed', `${attribute} is owned by ${source ?? 'an unknown source'}; DMC cannot write it`);
    const r = await this.ports.catalog.setAttribute(a.subject_ref, attribute, a.effect.value, SYSTEM);
    await this.db.query(`update ${M}.action set status='done', finished_at=now(), undo=$2 where id=$1`, [a.id, JSON.stringify({ attribute, previous: r.previous ?? null, applied: a.effect.value, changed: r.changed })]);
    await writeOutbox(this.db, M, { type: 'action.done', subjectRef: a.subject_ref, actor: SYSTEM, payload: { action: a.id, policy: a.policy_id, attribute, changed: r.changed } });
    void req;
  }

  private async toolTask(a: ActionRow, req: ActionRequest): Promise<void> {
    const attribute = String(a.effect.attribute ?? a.effect.concept ?? '');
    const expected = a.effect.value ?? a.effect.concept ?? null;
    const route = req.route ?? 'platform-governance';
    const wait = durationMs(req.escalateAfter);
    const dueBy = wait ? new Date(Date.now() + wait) : undefined;
    await this.ports.tasks.create({ route, subjectRef: a.subject_ref, message: String(a.effect.message ?? `Make this change in the owning tool: ${attribute}`), attribute, expected, dueBy: dueBy?.toISOString(), actor: SYSTEM, policyId: a.policy_id });
    await this.db.query(`insert into ${M}.pending_change (action_id, subject_ref, attribute, expected, route, due_by) values ($1,$2,$3,$4,$5,$6)`, [a.id, a.subject_ref, attribute, JSON.stringify(expected), route, dueBy ?? null]);
    await this.db.query(`update ${M}.action set status='pending_confirmation', finished_at=now() where id=$1`, [a.id]);
    await writeOutbox(this.db, M, { type: 'action.pending', subjectRef: a.subject_ref, actor: SYSTEM, payload: { action: a.id, policy: a.policy_id, attribute } });
  }

  // ---- undo ----

  /** Restore what the action changed. Refused if someone has changed the value since. */
  async undo(actionId: string, actor: string): Promise<void> {
    const r = await this.db.query<ActionRow>(`select * from ${M}.action where id = $1 for update`, [actionId]);
    const a = r.rows[0];
    if (!a) throw new ApiError('not_found', 'No such action');
    if (a.status === 'undone') return;
    if (a.kind !== 'dmc_change' || a.status !== 'done' || !a.undo) throw new ApiError('conflict', 'This action cannot be undone');
    const current = await this.ports.catalog.getAttribute(a.subject_ref, a.undo.attribute);
    if (JSON.stringify(current) !== JSON.stringify(a.undo.applied)) throw new ApiError('conflict', 'The value has changed since this action; undo would overwrite a newer change');
    await this.ports.catalog.setAttribute(a.subject_ref, a.undo.attribute, a.undo.previous, actor);
    await this.db.query(`update ${M}.action set status='undone', undone_at=now(), undone_by=$2 where id=$1`, [actionId, actor]);
    await writeOutbox(this.db, M, { type: 'action.undone', subjectRef: a.subject_ref, actor, payload: { action: actionId, attribute: a.undo.attribute } });
  }

  /** After a switch is released: send the blocked actions again. */
  async retryBlocked(): Promise<number> {
    const r = await this.db.query<ActionRow & { decision_id: string }>(`select * from ${M}.action where status = 'blocked' order by created_at`);
    let n = 0;
    for (const a of r.rows) {
      if (await this.blockedBy(a.policy_id, String(a.effect.action))) continue;
      await this.run(a, { idempotencyKey: a.idempotency_key, decisionId: a.decision_id, policyId: a.policy_id, subjectRef: a.subject_ref, effect: a.effect as never, notify: false });
      n++;
    }
    return n;
  }

  // ---- D3: confirm on sync, else escalate ----

  /**
   * A sync run reports what it saw. A pending change is confirmed when the source that owns the attribute now shows the expected
   * value. An escalated change that turns out to be done is confirmed too, and its exception is withdrawn.
   */
  async confirmOnSync(source: string, observed: Observation[], now: Date = new Date()): Promise<{ confirmed: number }> {
    let confirmed = 0;
    for (const o of observed) {
      const r = await this.db.query<PendingRow>(
        `select p.*, a.policy_id from ${M}.pending_change p join ${M}.action a on a.id = p.action_id
          where p.subject_ref = $1 and p.state in ('pending', 'escalated') order by p.created_at`, [o.subjectRef]);
      for (const p of r.rows) {
        if (!(p.attribute in o.attributes) || !same(o.attributes[p.attribute], p.expected)) continue;
        const owner = await this.ports.catalog.sourceOf(p.subject_ref, p.attribute);
        if (owner !== undefined && owner !== source) continue; // only the owning tool can confirm
        await this.db.query('begin');
        try {
          await this.db.query(`update ${M}.pending_change set state = 'confirmed', confirmed_at = $2 where id = $1`, [p.id, now]);
          await this.db.query(`update ${M}.action set status = 'done', finished_at = $2 where id = $1 and status = 'pending_confirmation'`, [p.action_id, now]);
          await writeOutbox(this.db, M, { type: 'action.confirmed', subjectRef: p.subject_ref, actor: SYSTEM, payload: { action: p.action_id, attribute: p.attribute, source, wasEscalated: p.state === 'escalated' } });
          await this.db.query('commit');
        } catch (e) { await this.db.query('rollback'); throw e; }
        if (p.state === 'escalated') await this.ports.exceptions.withdraw({ policyId: p.policy_id, subjectRef: p.subject_ref, actor: SYSTEM });
        confirmed++;
      }
    }
    return { confirmed };
  }

  /** Run on a timer. Changes past their deadline become an exception for the route that owns the tool. */
  async escalateOverdue(now: Date = new Date()): Promise<number> {
    const r = await this.db.query<PendingRow>(
      `select p.*, a.policy_id from ${M}.pending_change p join ${M}.action a on a.id = p.action_id
        where p.state = 'pending' and p.due_by is not null and p.due_by <= $1 order by p.due_by`, [now]);
    let n = 0;
    for (const p of r.rows) {
      const claimed = await this.db.query(`update ${M}.pending_change set state = 'escalated' where id = $1 and state = 'pending'`, [p.id]);
      if (claimed.rowCount !== 1) continue;
      await this.ports.exceptions.raise({
        kind: 'pending_change.overdue', severity: 'medium', subjectRef: p.subject_ref, policyId: p.policy_id, route: p.route, actor: SYSTEM,
        message: `${p.attribute} was not changed in the owning tool by ${p.due_by!.toISOString().slice(0, 10)}`,
      });
      await writeOutbox(this.db, M, { type: 'action.escalated', subjectRef: p.subject_ref, actor: SYSTEM, payload: { action: p.action_id, attribute: p.attribute } });
      n++;
    }
    return n;
  }

  async get(id: string): Promise<ActionRow | undefined> {
    return (await this.db.query<ActionRow>(`select * from ${M}.action where id = $1`, [id])).rows[0];
  }
}
