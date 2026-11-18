import { writeOutbox, type Queryable } from '@dmc/platform';

const M = 'policy';
export const ENFORCEMENT = 'enforcement';

export interface ControlState { enforcementPaused: boolean; pausedPolicies: string[] }

/**
 * U2. The pause switches: all enforcement, or one policy. Paused policies keep being evaluated and their results kept (as shadow results),
 * but raise no exceptions, tasks or changes. Every change is in the ledger.
 */
export class PolicyControl {
  constructor(private readonly db: Queryable) {}

  async state(): Promise<ControlState> {
    const r = await this.db.query<{ key: string }>(`select key from ${M}.control_state where paused`);
    const keys = r.rows.map((x) => x.key);
    return { enforcementPaused: keys.includes(ENFORCEMENT), pausedPolicies: keys.filter((k) => k.startsWith('policy:')).map((k) => k.slice(7)).sort() };
  }

  private async set(key: string, paused: boolean, actor: string, subjectRef: string, type: string): Promise<boolean> {
    await this.db.query('begin');
    try {
      const before = await this.db.query<{ paused: boolean }>(`select paused from ${M}.control_state where key = $1 for update`, [key]);
      if ((before.rows[0]?.paused ?? false) === paused) { await this.db.query('rollback'); return false; }
      await this.db.query(`insert into ${M}.control_state (key, paused, changed_by) values ($1,$2,$3)
        on conflict (key) do update set paused = excluded.paused, changed_by = excluded.changed_by, changed_at = now()`, [key, paused, actor]);
      await writeOutbox(this.db, M, { type: `${type}.${paused ? 'paused' : 'resumed'}`, subjectRef, actor, payload: { key } });
      await this.db.query('commit');
      return true;
    } catch (e) { await this.db.query('rollback'); throw e; }
  }

  /** Returns false when it was already so (nothing written). */
  setEnforcement(paused: boolean, actor: string): Promise<boolean> { return this.set(ENFORCEMENT, paused, actor, 'control/enforcement', 'policy.enforcement'); }
  setPolicy(id: string, paused: boolean, actor: string): Promise<boolean> { return this.set(`policy:${id}`, paused, actor, `Policy:${id}`, 'policy'); }
}
