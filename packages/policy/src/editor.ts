import { parse } from 'yaml';
import type { Registry } from '@dmc/platform';
import { compilePolicy, PolicyError, type PolicyIR } from './compile.js';
import { findConflicts, type Conflict, type Sample } from './conflicts.js';
import type { GoldenCase } from './golden.js';

/**
 * P3. What the policy editor needs behind it: check a draft (compile, golden cases, conflicts, a dry run over sample assets) and
 * produce the report that goes on the pull request. Nothing is saved here; saving opens a pull request.
 */
export interface DryRun { type: string; sampled: number; matched: number; errors: number; matches: string[]; note: string }
export interface DraftReport {
  ok: boolean;
  policy?: { id: string; control: string; mode: string; type: string; implements?: string };
  problems: string[];
  cases: { name: string; pass: boolean; detail?: string }[];
  conflicts: Conflict[];
  dryRun?: DryRun;
}

export function checkDraft(yaml: string, goldenYaml: string | undefined, registry: Registry, existing: PolicyIR[], sample: Sample = {}): DraftReport {
  // a policy's file is named after it, so the draft is compiled under that name
  let named: unknown; try { named = (parse(yaml) as { policy?: unknown } | null)?.policy; } catch { /* the compiler reports it */ }
  const file = typeof named === 'string' && /^[a-z0-9-]+$/.test(named) ? `${named}.yaml` : 'draft.yaml';
  const rep: DraftReport = { ok: false, problems: [], cases: [], conflicts: [] };
  let ir: PolicyIR;
  try { ir = compilePolicy(yaml, registry, file); }
  catch (e) { if (e instanceof PolicyError) { rep.problems.push(...e.problems); return rep; } throw e; }
  rep.policy = { id: ir.id, control: ir.control, mode: ir.mode, type: ir.scopeKeys.type, ...(ir.implements ? { implements: ir.implements } : {}) };

  let cases: GoldenCase[] = [];
  if (!goldenYaml) rep.problems.push('no golden cases: every policy needs at least one that matches and one that does not');
  else {
    try { cases = ((parse(goldenYaml) as { cases?: GoldenCase[] } | null)?.cases) ?? []; } catch (e) { rep.problems.push(`golden cases: ${(e as Error).message.split('\n')[0]}`); }
    if (!cases.some((c) => c.expect === true) || !cases.some((c) => c.expect === false)) rep.problems.push('golden cases need one that matches and one that does not');
  }
  for (const c of cases) {
    const r = ir.evaluate(c.asset ?? {});
    const got = r.ok ? r.matched : 'error';
    rep.cases.push({ name: c.name, pass: got === c.expect, detail: got === c.expect ? undefined : `expected ${c.expect}, got ${got}${r.ok ? '' : ` (${r.error})`}` });
  }

  const others = existing.filter((p) => p.id !== ir.id);
  rep.conflicts = findConflicts([...others, ir], sample, ir.id);

  const assets = sample[ir.scopeKeys.type] ?? [];
  const matches: string[] = []; let errors = 0;
  for (const a of assets) { const r = ir.evaluate(a); if (!r.ok) errors++; else if (r.matched) matches.push(String(a.qualified_name ?? '')); }
  rep.dryRun = { type: ir.scopeKeys.type, sampled: assets.length, matched: matches.length, errors, matches: matches.slice(0, 20),
    note: 'Evaluated on each sampled asset’s own attributes; a rule that reads an edge cannot be evaluated here and counts as an error.' };
  rep.ok = rep.problems.length === 0 && rep.cases.every((c) => c.pass) && rep.conflicts.length === 0;
  return rep;
}

/** The dry-run report, as it is attached to the pull request. */
export function renderReport(r: DraftReport): string {
  const L: string[] = [`## DMC dry-run report: ${r.ok ? 'passed' : 'FAILED'}`, ''];
  if (r.policy) L.push(`Policy \`${r.policy.id}\` · control ${r.policy.control} · mode **${r.policy.mode}** · on ${r.policy.type}${r.policy.implements ? ` · implements ${r.policy.implements}` : ''}`, '');
  if (r.problems.length) L.push('### Problems', ...r.problems.map((p) => `- ${p}`), '');
  if (r.cases.length) L.push('### Golden cases', ...r.cases.map((c) => `- ${c.pass ? 'pass' : 'FAIL'}: ${c.name}${c.detail ? ` (${c.detail})` : ''}`), '');
  L.push('### Conflicts', ...(r.conflicts.length ? r.conflicts.map((c) => `- ${c.a} and ${c.b}: ${c.reason} (${c.overlap})`) : ['- none']), '');
  if (r.dryRun) L.push('### Dry run', `${r.dryRun.matched} of ${r.dryRun.sampled} sampled ${r.dryRun.type} assets match; ${r.dryRun.errors} could not be evaluated.`, r.dryRun.note, ...(r.dryRun.matches.length ? ['', ...r.dryRun.matches.map((m) => `- ${m}`)] : []), '');
  return L.join('\n');
}
