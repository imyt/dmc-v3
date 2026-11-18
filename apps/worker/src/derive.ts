import { createHash } from 'node:crypto';
import type { Queryable } from '@dmc/platform';
import type { Signal, SignalSink } from '@dmc/contracts';
import { CatalogLineage, type CatalogStore, type NodeRecord } from '@dmc/catalog';
import { evaluateTransfer, type TransferResult, type Visa } from '@dmc/privacy';
import { gradeAsset, requiredTier, TIERS, TrustService, type Tier, type TrustFacts } from '@dmc/trust';
import { nearest, proposeFrom, type ClassEdge, type Proposal } from '@dmc/lineage';

/**
 * L2, L3, L4. Derived facts the policies decide on: cross-border cover, trust tiers and classification proposals.
 * Each pass reads the catalog, records what it concluded (as derived attributes or its own tables) and sends a signal only when the
 * conclusion changed, so the decision path raises, or clears, exceptions without being asked twice.
 */
export interface DeriveDb { catalog: Queryable; trust: Queryable; workflow: Queryable; actions: Queryable }
const ACTOR = 'system/derive';
const DERIVED = { kind: 'sync', source: 'derived' } as const;
const LIMIT = 5000;
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 16);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

export class Derivations {
  private readonly trust = new TrustService();
  constructor(private readonly store: CatalogStore, private readonly db: DeriveDb, private readonly sink: SignalSink, private readonly now: () => Date = () => new Date()) {}

  private async out(qn: string, name: string, dir: 'out' | 'in' = 'out') { return this.store.namedEdgesOf(this.db.catalog, qn, { name, direction: dir }); }
  private async node(qn: string): Promise<NodeRecord | undefined> { return this.store.getNode(this.db.catalog, qn); }
  private async write(type: string, qn: string, attributes: Record<string, unknown>) {
    return this.store.tx(this.db.catalog, () => this.store.applyNode(this.db.catalog, { type, qualifiedName: qn, attributes, writer: DERIVED, actor: ACTOR }));
  }
  private signal(s: Omit<Signal, 'source' | 'actor'>): Signal { return { source: 'dmc-derive', actor: ACTOR, ...s }; }

  // ---- L4: cross-border ----

  /** Every integration between applications in different countries gets a CrossBorderTransfer with its DataVisa status. */
  async crossBorder(): Promise<{ transfers: number; changed: number }> {
    const today = this.now().toISOString().slice(0, 10);
    const visas: Visa[] = (await this.store.listByType(this.db.catalog, 'DataVisa', { limit: LIMIT })).map((v) => ({
      qualifiedName: v.qualifiedName, sourceCountry: String(v.attributes.source_country ?? ''), targetCountry: String(v.attributes.target_country ?? ''),
      categories: Array.isArray(v.attributes.data_categories) ? v.attributes.data_categories.map(String) : [], validFrom: String(v.attributes.valid_from ?? '0000-01-01'),
      ...(str(v.attributes.valid_to) ? { validTo: str(v.attributes.valid_to)! } : {}), ...(str(v.attributes.status) ? { status: str(v.attributes.status)! } : {}) }));
    let transfers = 0; let changed = 0; const signals: Signal[] = [];
    for (const i of await this.store.listByType(this.db.catalog, 'Integration', { limit: LIMIT })) {
      const country = async (edge: string) => {
        for (const e of await this.out(i.qualifiedName, edge, 'in')) { const a = await this.node(e.fromQn); if (a?.type === 'Application') return str(a.attributes.hosting_country); }
        return undefined;
      };
      // data categories of the integration's datasets, by every name a DataVisa might use for them
      const cats = new Map<string, string>();
      for (const t of await this.out(i.qualifiedName, 'transfers')) for (const c of await this.out(t.toQn, 'in_category')) {
        const n = await this.node(c.toQn);
        for (const alias of [c.toQn, c.toQn.split(':').pop()!, String(n?.attributes.name ?? '')]) if (alias) cats.set(alias.toLowerCase(), c.toQn);
      }
      const assess = (await this.out(i.qualifiedName, 'assessed_by'))[0];
      const a = assess ? await this.node(assess.toQn) : undefined;
      const input = {
        integration: i.qualifiedName, sourceCountry: await country('source_of'), targetCountry: await country('target_of'),
        ...(a ? { assessment: { qualifiedName: a.qualifiedName, outcome: a.attributes.outcome as 'datavisa-required' | 'datavisa-not-required' } } : {}),
        categories: [...new Set(cats.values())],
        visas: visas.map((v) => ({ ...v, categories: v.categories.map((c) => cats.get(c.toLowerCase()) ?? c) })),
      };
      const r: TransferResult | undefined = evaluateTransfer(input, today);
      if (!r) continue;
      transfers++;
      const attrs = { from_country: r.fromCountry, to_country: r.toCountry, data_categories: r.categories, status: r.status, ...(r.problem ? { problem: r.problem } : {}), uncovered: r.uncovered, ...(r.message ? { detail: r.message } : {}) };
      const before = await this.node(r.qualifiedName);
      const res = await this.write('CrossBorderTransfer', r.qualifiedName, attrs);
      const lnk = async (name: string, to: string) => this.store.tx(this.db.catalog, () => this.store.link(this.db.catalog, { name, fromQn: r.qualifiedName, toQn: to, source: 'derived', actor: ACTOR }));
      await lnk('over', i.qualifiedName);
      if (r.visas[0] && r.status === 'covered') await lnk('covered_by', r.visas[0]);
      if (res.changed || !before) {
        changed++;
        signals.push(this.signal({ key: `xborder:${r.qualifiedName}:${hash(attrs)}`, kind: 'derived.upsert', subjectRef: `CrossBorderTransfer:${r.qualifiedName}`, subjectType: 'CrossBorderTransfer', asset: { qualified_name: r.qualifiedName, ...attrs } }));
      }
    }
    if (signals.length) await this.sink.submit(signals);
    return { transfers, changed };
  }

