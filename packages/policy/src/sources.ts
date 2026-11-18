import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import type { Registry } from '@dmc/platform';
import { compilePolicy } from './compile.js';
import { readOverlay } from './load.js';

/**
 * P3. A policy as it is stored in the policies folder: its YAML and its golden cases as text, for the editor to open.
 * Policy files are metadata about rules, never data values from source systems (rule 8).
 */
export interface PolicySource {
  id: string;
  /** path relative to the repo, with forward slashes, for example `policies/examples/application-has-owner.yaml` */
  path: string;
  type: string;
  control: string;
  implements?: string;
  /** the mode the file says */
  sourceMode: 'shadow' | 'enforced';
  /** the mode in force in this environment (the file's, unless `env/<environment>.yaml` overrides it) */
  mode: 'shadow' | 'enforced';
  /** false when this environment's overlay disables the policy */
  effective: boolean;
  yaml: string;
  /** null when the policy has no golden file */
  golden: string | null;
  /** sha256 over the YAML and the golden text; the editor can send it back to say which stored version a change starts from */
  checksum: string;
}

export const sourceChecksum = (yaml: string, golden: string | null): string => createHash('sha256').update(yaml).update('\n--golden--\n').update(golden ?? '').digest('hex');

/** Reads every policy file under `dir` (as `loadPolicies` does, so call it after that has succeeded), sorted by id. */
export function listPolicySources(dir: string, registry: Registry, environment: string, repoRelative = 'policies'): PolicySource[] {
  const overlay = readOverlay(dir, environment);
  const files = (readdirSync(dir, { recursive: true }) as string[]).filter((f) => /\.ya?ml$/.test(f) && !/\.golden\.ya?ml$/.test(f) && !/^env[\\/]/.test(f)).sort();
  const out: PolicySource[] = [];
  for (const f of files) {
    const path = join(dir, f);
    const yaml = readFileSync(path, 'utf8');
    const ir = compilePolicy(yaml, registry, f);
    const goldenPath = path.replace(/\.ya?ml$/, '.golden.yaml');
    const golden = existsSync(goldenPath) ? readFileSync(goldenPath, 'utf8') : null;
    const effective = !(overlay.disabled ?? []).includes(ir.id);
    out.push({
      id: ir.id, path: `${repoRelative}/${f.split(sep).join('/')}`, type: ir.scopeKeys.type, control: ir.control, ...(ir.implements ? { implements: ir.implements } : {}),
      sourceMode: ir.mode, mode: overlay.overrides?.[ir.id]?.mode ?? ir.mode, effective, yaml, golden, checksum: sourceChecksum(yaml, golden),
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
