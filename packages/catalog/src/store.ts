import { ApiError, writeOutbox, type Queryable } from '@dmc/platform';
import { canonical } from './canonical.js';
import type { Registry } from '@dmc/platform';
import { indexParts } from './search.js';
import { makeWriteValidator, type Writer } from './validate.js';

export type Lifecycle = 'discovered' | 'proposed' | 'confirmed' | 'deprecated';

const NEXT: Record<Lifecycle, Lifecycle[]> = {
  discovered: ['proposed', 'confirmed', 'deprecated'],
  proposed: ['confirmed', 'deprecated'],
  confirmed: ['deprecated'],
  deprecated: ['discovered'], // seen again
};

export interface AsOf { validAt?: Date; knownAt?: Date }

export interface NodeRecord {
  id: string; type: string; qualifiedName: string; lifecycle: Lifecycle;
  attributes: Record<string, unknown>; provenance: Record<string, { by: string; at: string }>;
  validFrom: Date; validTo: Date | null; recordedFrom: Date; actor: string;
}
export interface NamedEdge extends EdgeRecord { fromQn: string; toQn: string }
export interface EdgeRecord {
  id: number; name: string; fromId: string; toId: string; lifecycle: Lifecycle; source: string;
  validFrom: Date; validTo: Date | null;
  /** what the source said about the edge (for lineage: `job`, `confidence`) */
  attributes: Record<string, unknown>;
}

export interface ApplyNode {
  type: string; qualifiedName: string; attributes: Record<string, unknown>;
  writer: Writer; actor: string; validFrom?: Date; lifecycle?: Lifecycle;
}

const writerLabel = (w: Writer) => (w.kind === 'user' ? 'dmc' : w.source);
const T = 'catalog';

const NODE_COLS = `n.id, n.type, n.qualified_name, v.lifecycle, v.attributes, v.provenance, v.valid_from, v.valid_to, v.recorded_from, v.actor`;
const mapNode = (r: any): NodeRecord => ({ id: r.id, type: r.type, qualifiedName: r.qualified_name, lifecycle: r.lifecycle, attributes: r.attributes,
  provenance: r.provenance, validFrom: r.valid_from, validTo: r.valid_to, recordedFrom: r.recorded_from, actor: r.actor });
const mapEdge = (r: any): EdgeRecord => ({ id: Number(r.id), name: r.name, fromId: r.from_id, toId: r.to_id, lifecycle: r.lifecycle, source: r.source,
  validFrom: r.valid_from, validTo: r.valid_to, attributes: r.attributes ?? {} });

/** The `valid_at`/`known_at` filter. With no AsOf it returns the current state. */
function asOfSql(alias: string, a: AsOf, params: unknown[]): string {
  if (!a.validAt && !a.knownAt) return `${alias}.valid_to is null and ${alias}.recorded_to is null`;
  const v = a.validAt ?? new Date();
  const k = a.knownAt ?? new Date();
  params.push(v, k);
  const i = params.length;
  return `${alias}.valid_from <= $${i - 1} and (${alias}.valid_to is null or ${alias}.valid_to > $${i - 1})
          and ${alias}.recorded_from <= $${i} and (${alias}.recorded_to is null or ${alias}.recorded_to > $${i})`;
}

export class CatalogStore {
  readonly validate;
  constructor(private readonly reg: Registry) {
    this.validate = makeWriteValidator(reg);
  }

  /** Run `fn` in one transaction (a single connection). Every write below must be called inside one. */
  async tx<R>(db: Queryable, fn: () => Promise<R>): Promise<R> {
    await db.query('begin');
    try { const r = await fn(); await db.query('commit'); return r; }
    catch (e) { await db.query('rollback'); throw e; }
  }

