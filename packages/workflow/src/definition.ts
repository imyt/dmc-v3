import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { Environment } from '@marcbachmann/cel-js';
import { parse } from 'yaml';

export type Step =
  | { type: 'task'; title?: string; assignee: string; decisions: Record<string, string>; sla?: string; sla_context?: string; escalate_to?: string }
  | { type: 'action'; action: string; next: string }
  | { type: 'branch'; branches: { when: string; next: string }[]; default: string }
  | { type: 'parallel'; branches: string[] }
  | { type: 'join'; parallel: string; next: string }
  | { type: 'end'; outcome: string };

export interface WorkflowDef { workflow: string; version: number; start: string; steps: Record<string, Step> }

export class WorkflowDefError extends Error {
  constructor(readonly problems: string[]) { super(`Invalid workflow:\n - ${problems.join('\n - ')}`); }
}

const schema = JSON.parse(readFileSync(new URL('../schema/workflow.schema.json', import.meta.url), 'utf8')) as object;
const validateSchema = new Ajv2020({ allErrors: true, strict: false }).compile(schema);
const env = new Environment().registerVariable('ctx', 'map');

export const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
export const slaMs = (s: string): number => Number(s.slice(0, -1)) * UNIT_MS[s.slice(-1) as keyof typeof UNIT_MS];

export function successors(s: Step): string[] {
  switch (s.type) {
    case 'task': return Object.values(s.decisions);
    case 'action': case 'join': return [s.next];
    case 'branch': return [...s.branches.map((b) => b.next), s.default];
    case 'parallel': return s.branches;
    case 'end': return [];
  }
}

/** Parse and check a definition: schema, every reference exists, no cycles, every step reachable, branches compile, joins match their parallel. */
export function compileWorkflow(yamlText: string): WorkflowDef {
  let doc: unknown;
  try { doc = parse(yamlText); } catch (e) { throw new WorkflowDefError([`not valid YAML: ${(e as Error).message}`]); }
  if (!validateSchema(doc)) throw new WorkflowDefError((validateSchema.errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}`));
  const def = doc as WorkflowDef;
  const problems: string[] = [];
  const ids = Object.keys(def.steps);

  if (!def.steps[def.start]) problems.push(`start: no step ${def.start}`);
  for (const [id, s] of Object.entries(def.steps))
    for (const n of successors(s)) if (!def.steps[n]) problems.push(`${id}: points at unknown step ${n}`);
  if (problems.length) throw new WorkflowDefError(problems);

  for (const [id, s] of Object.entries(def.steps)) {
    if (s.type === 'task' && s.escalate_to && !s.sla && !s.sla_context) problems.push(`${id}: escalate_to needs an sla`);
    if (s.type === 'branch') for (const b of s.branches) {
      try { const c = env.check(b.when); if (!c.valid || (c.type !== 'bool' && c.type !== 'dyn')) problems.push(`${id}: condition "${b.when}" is not a valid boolean expression`); }
      catch (e) { problems.push(`${id}: condition "${b.when}" does not compile (${(e as Error).message.split('\n')[0]})`); }
    }
    if (s.type === 'join') {
      const p = def.steps[s.parallel];
      if (!p || p.type !== 'parallel') problems.push(`${id}: parallel "${s.parallel}" is not a parallel step`);
    }
  }

  // acyclic + reachable
  const seen = new Set<string>(), stack = new Set<string>();
  const visit = (id: string) => {
    if (stack.has(id)) { problems.push(`cycle through ${id}`); return; }
    if (seen.has(id)) return;
    seen.add(id); stack.add(id);
    for (const n of successors(def.steps[id]!)) visit(n);
    stack.delete(id);
  };
  visit(def.start);
  for (const id of ids) if (!seen.has(id)) problems.push(`${id}: not reachable from ${def.start}`);

  // every branch of a parallel must reach its join, and nothing may escape to an end without it
  for (const [id, s] of Object.entries(def.steps)) {
    if (s.type !== 'parallel') continue;
    const joins = Object.entries(def.steps).filter(([, j]) => j.type === 'join' && (j as { parallel: string }).parallel === id).map(([k]) => k);
    if (joins.length !== 1) { problems.push(`${id}: needs exactly one join step (found ${joins.length})`); continue; }
    for (const b of s.branches) {
      const reach = new Set<string>(); const go = (n: string) => { if (reach.has(n) || n === joins[0]) { reach.add(n); return; } reach.add(n); successors(def.steps[n]!).forEach(go); };
      go(b);
      if (!reach.has(joins[0]!)) problems.push(`${id}: branch ${b} never reaches join ${joins[0]}`);
      for (const r of reach) if (def.steps[r]!.type === 'end') problems.push(`${id}: branch ${b} reaches end ${r} without joining`);
    }
  }
  if (!Object.values(def.steps).some((s) => s.type === 'end')) problems.push('needs at least one end step');
  if (problems.length) throw new WorkflowDefError(problems);
  return def;
}

/** Choose the next step of a branch: first matching condition, else the default. */
export function pickBranch(s: Extract<Step, { type: 'branch' }>, ctx: Record<string, unknown>): string {
  for (const b of s.branches) {
    // a condition that reads a context key that is not there is simply not a match
    let v: unknown = false;
    try { v = env.parse(b.when)({ ctx }); } catch { v = false; }
    if (v === true) return b.next;
  }
  return s.default;
}
