import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { Registry } from '@dmc/platform';
import { compilePolicy, PolicyError, type PolicyIR } from './compile.js';
import { runPolicyDir, failures } from './golden.js';

export interface EnvOverlay {
  /** policy id -> fields that differ in this environment (only `mode` for now) */
  overrides?: Record<string, { mode?: 'shadow' | 'enforced' }>;
  disabled?: string[];
}

/** `env/<environment>.yaml` under `dir`, or an empty overlay when the environment has none. */
export function readOverlay(dir: string, environment: string): EnvOverlay {
  const overlayPath = join(dir, 'env', `${environment}.yaml`);
  return existsSync(overlayPath) ? (parse(readFileSync(overlayPath, 'utf8')) as EnvOverlay) ?? {} : {};
}

/** Loads every policy under `dir`, applies `env/<environment>.yaml`, and returns the active set. Throws if anything fails to compile or its golden tests fail. */
export function loadPolicies(dir: string, registry: Registry, environment: string): PolicyIR[] {
  const reports = runPolicyDir(dir, registry);
  const bad = failures(reports);
  if (bad.length) throw new PolicyError(dir, bad);

  const overlayPath = join(dir, 'env', `${environment}.yaml`);
  const overlay = readOverlay(dir, environment);
  const policies = reports.filter((r) => r.policy && !r.file.startsWith('env')).map((r) => r.policy!);
  const ids = new Set(policies.map((p) => p.id));
  const unknown = [...Object.keys(overlay.overrides ?? {}), ...(overlay.disabled ?? [])].filter((i) => !ids.has(i));
  if (unknown.length) throw new PolicyError(overlayPath, unknown.map((i) => `overlay names unknown policy ${i}`));

  return policies
    .filter((p) => !(overlay.disabled ?? []).includes(p.id))
    .map((p) => ({ ...p, mode: overlay.overrides?.[p.id]?.mode ?? p.mode }));
}

/** Active policies indexed by the type they apply to, so a signal loads only the few that can match. */
export class PolicyIndex {
  private readonly byType = new Map<string, PolicyIR[]>();
  constructor(readonly policies: PolicyIR[]) {
    for (const p of policies) {
      const list = this.byType.get(p.scopeKeys.type) ?? [];
      list.push(p);
      this.byType.set(p.scopeKeys.type, list);
    }
  }
  forType(type: string): PolicyIR[] { return this.byType.get(type) ?? []; }
  get(id: string): PolicyIR | undefined { return this.policies.find((p) => p.id === id); }
}
