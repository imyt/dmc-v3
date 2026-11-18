import type { Queryable } from '@dmc/platform';
import { CatalogScopes, type CatalogStore } from '@dmc/catalog';
import type { WorkflowEngine } from '@dmc/workflow';

export const LINK_WORKFLOW = 'scope-links';
const ACTOR = 'system/scope-links';
const M = 'workflow';

/**
 * C3. A submitted scope gives each application on its flows one task for its owner: link your tables and columns to the scope's business elements.
 * Run from housekeeping, so it needs no event and cannot be missed: it opens what is missing for the scope's current version,
 * and withdraws the open tasks of a scope that was amended and is being rewritten (submitting again opens them for the new version).
 */
export class ScopeLinkTasks {
  private readonly scopes: CatalogScopes;
  constructor(private readonly store: CatalogStore, private readonly engine: WorkflowEngine, private readonly db: { catalog: Queryable; workflow: Queryable }) { this.scopes = new CatalogScopes(store); }

  async sweep(): Promise<{ opened: number; withdrawn: number }> {
    let opened = 0; let withdrawn = 0;
    for (const scope of await this.store.listByType(this.db.catalog, 'Scope', { limit: 5000 })) {
      const subject = `Scope:${scope.qualifiedName}`;
      const version = Number(scope.attributes.version ?? 1);
      if (scope.attributes.status !== 'submitted') {
        const running = await this.db.workflow.query<{ id: string }>(`select id from ${M}.instance where name = $1 and subject_ref = $2 and status = 'running'`, [LINK_WORKFLOW, subject]);
        for (const r of running.rows) { await this.engine.cancel(this.db.workflow, r.id, ACTOR); withdrawn++; }
        continue;
      }
      const have = await this.db.workflow.query<{ app: string }>(
        `select context->>'app' as app from ${M}.instance where name = $1 and subject_ref = $2 and (context->>'version')::int = $3`, [LINK_WORKFLOW, subject, version]);
      const done = new Set(have.rows.map((r) => r.app));
      for (const app of await this.scopes.applicationsOn(this.db.catalog, scope.qualifiedName)) {
        if (done.has(app.qn)) continue;
        await this.engine.startInstance(this.db.workflow, {
          workflow: LINK_WORKFLOW, subjectRef: subject, actor: ACTOR,
          context: {
            route: app.owner ?? 'platform-governance', scope_owner: typeof scope.attributes.owner === 'string' ? scope.attributes.owner : 'platform-governance',
            app: app.qn, version, message: `Link ${app.name}'s tables and columns to the business elements of ${String(scope.attributes.name ?? scope.qualifiedName)} (version ${version}).`,
          },
        });
        opened++;
      }
    }
    return { opened, withdrawn };
  }
}
