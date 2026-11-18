import type { Autonomy, Outcome } from '@dmc/contracts';

export interface Thresholds { act: number; act_notify: number; propose: number }
export const DEFAULT_THRESHOLDS: Thresholds = { act: 0.95, act_notify: 0.8, propose: 0.5 };

const RANK: Record<Outcome, number> = { drop: 0, propose: 1, act_notify: 2, act: 3 };

/** The highest level that this confidence allows. Below the lowest threshold, nothing is allowed. */
export function levelForConfidence(c: number, t: Thresholds = DEFAULT_THRESHOLDS): Outcome {
  if (c >= t.act) return 'act';
  if (c >= t.act_notify) return 'act_notify';
  if (c >= t.propose) return 'propose';
  return 'drop';
}

/** effective = min(ceiling, level allowed by confidence). Actions that cannot be undone never exceed `propose`. */
export function resolveAutonomy(ceiling: Autonomy, confidence: number, opts: { reversible?: boolean; thresholds?: Thresholds } = {}): Outcome {
  const byConfidence = levelForConfidence(confidence, opts.thresholds);
  let level: Outcome = RANK[ceiling] <= RANK[byConfidence] ? ceiling : byConfidence;
  if (opts.reversible === false && RANK[level] > RANK.propose) level = 'propose';
  return level;
}

/** Effects that change DMC state and can be undone (D2 stores the undo). Human-facing effects are not "changes". */
export const STATE_CHANGING = new Set(['set_attribute', 'classify', 'apply_change']);
