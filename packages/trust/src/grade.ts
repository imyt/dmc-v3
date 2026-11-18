/**
 * L3. Trust tiers (PRD "Tier criteria"). Each asset is graded per dimension, scorecard-style; its tier is its weakest dimension,
 * so the reason for a tier is always visible. An asset that misses Bronze on any dimension is Unverified.
 * Pure functions: the worker gathers the facts from the catalog and the other tools and stores the result.
 */
export const TIERS = ['unverified', 'bronze', 'silver', 'gold'] as const;
export type Tier = (typeof TIERS)[number];
export const tierRank = (t: Tier): number => TIERS.indexOf(t);

export const DIMENSIONS = ['ownership', 'quality', 'lineage', 'compliance', 'sync'] as const;
export type Dimension = (typeof DIMENSIONS)[number];

/** What is known about one asset. A fact that is not known is left out and counts against the grade, never for it. */
export interface TrustFacts {
  ownership?: { owner?: boolean; steward?: boolean; description?: boolean; classificationConfirmed?: boolean; allColumnsClassified?: boolean; allColumnsLinkedToTerms?: boolean };
  quality?: { rulesDefined?: boolean; passRate30?: number; passRate90?: number; openCriticalBreach?: boolean };
  lineage?: { tableLevelToSource?: boolean; columnLevelCritical?: boolean; columnLevelEndToEnd?: boolean };
  compliance?: { overduePrivacyOrRetention?: boolean; exceptionsPastSla?: number; openExceptions?: number; controlsEvidenced?: boolean };
  sync?: { ageDays?: number; dailyFor7Days?: boolean; pendingChanges?: number };
}
export interface DimensionGrade { grade: Tier; /** what stops it reaching the next tier (empty at gold) */ next: string[] }
export interface TrustResult { dimensions: Record<Dimension, DimensionGrade>; tier: Tier; /** the dimensions that hold the tier down */ weakest: Dimension[] }

type Check = [label: string, ok: boolean];
/** The highest tier whose checks all pass, and what the next tier still needs. */
function grade(bronze: Check[], silver: Check[], gold: Check[]): DimensionGrade {
  const miss = (cs: Check[]) => cs.filter(([, ok]) => !ok).map(([l]) => l);
  const b = miss(bronze); if (b.length) return { grade: 'unverified', next: b };
  const s = miss(silver); if (s.length) return { grade: 'bronze', next: s };
  const g = miss(gold); if (g.length) return { grade: 'silver', next: g };
  return { grade: 'gold', next: [] };
}

export function gradeAsset(f: TrustFacts): TrustResult {
  const o = f.ownership ?? {}, q = f.quality ?? {}, l = f.lineage ?? {}, c = f.compliance ?? {}, s = f.sync ?? {};
  const dimensions: Record<Dimension, DimensionGrade> = {
    ownership: grade([['owner assigned', !!o.owner]],
      [['steward assigned', !!o.steward], ['description present', !!o.description], ['classification confirmed', !!o.classificationConfirmed]],
      [['every column classified', !!o.allColumnsClassified], ['every column linked to business terms', !!o.allColumnsLinkedToTerms]]),
    quality: grade([['quality rules defined on key columns', !!q.rulesDefined]],
      [['pass rate at least 95% over 30 days', (q.passRate30 ?? 0) >= 0.95]],
      [['pass rate at least 99% over 90 days', (q.passRate90 ?? 0) >= 0.99], ['no open critical breach', q.openCriticalBreach === false]]),
    lineage: grade([['table-level lineage to the source application', !!l.tableLevelToSource]],
      [['column-level lineage for critical elements', !!l.columnLevelCritical]],
      [['column-level lineage end to end, above the confidence threshold, with no gaps', !!l.columnLevelEndToEnd]]),
    compliance: grade([['no overdue retention or privacy actions', c.overduePrivacyOrRetention === false]],
      [['no exceptions past their SLA', c.exceptionsPastSla === 0]],
      [['no open exceptions', c.openExceptions === 0], ['every control evidenced in the ledger', !!c.controlsEvidenced]]),
    sync: grade([['synced in the last 7 days', s.ageDays !== undefined && s.ageDays <= 7]],
      [['synced daily', !!s.dailyFor7Days]],
      [['no pending changes', s.pendingChanges === 0]]),
  };
  const lowest = Math.min(...DIMENSIONS.map((d) => tierRank(dimensions[d].grade)));
  return { dimensions, tier: TIERS[lowest]!, weakest: DIMENSIONS.filter((d) => tierRank(dimensions[d].grade) === lowest) };
}

/** The tier an asset must reach: the highest any submitted scope using it asks for. A scope owner chooses its own; the default is Bronze. */
export function requiredTier(chosen: Array<Tier | undefined>): Tier {
  return chosen.reduce<Tier>((hi, t) => { const x = t ?? 'bronze'; return tierRank(x) > tierRank(hi) ? x : hi; }, 'bronze');
}
export const meetsTier = (tier: Tier, required: Tier): boolean => tierRank(tier) >= tierRank(required);
