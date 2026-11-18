import { MetricPanel } from '@/components/patterns/metric-panel';
import { PageHeader } from '@/components/patterns/page-header';
import { EmptyState, ErrorState, LoadingState } from '@/components/patterns/states';
import { ApiProblem, useData, type DashboardMeasure } from '@/lib/data';
import { useAsync } from '@/lib/use-async';

/** What goes after the number. The API says `percent`, `count` or `days`. */
const SUFFIX: Record<string, string> = { percent: '%', days: ' days', count: '' };
const suffix = (m: DashboardMeasure) => SUFFIX[m.unit] ?? '';
const shown = (m: DashboardMeasure) => `${m.value.toLocaleString('en-GB')}${suffix(m)}`;
/** A measure of ageing or of things overdue is better when it is lower. */
const lowerIsBetter = (m: DashboardMeasure) => m.unit === 'days' || m.target === 0;

/** The PRD success measure DMC cannot work out from its own data: a date, not a number. */
const COLLIBRA = { label: 'Collibra switched off', target: 'Before the March 2028 licence renewal', note: 'A date, not a number DMC can work out from its own data.' };

/** U5. Management view: every success measure the API reports, each against its one-year target. */
export function DashboardRoute() {
  const data = useData();
  const s = useAsync(() => data.dashboardMeasures(), []);
  const measures = s.status === 'done' ? s.value : [];
  const withTarget = measures.filter((m) => m.target !== null);
  const without = measures.filter((m) => m.target === null);
  return (
    <>
      <PageHeader title="Management dashboard" description="Progress against the one-year success targets in the PRD." crumbs={[{ label: 'Home', to: '/' }, { label: 'Dashboard' }]} />
      <div className="mx-auto max-w-[var(--content-max)] space-y-8 px-8 py-6">
        {s.status === 'loading' && <LoadingState label="Loading measures" />}
        {s.status === 'error' && <ErrorState message={s.error instanceof ApiProblem ? s.error.detail : 'The measures could not be loaded.'} requestId={s.error instanceof ApiProblem ? s.error.requestId : undefined} />}
        {s.status === 'done' && measures.length === 0 && <EmptyState title="No measures yet" doing="Measures appear here as soon as the data behind them has been synced." />}
        {s.status === 'done' && measures.length > 0 && (<>
          <section aria-labelledby="targets" className="space-y-4">
            <h2 id="targets" className="text-2xl font-semibold">Success measures</h2>
            <div className="grid gap-4 md:grid-cols-2">
              {withTarget.map((m) => <MetricPanel key={m.id} title={m.label} value={m.value} target={m.target as number} unit={suffix(m)} detail={m.detail} higherIsBetter={!lowerIsBetter(m)} />)}
              <section aria-labelledby="collibra" className="border border-border p-4">
                <h3 id="collibra" className="text-sm text-muted-foreground">{COLLIBRA.label}</h3>
                <p className="mt-1 text-xl font-semibold">{COLLIBRA.target}</p>
                <p className="mt-1 text-sm text-muted-foreground">{COLLIBRA.note}</p>
              </section>
            </div>
          </section>
          {without.length > 0 && (
            <section aria-labelledby="tracked" className="space-y-2">
              <h2 id="tracked" className="text-2xl font-semibold">Also tracked</h2>
              <p className="text-sm text-muted-foreground">Counts that help read the targets above. The PRD sets no target for them.</p>
              <table className="w-full max-w-3xl border border-border text-sm">
                <thead><tr className="bg-muted text-left"><th className="px-3 py-2">Measure</th><th className="px-3 py-2 text-right">Value</th><th className="px-3 py-2">Detail</th></tr></thead>
                <tbody>{without.map((m) => <tr key={m.id} className="border-t border-border"><td className="px-3 py-2">{m.label}</td><td className="px-3 py-2 text-right">{shown(m)}</td><td className="px-3 py-2 text-muted-foreground">{m.detail ?? ''}</td></tr>)}</tbody>
              </table>
            </section>
          )}
        </>)}
      </div>
    </>
  );
}
