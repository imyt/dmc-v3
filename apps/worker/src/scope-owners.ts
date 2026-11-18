import type { ExceptionPort, Signal, SignalSink } from '@dmc/contracts';
import type { Queryable } from '@dmc/platform';
import type { CatalogStore } from '@dmc/catalog';

export const SCOPE_OWNER_POLICY = 'scope-owner-unknown';

/**
 * S11 (CAT-9): a scope synced from ARIS, RRIS or the BCBS inventory names its owner. The owner must be a Person in the catalog
 * (its key is the staff ID, ADR 0026). When it is not, the scope is kept as the source says (it is read-only in DMC) and an
 * exception goes to the platform admin; it is withdrawn when the owner appears. Nothing here fails a sync run.
 */
export class ScopeOwnerCheck implements SignalSink {
  constructor(private readonly d: { store: CatalogStore; connect(): Promise<Queryable & { release(): void }>; exceptions: ExceptionPort; next?: SignalSink; route?: string;
    /** subject references with an open `scope.owner_unknown` exception; needed by `recheck` */
    openUnknown?(): Promise<string[]> }) {}

  async submit(signals: Signal[]): Promise<void> {
    const scopes = signals.filter((s) => s.subjectType === 'Scope' && (s.kind === 'sync.upsert' || s.kind === 'sync.missing'));
    if (scopes.length) {
      const c = await this.d.connect();
      try { for (const s of scopes) await this.check(c, s); } finally { c.release(); }
    }
    if (this.d.next) await this.d.next.submit(signals);
  }

  /**
   * Periodic re-check (ADR 0024): an unknown-owner exception is also withdrawn when the Person appears later, without the scope record changing.
   * Looks only at scopes with an open exception, against the scope as it now is in the catalog; it never raises. A scope that is gone from the catalog or deprecated is withdrawn too.
   */
  async recheck(): Promise<{ checked: number; withdrawn: number }> {
    const refs = (await this.d.openUnknown?.()) ?? [];
    let withdrawn = 0;
    if (!refs.length) return { checked: 0, withdrawn };
    const c = await this.d.connect();
    try {
      for (const ref of refs) {
        const qn = ref.slice(ref.indexOf(':') + 1);
        const node = await this.d.store.getNode(c, qn);
        const owner = typeof node?.attributes.owner === 'string' ? node.attributes.owner.trim() : '';
        const gone = !node || node.lifecycle === 'deprecated';
        if (gone || (owner && await this.person(c, owner))) {
          if (await this.d.exceptions.withdraw({ policyId: SCOPE_OWNER_POLICY, subjectRef: ref, actor: 'system/scope-owners' })) withdrawn++;
        }
      }
    } finally { c.release(); }
    return { checked: refs.length, withdrawn };
  }

  private async check(c: Queryable, s: Signal): Promise<void> {
    const qn = s.subjectRef.slice(s.subjectType.length + 1);
    const base = { policyId: SCOPE_OWNER_POLICY, subjectRef: s.subjectRef, actor: `sync/${s.source}` };
    const owner = typeof s.asset.owner === 'string' ? s.asset.owner.trim() : '';
    if (s.kind === 'sync.missing' || (owner && await this.person(c, owner))) { await this.d.exceptions.withdraw(base); return; }
    const name = typeof s.asset.name === 'string' ? s.asset.name : qn;
    await this.d.exceptions.raise({ ...base, kind: 'scope.owner_unknown', severity: 'medium', route: this.d.route ?? 'platform-admin',
      message: owner ? `${s.source} lists ${owner} as owner of ${name}, but no such person is in the catalog` : `${s.source} lists no owner for ${name}` });
  }

  /** A Person whose key is the owner id the source gave (ADR 0026: the key is the staff ID; an email was already resolved to it before the scope was written). The id is used exactly as given: no padding, no trimming of zeros. */
  private async person(c: Queryable, owner: string): Promise<boolean> {
    return (await this.d.store.getNode(c, owner))?.type === 'Person';
  }
}
