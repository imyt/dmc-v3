import type { Queryable } from '@dmc/platform';
import { ident } from '@dmc/platform';
import type { Registry, TypeDef } from '@dmc/platform';

export type ChangeKind =
  | 'type_added' | 'type_removed' | 'parent_changed' | 'version_not_bumped'
  | 'attribute_added' | 'attribute_added_required' | 'attribute_removed' | 'attribute_type_changed'
  | 'attribute_source_changed' | 'attribute_made_required' | 'identity_changed' | 'attribute_pattern_changed'
  | 'enum_value_added' | 'enum_value_removed'
  | 'edge_added' | 'edge_removed' | 'edge_cardinality_changed';

export interface Change {
  kind: ChangeKind; type: string; detail: string;
  breaking: boolean;
  /** for identity_changed and attribute_pattern_changed: the new pattern (a regular expression), used to count what no longer conforms */
  pattern?: string;
  /** how many current objects the change affects; undefined until counted */
  affected?: number;
  /** breaking and still in use (or not yet counted) */
  blocked?: boolean;
}

const BREAKING = new Set<ChangeKind>(['type_removed', 'parent_changed', 'attribute_added_required', 'attribute_removed', 'attribute_type_changed',
  'attribute_source_changed', 'attribute_made_required', 'identity_changed', 'attribute_pattern_changed', 'enum_value_removed', 'edge_removed', 'edge_cardinality_changed']);

const mk = (kind: ChangeKind, type: string, detail: string): Change => ({ kind, type, detail, breaking: BREAKING.has(kind) });

function diffType(b: TypeDef, h: TypeDef, out: Change[]): void {
  const t = h.type;
  if (b.parent !== h.parent) out.push(mk('parent_changed', t, `${b.parent} → ${h.parent}`));
  // the key of a type is its identity: a change of the rule, or a tighter pattern, breaks every node whose key no longer conforms
  if (b.identity.qualified_name !== h.identity.qualified_name || (b.identity.pattern ?? '') !== (h.identity.pattern ?? ''))
    out.push({ ...mk('identity_changed', t, `${b.identity.qualified_name}${b.identity.pattern ? ` (${b.identity.pattern})` : ''} → ${h.identity.qualified_name}${h.identity.pattern ? ` (${h.identity.pattern})` : ''}`), ...(h.identity.pattern ? { pattern: h.identity.pattern } : {}) });
  for (const [n, ha] of Object.entries(h.attributes)) {
    const ba = b.attributes[n];
    if (!ba) { out.push(mk(ha.required ? 'attribute_added_required' : 'attribute_added', t, n)); continue; }
    if (ba.type !== ha.type) out.push(mk('attribute_type_changed', t, `${n}: ${ba.type} → ${ha.type}`));
    if (ba.source !== ha.source) out.push(mk('attribute_source_changed', t, `${n}: ${ba.source} → ${ha.source}`));
    if ((ba.pattern ?? '') !== (ha.pattern ?? '')) out.push({ ...mk('attribute_pattern_changed', t, `${n}: ${ba.pattern ?? 'none'} → ${ha.pattern ?? 'none'}`), ...(ha.pattern ? { pattern: ha.pattern } : {}) });
    if (!ba.required && ha.required) out.push(mk('attribute_made_required', t, n));
    for (const v of ba.values ?? []) if (!(ha.values ?? []).includes(v)) out.push(mk('enum_value_removed', t, `${n}=${v}`));
    for (const v of ha.values ?? []) if (!(ba.values ?? []).includes(v)) out.push(mk('enum_value_added', t, `${n}=${v}`));
  }
  for (const n of Object.keys(b.attributes)) if (!h.attributes[n]) out.push(mk('attribute_removed', t, n));
  const be = b.edges ?? {}, he = h.edges ?? {};
  for (const [n, defs] of Object.entries(he)) {
    if (!be[n]) { out.push(mk('edge_added', t, n)); continue; }
    const sig = (d: { to: string; cardinality: string }[]) => d.map((x) => `${x.to}:${x.cardinality}`).sort().join(',');
    if (sig(be[n]!) !== sig(defs)) {
      const removedTarget = be[n]!.some((x) => !defs.some((y) => y.to === x.to));
      out.push(mk(removedTarget ? 'edge_removed' : 'edge_cardinality_changed', t, `${n}: ${sig(be[n]!)} → ${sig(defs)}`));
    }
  }
  for (const n of Object.keys(be)) if (!he[n]) out.push(mk('edge_removed', t, n));
}

