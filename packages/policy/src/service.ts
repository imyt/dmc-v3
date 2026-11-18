import { createHash } from 'node:crypto';
import type { Queryable } from '@dmc/platform';
import type { PolicyEvaluation, PolicyPort } from '@dmc/contracts';
import type { PolicyIR } from './compile.js';
import { PolicyIndex } from './load.js';
import { evaluateAsset, recordShadow } from './shadow.js';
import { PolicyControl } from './control.js';

const stable = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));
const policyHash = (p: PolicyIR) => createHash('sha256').update(stable({ id: p.id, when: p.when, effect: p.effect, mode: p.mode, route: p.route, autonomy: p.autonomy, confidence: p.confidence })).digest('hex');

/** What other modules see of policy (the `PolicyPort`). Shadow results are stored here; nothing is raised or changed. */
export class PolicyService implements PolicyPort {
  constructor(private readonly db: Queryable, private readonly index: PolicyIndex) {}

  async evaluate(assetType: string, subjectRef: string, asset: Record<string, unknown>): Promise<PolicyEvaluation[]> {
    // a paused policy (or all of them) is judged as a shadow policy: recorded, never acted on
    const paused = await new PolicyControl(this.db).state();
    const evals = evaluateAsset(this.index.forType(assetType), asset).map((e) =>
      e.policy.mode === 'enforced' && (paused.enforcementPaused || paused.pausedPolicies.includes(e.policy.id)) ? { ...e, policy: { ...e.policy, mode: 'shadow' as const } } : e);
    await recordShadow(this.db, subjectRef, evals);
    const assetHash = createHash('sha256').update(stable(asset)).digest('hex');
    return evals.map((e) => ({
      policyId: e.policy.id, control: e.policy.control, mode: e.policy.mode, matched: e.matched, error: e.error,
      effect: e.policy.effect, route: e.policy.route,
      escalateAfter: e.policy.escalateAfterMs ? toDuration(e.policy.escalateAfterMs) : undefined,
      autonomy: e.policy.autonomy, confidence: e.policy.confidence,
      inputsHash: createHash('sha256').update(policyHash(e.policy) + assetHash).digest('hex'),
    }));
  }
}

function toDuration(ms: number): string {
  if (ms % 86_400_000 === 0) return `${ms / 86_400_000}d`;
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  return `${Math.round(ms / 60_000)}m`;
}
