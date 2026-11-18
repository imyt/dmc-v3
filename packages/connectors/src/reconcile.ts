import type { Registry } from '@dmc/platform';
import type { SourceRecord } from '@dmc/contracts';
import { parse } from 'yaml';
import type { JobDef } from './definition.js';
import { mapRecord, pick, stableStringify } from './mapping.js';
import { emailIndex, resolvePersonRef, staffIdPattern } from './person.js';

/** What Collibra said, as the jobs read it: one entry per job (its definition and every record it read), plus relations and responsibilities. */
export interface CollibraExport {
  jobs: { def: JobDef; records: SourceRecord[] }[];
  relations: SourceRecord[];
  responsibilities: SourceRecord[];
}
/** The catalog as a snapshot of what the sync wrote: nodes by qualified name, edges by name and qualified names of both ends. */
export interface CatalogSnapshot {
  nodes: { type: string; qualifiedName: string; attributes: Record<string, unknown>; lifecycle?: string }[];
  edges: { name: string; from: string; to: string }[];
  /** the Person nodes (key = staff ID) with their email, to resolve a responsibility held by an email (ADR 0026); needed only when the key field is not the staff ID */
  people?: { qualifiedName: string; email?: string }[];
}
export interface ReconcileMapping {
  relations: { role: string; edge: string; from: string; to: string }[];
  responsibilities: Record<string, string>;
  /** the field of a responsibility's user that identifies the person: the same as the overlay parameter ownerKeyField of the owner and steward jobs. Default emailAddress. */
  personKeyField?: string;
}
export const parseReconcileMapping = (yamlText: string): ReconcileMapping => {
  const d = parse(yamlText) as Partial<ReconcileMapping> | null;
  return { relations: d?.relations ?? [], responsibilities: d?.responsibilities ?? {}, ...(typeof d?.personKeyField === 'string' ? { personKeyField: d.personKeyField } : {}) };
};

export interface TypeReconciliation {
  type: string;
  collibra: number; catalog: number;
  /** keys Collibra has and the catalog lacks / the catalog has (not deprecated) and Collibra lacks */
  missing: string[]; extra: string[];
  diffs: { key: string; attribute: string; collibra: unknown; catalog: unknown }[];
  /** the type's Collibra-owned attributes now belong to DMC (ADR 0018): nothing to compare */
  switchedToDmc: boolean;
  /** Collibra records with no usable key; they cannot reach the catalog */
  unkeyed: number;
  matches: boolean;
}
export interface EdgeReconciliation { edge: string; collibra: number; catalog: number; missing: string[]; extra: string[]; matches: boolean }
export interface ReconciliationReport {
  types: TypeReconciliation[];
  relations: EdgeReconciliation[];
  responsibilities: EdgeReconciliation[];
  /** Collibra links the metamodel cannot hold (for example `owned_by` on a type that does not declare it); counted, never compared */
  unmodelled: { kind: 'relation' | 'responsibility'; edge: string; from: string; to: string; count: number }[];
  /** responsibilities whose person cannot be resolved to a staff ID (an email nobody has, a short number, a group): data errors, they make the report not match */
  unresolvedPeople: { asset: string; value: string; reason: string }[];
  /** Collibra links whose end is not among the synced assets */
  outOfScope: number;
  matches: boolean;
}

