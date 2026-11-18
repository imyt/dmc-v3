import type { ResolvedJob } from './definition.js';

/** Sources with exactly one enabled writer per target type and edge in an environment. */
export const EXCLUSIVE_SOURCES: readonly string[] = ['servicenow'];

/**
 * S6: two enabled jobs must not write the same thing (same target type, source and edge name) in one environment, for example the REST stand-in and the BigQuery
 * job for ServiceNow applications: they would overwrite each other and one would deprecate what the other still sees. Only the `exclusive` sources are checked: some sources are
 * legitimately fed by several jobs into one type (the scope inventories share one source name), so the rule is opt-in per source.
 * Returns one problem per clash; the caller (a test, or job loading) decides what to do.
 */
export function singleWriterProblems(jobs: ResolvedJob[], exclusive: readonly string[] = EXCLUSIVE_SOURCES): string[] {
  const seen = new Map<string, string>();
  const problems: string[] = [];
  for (const j of jobs) {
    const t = j.def.target;
    if (!j.enabled || !t.source || !exclusive.includes(t.source)) continue;
    const key = `${t.type} / ${t.source}${t.edge ? ` / edge ${t.edge.name}` : ''}`;
    const other = seen.get(key);
    if (other) problems.push(`${other} and ${j.def.job} both write ${key} in ${j.environment}: enable only one`);
    else seen.set(key, j.def.job);
  }
  return problems;
}
