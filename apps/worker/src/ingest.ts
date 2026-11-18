import type { Queryable } from '@dmc/platform';
import type { Signal, SignalSink, SubmitResult } from '@dmc/contracts';
import type { CatalogStore } from '@dmc/catalog';

export interface IngestDeps {
  /** one connection as the catalog module's role */
  connect(): Promise<Queryable & { release(): void }>;
  store: CatalogStore;
  /** which source system a job's records come from (SyncService.writerSource) */
  sourceOf(job: string): Promise<string>;
  /** where signals go next (the decision path); omitted in tests that only look at the catalog */
  next?: SignalSink;
  /** a record the metamodel refuses is skipped and reported, so one bad record never blocks a run */
  onReject?(signal: Signal, reason: string): Promise<void> | void;
  /**
   * S10 / D3: edges the catalog accepted (`sync.link` only), so a pending change for an edge a tool owns (a classification) can be confirmed.
   * Edges still never reach the decision path as asset changes; this is a separate, optional hook.
   */
  linked?(signals: Signal[]): Promise<void> | void;
}

/** What a linked edge shows about its from-node, in the shape D3's confirmOnSync reads: `{ <edge name>: <qualified name of the other end> }`. Names only, never source data. */
export function edgeObservation(s: Signal): { subjectRef: string; attributes: Record<string, unknown> } | undefined {
  if (s.kind !== 'sync.link') return undefined;
  const { edge, from, to } = s.asset as { edge: string; from: string; to: string };
  return { subjectRef: `${s.subjectType}:${from}`, attributes: { [edge]: to } };
}

/** The `linked` hook the worker uses: each accepted edge is shown to D3 as the source that owns the job's records. */
export const confirmLinked = (actions: { confirmOnSync(source: string, observed: { subjectRef: string; attributes: Record<string, unknown> }[], now?: Date): Promise<unknown> }, writerSource: (job: string) => Promise<string>, now?: () => Date) =>
  async (signals: Signal[]): Promise<void> => {
    for (const s of signals) { const o = edgeObservation(s); if (o) await actions.confirmOnSync(await writerSource(s.source), [o], now?.()); }
  };

/**
 * Applies sync signals to the catalog, then passes them on to the decision path.
 * `sync.upsert` creates or updates the node (only attributes the source owns can be written); `sync.missing` deprecates it.
 * Both are idempotent: the same record again changes nothing.
 */
export class CatalogIngest implements SignalSink {
  constructor(private readonly d: IngestDeps) {}

  /** Returns the keys of the signals the catalog refused, so the sync run does not record those records as delivered (ADR 0024). */
  async submit(signals: Signal[]): Promise<SubmitResult> {
    const forwarded: Signal[] = [];
    const rejected: string[] = [];
    const linked: Signal[] = [];
    const c = await this.d.connect();
    try {
      for (const s of signals) {
        if (s.kind !== 'sync.upsert' && s.kind !== 'sync.missing' && s.kind !== 'sync.link' && s.kind !== 'sync.unlink') { forwarded.push(s); continue; }
        try {
          if (s.kind === 'sync.link' || s.kind === 'sync.unlink') { await this.applyEdge(c, s); if (s.kind === 'sync.link') linked.push(s); continue; } // an edge is not an asset change: nothing for the decision path
          forwarded.push(await this.apply(c, s));
        }
        catch (e) {
          if (!(e instanceof Error) || !('code' in e)) throw e; // only the catalog's own refusals are record problems
          await c.query('rollback').catch(() => undefined);
          rejected.push(s.key);
          await this.d.onReject?.(s, e.message);
        }
      }
    } finally { c.release(); }
    if (linked.length) await this.d.linked?.(linked);
    if (forwarded.length) await this.d.next?.submit(forwarded);
    return rejected.length ? { rejected } : {};
  }

  /**
   * S8: `sync.link` creates (or re-describes) an edge the source owns, `sync.unlink` ends it. The edge name and its ends are checked by the metamodel in the store;
   * the source system is the edge's provenance and the producing job travels in the edge attributes. Both ends must already exist: a missing end is refused and reported.
   */
  private async applyEdge(c: Queryable, s: Signal): Promise<void> {
    const { edge, from, to, attributes } = s.asset as { edge: string; from: string; to: string; attributes?: Record<string, unknown> };
    const actor = s.actor ?? `sync/${s.source}`;
    await this.d.store.tx(c, async () => {
      const source = await this.d.sourceOf(s.source);
      if (s.kind === 'sync.unlink') await this.d.store.unlink(c, { name: edge, fromQn: from, toQn: to, actor, source });
      else await this.d.store.link(c, { name: edge, fromQn: from, toQn: to, source, actor, attributes: attributes ?? {} });
    });
  }

  /** Returns the signal the decision path should see: its asset is the whole node as it now is, because policies are written against the node, not the source record. */
  private async apply(c: Queryable, s: Signal): Promise<Signal> {
    const qn = s.subjectRef.slice(s.subjectType.length + 1);
    const actor = s.actor ?? `sync/${s.source}`;
    return this.d.store.tx(c, async (): Promise<Signal> => {
      if (s.kind === 'sync.missing') {
        if (await this.d.store.getNode(c, qn)) await this.d.store.setLifecycle(c, qn, 'deprecated', actor);
        const gone = await this.d.store.getNode(c, qn);
        return { ...s, asset: { ...(gone?.attributes ?? {}), qualified_name: qn, lifecycle: 'deprecated' } };
      }
      const source = await this.d.sourceOf(s.source);
      await this.d.store.applyNode(c, { type: s.subjectType, qualifiedName: qn, attributes: s.asset, writer: { kind: 'sync', source }, actor });
      let n = await this.d.store.getNode(c, qn);
      if (n?.lifecycle === 'deprecated') { await this.d.store.setLifecycle(c, qn, 'discovered', actor); n = await this.d.store.getNode(c, qn); } // seen again
      return { ...s, asset: { ...(n?.attributes ?? {}), qualified_name: qn, lifecycle: n?.lifecycle ?? 'discovered' } };
    });
  }
}
