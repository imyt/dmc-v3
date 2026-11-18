import type { Queryable } from '@dmc/platform';
import type { CatalogStore } from './store.js';

export interface ScopeApplication { qn: string; name: string; owner?: string; delegates: string[] }

/** What the catalog says about a scope's surroundings: which applications its data flows through. */
export class CatalogScopes {
  constructor(private readonly store: CatalogStore) {}

  /** Applications that are the source or the target of an integration the scope flows through, with their owners. */
  async applicationsOn(db: Queryable, scopeQn: string): Promise<ScopeApplication[]> {
    const apps = new Map<string, ScopeApplication>();
    for (const flow of await this.store.namedEdgesOf(db, scopeQn, { name: 'flows_through', direction: 'out' })) {
      for (const edge of ['source_of', 'target_of']) {
        for (const e of await this.store.namedEdgesOf(db, flow.toQn, { name: edge, direction: 'in' })) {
          if (apps.has(e.fromQn)) continue;
          const a = await this.store.getNode(db, e.fromQn);
          if (a?.type !== 'Application') continue;
          const delegates = Array.isArray(a.attributes.delegates) ? a.attributes.delegates.filter((x): x is string => typeof x === 'string') : [];
          apps.set(a.qualifiedName, { qn: a.qualifiedName, name: String(a.attributes.name ?? a.qualifiedName), ...(typeof a.attributes.owner === 'string' ? { owner: a.attributes.owner } : {}), delegates });
        }
      }
    }
    return [...apps.values()];
  }
}
