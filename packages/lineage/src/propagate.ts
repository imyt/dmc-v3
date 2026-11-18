/**
 * L2. Classifications follow lineage as proposals. A classification the classification tool set is authoritative: it is never
 * overridden, and it is what propagates. A column downstream of a classified one gets a proposal, for its steward to accept.
 */
export interface ClassEdge { code: string; scheme: string; /** the source that wrote the edge */ source: string }
export const TOOL_SOURCE = 'classification-tool';
export interface Proposal { target: string; code: string; scheme: string; via: string; depth: number }

/**
 * `from`: the classified column, with the classifications that came from the tool.
 * `downstream`: columns built from it with their hops; `held`: what each of those already has.
 */
export function proposeFrom(from: { qn: string; classes: ClassEdge[] }, downstream: { qn: string; depth: number }[], held: Map<string, ClassEdge[]>): Proposal[] {
  const out: Proposal[] = [];
  for (const c of from.classes.filter((x) => x.source === TOOL_SOURCE)) {
    for (const d of downstream) {
      if (d.qn === from.qn) continue;
      const has = held.get(d.qn) ?? [];
      if (has.some((h) => h.code === c.code)) continue;                                   // already there, from anyone
      if (has.some((h) => h.scheme === c.scheme && h.source === TOOL_SOURCE)) continue;   // the tool has its own say on this scheme
      out.push({ target: d.qn, code: c.code, scheme: c.scheme, via: from.qn, depth: d.depth });
    }
  }
  return out;
}

/** One proposal per target and classification: the nearest source wins. */
export function nearest(ps: Proposal[]): Proposal[] {
  const best = new Map<string, Proposal>();
  for (const p of ps) { const k = `${p.target}|${p.code}`; const b = best.get(k); if (!b || p.depth < b.depth || (p.depth === b.depth && p.via < b.via)) best.set(k, p); }
  return [...best.values()].sort((a, b) => a.target.localeCompare(b.target) || a.code.localeCompare(b.code));
}
