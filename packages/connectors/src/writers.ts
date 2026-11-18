import type { ResolvedJob } from './definition.js';

/**
 * S6: two enabled jobs must not write the same thing (same target type, source and edge name) in one environment, for example the REST stand-in and the BigQuery
 * job for ServiceNow applications: they would overwrite each other and one would deprecate what the other still sees. Jobs without a target source are not checked.
 * Returns one problem per clash; the caller (a test, or job loading) decides what to do.
 */
export function singleWriterProblems(jobs: ResolvedJob[]): string[] {
  const seen = new Map<string, string>();
  const problems: string[] = [];
  for (const j of jobs) {
    const t = j.def.target;
    if (!j.enabled || !t.source) continue;
    const key = `${t.type} / ${t.source}${t.edge ? ` / edge ${t.edge.name}` : ''}`;
    const other = seen.get(key);
    if (other) problems.push(`${other} and ${j.def.job} both write ${key} in ${j.environment}: enable only one`);
    else seen.set(key, j.def.job);
  }
  return problems;
}
