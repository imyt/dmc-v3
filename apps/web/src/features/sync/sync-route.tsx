import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Sheet, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { PageHeader } from '@/components/patterns/page-header';
import { DataTable, type Col } from '@/components/patterns/data-table';
import { ErrorState, LoadingState } from '@/components/patterns/states';
import { RunStatusBadge, type RunState } from '@/components/patterns/job-monitor';
import { notify } from '@/components/patterns/toast';
import { ApiProblem, useData, type ApiSyncJob, type ApiSyncRun } from '@/lib/data';
import { useAsync } from '@/lib/use-async';

const problem = (e: unknown) => (e instanceof ApiProblem ? e.detail : 'Something went wrong. Try again.');
const requestId = (e: unknown) => (e instanceof ApiProblem ? e.requestId : undefined);

/** Dates as `17 Nov 2026 06:30`, with the exact instant on hover (DESIGN section 6). */
const fmt = (at: string) => new Date(at).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
function When({ at }: { at: string | null }) {
  if (!at) return <span className="text-muted-foreground">Never</span>;
  return <time dateTime={at} title={new Date(at).toISOString()}>{fmt(at)}</time>;
}

export const runState = (r: ApiSyncRun | null): RunState => (!r ? 'never' : r.status === 'paused_limit' ? 'held' : r.status);
/** A run held by the change limit stays the job's state until someone decides it, even when later runs were skipped behind it. */
export const jobState = (j: ApiSyncJob): RunState => (j.awaiting_review ? 'held' : runState(j.last_run));

const n = (v: number) => v.toLocaleString('en-GB');
function Changes({ c, running }: { c: ApiSyncRun['counts'] | undefined; running?: boolean }) {
  if (running) return <span className="text-muted-foreground">In progress</span>;
  if (!c) return <span className="text-muted-foreground">No runs yet</span>;
  return <span>{n(c.created)} new, {n(c.updated)} updated, {n(c.missing)} missing{c.errors > 0 && <>, <strong className="text-destructive">{n(c.errors)} not mapped</strong></>}{c.refused > 0 && <>, {n(c.refused)} refused</>}</span>;
}

type Ask = { title: string; body: string; confirmLabel: string; run: () => Promise<unknown>; done: string };
type Target = Pick<ApiSyncJob, 'environment' | 'name'>;

/**
 * S12. Sync jobs per environment: state, schedule, last run and its counts, with pause, run now and the review of a run the change limit held.
 * Jobs are edited in the repository, not here. Nothing on this page shows a connection's configuration or a source value, only names and counts.
 */
