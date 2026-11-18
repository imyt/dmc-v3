import type { ApiLineage } from '@/lib/data';

export interface LNode { qn: string; type: string; container?: string }
export interface LEdge { from: string; to: string; source: string; job?: string }
export interface Graph { root: string; nodes: Map<string, LNode>; edges: Map<string, LEdge> }

export const emptyGraph = (root: string): Graph => ({ root, nodes: new Map([[root, { qn: root, type: 'Column' }]]), edges: new Map() });

/** Add what a walk found. Nodes and edges already shown stay where they are; the walk's own root is a node like any other. */
export function mergeLineage(g: Graph, l: ApiLineage): Graph {
  const nodes = new Map(g.nodes); const edges = new Map(g.edges);
  for (const n of l.nodes) nodes.set(n.qualified_name, { qn: n.qualified_name, type: n.type, ...(n.container ? { container: n.container } : {}) });
  if (!nodes.has(l.root)) nodes.set(l.root, { qn: l.root, type: 'Column' });
  for (const e of l.edges) edges.set(`${e.from}>${e.to}`, { from: e.from, to: e.to, source: e.source, ...(e.job ? { job: e.job } : {}) });
  return { root: g.root, nodes, edges };
}

/** The same graph one level up: each column becomes the table (container) it sits in, and edges between the same two tables become one. */
export function tableLevel(g: Graph): Graph {
  const of = (qn: string) => g.nodes.get(qn)?.container ?? qn;
  const nodes = new Map<string, LNode>(); const edges = new Map<string, LEdge>();
  for (const n of g.nodes.values()) { const c = n.container ?? n.qn; nodes.set(c, { qn: c, type: n.container ? 'Table' : n.type }); }
  for (const e of g.edges.values()) {
    const a = of(e.from), b = of(e.to);
    if (a !== b && !edges.has(`${a}>${b}`)) edges.set(`${a}>${b}`, { from: a, to: b, source: e.source, ...(e.job ? { job: e.job } : {}) });
  }
  return { root: of(g.root), nodes, edges };
}

/** Where a node can still be expanded from: it has no known neighbour that way yet. */
export const hasNeighbour = (g: Graph, qn: string, direction: 'upstream' | 'downstream'): boolean =>
  [...g.edges.values()].some((e) => (direction === 'upstream' ? e.to === qn : e.from === qn));

/** The accessible alternative to the canvas: one row per edge, upstream first. */
export const edgeRows = (g: Graph): { from: string; to: string; job: string; source: string }[] =>
  [...g.edges.values()].map((e) => ({ from: e.from, to: e.to, job: e.job ?? '', source: e.source })).sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