  // ---- L3: trust tiers ----

  /** Assets that implement elements of submitted scopes, with the kinds of scope that need them. */
  private async scopedAssets(): Promise<Map<string, Set<string>>> {
    const out = new Map<string, Set<string>>();
    for (const s of await this.store.listByType(this.db.catalog, 'Scope', { limit: LIMIT })) {
      if (s.attributes.status !== 'submitted') continue;
      const tier = TIERS.includes(s.attributes.required_tier as Tier) ? String(s.attributes.required_tier) : 'bronze';
      for (const g of await this.out(s.qualifiedName, 'includes')) for (const e of await this.out(g.toQn, 'includes')) for (const l of await this.out(e.toQn, 'implemented_by')) {
        if ((l.attributes?.state ?? 'confirmed') !== 'confirmed') continue;
        out.set(l.toQn, (out.get(l.toQn) ?? new Set()).add(tier));
      }
    }
    return out;
  }

  private async countFor(db: Queryable, sql: string, ref: string): Promise<number> { return Number(((await db.query<{ n: string }>(sql, [ref])).rows[0])?.n ?? 0); }

  private async factsFor(n: NodeRecord): Promise<TrustFacts> {
    const has = async (edge: string, node = n.qualifiedName) => (await this.out(node, edge)).length > 0;
    const columns = n.type === 'Table' ? (await this.out(n.qualifiedName, 'contains')).map((e) => e.toQn) : [n.qualifiedName];
    const every = async (edge: string) => { for (const c of columns) if (!(await has(edge, c))) return false; return columns.length > 0; };
    const ref = `${n.type}:${n.qualifiedName}`;
    const lineageAll = new CatalogLineage(this.db.catalog);
    const up = await lineageAll.traverse(columns[0] ?? n.qualifiedName, { direction: 'upstream', depth: 20 });
    const hasUp = !!up && up.edges.length > 0;
    const sure = (up?.edges ?? []).every((e) => (e.confidence ?? 1) >= 0.8);
    const latest = Object.values(n.provenance).map((p) => Date.parse(p.at)).filter((x) => !Number.isNaN(x)).sort((a, b) => b - a)[0];
    const ageDays = latest === undefined ? undefined : (this.now().getTime() - latest) / 86_400_000;
    const open = await this.countFor(this.db.workflow, `select count(*) as n from workflow.exception e join workflow.instance i on i.id = e.instance_id where e.subject_ref = $1 and i.status = 'running'`, ref);
    const late = await this.countFor(this.db.workflow, `select count(*) as n from workflow.exception e join workflow.instance i on i.id = e.instance_id where e.subject_ref = $1 and i.status = 'running' and e.due_at < now()`, ref);
    const pending = await this.countFor(this.db.actions, `select count(*) as n from actions.pending_change where subject_ref = $1 and state = 'pending'`, ref);
    return {
      ownership: { owner: !!str(n.attributes.owner) || await has('owned_by'), steward: await has('stewarded_by'), description: !!str(n.attributes.description), classificationConfirmed: await has('classified_as'),
        allColumnsClassified: await every('classified_as'), allColumnsLinkedToTerms: await every('represents') },
      quality: { rulesDefined: await has('checked_by'), openCriticalBreach: undefined },   // pass rates arrive with the DQ Hub job (S9); until then Silver and Gold quality are not reachable
      lineage: { tableLevelToSource: hasUp, columnLevelCritical: hasUp, columnLevelEndToEnd: hasUp && !up!.truncated.depth && !up!.truncated.nodes && sure },
      compliance: { overduePrivacyOrRetention: false, exceptionsPastSla: late, openExceptions: open, controlsEvidenced: true },
      sync: { ...(ageDays !== undefined ? { ageDays } : {}), dailyFor7Days: ageDays !== undefined && ageDays <= 1, pendingChanges: pending },
    };
  }

