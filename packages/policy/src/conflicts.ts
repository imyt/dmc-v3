import type { PolicyIR } from './compile.js';

export interface Conflict { a: string; b: string; reason: string; overlap: 'possible' | 'confirmed' }
export type Sample = Record<string, Record<string, unknown>[]>; // asset type -> sample entities

/** Can the two scopes select the same asset? Different types, domains or scopes cannot overlap. */
export function scopesCanOverlap(a: PolicyIR, b: PolicyIR): boolean {
  const x = a.scopeKeys, y = b.scopeKeys;
  if (x.type !== y.type) return false;
  for (const k of ['domain', 'scope'] as const) if (x[k] && y[k] && x[k] !== y[k]) return false;
  return true;
}

/** Two effects contradict when they set the same attribute to different values. */
export function effectsContradict(a: PolicyIR, b: PolicyIR): string | undefined {
  const x = a.effect, y = b.effect;
  if (x.action === 'set_attribute' && y.action === 'set_attribute' && x.attribute === y.attribute && JSON.stringify(x.value) !== JSON.stringify(y.value))
    return `both set ${x.attribute} (${JSON.stringify(x.value)} vs ${JSON.stringify(y.value)})`;
  return undefined;
}

/**
 * Pairs of policies whose scopes can overlap and whose effects contradict. With a sample of real assets,
 * a pair is dropped if no sampled asset satisfies both conditions (the overlap cannot occur in practice).
 * `candidate` limits the check to pairs that include that policy (a pull request checks its own policy).
 */
export function findConflicts(policies: PolicyIR[], sample: Sample = {}, candidate?: string): Conflict[] {
  const out: Conflict[] = [];
  for (let i = 0; i < policies.length; i++)
    for (let j = i + 1; j < policies.length; j++) {
      const a = policies[i]!, b = policies[j]!;
      if (candidate && a.id !== candidate && b.id !== candidate) continue;
      if (!scopesCanOverlap(a, b)) continue;
      const reason = effectsContradict(a, b);
      if (!reason) continue;
      const assets = sample[a.scopeKeys.type] ?? [];
      if (assets.length) {
        const both = assets.some((x) => {
          const ra = a.evaluate(x), rb = b.evaluate(x);
          return ra.ok && rb.ok && ra.matched && rb.matched;
        });
        if (!both) continue;
        out.push({ a: a.id, b: b.id, reason, overlap: 'confirmed' });
      } else out.push({ a: a.id, b: b.id, reason, overlap: 'possible' });
    }
  return out;
}

export interface DryRunReport {
  policy: string; mode: string; evaluated: number; matched: number; errors: number;
  errorKinds: Record<string, number>; examples: string[]; conflicts: Conflict[]; blocked: boolean;
}

/** What would this policy do to today's data? Raises nothing and changes nothing. */
export function dryRun(policy: PolicyIR, assets: Record<string, unknown>[], opts: { others?: PolicyIR[]; examples?: number } = {}): DryRunReport {
  let matched = 0, errors = 0;
  const kinds: Record<string, number> = {};
  const examples: string[] = [];
  for (const a of assets) {
    const r = policy.evaluate(a);
    if (!r.ok) { errors++; kinds[r.error] = (kinds[r.error] ?? 0) + 1; continue; }
    if (r.matched) { matched++; if (examples.length < (opts.examples ?? 5)) examples.push(String(a.qualified_name ?? '?')); }
  }
  const conflicts = findConflicts([...(opts.others ?? []).filter((p) => p.id !== policy.id), policy], { [policy.scopeKeys.type]: assets }, policy.id);
  return { policy: policy.id, mode: policy.mode, evaluated: assets.length, matched, errors, errorKinds: kinds, examples, conflicts, blocked: conflicts.length > 0 };
}

/** Markdown for the pull request comment. */
export function formatDryRun(r: DryRunReport): string {
  const lines = [
    `### Dry run: \`${r.policy}\` (${r.mode})`,
    `Evaluated ${r.evaluated} assets: **${r.matched} would match**, ${r.errors} could not be evaluated.`,
  ];
  if (r.examples.length) lines.push(`Examples: ${r.examples.map((e) => `\`${e}\``).join(', ')}`);
  for (const [k, n] of Object.entries(r.errorKinds)) lines.push(`- ${n} × ${k}`);
  if (r.conflicts.length) lines.push('', '**Blocked: conflicts with existing policies**', ...r.conflicts.map((c) => `- \`${c.a}\` vs \`${c.b}\`: ${c.reason} (${c.overlap} overlap)`));
  else lines.push('', 'No conflicts.');
  return lines.join('\n');
}
