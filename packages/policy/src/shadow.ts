import type { Queryable } from '@dmc/platform';
import type { PolicyIR } from './compile.js';

export interface Evaluation { policy: PolicyIR; matched: boolean | null; error?: string }

/** Evaluate every policy that applies to an asset of `type`. Pure: no storage, no side effects. */
export function evaluateAsset(policies: PolicyIR[], asset: Record<string, unknown>, now?: Date): Evaluation[] {
  return policies.map((policy) => {
    const r = policy.evaluate(asset, now);
    return r.ok ? { policy, matched: r.matched } : { policy, matched: null, error: r.error };
  });
}

/** Stores shadow results (latest per policy and subject). Enforced policies are not recorded here. */
export async function recordShadow(db: Queryable, subjectRef: string, evals: Evaluation[]): Promise<number> {
  const shadow = evals.filter((e) => e.policy.mode === 'shadow');
  for (const e of shadow)
    await db.query(
      `insert into policy.shadow_result (policy_id, policy_mode, subject_ref, matched, error, evaluated_at) values ($1,'shadow',$2,$3,$4,now())
       on conflict (policy_id, subject_ref) do update set matched = excluded.matched, error = excluded.error, evaluated_at = excluded.evaluated_at`,
      [e.policy.id, subjectRef, e.matched, e.error ?? null]);
  return shadow.length;
}

export interface ShadowSummary { policyId: string; evaluated: number; matched: number; errors: number }

/** What a shadow policy would have done so far: for the policy author and for auditors. */
export async function shadowSummary(db: Queryable, policyId?: string): Promise<ShadowSummary[]> {
  const r = await db.query<{ policy_id: string; n: string; m: string; e: string }>(
    `select policy_id, count(*) n, count(*) filter (where matched) m, count(*) filter (where error is not null) e
       from policy.shadow_result where ($1::text is null or policy_id = $1) group by policy_id order by policy_id`, [policyId ?? null]);
  return r.rows.map((x) => ({ policyId: x.policy_id, evaluated: Number(x.n), matched: Number(x.m), errors: Number(x.e) }));
}
