/**
 * L4 (PRV-3, PRV-4, PRV-5). A cross-border transfer is an integration between applications hosted in different countries.
 * Its Assessment decides whether a DataVisa is required; where one is, every data category of the integration's datasets
 * must be on a valid DataVisa for that country pair. Pure functions: the worker reads the catalog and records the result.
 */
export interface Visa { qualifiedName: string; sourceCountry: string; targetCountry: string; categories: string[]; validFrom: string; validTo?: string; status?: string }
export interface TransferInput {
  integration: string;
  sourceCountry?: string; targetCountry?: string;
  /** the integration's Assessment outcome; undefined when it has none */
  assessment?: { qualifiedName: string; outcome: 'datavisa-required' | 'datavisa-not-required' };
  /** data categories of the integration's datasets */
  categories: string[];
  visas: Visa[];
}
export type TransferProblem = 'no_assessment' | 'no_datavisa' | 'datavisa_expired' | 'category_uncovered';
export interface TransferResult {
  qualifiedName: string; integration: string; fromCountry: string; toCountry: string; categories: string[];
  status: 'covered' | 'missing' | 'expired';
  problem?: TransferProblem; uncovered: string[]; visas: string[]; message?: string;
}

const day = (s: string) => s.slice(0, 10);
const live = (v: Visa, today: string) => day(v.validFrom) <= today && (!v.validTo || day(v.validTo) >= today) && (v.status === undefined || !/revoked|withdrawn|rejected/i.test(v.status));

/** `undefined`: not a cross-border transfer (same country, a country not known) or no DataVisa is required, so there is nothing to check. */
export function evaluateTransfer(t: TransferInput, today: string): TransferResult | undefined {
  if (!t.sourceCountry || !t.targetCountry || t.sourceCountry === t.targetCountry) return undefined;
  const base = { qualifiedName: `${t.integration}--${t.sourceCountry.toLowerCase()}-${t.targetCountry.toLowerCase()}`, integration: t.integration, fromCountry: t.sourceCountry, toCountry: t.targetCountry, categories: [...t.categories].sort() };
  if (!t.assessment) return { ...base, status: 'missing', problem: 'no_assessment', uncovered: [], visas: [], message: `${t.integration} sends data from ${t.sourceCountry} to ${t.targetCountry} and has no assessment in the DataVisa tool` };
  if (t.assessment.outcome === 'datavisa-not-required') return undefined;
  const pair = t.visas.filter((v) => v.sourceCountry === t.sourceCountry && v.targetCountry === t.targetCountry);
  const valid = pair.filter((v) => live(v, today));
  const covered = new Set(valid.flatMap((v) => v.categories));
  const uncovered = base.categories.filter((c) => !covered.has(c));
  const used = valid.filter((v) => v.categories.some((c) => base.categories.includes(c))).map((v) => v.qualifiedName).sort();
  if (!uncovered.length && (base.categories.length > 0 || valid.length > 0)) return { ...base, status: 'covered', uncovered: [], visas: used };
  const lapsed = pair.filter((v) => !live(v, today) && v.categories.some((c) => uncovered.includes(c)));
  const pair2 = `${t.sourceCountry} to ${t.targetCountry}`;
  if (pair.length === 0) return { ...base, status: 'missing', problem: 'no_datavisa', uncovered, visas: [], message: `${t.integration} needs a DataVisa for ${pair2} and none exists` };
  if (lapsed.length) return { ...base, status: 'expired', problem: 'datavisa_expired', uncovered, visas: lapsed.map((v) => v.qualifiedName).sort(), message: `The DataVisa for ${pair2} on ${t.integration} has expired; ${uncovered.join(', ')} is not covered` };
  return { ...base, status: 'missing', problem: 'category_uncovered', uncovered, visas: used, message: `${uncovered.join(', ')} on ${t.integration} is not on a DataVisa for ${pair2}` };
}