export function SyncRoute() {
  const data = useData();
  const [version, setVersion] = useState(0);
  const refresh = () => setVersion((v) => v + 1);
  const jobs = useAsync(() => data.syncJobs(), [version]);
  const [env, setEnv] = useState('all');
  const [selected, setSelected] = useState<Target>();
  const [ask, setAsk] = useState<Ask>();
  const [busy, setBusy] = useState(false);
  const [reviewing, setReviewing] = useState<string>();

  const confirm = async () => {
    if (!ask || busy) return;
    setBusy(true);
    try { await ask.run(); notify({ tone: 'success', title: ask.done }); setAsk(undefined); }
    catch (e) {
      notify({ tone: 'error', title: 'Could not do that', description: e instanceof ApiProblem && e.status === 412 ? 'The job changed since you loaded this page. The list has been refreshed; try again.' : problem(e) });
      if (e instanceof ApiProblem && (e.status === 412 || e.status === 409)) setAsk(undefined);
    } finally { setBusy(false); refresh(); }
  };

  const pause = (j: ApiSyncJob) => setAsk({
    title: `${j.paused ? 'Resume' : 'Pause'} ${j.name} in ${j.environment}?`,
    body: j.paused ? 'The job runs again on its next schedule, and can be run now.' : 'The job will not run, on its schedule or by hand, until you resume it. Its schedule keeps ticking and records a skipped run each time. This is recorded in the ledger.',
    confirmLabel: j.paused ? 'Resume job' : 'Pause job',
    run: () => data.setSyncPaused(j, !j.paused), done: j.paused ? `${j.name} resumed` : `${j.name} paused`,
  });
  const runNow = (j: ApiSyncJob) => setAsk({
    title: `Run ${j.name} in ${j.environment} now?`,
    body: 'The run is queued for the worker, the same way a scheduled run is. It appears in the job’s runs when the worker starts it. A job that is already running or queued cannot be run twice.',
    confirmLabel: 'Run now', run: () => data.runSyncNow(j), done: `${j.name} queued to run`,
  });

  const all = jobs.status === 'done' ? jobs.value : [];
  const envs = [...new Set(all.map((j) => j.environment))].sort();
  const shown = all.filter((j) => env === 'all' || j.environment === env);
  const held = all.filter((j) => j.awaiting_review).length;
  const failed = all.filter((j) => jobState(j) === 'failed').length;

  const cols: Col<ApiSyncJob>[] = [
    { id: 'job', header: 'Job', sortable: false, text: (j) => j.name, cell: (j) => (
      <div>
        <Button variant="link" className="h-auto p-0 normal-case tracking-normal" aria-label={`Show runs of ${j.name} in ${j.environment}`} onPress={() => setSelected(j)}>{j.name}</Button>
        {(jobState(j) === 'failed' || jobState(j) === 'held') && j.last_run?.note && <p role="alert" className={`mt-1 max-w-80 text-xs ${jobState(j) === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`}>{j.last_run.note}</p>}
      </div>
    ) },
    { id: 'env', header: 'Environment', text: (j) => j.environment, cell: (j) => <Badge variant="outline">{j.environment.toUpperCase()}</Badge> },
    { id: 'status', header: 'Status', text: (j) => jobState(j), cell: (j) => (
      <span className="flex flex-wrap gap-1"><RunStatusBadge state={jobState(j)} />{j.paused && <RunStatusBadge state="paused" />}{!j.enabled && <RunStatusBadge state="disabled" />}</span>
    ) },
    { id: 'schedule', header: 'Schedule', text: (j) => j.schedule, cell: (j) => <code className="text-xs">{j.schedule}</code> },
    { id: 'last', header: 'Last run', text: (j) => j.last_run?.started_at ?? '', cell: (j) => (j.last_run ? <span>{runLabel(j.last_run)}<br /><When at={j.last_run.started_at} /></span> : <span className="text-muted-foreground">Never</span>) },
    { id: 'changes', header: 'Changes', text: (j) => (j.last_run ? `${j.last_run.counts.created}/${j.last_run.counts.updated}/${j.last_run.counts.missing}` : ''), cell: (j) => <Changes c={j.last_run?.counts} running={j.last_run?.status === 'running'} /> },
    { id: 'connection', header: 'Connection', hidden: true, text: (j) => j.connection, cell: (j) => <span>{j.connection}{j.connection_type && <span className="text-muted-foreground"> ({j.connection_type})</span>}</span> },
    { id: 'actions', header: 'Actions', cell: (j) => {
      const idle = j.enabled && !j.paused && !j.awaiting_review && j.last_run?.status !== 'running';
      return (
        <span className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" isDisabled={!idle} aria-label={`Run ${j.name} in ${j.environment} now`} onPress={() => runNow(j)}>Run now</Button>
          <Button size="sm" variant="outline" aria-label={`${j.paused ? 'Resume' : 'Pause'} ${j.name} in ${j.environment}`} onPress={() => pause(j)}>{j.paused ? 'Resume' : 'Pause'}</Button>
          {j.awaiting_review && <Button size="sm" aria-label={`Review the held run of ${j.name} in ${j.environment}`} onPress={() => { setSelected(j); setReviewing(j.awaiting_review!); }}>Review held run</Button>}
        </span>
      );
    } },
  ];

  const selectedJob = selected ? all.find((j) => j.environment === selected.environment && j.name === selected.name) : undefined;

  return (
    <>
      <PageHeader title="Sync" description="What syncs from each source system, in each environment. Jobs are edited in the repository, not here."
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Admin', to: '/admin' }, { label: 'Sync' }]}
        actions={<Button variant="outline" onPress={refresh}>Refresh</Button>} />
      <div className="mx-auto max-w-[var(--content-max)] space-y-6 px-8 py-6">
        {jobs.status === 'loading' && <LoadingState label="Loading sync jobs" />}
        {jobs.status === 'error' && <ErrorState message={problem(jobs.error)} requestId={requestId(jobs.error)} action={<Button variant="outline" onPress={refresh}>Try again</Button>} />}
        {jobs.status === 'done' && (
          <section aria-labelledby="jobs-h" className="space-y-3">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <h2 id="jobs-h" className="text-lg font-semibold">Jobs</h2>
                <p className="text-sm text-muted-foreground">{all.length} {all.length === 1 ? 'job' : 'jobs'}{held > 0 && <>, <strong>{held} held for review</strong></>}{failed > 0 && <>, <strong className="text-destructive">{failed} failed</strong></>}</p>
              </div>
              {envs.length > 1 && (
                <div role="group" aria-label="Environment" className="flex gap-1">
                  {['all', ...envs].map((e) => <Button key={e} size="sm" variant={env === e ? 'default' : 'outline'} aria-pressed={env === e} onPress={() => setEnv(e)}>{e === 'all' ? 'All' : e.toUpperCase()}</Button>)}
                </div>
              )}
            </div>
            <DataTable label="Sync jobs" columns={cols} rows={shown} rowId={(j) => `${j.environment}/${j.name}`}
              empty={{ title: 'No sync jobs yet', doing: 'The worker installs the jobs in the repository’s sync folder when it starts, and runs each on its schedule. Once it has, they appear here with their runs.' }} />
          </section>
        )}
        {selected && <RunsSection key={`${selected.environment}/${selected.name}/${version}`} job={selectedJob ?? selected} full={selectedJob} onChanged={refresh} onClose={() => setSelected(undefined)} />}
      </div>

      <Dialog isOpen={!!ask} onOpenChange={(o) => { if (!o && !busy) setAsk(undefined); }} showCloseButton={false}>
        <DialogHeader><DialogTitle>{ask?.title}</DialogTitle><DialogDescription>{ask?.body}</DialogDescription></DialogHeader>
        <DialogFooter>
          <Button variant="outline" onPress={() => setAsk(undefined)}>Cancel</Button>
          <Button isDisabled={busy} onPress={() => void confirm()}>{ask?.confirmLabel ?? 'Confirm'}</Button>
        </DialogFooter>
      </Dialog>
      {reviewing && <RunPanel runId={reviewing} onClose={() => setReviewing(undefined)} onDone={refresh} />}
    </>
  );
}

