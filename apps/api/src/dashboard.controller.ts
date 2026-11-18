import { Controller, Get, Inject, UseGuards } from '@nestjs/common';
import type { Queryable } from '@dmc/platform';
import type { NodeRecord } from '@dmc/catalog';
import { verifyChain } from '@dmc/evidence';
import { AuthGuard } from './auth.js';
import { DEPS, type ApiDeps } from './context.js';

interface Measure { id: string; label: string; value: number; target: number | null; unit: 'percent' | 'count' | 'days'; detail?: string }
const pct = (n: number, of: number): number => (of === 0 ? 0 : Math.round((n / of) * 1000) / 10);
const quantile = (xs: number[], q: number): number => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)]! * 10) / 10; };

/**
 * U5. The success measures of the PRD that DMC can work out from what it holds today. Targets are the one-year targets.
 * Applications are counted against the applications in the catalog, not the whole estate.
 */
@Controller('v1/dashboard')
@UseGuards(AuthGuard)
export class DashboardController {
  constructor(@Inject(DEPS) private readonly d: ApiDeps) {}

  private async all(db: Queryable, type: string): Promise<NodeRecord[]> {
    const out: NodeRecord[] = [];
    for (let after: string | undefined; ;) {
      const page = await this.d.store.listByType(db, type, { limit: 500, afterQn: after });
      out.push(...page);
      if (page.length < 500) return out;
      after = page.at(-1)!.qualifiedName;
    }
  }

  @Get('measures')
  async measures() {
    const c = await this.d.connect();
    const ms: Measure[] = [];
    try {
      // applications taken on: an owner, at least one integration, and every integration carries a dataset
      const apps = await this.all(c, 'Application');
      const taken = new Set(apps.filter((a) => typeof a.attributes.owner === 'string' && a.attributes.owner).map((a) => a.qualifiedName));
      const has = new Set<string>(); const bad = new Set<string>();
      for (const i of await this.all(c, 'Integration')) {
        const datasets = (await this.d.store.namedEdgesOf(c, i.qualifiedName, { name: 'transfers', direction: 'out' })).length;
        for (const edge of ['source_of', 'target_of']) for (const e of await this.d.store.namedEdgesOf(c, i.qualifiedName, { name: edge, direction: 'in' })) { has.add(e.fromQn); if (!datasets) bad.add(e.fromQn); }
      }
      const done = [...taken].filter((q) => has.has(q) && !bad.has(q)).length;
      ms.push({ id: 'applications_taken_on', label: 'Applications taken on', value: pct(done, apps.length), target: 10, unit: 'percent', detail: `${done} of ${apps.length} applications in the catalog` });

      // scopes
      const scopes = (await this.all(c, 'Scope')).filter((s) => s.attributes.status === 'submitted');
      let els = 0; let linked = 0; let complete = 0;
      for (const s of scopes) {
        let n = 0; let l = 0;
        for (const g of await this.d.store.namedEdgesOf(c, s.qualifiedName, { name: 'includes', direction: 'out' }))
          for (const e of await this.d.store.namedEdgesOf(c, g.toQn, { name: 'includes', direction: 'out' })) {
            n++;
            if ((await this.d.store.namedEdgesOf(c, e.toQn, { name: 'implemented_by', direction: 'out' })).some((x) => (x.attributes?.state ?? 'confirmed') === 'confirmed')) l++;
          }
        els += n; linked += l; if (n > 0 && l === n) complete++;
      }
      ms.push({ id: 'scopes_submitted', label: 'Priority returns with scopes submitted', value: scopes.length, target: 50, unit: 'count' });
      ms.push({ id: 'scopes_complete', label: 'Submitted scopes with every element linked', value: complete, target: null, unit: 'count', detail: `${complete} of ${scopes.length} submitted scopes` });
      ms.push({ id: 'element_links', label: 'Elements of submitted scopes with confirmed column links', value: pct(linked, els), target: 70, unit: 'percent', detail: `${linked} of ${els} elements` });

      // cross-border
      const transfers = await this.all(c, 'CrossBorderTransfer');
      const assessed = transfers.filter((t) => t.attributes.problem !== 'no_assessment').length;
      ms.push({ id: 'cross_border_assessed', label: 'Cross-border integrations with a current assessment', value: pct(assessed, transfers.length), target: 70, unit: 'percent', detail: `${assessed} of ${transfers.length} cross-border integrations` });

      // trust tiers
      const assets = [...await this.all(c, 'Column'), ...await this.all(c, 'Table')].filter((n) => typeof n.attributes.required_tier === 'string');
      const atTier = assets.filter((n) => n.attributes.trust_shortfall !== true).length;
      ms.push({ id: 'trust_at_required', label: 'Assets of submitted scopes at their required trust tier', value: pct(atTier, assets.length), target: 40, unit: 'percent', detail: `${atTier} of ${assets.length} assets` });
      for (const tier of ['unverified', 'bronze', 'silver', 'gold']) ms.push({ id: `trust_${tier}`, label: `Assets graded ${tier}`, value: assets.filter((n) => (n.attributes.trust_tier ?? 'unverified') === tier).length, target: null, unit: 'count' });

      // requirements
      const reqs = await this.all(c, 'ControlRequirement');
      const policies = this.d.policies();
      const enforced = reqs.filter((r) => policies.some((p) => p.implements === r.attributes.reference_id && p.mode === 'enforced')).length;
      ms.push({ id: 'requirements_enforced', label: 'Requirements with an enforced policy', value: pct(enforced, reqs.length), target: null, unit: 'percent', detail: `${enforced} of ${reqs.length} requirements` });
    } finally { c.release(); }

    if (this.d.stats) {
      const s = await this.d.stats();
      const ages = s.exceptions.openAgesDays;
      ms.push({ id: 'exceptions_open', label: 'Open exceptions', value: ages.length, target: null, unit: 'count' });
      ms.push({ id: 'exceptions_overdue', label: 'Exceptions past their due date', value: s.exceptions.overdue, target: 0, unit: 'count' });
      ms.push({ id: 'exception_age_median', label: 'Exception age, median', value: quantile(ages, 0.5), target: 15, unit: 'days' });
      ms.push({ id: 'exception_age_p95', label: 'Exception age, 95th percentile', value: quantile(ages, 0.95), target: 45, unit: 'days' });
      ms.push({ id: 'automation_rate', label: 'Decisions made without a person', value: pct(s.decisions.automatic, s.decisions.automatic + s.decisions.byPerson), target: 30, unit: 'percent', detail: `${s.decisions.automatic} of ${s.decisions.automatic + s.decisions.byPerson} applied decisions` });
    }

    const ev = await this.d.connectEvidence();
    try {
      const head = Number((await ev.query<{ seq: string }>('select seq from evidence.ledger_entry order by seq desc limit 1')).rows[0]?.seq ?? 0);
      const r = await verifyChain(ev, head ? { fromSeq: Math.max(1, head - 999) } : {});
      ms.push({ id: 'evidence_checks', label: 'Evidence checks passing', value: r.ok ? 100 : 0, target: 100, unit: 'percent', detail: `${r.checked} recent ledger entries checked` });
    } finally { ev.release(); }

    return { measures: ms };
  }
}
