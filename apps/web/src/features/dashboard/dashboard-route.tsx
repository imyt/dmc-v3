import { MetricPanel } from '@/components/patterns/metric-panel';
import { PageHeader } from '@/components/patterns/page-header';
import { EmptyState, ErrorState, LoadingState } from '@/components/patterns/states';
import { ApiProblem, useData } from '@/lib/data';
import { useAsync } from '@/lib/use-async';

/** U5. Management view: every measure the API reports, each against its target. */
export function DashboardRoute() {
  const data = useData();
  const s = useAsync(() => data.dashboardMeasures(), []);
  return (
    <>
      <PageHeader title="Management dashboard" description="Progress against the success targets." crumbs={[{ label: 'Home', to: '/' }, { label: 'Dashboard' }]} />
      <div className="mx-auto max-w-[var(--content-max)] space-y-6 px-8 py-6">
        {s.status === 'loading' && <LoadingState label="Loading measures" />}
        {s.status === 'error' && <ErrorState message={s.error instanceof ApiProblem ? s.error.detail : 'Something went wrong.'} requestId={s.error instanceof ApiProblem ? s.error.requestId : undefined} />}
        {s.status === 'done' && s.value.length === 0 && <EmptyState title="No measures yet" doing="Measures appear here as soon as the data behind them has been synced." />}
        {s.status === 'done' && s.value.map((m) => <MetricPanel key={m.id} title={m.label} value={m.value} target={m.target} unit={m.unit ?? '%'} />)}
      </div>
    </>
  );
}
