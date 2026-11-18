import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { Registry } from '@dmc/platform';
import { compilePolicy, PolicyError, type PolicyIR } from './compile.js';

export interface GoldenCase { name: string; asset: Record<string, unknown>; expect: boolean | 'error' }
export interface PolicyReport { file: string; policy?: PolicyIR; problems: string[]; cases: { name: string; pass: boolean; detail?: string }[] }

/** Compile every `*.yaml` under `dir` (except `*.golden.yaml`) and run its golden cases from `<name>.golden.yaml`. */
export function runPolicyDir(dir: string, registry: Registry): PolicyReport[] {
  const reports: PolicyReport[] = [];
  const files = (readdirSync(dir, { recursive: true }) as string[]).filter((f) => /\.ya?ml$/.test(f) && !/\.golden\.ya?ml$/.test(f) && !/^env[\\/]/.test(f)).sort();
  const ids = new Map<string, string>();
  for (const f of files) {
    const path = join(dir, f);
    const report: PolicyReport = { file: f, problems: [], cases: [] };
    reports.push(report);
    try {
      const ir = compilePolicy(readFileSync(path, 'utf8'), registry, f);
      report.policy = ir;
      if (ids.has(ir.id)) report.problems.push(`duplicate policy id ${ir.id} (also in ${ids.get(ir.id)})`);
      ids.set(ir.id, f);
      const goldenPath = path.replace(/\.ya?ml$/, '.golden.yaml');
      if (!existsSync(goldenPath)) { report.problems.push('no golden file: every policy needs at least one passing and one failing case'); continue; }
      const cases = (parse(readFileSync(goldenPath, 'utf8')) as { cases?: GoldenCase[] }).cases ?? [];
      if (!cases.some((c) => c.expect === true) || !cases.some((c) => c.expect === false)) report.problems.push('golden file needs a case that matches and one that does not');
      for (const c of cases) {
        const r = ir.evaluate(c.asset);
        const got = r.ok ? r.matched : 'error';
        report.cases.push({ name: c.name, pass: got === c.expect, detail: got === c.expect ? undefined : `expected ${c.expect}, got ${got}${r.ok ? '' : ` (${r.error})`}` });
      }
    } catch (e) {
      if (e instanceof PolicyError) report.problems.push(...e.problems);
      else throw e;
    }
  }
  return reports;
}

export const failures = (reports: PolicyReport[]): string[] =>
  reports.flatMap((r) => [...r.problems.map((p) => `${r.file}: ${p}`), ...r.cases.filter((c) => !c.pass).map((c) => `${r.file}: case "${c.name}" ${c.detail}`)]);
