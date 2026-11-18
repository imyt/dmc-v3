import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { Environment, parse as celParse } from '@marcbachmann/cel-js';
import { parse as yamlParse } from 'yaml';
import type { Registry } from '@dmc/platform';

export class PolicyError extends Error {
  constructor(readonly file: string, readonly problems: string[]) {
    super(`${file}:\n - ${problems.join('\n - ')}`);
  }
}

export type Autonomy = 'propose' | 'act_notify' | 'act';

/** Compiled form (the "IR"): what live evaluation, dry run and staged rollout all run. */
export interface PolicyIR {
  id: string;
  control: string;
  implements?: string;
  mode: 'shadow' | 'enforced';
  /** keys used to find the policies that apply to an asset */
  scopeKeys: { type: string; category: string; concept?: string; domain?: string; scope?: string };
  /** name of the CEL variable that holds the asset */
  binding: string;
  when: string;
  effect: { action: string; message?: string; attribute?: string; value?: unknown; concept?: string };
  route?: string;
  escalateAfterMs?: number;
  autonomy: Autonomy;
  confidence: number;
  /** attributes and edges of the scope type the expression reads */
  reads: string[];
  evaluate(asset: Record<string, unknown>, now?: Date): EvalResult;
}
export type EvalResult = { ok: true; matched: boolean } | { ok: false; error: string };

const SCHEMA = JSON.parse(readFileSync(new URL('../schema/policy.schema.json', import.meta.url), 'utf8')) as object;
const validateSchema = new Ajv2020({ allErrors: true, strict: false }).compile(SCHEMA);

export const bindingFor = (type: string): string => type.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
const BUILTIN = new Set(['qualified_name', 'type', 'lifecycle']);
const UNIT = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/** Names read directly off the asset variable, e.g. `integration.transfers` → transfers. */
function reads(node: any, binding: string, out = new Set<string>()): Set<string> {
  if (!node || typeof node !== 'object') return out;
  if (node.op === '.' && node.args?.[0]?.op === 'id' && node.args[0].args === binding) out.add(String(node.args[1]));
  if (Array.isArray(node.args)) {
    for (const a of node.args) {
      if (Array.isArray(a)) a.forEach((x) => reads(x, binding, out));
      else reads(a, binding, out);
    }
  }
  return out;
}

/**
 * Parse, check and compile one policy. Checks the schema, the metamodel (type, attributes, edges, concepts)
 * and the CEL expression (parses, only known variables, returns a boolean). Throws PolicyError with every problem found.
 */
export function compilePolicy(yamlText: string, registry: Registry, file = 'policy.yaml'): PolicyIR {
  let doc: any;
  try { doc = yamlParse(yamlText); } catch (e) { throw new PolicyError(file, [`not valid YAML: ${(e as Error).message}`]); }
  if (!validateSchema(doc)) throw new PolicyError(file, (validateSchema.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`));
  const d = doc as any;

  const problems: string[] = [];
  const slug = file.replace(/^.*[\\/]/, '').replace(/\.ya?ml$/, '');
  if (!file.endsWith('policy.yaml') && d.policy !== slug) problems.push(`policy "${d.policy}" must match the file name "${slug}"`);

  const type: string = d.scope.type;
  if (!registry.has(type)) problems.push(`scope.type: unknown type ${type}`);
  if (d.scope.concept && !registry.all().some((t) => t.parent === 'Concept' && t.type === d.scope.concept))
    problems.push(`scope.concept: ${d.scope.concept} is not a concept type`);
  const def = registry.has(type) ? registry.get(type) : undefined;

  const binding = bindingFor(type);
  const env = new Environment().registerVariable(binding, 'map').registerVariable('now', 'google.protobuf.Timestamp');
  let program: ((ctx: Record<string, unknown>) => unknown) | undefined;
  let read = new Set<string>();
  try {
    const checked = env.check(d.when);
    if (!checked.valid) problems.push(`when: ${(checked as any).error?.message ?? 'invalid expression'}`);
    else if (checked.type !== 'bool' && checked.type !== 'dyn') problems.push(`when: must return a boolean, returns ${checked.type}`);
    program = env.parse(d.when) as any;
    read = reads(celParse(d.when).ast, binding);
  } catch (e) { problems.push(`when: ${(e as Error).message.split('\n')[0]}`); }

  if (def) {
    for (const r of read)
      if (!(r in def.attributes) && !(def.edges && r in def.edges) && !BUILTIN.has(r))
        problems.push(`when: ${type} has no attribute or edge "${r}"`);
    const eff = d.effect;
    if (eff.action === 'set_attribute') {
      const a = def.attributes[eff.attribute];
      if (!a) problems.push(`effect.attribute: ${type} has no attribute "${eff.attribute}"`);
      else if (a.source !== 'dmc') problems.push(`effect.attribute: "${eff.attribute}" is sourced from ${a.source}; policies may only set dmc attributes`);
    }
  }
  if (d.effect.action === 'classify' && !registry.has(d.effect.concept)) problems.push(`effect.concept: unknown type ${d.effect.concept}`);
  if (d.effect.action === 'raise_exception' && !d.route) problems.push('route: needed so the exception has an owner');
  if (problems.length) throw new PolicyError(file, problems);

  const run = program!;
  return {
    id: d.policy, control: d.control, implements: d.implements, mode: d.mode,
    scopeKeys: { type, category: def!.parent, concept: d.scope.concept, domain: d.scope.domain, scope: d.scope.scope },
    binding, when: d.when, effect: d.effect, route: d.route,
    escalateAfterMs: d.escalate_after ? Number(d.escalate_after.slice(0, -1)) * UNIT[d.escalate_after.slice(-1) as keyof typeof UNIT] : undefined,
    autonomy: d.autonomy ?? 'propose', confidence: d.confidence ?? 1, reads: [...read].sort(),
    evaluate(asset, now = new Date()) {
      try {
        const v = run({ [binding]: asset, now });
        return typeof v === 'boolean' ? { ok: true, matched: v } : { ok: false, error: 'expression did not return a boolean' };
      } catch (e) { return { ok: false, error: (e as Error).message.split('\n')[0]! }; }
    },
  };
}