  /** Grade every asset a submitted scope depends on against the tier its scopes require; a changed result is stored, written to the asset, and decided on. */
  async trustTiers(): Promise<{ graded: number; changed: number; short: number }> {
    let graded = 0; let changed = 0; let short = 0; const signals: Signal[] = [];
    for (const [qn, kinds] of await this.scopedAssets()) {
      const n = await this.node(qn);
      if (!n || (n.type !== 'Column' && n.type !== 'Table')) continue;
      const required: Tier = requiredTier([...kinds] as Tier[]);
      const r = gradeAsset(await this.factsFor(n));
      const rec = await this.trust.record(this.db.trust, `${n.type}:${qn}`, r, required, ACTOR);
      graded++; if (!rec.meets) short++;
      const attrs = { trust_tier: r.tier, required_tier: required, trust_shortfall: !rec.meets };
      const res = await this.write(n.type, qn, attrs);
      if (rec.changed || res.changed) {
        changed++;
        signals.push(this.signal({ key: `trust:${qn}:${hash(attrs)}`, kind: 'derived.upsert', subjectRef: `${n.type}:${qn}`, subjectType: n.type, asset: { qualified_name: qn, ...attrs } }));
      }
    }
    if (signals.length) await this.sink.submit(signals);
    return { graded, changed, short };
  }

  // ---- L2: classification along lineage ----

  private async classes(qn: string): Promise<ClassEdge[]> {
    return (await this.out(qn, 'classified_as')).map((e) => ({ code: e.toQn, scheme: e.toQn.split(':')[0]!, source: e.source }));
  }

  /** Columns downstream of a tool-classified column get a proposal. Tool-classified columns are never overridden. */
  async classifications(): Promise<{ proposed: number; changed: number }> {
    const lineage = new CatalogLineage(this.db.catalog);
    const props: Proposal[] = [];
    const held = new Map<string, ClassEdge[]>();
    for (const c of await this.store.listByType(this.db.catalog, 'Column', { limit: LIMIT })) {
      const classes = await this.classes(c.qualifiedName);
      if (!classes.some((x) => x.source === 'classification-tool')) continue;
      const down = await lineage.traverse(c.qualifiedName, { direction: 'downstream', depth: 10 });
      const targets = (down?.nodes ?? []).filter((x) => x.depth > 0 && x.type === 'Column').map((x) => ({ qn: x.qualifiedName, depth: x.depth }));
      for (const t of targets) if (!held.has(t.qn)) held.set(t.qn, await this.classes(t.qn));
      props.push(...proposeFrom({ qn: c.qualifiedName, classes }, targets, held));
    }
    const byTarget = new Map<string, Proposal[]>();
    const rejected = new Map<string, string[]>();
    for (const p of nearest(props)) {
      // a steward who rejected a classification is not asked again
      if (!rejected.has(p.target)) { const r = (await this.node(p.target))?.attributes.rejected_classification; rejected.set(p.target, Array.isArray(r) ? r.map(String) : []); }
      if (rejected.get(p.target)!.includes(p.code)) continue;
      byTarget.set(p.target, [...(byTarget.get(p.target) ?? []), p]);
    }
    const signals: Signal[] = []; let changed = 0;
    for (const [target, ps] of byTarget) {
      const codes = ps.map((p) => p.code);
      const res = await this.write('Column', target, { proposed_classification: codes, proposed_from: [...new Set(ps.map((p) => p.via))].sort() });
      if (res.changed) {
        changed++;
        signals.push(this.signal({ key: `classify:${target}:${hash(codes)}`, kind: 'derived.upsert', subjectRef: `Column:${target}`, subjectType: 'Column',
          asset: { qualified_name: target, proposed_classification: codes, proposed_from: ps.map((p) => p.via) } }));
      }
    }
    // a column whose proposal no longer applies (accepted, or the lineage changed) is cleared
    for (const c of await this.store.listByType(this.db.catalog, 'Column', { limit: LIMIT })) {
      const have = c.attributes.proposed_classification;
      if (Array.isArray(have) && have.length && !byTarget.has(c.qualifiedName)) {
        await this.write('Column', c.qualifiedName, { proposed_classification: [], proposed_from: [] });
        signals.push(this.signal({ key: `classify:${c.qualifiedName}:cleared:${hash(have)}`, kind: 'derived.upsert', subjectRef: `Column:${c.qualifiedName}`, subjectType: 'Column', asset: { qualified_name: c.qualifiedName, proposed_classification: [] } }));
      }
    }
    if (signals.length) await this.sink.submit(signals);
    return { proposed: byTarget.size, changed };
  }

  async all() { return { crossBorder: await this.crossBorder(), trust: await this.trustTiers(), classifications: await this.classifications() }; }
}
