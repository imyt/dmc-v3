import type { ObjectModel } from '@/components/patterns/object-page';
import type { Lifecycle } from '@/components/patterns/status-badge';
import type { TimelineEvent } from '@/components/patterns/timeline';
import type { ApiEdgeList, ApiHistory, ApiNode } from '@/lib/data';

/** "BusinessTerm" → "Business term"; "hosting_country" → "Hosting country". */
export const humanise = (s: string): string => {
  const words = s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').trim().toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};
export const objectHref = (qn: string): string => `/o/${encodeURIComponent(qn)}`;

const STATE: Record<string, Lifecycle> = { discovered: 'draft', proposed: 'proposed', confirmed: 'active', deprecated: 'deprecated' };
export const stateOf = (lifecycle: string): Lifecycle => STATE[lifecycle] ?? 'draft';

const show = (v: unknown): string => (v === undefined || v === null || v === '' ? 'Not set' : Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v));

const actorOf = (name: string): TimelineEvent['actor'] =>
  name.includes(' for ') ? { kind: 'agent', name } : name.startsWith('sync/') ? { kind: 'sync', name } : name.startsWith('system/') ? { kind: 'sync', name } : { kind: 'person', name };

/** What changed between two versions, as a sentence. */
function summarise(prev: Record<string, unknown> | undefined, now: Record<string, unknown>, lifecycleChange: string | undefined): string {
  if (!prev) return 'created this record';
  const changed = Object.keys({ ...prev, ...now }).filter((k) => JSON.stringify(prev[k]) !== JSON.stringify(now[k])).map(humanise);
  const parts = [changed.length ? `changed ${changed.join(', ').toLowerCase()}` : undefined, lifecycleChange].filter(Boolean);
  return parts.join(' and ') || 'updated this record';
}

/**
 * The object page is driven by the metamodel: every attribute the type declares becomes a field, its source says where it comes from,
 * and nothing here knows what a dataset or a term is.
 */
export function toObjectModel(node: ApiNode, out: ApiEdgeList, incoming: ApiEdgeList, history: ApiHistory): ObjectModel {
  const attrs = node.attributes as Record<string, unknown>;
  const prov = node.provenance as Record<string, { by: string; at: string }>;
  const sources = node.attribute_sources as Record<string, string>;

  const fields = Object.keys(sources).map((id) => {
    const owner = sources[id]!;
    return { id, label: humanise(id), value: show(attrs[id]), ...(owner !== 'dmc' ? { source: { tool: owner, syncedAt: prov[id]?.at ?? '' } } : {}) };
  });

  const group = (edges: ApiEdgeList, dir: 'out' | 'in') => {
    const by = new Map<string, { id: string; label: string; typeLabel: string; href: string }[]>();
    for (const e of edges.items) {
      const other = dir === 'out' ? e.to : e.from;
      const key = dir === 'out' ? e.name : `${e.name}:in`;
      by.set(key, [...(by.get(key) ?? []), { id: `${key}/${other}`, label: other, typeLabel: dir === 'out' ? 'Outgoing' : 'Incoming', href: objectHref(other) }]);
    }
    return [...by].map(([key, items]) => ({ id: key, label: key.endsWith(':in') ? `${humanise(key.slice(0, -3))} (from other objects)` : humanise(key), items }));
  };

  // history lists every recorded version, including closed copies of an old one; keep one entry per real change
  const events: TimelineEvent[] = [];
  let prevAttrs: Record<string, unknown> | undefined; let prevLifecycle: string | undefined;
  for (const v of history.items) {
    const same = prevAttrs && JSON.stringify(prevAttrs) === JSON.stringify(v.attributes) && prevLifecycle === v.lifecycle;
    if (same) continue;
    events.push({ id: `${events.length}-${v.recorded_from}`, at: v.recorded_from, actor: actorOf(v.actor),
      summary: summarise(prevAttrs, v.attributes as Record<string, unknown>, prevLifecycle && prevLifecycle !== v.lifecycle ? `moved from ${prevLifecycle} to ${v.lifecycle}` : undefined) });
    prevAttrs = v.attributes as Record<string, unknown>; prevLifecycle = v.lifecycle;
  }

  return {
    type: node.type, typeLabel: humanise(node.type),
    name: typeof attrs.name === 'string' ? attrs.name : node.qualified_name,
    state: stateOf(node.lifecycle),
    owner: typeof attrs.owner === 'string' ? attrs.owner : undefined,
    fields: [{ id: 'qualified_name', label: 'Identifier', value: node.qualified_name }, ...fields],
    relationships: [...group(out, 'out'), ...group(incoming, 'in')],
    controls: [],
    events: events.reverse(),
    actions: [],
  };
}