const runLabel = (r: ApiSyncRun) => (r.trigger === 'manual' ? 'Run by hand' : 'Scheduled run');

/** The runs of one job, newest first, 20 at a time. */
function RunsSection({ job, full, onChanged, onClose }: { job: Target; full?: ApiSyncJob; onChanged(): void; onClose(): void }) {
  const data = useData();
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const cursor = cursors[cursors.length - 1];
  const runs = useAsync(() => data.syncRuns(job.environment, job.name, cursor), [cursor]);
  const [open, setOpen] = useState<string>();
  const top = useRef<HTMLElement>(null);
  useEffect(() => { top.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' }); }, []);   // the runs sit below a long table: bring them into view

  const cols: Col<ApiSyncRun>[] = [
    { id: 'started', header: 'Started', text: (r) => r.started_at, cell: (r) => <When at={r.started_at} /> },
    { id: 'trigger', header: 'Trigger', text: (r) => r.trigger, cell: (r) => (r.trigger === 'manual' ? 'By hand' : 'Schedule') },
    { id: 'status', header: 'Status', text: (r) => r.status, cell: (r) => <RunStatusBadge state={runState(r)} /> },
    { id: 'changes', header: 'Changes', text: (r) => `${r.counts.created}/${r.counts.updated}/${r.counts.missing}`, cell: (r) => <Changes c={r.counts} running={r.status === 'running'} /> },
    { id: 'note', header: 'Notes', text: (r) => r.note ?? '', cell: (r) => (r.note ? <span className="line-clamp-2 max-w-96 text-xs">{r.note}</span> : <span className="text-muted-foreground">None</span>) },
    { id: 'open', header: 'Details', cell: (r) => <Button size="sm" variant="outline" aria-label={`Show run of ${job.name} started ${fmt(r.started_at)}`} onPress={() => setOpen(r.id)}>Details</Button> },
  ];

  return (
    <section ref={top} aria-labelledby="runs-h" className="space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 id="runs-h" className="text-lg font-semibold">Runs of {job.name} in {job.environment.toUpperCase()}</h2>
          {full && (
            <p className="text-sm text-muted-foreground">
              Schedule <code>{full.schedule}</code>, {full.mode} reads, connection {full.connection}{full.connection_type ? ` (${full.connection_type})` : ''}, version {full.version}
              {full.max_changes_pct != null && <>, a run changing more than {full.max_changes_pct}% of records waits for review</>}. Last success: {full.last_success_at ? <When at={full.last_success_at} /> : 'never'}.
            </p>
          )}
        </div>
        <Button variant="outline" size="sm" onPress={onClose}>Close runs</Button>
      </div>
      {runs.status === 'loading' && <LoadingState label="Loading runs" rows={3} />}
      {runs.status === 'error' && <ErrorState message={problem(runs.error)} requestId={requestId(runs.error)} />}
      {runs.status === 'done' && (
        <DataTable label={`Runs of ${job.name}`} columns={cols} rows={runs.value.items} rowId={(r) => r.id}
          empty={{ title: 'No runs yet', doing: `This job has not run in ${job.environment}. It runs on its schedule${full ? ` (${full.schedule})` : ''}, and you can run it now once it is enabled and not paused.` }}
          paging={{ hasPrevious: cursors.length > 1, hasNext: runs.value.next_cursor != null, onPrevious: () => setCursors((c) => c.slice(0, -1)), onNext: () => setCursors((c) => [...c, runs.value.next_cursor!]) }} />
      )}
      {open && <RunPanel runId={open} onClose={() => setOpen(undefined)} onDone={onChanged} />}
    </section>
  );
}

const COUNTS: { key: keyof ApiSyncRun['counts']; label: string; hint: string }[] = [
  { key: 'read', label: 'Read', hint: 'Records the source returned' },
  { key: 'created', label: 'Created', hint: 'New in DMC' },
  { key: 'updated', label: 'Updated', hint: 'Changed since the last run' },
  { key: 'unchanged', label: 'Unchanged', hint: 'Same as the last run' },
  { key: 'missing', label: 'Missing', hint: 'Gone from a complete full run, so deprecated' },
  { key: 'errors', label: 'Errors', hint: 'Records that could not be mapped' },
  { key: 'refused', label: 'Refused', hint: 'Refused by the catalog; sent again next run' },
];

/** One run in a side panel: counts, notes, and for a held run the approval, confirmed in the panel itself (no modal on a modal). */
function RunPanel({ runId, onClose, onDone }: { runId: string; onClose(): void; onDone(): void }) {
  const data = useData();
  const [v, setV] = useState(0);
  const run = useAsync(() => data.syncRun(runId), [runId, v]);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const approve = async (r: ApiSyncRun) => {
    setBusy(true); setError(undefined);
    try {
      await data.approveSyncRun(r);
      notify({ tone: 'success', title: 'Approval sent to the worker', description: `${r.job} applies the held changes shortly. Refresh to see the result.` });
      onDone(); onClose();
    } catch (e) {
      setError(e instanceof ApiProblem && e.status === 412 ? 'The run changed since you opened it. It has been reloaded.' : problem(e));
      setConfirming(false); setV((x) => x + 1);
    } finally { setBusy(false); }
  };

  const r = run.status === 'done' ? run.value : undefined;
  return (
    <Sheet isOpen onOpenChange={(o) => { if (!o) onClose(); }} showCloseButton={false}>
      <SheetHeader>
        <SheetTitle>{r ? `Run of ${r.job} in ${r.environment.toUpperCase()}` : 'Run'}</SheetTitle>
        <SheetDescription>{r ? <>{runLabel(r)} started <When at={r.started_at} /></> : 'Loading the run'}</SheetDescription>
      </SheetHeader>
      <div className="flex-1 space-y-4 overflow-auto px-8">
        {run.status === 'loading' && <LoadingState label="Loading the run" rows={3} />}
        {run.status === 'error' && <ErrorState message={problem(run.error)} requestId={requestId(run.error)} />}
        {error && <div role="alert" className="border border-destructive p-3 text-sm">{error}</div>}
        {r && (<>
          <p className="flex flex-wrap items-center gap-2"><RunStatusBadge state={runState(r)} />
            <span className="text-sm text-muted-foreground">{r.status === 'running' ? 'Still running' : <>Finished <When at={r.finished_at} /></>}</span></p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-sm">
            <dt className="font-semibold">Mode</dt><dd>{r.mode === 'full' ? 'Full read' : r.mode === 'incremental' ? 'Incremental read' : r.mode}</dd>
            <dt className="font-semibold">Complete</dt><dd>{r.complete ? 'Yes. Every page was read and every record mapped.' : 'No. Nothing is deprecated by a run that is not complete.'}</dd>
          </dl>
          <table className="w-full border-collapse text-sm">
            <caption className="mb-1 text-left font-semibold">Counts</caption>
            <tbody>
              {COUNTS.map((c) => (
                <tr key={c.key} className="border-b border-border">
                  <th scope="row" className="py-1.5 pr-4 text-left font-normal">{c.label}</th>
                  <td className="py-1.5 pr-4 text-right font-semibold tabular-nums">{n(r.counts[c.key])}</td>
                  <td className="py-1.5 text-muted-foreground">{c.hint}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <section aria-label="Notes"><h3 className="font-semibold">Notes</h3>{r.note ? <p className="mt-1 text-sm">{r.note}</p> : <p className="mt-1 text-sm text-muted-foreground">This run has no notes.</p>}</section>
          {r.status === 'paused_limit' && <p className="border border-warning p-3 text-sm">This run would change more records than the job’s limit allows, so nothing has been applied and the job’s later runs are skipped. Approving sends the held changes to the catalog.</p>}
        </>)}
      </div>
      {confirming && r ? (
        <SheetFooter role="alertdialog" aria-label="Approve this run?">
          <p className="mr-auto self-center">Approve this run and apply its held changes?</p>
          <Button variant="outline" isDisabled={busy} onPress={() => setConfirming(false)}>Cancel</Button>
          <Button isDisabled={busy} onPress={() => void approve(r)}>Approve and apply</Button>
        </SheetFooter>
      ) : (
        <SheetFooter>
          <Button variant="outline" onPress={onClose}>Close</Button>
          {r?.status === 'paused_limit' && <Button onPress={() => setConfirming(true)}>Approve run</Button>}
        </SheetFooter>
      )}
    </Sheet>
  );
}