  /** Create or update a node by qualified name. Re-applying the same record changes nothing and records nothing. */
  async applyNode(tx: Queryable, a: ApplyNode): Promise<{ id: string; created: boolean; changed: boolean }> {
    const def = this.reg.has(a.type) ? this.reg.get(a.type) : undefined;
    if (!def) throw new ApiError('validation_failed', `Unknown type ${a.type}`);
    const found = await tx.query<{ id: string; type: string }>(`select id, type from ${T}.node where qualified_name = $1`, [a.qualifiedName]);
    const existing = found.rows[0];
    if (existing && existing.type !== a.type) throw new ApiError('conflict', `${a.qualifiedName} already exists as ${existing.type}`);

    // identity.pattern is data in the type's YAML (Person: the staff ID, exactly 8 digits); the key is a string and is never padded or reformatted
    if (!existing && def.identity.pattern && !new RegExp(def.identity.pattern).test(a.qualifiedName))
      throw new ApiError('validation_failed', `${a.qualifiedName} is not a valid ${a.type} key: it must match ${def.identity.pattern}`, [{ path: 'qualified_name', message: `must match ${def.identity.pattern}${/^\d+$/.test(a.qualifiedName) ? ' (all digits but the wrong length: leading zeros may have been lost; it is not padded)' : ''}` }]);
    // A sync writer sends null for a value its source has cleared (ADR 0027). Null never reaches the shape check: on a create it is "not set" (a no-op), on an update it clears the attribute,
    // and it is refused only for an attribute the type requires. Ownership is still checked for the cleared name.
    const sync = a.writer.kind === 'sync' ? a.writer.source : undefined;
    const cleared = sync ? Object.keys(a.attributes).filter((k) => a.attributes[k] === null) : [];
    const given = cleared.length ? Object.fromEntries(Object.entries(a.attributes).filter(([, v]) => v !== null)) : a.attributes;
    const problems = this.validate(a.type, given, a.writer, { partial: !!existing });
    for (const k of cleared) {
      const d = def.attributes[k];
      if (!d) problems.push({ path: k, message: 'is not an attribute of this type' });
      else if (d.source !== sync) problems.push({ path: k, message: `is read-only here: its source is ${d.source}` });
      else if (d.required && existing) problems.push({ path: k, message: 'is required and cannot be cleared' });
    }
    if (problems.length) throw new ApiError('validation_failed', 'Attributes are invalid', problems);

    let id = existing?.id;
    if (!id) {
      const ins = await tx.query<{ id: string }>(`insert into ${T}.node (type, qualified_name) values ($1, $2) returning id`, [a.type, a.qualifiedName]);
      id = ins.rows[0]!.id;
    }
    const cur = existing ? (await tx.query<any>(
      `select * from ${T}.node_version where node_id = $1 and valid_to is null and recorded_to is null`, [id])).rows[0] : undefined;

    // The primary key is (node, valid_from, recorded_from) at millisecond resolution: two writes to one node in the same millisecond (a seed that writes a node twice in a row) would insert the same key twice.
    // A change is therefore recorded at least 1 ms after the version it replaces.
    let now = new Date();
    if (cur && now.getTime() <= new Date(cur.recorded_from).getTime()) now = new Date(new Date(cur.recorded_from).getTime() + 1);
    const validFrom = a.validFrom ?? now;

    const merged: Record<string, unknown> = { ...(cur?.attributes ?? {}) };
    const prov: Record<string, { by: string; at: string }> = { ...(cur?.provenance ?? {}) };
    for (const [k, v] of Object.entries(a.attributes)) {
      if (v === null) { if (existing) { delete merged[k]; delete prov[k]; } continue; }
      if (canonical(merged[k]) !== canonical(v)) prov[k] = { by: writerLabel(a.writer), at: now.toISOString() };
      merged[k] = v;
    }
    const lifecycle: Lifecycle = a.lifecycle ?? cur?.lifecycle ?? 'discovered';
    if (cur && canonical(cur.attributes) === canonical(merged) && cur.lifecycle === lifecycle) return { id, created: false, changed: false };
    if (cur && validFrom < cur.valid_from) throw new ApiError('validation_failed', 'valid_from is before the current version; corrections are not supported');

    if (cur) {
      await tx.query(`update ${T}.node_version set recorded_to = $3 where node_id = $1 and valid_from = $2 and recorded_from = $4`,
        [id, cur.valid_from, now, cur.recorded_from]);
      // keep what we used to believe about the past period, closed at the change
      await tx.query(`insert into ${T}.node_version (node_id, lifecycle, attributes, provenance, valid_from, valid_to, recorded_from, actor)
        values ($1,$2,$3,$4,$5,$6,$7,$8)`, [id, cur.lifecycle, cur.attributes, cur.provenance, cur.valid_from, validFrom, now, cur.actor]);
    }
    await tx.query(`insert into ${T}.node_version (node_id, lifecycle, attributes, provenance, valid_from, recorded_from, actor)
      values ($1,$2,$3,$4,$5,$6,$7)`, [id, lifecycle, merged, prov, validFrom, now, a.actor]);
    const ix = indexParts(a.qualifiedName, merged);
    await tx.query(`insert into ${T}.search_doc (node_id, type, lifecycle, qualified_name, name, doc)
      values ($1, $2, $3, $4, $5, setweight(to_tsvector('simple', $5), 'A') || setweight(to_tsvector('simple', replace($4, '.', ' ')), 'B') || setweight(to_tsvector('simple', $6), 'C'))
      on conflict (node_id) do update set lifecycle = excluded.lifecycle, name = excluded.name, doc = excluded.doc`,
      [id, a.type, lifecycle, a.qualifiedName, ix.name, ix.rest]);
    await writeOutbox(tx, T, { type: existing ? 'node.updated' : 'node.created', subjectRef: `node/${id}`, actor: a.actor,
      payload: { qualified_name: a.qualifiedName, node_type: a.type, changed: Object.keys(a.attributes).filter((k) => !(a.attributes[k] === null && !existing)), lifecycle } });
    return { id, created: !existing, changed: true };
  }

