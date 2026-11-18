import { ApiProblem, type ApiNode, type DataSource } from '@/lib/data';
import snapshot from './fixtures/api-snapshot.json';

/**
 * A DataSource that answers the way the real API does, from responses captured from the local seed (scripts/seed-lib.ts):
 * the same nodes, edges, scope detail, datasets, lineage walks and measures, in the same shapes. It refuses what the API refuses
 * (search without a word is a 422, an unknown object is a 404), so a screen that asks the API something it would not answer fails here too.
 */
type Snap = {
  nodes: Record<string, ApiNode>; rel: Record<string, { out: unknown[]; in: unknown[] }>; hist: Record<string, unknown>;
  scopes: Record<string, { detail: unknown; completeness: unknown }>; datasets: Record<string, unknown>;
  lineage: Record<string, { upstream: unknown; downstream: unknown }>; measures: unknown[]; requirements: unknown; inboxBen: unknown;
};
export const SNAP = snapshot as unknown as Snap;

export interface FakeOptions {
  /** who is signed in (default: the platform admin) */
  user?: { staffID: string; displayName: string; groups: string[]; roles?: string[] };
  /** change a Person record, for example to mark someone as having left */
  people?: Record<string, { lifecycle: string }>;
  /** replace or add any method */
  over?: Partial<DataSource>;
}

export const ADMIN = { staffID: '43000009', displayName: 'Anil Admin', groups: ['dmc-platform-admin'], roles: ['admin', 'viewer'] };
export const BEN = { staffID: '43000002', displayName: 'Ben Brooks', groups: [], roles: ['app-owner', 'viewer'] };

const missing = (qn: string) => new ApiProblem(404, `No ${qn} in the catalog`, 'req-1');

export function apiFake(o: FakeOptions = {}): DataSource {
  const user = o.user ?? ADMIN;
  const nodes: Record<string, ApiNode> = { ...SNAP.nodes };
  for (const [qn, p] of Object.entries(o.people ?? {})) if (nodes[qn]) nodes[qn] = { ...nodes[qn]!, lifecycle: p.lifecycle as ApiNode['lifecycle'] };
  const get = (qn: string): ApiNode => { const n = nodes[qn]; if (!n) throw missing(qn); return n; };
  const ds = {
    async search(q: string, opts: { types?: string[] } = {}) {
      if (!q.trim()) throw new ApiProblem(422, 'q is required', 'req-422');
      const hits = Object.values(nodes).filter((n) => (!opts.types?.length || opts.types.includes(n.type)) && `${n.qualified_name} ${String(n.attributes.name ?? '')}`.toLowerCase().includes(q.toLowerCase()))
        .map((n) => ({ qualified_name: n.qualified_name, type: n.type, name: String(n.attributes.name ?? n.qualified_name), lifecycle: n.lifecycle }));
      const count = (k: 'type' | 'lifecycle') => hits.reduce<Record<string, number>>((m, h) => ({ ...m, [h[k]]: (m[h[k]] ?? 0) + 1 }), {});
      return { hits, facets: { type: count('type'), lifecycle: count('lifecycle') }, facets_sampled: false };
    },
    async node(qn: string) { return get(qn); },
    async listNodes(type: string) { return Object.values(nodes).filter((n) => n.type === type); },
    async relationships(qn: string, direction: 'out' | 'in') { get(qn); return { items: SNAP.rel[qn]?.[direction] ?? [] }; },
    async history(qn: string) { get(qn); return SNAP.hist[qn] ?? { items: [] }; },
    async inbox() { return user.staffID === BEN.staffID ? SNAP.inboxBen : { items: [], count: 0 }; },
    async scope(qn: string) { const s = SNAP.scopes[qn]; if (!s) throw missing(qn); return s.detail; },
    async scopeCompleteness(qn: string) { const s = SNAP.scopes[qn]; if (!s) throw missing(qn); return s.completeness; },
    async datasets(i: string) { const d = SNAP.datasets[i]; if (!d) throw missing(i); return d; },
    async lineage(qn: string, direction: 'upstream' | 'downstream') { const l = SNAP.lineage[qn]; if (!l) throw missing(qn); return l[direction]; },
    async dashboardMeasures() { return SNAP.measures; },
    async requirementCoverage() { return SNAP.requirements; },
    async me() { return user; },
    async health() { return { status: 'ok', version: '0.0.0' }; },
    async classificationProposals() { return []; },
    async verifyLedger() { return { ok: true, checked: 173 }; },
    async adminStatus() { return { version: '0.0.0', metamodel_version: '9a6f04cf', enforcement: 'running', policies: [] }; },
    ...o.over,
  };
  return ds as unknown as DataSource;
}
