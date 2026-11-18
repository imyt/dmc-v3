import type { Queryable, Registry } from '@dmc/platform';
import type { Signal, SignalSink, SubmitResult } from '@dmc/contracts';
import type { CatalogStore } from '@dmc/catalog';
import { classifyPersonRef, emailIndex, resolvePersonRef, staffIdPattern } from '@dmc/connectors';

const PAGE = 500;

/**
 * ADR 0026. Sits in front of the catalog ingest. The Person key is the staff ID (a string of 8 digits), so a source that names a person by email must be resolved
 * to the staff ID before anything is written:
 *  - an attribute the metamodel marks as a person (`type: person`, or `identifies: Person`) that a sync job writes;
 *  - the Person end of an edge (owned_by, stewarded_by ...) from a node whose type may link to a Person.
 * A staff ID passes through untouched (no trimming of zeros, no padding). An email is looked up on the Person's email attribute. A value that is all digits but not
 * 8 long, an email nobody has, or anything else is a data error: the record is refused through the same reject path as any record the catalog refuses
 * (`onReject`, and its key in `rejected`, so the sync run counts it and retries it), never guessed.
 * An email is also meant to identify one Person: a Person upsert whose email another Person already has (in the catalog, or in the same batch) is refused and reported the same way (IdP people job).
 */
export class PersonRefResolver implements SignalSink {
  private readonly pattern: RegExp;
  constructor(private readonly d: { store: CatalogStore; registry: Registry; connect(): Promise<Queryable & { release(): void }>; next: SignalSink; onReject?(s: Signal, reason: string): Promise<void> | void }) {
    this.pattern = staffIdPattern(d.registry);
  }

  async submit(signals: Signal[]): Promise<SubmitResult> {
    const out: Signal[] = []; const rejected: string[] = [];
    // Person upserts of this batch by email (lower case): an email given to two people in one run is refused for both, since nothing says which one is right
    const inBatch = new Map<string, string[]>();
    for (const s of signals) {
      const e = s.kind === 'sync.upsert' && s.subjectType === 'Person' && typeof s.asset.email === 'string' ? s.asset.email.trim().toLowerCase() : '';
      if (e) inBatch.set(e, [...(inBatch.get(e) ?? []), s.subjectRef.slice('Person:'.length)]);
    }
    let index: Map<string, string | null> | undefined; let activeIndex: Map<string, string | null> | undefined;
    const c = await this.d.connect();
    const load = async () => {
      const people: { qualifiedName: string; email?: unknown; lifecycle?: string }[] = [];
      for (let after: string | undefined; ;) {
        const page = await this.d.store.listByType(c, 'Person', { limit: PAGE, ...(after ? { afterQn: after } : {}) });
        people.push(...page.slice(0, PAGE).map((p) => ({ qualifiedName: p.qualifiedName, email: p.attributes.email, lifecycle: p.lifecycle })));
        if (page.length <= PAGE) break;
        after = page[PAGE - 1]!.qualifiedName;
      }
      index = emailIndex(people); activeIndex = emailIndex(people, { activeOnly: true });
    };
    /** resolution: an active Person first, a deprecated one only when no active Person has the email (ADR 0027) */
    const byEmail = async () => { if (!index) await load(); return index!; };
    /** duplicate check: a deprecated Person's email is free for a new hire */
    const byActiveEmail = async () => { if (!activeIndex) await load(); return activeIndex!; };
    try {
      for (const s of signals) {
        const r = await this.one(c, s, byEmail, byActiveEmail, inBatch);
        if ('error' in r) { rejected.push(s.key); await this.d.onReject?.(s, r.error); } else out.push(r.signal);
      }
    } finally { c.release(); }
    const next = out.length ? await this.d.next.submit(out) : undefined;
    const all = [...rejected, ...((next && next.rejected) ?? [])];
    return all.length ? { rejected: all } : {};
  }

  private async one(c: Queryable, s: Signal, byEmail: () => Promise<Map<string, string | null>>, byActiveEmail: () => Promise<Map<string, string | null>>, inBatch: Map<string, string[]>): Promise<{ signal: Signal } | { error: string }> {
    if (s.kind === 'sync.upsert' && s.subjectType === 'Person' && typeof s.asset.email === 'string' && s.asset.email.trim()) {
      const e = s.asset.email.trim().toLowerCase(); const key = s.subjectRef.slice('Person:'.length);
      if ((inBatch.get(e) ?? []).length > 1) return { error: `email ${e} is given to more than one Person in this run (${inBatch.get(e)!.join(', ')}): refused, fix it in the source` };
      const held = (await byActiveEmail()).get(e);
      if (held === null || (held !== undefined && held !== key)) return { error: `email ${e} already belongs to ${held === null ? 'more than one other Person' : `Person ${held}`}: refused, an email must identify one person` };
    }
    if (s.kind === 'sync.upsert' && this.d.registry.has(s.subjectType)) {
      const attrs = this.d.registry.get(s.subjectType).attributes;
      const asset = { ...s.asset };
      for (const [name, def] of Object.entries(attrs)) {
        if (def.type !== 'person' && def.identifies !== 'Person') continue;
        const v = asset[name];
        if (v === undefined || v === null || (typeof v === 'string' && v.trim() === '')) continue; // no owner at all is the owner check's business, not a data error here (a NULL or blank is turned into a clear by the job mapping, ADR 0027)
        const r = resolvePersonRef(v, this.pattern, classifyPersonRef(v, this.pattern).kind === 'email' ? await byEmail() : new Map());
        if ('error' in r) return { error: `${name}: ${r.error}` };
        asset[name] = r.id;
      }
      return { signal: { ...s, asset } };
    }
    if (s.kind === 'sync.link' || s.kind === 'sync.unlink') {
      const a = s.asset as { edge: string; from: string; to: string; attributes?: Record<string, unknown> };
      const ref = classifyPersonRef(a.to, this.pattern);
      if (ref.kind === 'staff') return { signal: s };
      const from = await this.d.store.getNode(c, a.from);
      // only the Person end of an edge is resolved; a Group (or any other end) keeps the name the source gave
      if (!from || !this.d.registry.canLink(from.type, a.edge, 'Person')) return { signal: s };
      if (ref.kind === 'error' && !/^\d+$/.test(String(a.to).trim())) return { signal: s };
      const r = resolvePersonRef(a.to, this.pattern, ref.kind === 'email' ? await byEmail() : new Map());
      if ('error' in r) return { error: `${a.edge} ${a.from}: ${r.error}` };
      return { signal: { ...s, asset: { ...a, to: r.id } } };
    }
    return { signal: s };
  }
}