  /** True when `source` used to own `type` and no longer does (ADR 0018): it must not write the type's lifecycle or edges. */
  isFormerOwner(type: string, source: string): boolean { return this.reg.formerOwners(type).includes(source); }

  async setLifecycle(tx: Queryable, qualifiedName: string, next: Lifecycle, actor: string): Promise<void> {
    const n = await this.getNode(tx, qualifiedName);
    if (!n) throw new ApiError('not_found', `No node ${qualifiedName}`);
    if (n.lifecycle === next) return;
    if (!NEXT[n.lifecycle].includes(next)) throw new ApiError('conflict', `Cannot move ${n.lifecycle} → ${next}`);
    await this.applyNode(tx, { type: n.type, qualifiedName, attributes: {}, writer: { kind: 'user' }, actor, lifecycle: next });
  }

  async link(tx: Queryable, a: { name: string; fromQn: string; toQn: string; source: string; actor: string; validFrom?: Date; lifecycle?: Lifecycle; attributes?: Record<string, unknown> }): Promise<{ changed: boolean }> {
    const from = await this.getNode(tx, a.fromQn);
    const to = await this.getNode(tx, a.toQn);
    if (!from || !to) throw new ApiError('not_found', `Both ends must exist (${a.fromQn} → ${a.toQn})`);
    if (this.reg.formerOwners(from.type).includes(a.source)) throw new ApiError('conflict', `${from.type} is maintained in DMC now; ${a.source} no longer writes its edges`);
    const defs = this.reg.edgesFor(from.type, a.name).filter((e) => this.reg.matchesTarget(e.to, to.type));
    if (defs.length === 0) throw new ApiError('validation_failed', `${from.type} -${a.name}→ ${to.type} is not allowed by the metamodel`);

    const same = await tx.query<{ attributes: Record<string, unknown> }>(`select attributes from ${T}.edge where name=$1 and from_id=$2 and to_id=$3 and valid_to is null and recorded_to is null`, [a.name, from.id, to.id]);
    if (same.rowCount) {
      // same edge: only a changed description of it (job, confidence) is news; it replaces the old record and keeps history
      if (a.attributes === undefined || canonical(same.rows[0]!.attributes) === canonical(a.attributes)) return { changed: false };
      const now = new Date();
      await tx.query(`update ${T}.edge set recorded_to = $4 where name=$1 and from_id=$2 and to_id=$3 and valid_to is null and recorded_to is null`, [a.name, from.id, to.id, now]);
      await tx.query(`insert into ${T}.edge (name, from_id, to_id, lifecycle, source, valid_from, recorded_from, actor, attributes) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [a.name, from.id, to.id, a.lifecycle ?? 'discovered', a.source, a.validFrom ?? now, now, a.actor, JSON.stringify(a.attributes)]);
      await writeOutbox(tx, T, { type: 'edge.updated', subjectRef: `node/${from.id}`, actor: a.actor, payload: { name: a.name, from: a.fromQn, to: a.toQn } });
      return { changed: true };
    }

    const c = defs[0]!.cardinality;
    if (c === 'many-to-one' || c === 'one-to-one') {
      const o = await tx.query(`select 1 from ${T}.edge where name=$1 and from_id=$2 and valid_to is null and recorded_to is null`, [a.name, from.id]);
      if (o.rowCount) throw new ApiError('conflict', `${a.fromQn} already has a ${a.name} edge (${c})`);
    }
    if (c === 'one-to-many' || c === 'one-to-one') {
      const o = await tx.query(`select 1 from ${T}.edge where name=$1 and to_id=$2 and valid_to is null and recorded_to is null`, [a.name, to.id]);
      if (o.rowCount) throw new ApiError('conflict', `${a.toQn} already has an incoming ${a.name} edge (${c})`);
    }
    const now = new Date();
    await tx.query(`insert into ${T}.edge (name, from_id, to_id, lifecycle, source, valid_from, recorded_from, actor, attributes) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [a.name, from.id, to.id, a.lifecycle ?? 'discovered', a.source, a.validFrom ?? now, now, a.actor, JSON.stringify(a.attributes ?? {})]);
    await writeOutbox(tx, T, { type: 'edge.created', subjectRef: `node/${from.id}`, actor: a.actor, payload: { name: a.name, from: a.fromQn, to: a.toQn } });
    return { changed: true };
  }

  /** `source` (a sync writer) can end only edges it owns, and not at all on a type switched away from it (ADR 0018). */
  async unlink(tx: Queryable, a: { name: string; fromQn: string; toQn: string; actor: string; validTo?: Date; source?: string }): Promise<{ changed: boolean }> {
    const from = await this.getNode(tx, a.fromQn);
    const to = await this.getNode(tx, a.toQn);
    if (!from || !to) return { changed: false };
    if (a.source && this.reg.formerOwners(from.type).includes(a.source)) throw new ApiError('conflict', `${from.type} is maintained in DMC now; ${a.source} no longer writes its edges`);
    const now = new Date();
    const cur = await tx.query<any>(`select * from ${T}.edge where name=$1 and from_id=$2 and to_id=$3 and valid_to is null and recorded_to is null`, [a.name, from.id, to.id]);
    const e = cur.rows[0];
    if (!e || (a.source && e.source !== a.source)) return { changed: false };
    const end = a.validTo ?? now;
    await tx.query(`update ${T}.edge set recorded_to = $2 where id = $1`, [e.id, now]);
    await tx.query(`insert into ${T}.edge (name, from_id, to_id, lifecycle, source, valid_from, valid_to, recorded_from, actor, attributes) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [e.name, e.from_id, e.to_id, e.lifecycle, e.source, e.valid_from, end, now, e.actor, JSON.stringify(e.attributes ?? {})]);
    await writeOutbox(tx, T, { type: 'edge.removed', subjectRef: `node/${from.id}`, actor: a.actor, payload: { name: a.name, from: a.fromQn, to: a.toQn } });
    return { changed: true };
  }

  async getNode(db: Queryable, qualifiedName: string, asOf: AsOf = {}): Promise<NodeRecord | undefined> {
    const params: unknown[] = [qualifiedName];
    const r = await db.query(`select ${NODE_COLS} from ${T}.node n join ${T}.node_version v on v.node_id = n.id
      where n.qualified_name = $1 and ${asOfSql('v', asOf, params)}`, params);
    return r.rows[0] ? mapNode(r.rows[0]) : undefined;
  }

  async listByType(db: Queryable, type: string, opts: { limit?: number; afterQn?: string } & AsOf = {}): Promise<NodeRecord[]> {
    const params: unknown[] = [type, opts.afterQn ?? '', (opts.limit ?? 50) + 1];
    const r = await db.query(`select ${NODE_COLS} from ${T}.node n join ${T}.node_version v on v.node_id = n.id
      where n.type = $1 and n.qualified_name > $2 and ${asOfSql('v', opts, params)} order by n.qualified_name limit $3`, params);
    return r.rows.map(mapNode);
  }

  async edgesOf(db: Queryable, qualifiedName: string, opts: { name?: string; direction?: 'out' | 'in' } & AsOf = {}): Promise<EdgeRecord[]> {
    const n = await this.getNode(db, qualifiedName, { validAt: opts.validAt, knownAt: opts.knownAt });
    const id = n?.id ?? (await db.query<{ id: string }>(`select id from ${T}.node where qualified_name = $1`, [qualifiedName])).rows[0]?.id;
    if (!id) return [];
    const params: unknown[] = [id, opts.name ?? null];
    const col = opts.direction === 'in' ? 'to_id' : 'from_id';
    const r = await db.query(`select * from ${T}.edge e where e.${col} = $1 and ($2::text is null or e.name = $2) and ${asOfSql('e', opts, params)} order by e.id`, params);
    return r.rows.map(mapEdge);
  }

  /** Like edgesOf, with the qualified name at each end (what an API needs). */
  async namedEdgesOf(db: Queryable, qualifiedName: string, opts: { name?: string; direction?: 'out' | 'in' } & AsOf = {}): Promise<NamedEdge[]> {
    const edges = await this.edgesOf(db, qualifiedName, opts);
    if (edges.length === 0) return [];
    const ids = [...new Set(edges.flatMap((e) => [e.fromId, e.toId]))];
    const r = await db.query<{ id: string; qualified_name: string }>(`select id, qualified_name from ${T}.node where id = any($1::uuid[])`, [ids]);
    const qn = new Map(r.rows.map((x) => [x.id, x.qualified_name]));
    return edges.map((e) => ({ ...e, fromQn: qn.get(e.fromId) ?? e.fromId, toQn: qn.get(e.toId) ?? e.toId }));
  }

  /** Every version we have ever recorded for a node, oldest first. */
  async history(db: Queryable, qualifiedName: string): Promise<NodeRecord[]> {
    const r = await db.query(`select ${NODE_COLS} from ${T}.node n join ${T}.node_version v on v.node_id = n.id
      where n.qualified_name = $1 order by v.recorded_from, v.valid_from`, [qualifiedName]);
    return r.rows.map(mapNode);
  }
}
