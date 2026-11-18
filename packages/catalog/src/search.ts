import type { Queryable } from '@dmc/platform';
import type { Lifecycle } from './store.js';

export interface SearchQuery {
  text: string;
  types?: string[];
  lifecycles?: Lifecycle[];
  limit?: number;
  offset?: number; // capped at 1000: refine the query instead of paging deep
}
export interface SearchHit { id: string; type: string; qualifiedName: string; name: string; lifecycle: Lifecycle; rank: number }
export interface SearchResult {
  hits: SearchHit[];
  facets: { type: Record<string, number>; lifecycle: Record<string, number> };
  /** true when more than FACET_SAMPLE rows matched: ranking and facets cover only the first FACET_SAMPLE */
  facetsSampled: boolean;
}

/** What the rest of DMC depends on; Postgres is one implementation. */
export interface SearchPort {
  search(q: SearchQuery): Promise<SearchResult>;
}

export const FACET_SAMPLE = 5000;

/** 'sys pay' → 'sys':* & 'pay':*  (every word is a prefix, so results appear as the user types) */
export function toTsQuery(text: string): string | undefined {
  const tokens = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0, 8);
  return tokens.length ? tokens.map((t) => `'${t.replace(/'/g, "''")}':*`).join(' & ') : undefined;
}

export class PostgresSearch implements SearchPort {
  constructor(private readonly db: Queryable) {}

  async search(q: SearchQuery): Promise<SearchResult> {
    const tsq = toTsQuery(q.text);
    if (!tsq) return { hits: [], facets: { type: {}, lifecycle: {} }, facetsSampled: false };
    const limit = Math.min(q.limit ?? 20, 100);
    const offset = Math.min(q.offset ?? 0, 1000);
    const p: unknown[] = [tsq, q.types?.length ? q.types : null, q.lifecycles?.length ? q.lifecycles : null];
    const where = `doc @@ to_tsquery('simple', $1) and ($2::text[] is null or type = any($2)) and ($3::text[] is null or lifecycle = any($3))`;

    // Rank only a bounded candidate set: exact for narrow queries, approximate for very broad ones.
    const cand = `select node_id, type, qualified_name, name, lifecycle, doc from catalog.search_doc where ${where} limit ${FACET_SAMPLE + 1}`;
    const hits = await this.db.query<{ node_id: string; type: string; qualified_name: string; name: string; lifecycle: Lifecycle; rank: number }>(
      `with c as (${cand}) select node_id, type, qualified_name, name, lifecycle, ts_rank_cd(doc, to_tsquery('simple', $1)) as rank
         from c order by rank desc, qualified_name limit ${limit} offset ${offset}`, p);

    const f = await this.db.query<{ type: string; lifecycle: string; n: string; total: string }>(
      `with c as (${cand}) select type, lifecycle, count(*) n, sum(count(*)) over () total from c group by type, lifecycle`, p);
    const facets = { type: {} as Record<string, number>, lifecycle: {} as Record<string, number> };
    for (const r of f.rows) {
      facets.type[r.type] = (facets.type[r.type] ?? 0) + Number(r.n);
      facets.lifecycle[r.lifecycle] = (facets.lifecycle[r.lifecycle] ?? 0) + Number(r.n);
    }
    const total = f.rows[0] ? Number(f.rows[0].total) : 0;
    return {
      hits: hits.rows.map((r) => ({ id: r.node_id, type: r.type, qualifiedName: r.qualified_name, name: r.name, lifecycle: r.lifecycle, rank: Number(r.rank) })),
      facets, facetsSampled: total > FACET_SAMPLE,
    };
  }
}

/** Text that goes into the index: name weighted highest, then the qualified name, then every other string attribute. */
export function indexParts(qualifiedName: string, attributes: Record<string, unknown>): { name: string; rest: string } {
  const name = typeof attributes.name === 'string' ? attributes.name : qualifiedName;
  const rest = Object.entries(attributes).filter(([k, v]) => k !== 'name' && typeof v === 'string').map(([, v]) => v as string).join(' ');
  return { name, rest };
}