/** Metadata only: nothing here reads a value from a source system, only names, definitions and links of governance objects. */
export function reconcile(registry: Registry, collibra: CollibraExport, catalog: CatalogSnapshot, mapping: ReconcileMapping): ReconciliationReport {
  const keyType = new Map<string, string>(); // collibra id -> type
  const types: TypeReconciliation[] = [];

  for (const { def, records } of collibra.jobs) {
    const t = def.target;
    const attrDefs = registry.get(t.type).attributes as Record<string, { source?: string }>;
    const owned = Object.keys(t.map).filter((a) => attrDefs[a]?.source === (t.source ?? def.job));
    const switchedToDmc = owned.length === 0;
    const mapped = new Map<string, Record<string, unknown>>(); let unkeyed = 0;
    for (const r of records) { const m = mapRecord(r, t); if ('error' in m) unkeyed++; else mapped.set(m.key, m.attrs); }
    for (const k of mapped.keys()) keyType.set(k, t.type);
    const have = new Map(catalog.nodes.filter((n) => n.type === t.type && n.lifecycle !== 'deprecated').map((n) => [n.qualifiedName, n.attributes]));
    const missing = [...mapped.keys()].filter((k) => !have.has(k)).sort();
    const extra = [...have.keys()].filter((k) => !mapped.has(k)).sort();
    const diffs: TypeReconciliation['diffs'] = [];
    if (!switchedToDmc) {
      for (const [k, attrs] of [...mapped].sort(([a], [b]) => a.localeCompare(b))) {
        const c = have.get(k); if (!c) continue;
        for (const a of owned) if (stableStringify(attrs[a] ?? null) !== stableStringify(c[a] ?? null)) diffs.push({ key: k, attribute: a, collibra: attrs[a] ?? null, catalog: c[a] ?? null });
      }
    }
    types.push({ type: t.type, collibra: mapped.size, catalog: have.size, missing, extra, diffs, switchedToDmc, unkeyed,
      matches: switchedToDmc || (!missing.length && !extra.length && !diffs.length && !unkeyed) });
  }

  const unmodelled = new Map<string, ReconciliationReport['unmodelled'][number]>();
  let outOfScope = 0;
  const expected = new Map<string, Set<string>>(); // "kind:edge" -> "from|to"
  const add = (kind: 'relation' | 'responsibility', edge: string, from: string, to: string, fromType: string, toType: string) => {
    if (!registry.has(fromType) || !registry.canLink(fromType, edge, toType)) {
      const k = `${kind}|${edge}|${fromType}|${toType}`;
      unmodelled.set(k, { kind, edge, from: fromType, to: toType, count: (unmodelled.get(k)?.count ?? 0) + 1 });
      return;
    }
    const key = `${kind}:${edge}`;
    if (!expected.has(key)) expected.set(key, new Set());
    expected.get(key)!.add(`${from}|${to}`);
  };
  for (const r of collibra.relations) {
    const m = mapping.relations.find((x) => x.role === String(pick(r, 'type.role') ?? ''));
    if (!m) continue; // a relation the glossary does not use
    const s = String(pick(r, 'source.id') ?? ''); const d = String(pick(r, 'target.id') ?? '');
    if (keyType.get(s) !== m.from || keyType.get(d) !== m.to) { outOfScope++; continue; }
    add('relation', m.edge, s, d, m.from, m.to);
  }
  const pattern = staffIdPattern(registry); const byEmail = emailIndex((catalog.people ?? []).map((x) => ({ qualifiedName: x.qualifiedName, email: x.email })));
  const keyField = mapping.personKeyField ?? 'emailAddress';
  const unresolvedPeople: ReconciliationReport['unresolvedPeople'] = [];
  for (const r of collibra.responsibilities) {
    const edge = mapping.responsibilities[String(pick(r, 'role.name') ?? '')];
    if (!edge) continue;
    const a = String(pick(r, 'baseResource.id') ?? ''); const value = pick(r, `owner.${keyField}`);
    if (!keyType.has(a) || value === undefined || value === null || String(value).trim() === '') { outOfScope++; continue; }
    // the same resolution the sync applies: a staff ID as it is, an email through the Person's email, anything else is a data error (never padded)
    const who = resolvePersonRef(value, pattern, byEmail);
    if ('error' in who) { unresolvedPeople.push({ asset: a, value: String(value), reason: who.error }); continue; }
    add('responsibility', edge, a, who.id, keyType.get(a)!, 'Person');
  }

  const edgeReport = (kind: 'relation' | 'responsibility'): EdgeReconciliation[] => {
    const names = new Set([...expected.keys()].filter((k) => k.startsWith(`${kind}:`)).map((k) => k.slice(kind.length + 1)));
    for (const e of kind === 'relation' ? mapping.relations.map((m) => m.edge) : Object.values(mapping.responsibilities)) names.add(e);
    return [...names].sort().map((edge) => {
      const want = expected.get(`${kind}:${edge}`) ?? new Set<string>();
      const got = new Set(catalog.edges.filter((e) => e.name === edge).map((e) => `${e.from}|${e.to}`));
      const missing = [...want].filter((x) => !got.has(x)).sort();
      // only edges that start at a synced Collibra asset can be "extra", so edges DMC made itself are not counted against Collibra
      const extra = [...got].filter((x) => !want.has(x) && keyType.has(x.split('|')[0]!)).sort();
      return { edge, collibra: want.size, catalog: want.size - missing.length + extra.length, missing, extra, matches: !missing.length && !extra.length };
    });
  };
  const relations = edgeReport('relation');
  const responsibilities = edgeReport('responsibility').filter((e) => e.collibra || e.catalog);
  return { types, relations, responsibilities, unmodelled: [...unmodelled.values()], unresolvedPeople, outOfScope,
    matches: !unresolvedPeople.length && types.every((t) => t.matches) && relations.every((e) => e.matches) && responsibilities.every((e) => e.matches) };
}
