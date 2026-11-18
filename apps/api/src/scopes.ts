import { CatalogDelegations, type NodeRecord } from '@dmc/catalog';
import type { ObjectFacts, Queryable } from '@dmc/platform';
import type { ApiDeps } from './context.js';

export const SCOPE_TYPES = new Set(['Scope', 'ScopeGroup', 'BusinessElement']);
export const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** The scope a scope, group or element belongs to: up the `includes` edges (element → group → scope). */
export async function scopeOf(d: Pick<ApiDeps, 'store'>, db: Queryable, n: NodeRecord): Promise<NodeRecord | undefined> {
  let cur: NodeRecord | undefined = n;
  for (let hops = 0; cur && hops < 3; hops++) {
    if (cur.type === 'Scope') return cur;
    const up = await d.store.namedEdgesOf(db, cur.qualifiedName, { name: 'includes', direction: 'in' });
    cur = up[0] ? await d.store.getNode(db, up[0].fromQn) : undefined;
  }
  return undefined;
}

/** Who may change a scope, and whether it is locked. Active delegates join the owner here. */
export async function scopeFacts(d: Pick<ApiDeps, 'store'>, db: Queryable, n: NodeRecord): Promise<ObjectFacts> {
  const scope = await scopeOf(d, db, n);
  if (!scope) return {};
  const owner = scope.attributes.owner;
  return { ...(typeof owner === 'string' ? { scopeOwner: owner } : {}), scopeDelegates: await delegatesOf(d, db, scope), locked: scope.attributes.status === 'submitted' };
}

export const delegatesOf = (d: Pick<ApiDeps, 'store'>, db: Queryable, scope: NodeRecord): Promise<string[]> => new CatalogDelegations(d.store).delegatesOf(db, scope);
