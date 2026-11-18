import { ApiError, type Queryable } from '@dmc/platform';
import type { LineageEdge, LineageNode, LineageQuery, LineageResult, LineageStore } from '@dmc/contracts';

const T = 'catalog';
const MAX_DEPTH = 20; const MAX_NODES = 20_000;
export const LINEAGE_EDGE = 'derives_from';

/**
 * Lineage over `catalog.edge` with a recursive query. An edge `A derives_from B` means A is built from B:
 * upstream follows A → B, downstream follows B → A. Depth and node count are capped so one wide column cannot take the database down.
 * Edges that are ended or deprecated are not walked.
 */
export class CatalogLineage implements LineageStore {
  constructor(private readonly db: Queryable) {}

  async traverse(qualifiedName: string, q: LineageQuery): Promise<LineageResult | undefined> {
    const depth = q.depth ?? 10; const maxNodes = q.maxNodes ?? 5000; const minConf = q.minConfidence ?? 0;
    if (!Number.isInteger(depth) || depth < 1 || depth > MAX_DEPTH) throw new ApiError('validation_failed', `depth must be 1..${MAX_DEPTH}`, [{ path: 'depth', message: `1 to ${MAX_DEPTH}` }]);
    if (!Number.isInteger(maxNodes) || maxNodes < 1 || maxNodes > MAX_NODES) throw new ApiError('validation_failed', `max_nodes must be 1..${MAX_NODES}`, [{ path: 'max_nodes', message: `1 to ${MAX_NODES}` }]);
    const root = (await this.db.query<{ id: string; type: string }>(`select id, type from ${T}.node where qualified_name = $1`, [qualifiedName])).rows[0];
    if (!root) return undefined;

    const [near, far] = q.direction === 'upstream' ? ['from_id', 'to_id'] : ['to_id', 'from_id'];
    const live = (conf: string) => `e.name = '${LINEAGE_EDGE}' and e.valid_to is null and e.recorded_to is null and e.lifecycle <> 'deprecated' and coalesce((e.attributes->>'confidence')::numeric, 1) >= ${conf}`;
    // UNION (not UNION ALL) drops repeats of (node, depth), so cycles end at the depth cap; the node cap stops wide fan-out early
    const walk = await this.db.query<{ node_id: string; depth: number }>(
      `with recursive walk(node_id, depth) as (
         select $1::uuid, 0
         union
         select e.${far}, w.depth + 1 from walk w join ${T}.edge e on e.${near} = w.node_id and ${live('$4')} where w.depth < $2
       )
       select node_id, min(depth)::int as depth from walk group by node_id order by min(depth), node_id limit $3`,
      [root.id, depth, maxNodes + 1, minConf]);
    const cappedNodes = walk.rows.length > maxNodes;
    const rows = walk.rows.slice(0, maxNodes);
    const ids = rows.map((r) => r.node_id);

    const info = await this.db.query<{ id: string; qualified_name: string; type: string; container: string | null }>(
      `select n.id, n.qualified_name, n.type,
              (select p.qualified_name from ${T}.edge c join ${T}.node p on p.id = c.from_id
                where c.name = 'contains' and c.to_id = n.id and c.valid_to is null and c.recorded_to is null limit 1) as container
         from ${T}.node n where n.id = any($1::uuid[])`, [ids]);
    const byId = new Map(info.rows.map((r) => [r.id, r]));
    const nodes: LineageNode[] = rows.map((r) => { const i = byId.get(r.node_id)!; return { qualifiedName: i.qualified_name, type: i.type, depth: r.depth, ...(i.container ? { container: i.container } : {}) }; });

    const edgeRows = await this.db.query<{ from_qn: string; to_qn: string; source: string; attributes: Record<string, unknown> }>(
      `select f.qualified_name as from_qn, t.qualified_name as to_qn, e.source, e.attributes
         from ${T}.edge e join ${T}.node f on f.id = e.from_id join ${T}.node t on t.id = e.to_id
        where e.from_id = any($1::uuid[]) and e.to_id = any($1::uuid[]) and ${live('$2')}
        order by f.qualified_name, t.qualified_name`, [ids, minConf]);
    const edges: LineageEdge[] = edgeRows.rows.map((e) => ({ from: e.from_qn, to: e.to_qn, source: e.source,
      ...(typeof e.attributes.job === 'string' ? { job: e.attributes.job } : {}), ...(typeof e.attributes.confidence === 'number' ? { confidence: e.attributes.confidence } : {}) }));

    // more beyond the depth cap? one step further from the nodes at the last level
    const lastLevel = rows.filter((r) => r.depth === depth).map((r) => r.node_id);
    let deeper = false;
    if (lastLevel.length) {
      deeper = ((await this.db.query(`select 1 from ${T}.edge e where e.${near} = any($1::uuid[]) and ${live('$2')} limit 1`, [lastLevel, minConf])).rowCount ?? 0) > 0;
    }
    return { root: qualifiedName, direction: q.direction, nodes, edges, truncated: { depth: deeper, nodes: cappedNodes } };
  }
}