/** Compare the metamodel on the base branch with the one on the pull request. */
export function diffRegistries(base: Registry, head: Registry): Change[] {
  const out: Change[] = [];
  for (const h of head.all()) {
    if (!base.has(h.type)) { out.push(mk('type_added', h.type, h.parent)); continue; }
    const before = out.length;
    diffType(base.get(h.type), h, out);
    if (out.length > before && h.version <= base.get(h.type).version)
      out.push({ kind: 'version_not_bumped', type: h.type, detail: `version is still ${h.version}`, breaking: true, blocked: true, affected: 0 });
  }
  for (const b of base.all()) if (!head.has(b.type)) out.push(mk('type_removed', b.type, b.parent));
  return out;
}

const CUR = `v.valid_to is null and v.recorded_to is null`;

async function count(db: Queryable, c: Change): Promise<number> {
  const attr = c.detail.split(/[:=]/)[0]!.trim();
  const one = async (sql: string, p: unknown[]) => Number((await db.query<{ n: string }>(sql, p)).rows[0]!.n);
  const nodes = `catalog.node n join catalog.node_version v on v.node_id = n.id where n.type = $1 and ${CUR}`;
  switch (c.kind) {
    case 'identity_changed': return c.pattern ? one(`select count(*) n from ${nodes} and n.qualified_name !~ $2`, [c.type, c.pattern]) : one(`select count(*) n from ${nodes}`, [c.type]);
    case 'attribute_pattern_changed': return c.pattern ? one(`select count(*) n from ${nodes} and v.attributes ? $2 and v.attributes ->> $2 !~ $3`, [c.type, attr, c.pattern]) : 0;
    case 'type_removed': case 'parent_changed': return one(`select count(*) n from ${nodes}`, [c.type]);
    case 'attribute_removed': case 'attribute_type_changed': case 'attribute_source_changed':
      return one(`select count(*) n from ${nodes} and v.attributes ? $2`, [c.type, attr]);
    case 'attribute_added_required': case 'attribute_made_required':
      return one(`select count(*) n from ${nodes} and not (v.attributes ? $2)`, [c.type, attr]);
    case 'enum_value_removed': return one(`select count(*) n from ${nodes} and v.attributes ->> $2 = $3`, [c.type, attr, c.detail.split('=')[1]]);
    case 'edge_removed': case 'edge_cardinality_changed':
      return one(`select count(*) n from catalog.edge e join catalog.node f on f.id = e.from_id where f.type = $1 and e.name = $2 and e.valid_to is null and e.recorded_to is null`, [c.type, attr]);
    default: return 0;
  }
}

/** Adds counts of affected objects; a breaking change is blocked only while something still uses it. */
export async function countAffected(db: Queryable, changes: Change[]): Promise<Change[]> {
  void ident; // schema name is fixed (catalog); ident kept for symmetry with other modules
  const out: Change[] = [];
  for (const c of changes) {
    if (c.kind === 'version_not_bumped') { out.push(c); continue; }
    const affected = c.breaking ? await count(db, c) : 0;
    out.push({ ...c, affected, blocked: c.breaking && affected > 0 });
  }
  return out;
}

export function formatReport(changes: Change[]): string {
  if (changes.length === 0) return 'No metamodel changes.';
  const lines = changes.map((c) => `${c.blocked ? 'BLOCKED' : c.breaking ? 'breaking' : 'safe    '}  ${c.kind}  ${c.type}  ${c.detail}${c.affected !== undefined && c.breaking ? `  (${c.affected} affected)` : ''}`);
  const blocked = changes.filter((c) => c.blocked).length;
  return `${lines.join('\n')}\n\n${blocked ? `${blocked} change(s) blocked.` : 'No blocked changes.'}`;
}
