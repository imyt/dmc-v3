import { useMemo, useState } from 'react';
import { useSearch } from '@tanstack/react-router';
import { FacetPanel, type FacetSelection } from '@/components/patterns/facet-panel';
import { PageHeader } from '@/components/patterns/page-header';
import { EmptyState, ErrorState, LoadingState } from '@/components/patterns/states';
import { StatusBadge } from '@/components/patterns/status-badge';
import { ApiProblem, useData, useOptionalData } from '@/lib/data';
import { useAsync } from '@/lib/use-async';
import { humanise, objectHref, stateOf } from '../object/model';

/** U1. Results for the global search, with type and state filters. */
export function SearchRoute() {
  const { q } = useSearch({ strict: false }) as { q: string };
  if (!useOptionalData()) return <PageHeader title="Search" description={q ? `Results for “${q}”` : undefined} />;
  return <SearchResults />;
}

function SearchResults() {
  const { q } = useSearch({ strict: false }) as { q: string };
  const data = useData();
  const [sel, setSel] = useState<FacetSelection>({});
  const types = sel.type ?? [];
  const states = sel.lifecycle ?? [];
  const res = useAsync(() => (q.trim() ? data.search(q, { types, lifecycles: states, limit: 50 }) : Promise.resolve(undefined)), [q, types.join(), states.join()]);
  const [facets, setFacets] = useState<{ type: Record<string, number>; lifecycle: Record<string, number> }>({ type: {}, lifecycle: {} });
  const value = res.status === 'done' ? res.value : undefined;
  // keep the last counts while a filtered search loads so the panel does not jump
  useMemo(() => { if (value) setFacets(value.facets); }, [value]);

  const groups = [
    { id: 'type', label: 'Type', values: Object.entries(facets.type).map(([v, count]) => ({ value: v, label: humanise(v), count })) },
    { id: 'lifecycle', label: 'State', values: Object.entries(facets.lifecycle).map(([v, count]) => ({ value: v, label: humanise(v), count })) },
  ];
  return (
    <>
      <PageHeader title="Search" description={q ? `Results for “${q}”` : 'Type a term in the search box above.'} crumbs={[{ label: 'Home', to: '/' }, { label: 'Search' }]} />
      <div className="mx-auto flex max-w-[var(--content-max)] gap-8 px-8 py-6">
        <FacetPanel groups={groups} selected={sel} onChange={setSel} />
        <section aria-label="Results" className="min-w-0 flex-1">
          {res.status === 'loading' && <LoadingState label="Searching" />}
          {res.status === 'error' && <ErrorState message={res.error instanceof ApiProblem ? res.error.detail : 'Search failed.'} requestId={res.error instanceof ApiProblem ? res.error.requestId : undefined} />}
          {value && value.hits.length === 0 && <EmptyState title="No matches" doing="Try fewer words or remove a filter." />}
          {value && value.hits.length > 0 && (
            <ul className="divide-y divide-border border border-border">
              {value.hits.map((h) => (
                <li key={h.qualified_name} className="flex items-center justify-between gap-4 px-4 py-3">
                  <div className="min-w-0"><a className="font-semibold text-brand-text underline underline-offset-2" href={objectHref(h.qualified_name)}>{h.name}</a><div className="text-sm text-muted-foreground">{humanise(h.type)} · {h.qualified_name}</div></div>
                  <StatusBadge kind="state" value={stateOf(h.lifecycle)} />
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}
