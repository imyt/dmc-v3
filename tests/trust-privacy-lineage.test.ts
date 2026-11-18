import { describe, expect, it } from 'vitest';
import { gradeAsset, meetsTier, requiredTier, type TrustFacts } from '../packages/trust/src/index';
import { evaluateTransfer, type TransferInput } from '../packages/privacy/src/index';
import { nearest, proposeFrom } from '../packages/lineage/src/index';

const gold: TrustFacts = {
  ownership: { owner: true, steward: true, description: true, classificationConfirmed: true, allColumnsClassified: true, allColumnsLinkedToTerms: true },
  quality: { rulesDefined: true, passRate30: 0.99, passRate90: 0.995, openCriticalBreach: false },
  lineage: { tableLevelToSource: true, columnLevelCritical: true, columnLevelEndToEnd: true },
  compliance: { overduePrivacyOrRetention: false, exceptionsPastSla: 0, openExceptions: 0, controlsEvidenced: true },
  sync: { ageDays: 0.2, dailyFor7Days: true, pendingChanges: 0 },
};

describe('L3: trust tiers', () => {
  it('an asset meeting every criterion is Gold', () => { expect(gradeAsset(gold).tier).toBe('gold'); });
  it('the tier is the weakest dimension, and says which', () => {
    const r = gradeAsset({ ...gold, quality: { rulesDefined: true, passRate30: 0.96, passRate90: 0.9, openCriticalBreach: false } });
    expect(r.tier).toBe('silver');
    expect(r.weakest).toEqual(['quality']);
    expect(r.dimensions.quality.next).toEqual(['pass rate at least 99% over 90 days']);
  });
  it('missing Bronze on any dimension is Unverified; unknown facts count against', () => {
    expect(gradeAsset({ ...gold, ownership: { owner: false } }).tier).toBe('unverified');
    expect(gradeAsset({ ownership: { owner: true } }).tier).toBe('unverified');
    expect(gradeAsset({ ...gold, sync: { ageDays: 9 } }).dimensions.sync.grade).toBe('unverified');
  });
  it('a stale sync caps at Bronze; pending changes cap at Silver', () => {
    expect(gradeAsset({ ...gold, sync: { ageDays: 3, dailyFor7Days: false, pendingChanges: 0 } }).tier).toBe('bronze');
    expect(gradeAsset({ ...gold, sync: { ageDays: 0.5, dailyFor7Days: true, pendingChanges: 2 } }).tier).toBe('silver');
  });
  it('the required tier follows the scopes an asset serves', () => {
    expect(requiredTier(['gold'])).toBe('gold');
    expect(requiredTier(['bronze', 'silver', undefined])).toBe('silver');
    expect(requiredTier([])).toBe('bronze');
    expect(meetsTier('silver', 'gold')).toBe(false);
    expect(meetsTier('gold', 'silver')).toBe(true);
  });
});

describe('L4: cross-border (PRV-3, PRV-4)', () => {
  const visa = { qualifiedName: 'dv-1', sourceCountry: 'GB', targetCountry: 'US', categories: ['cat-pii'], validFrom: '2025-01-01', validTo: '2027-01-01' };
  const base: TransferInput = { integration: 'int-1', sourceCountry: 'GB', targetCountry: 'US', assessment: { qualifiedName: 'as-1', outcome: 'datavisa-required' }, categories: ['cat-pii'], visas: [visa] };
  const today = '2026-11-18';
  it('same country, an unknown country, or no DataVisa required is not checked', () => {
    expect(evaluateTransfer({ ...base, targetCountry: 'GB' }, today)).toBeUndefined();
    expect(evaluateTransfer({ ...base, targetCountry: undefined }, today)).toBeUndefined();
    expect(evaluateTransfer({ ...base, assessment: { qualifiedName: 'as-1', outcome: 'datavisa-not-required' } }, today)).toBeUndefined();
  });
  it('a missing assessment is reported', () => {
    expect(evaluateTransfer({ ...base, assessment: undefined }, today)).toMatchObject({ status: 'missing', problem: 'no_assessment' });
  });
  it('covered when every category is on a valid DataVisa for the pair', () => {
    expect(evaluateTransfer(base, today)).toMatchObject({ status: 'covered', visas: ['dv-1'], qualifiedName: 'int-1--gb-us' });
  });
  it('missing when there is no DataVisa for the pair, or a category is not on it', () => {
    expect(evaluateTransfer({ ...base, visas: [{ ...visa, targetCountry: 'IN' }] }, today)).toMatchObject({ status: 'missing', problem: 'no_datavisa' });
    expect(evaluateTransfer({ ...base, categories: ['cat-pii', 'cat-fin'] }, today)).toMatchObject({ status: 'missing', problem: 'category_uncovered', uncovered: ['cat-fin'] });
  });
  it('expired when the DataVisa has lapsed; not yet valid counts as lapsed too', () => {
    expect(evaluateTransfer({ ...base, visas: [{ ...visa, validTo: '2026-06-30' }] }, today)).toMatchObject({ status: 'expired', problem: 'datavisa_expired' });
    expect(evaluateTransfer({ ...base, visas: [{ ...visa, validFrom: '2027-01-01', validTo: undefined }] }, today)).toMatchObject({ status: 'expired' });
    expect(evaluateTransfer({ ...base, visas: [{ ...visa, status: 'Revoked' }] }, today)).toMatchObject({ status: 'expired' });
  });
});

describe('L2: classification along lineage', () => {
  const tool = { code: 'pii:email', scheme: 'pii', source: 'classification-tool' };
  it('proposes the tool’s classification to columns downstream', () => {
    const ps = proposeFrom({ qn: 'a', classes: [tool] }, [{ qn: 'b', depth: 1 }, { qn: 'c', depth: 2 }], new Map());
    expect(ps.map((p) => [p.target, p.code, p.via])).toEqual([['b', 'pii:email', 'a'], ['c', 'pii:email', 'a']]);
  });
  it('never overrides what the tool set for the scheme, and skips what is already there', () => {
    const held = new Map([['b', [{ code: 'pii:name', scheme: 'pii', source: 'classification-tool' }]], ['c', [{ code: 'pii:email', scheme: 'pii', source: 'dmc' }]], ['d', [{ code: 'isr:high', scheme: 'isr', source: 'classification-tool' }]]]);
    const ps = proposeFrom({ qn: 'a', classes: [tool] }, [{ qn: 'b', depth: 1 }, { qn: 'c', depth: 1 }, { qn: 'd', depth: 1 }], held);
    expect(ps.map((p) => p.target)).toEqual(['d']);
  });
  it('only tool classifications propagate', () => {
    expect(proposeFrom({ qn: 'a', classes: [{ ...tool, source: 'dmc' }] }, [{ qn: 'b', depth: 1 }], new Map())).toEqual([]);
  });
  it('the nearest source wins when two reach the same column', () => {
    const ps = nearest([{ target: 'x', code: 'pii:email', scheme: 'pii', via: 'far', depth: 3 }, { target: 'x', code: 'pii:email', scheme: 'pii', via: 'near', depth: 1 }]);
    expect(ps).toEqual([expect.objectContaining({ via: 'near' })]);
  });
});
