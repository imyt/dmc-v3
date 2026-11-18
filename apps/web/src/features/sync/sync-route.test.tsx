import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import { buildRouter } from '@/router';
import { ApiProblem, type ApiSyncJob, type ApiSyncRun, type DataSource } from '@/lib/data';
import { visibleItems } from '@/components/patterns/app-shell/nav-config';

// S12: the sync admin screen, against fixture data for every state a job can be in.
const counts = (o: Partial<ApiSyncRun['counts']> = {}) => ({ read: 0, created: 0, updated: 0, unchanged: 0, missing: 0, errors: 0, refused: 0, ...o });
const run = (id: string, job: string, o: Partial<ApiSyncRun> = {}): ApiSyncRun => ({ id, job, environment: 'uat', trigger: 'schedule', status: 'succeeded', mode: 'full', complete: true, started_at: '2026-11-17T03:00:00.000Z', finished_at: '2026-11-17T03:01:00.000Z', counts: counts(), note: null, etag: `W/"${id}-1"`, ...o });
const job = (name: string, last: ApiSyncRun | null, o: Partial<ApiSyncJob> = {}): ApiSyncJob => ({
  name, environment: 'uat', version: 3, enabled: true, paused: false, schedule: '0 3 * * *', connection: 'snow', connection_type: 'bigquery', mode: 'full', max_changes_pct: 10,
  last_run: last, last_success_at: last?.status === 'succeeded' ? last.finished_at : null, awaiting_review: null, etag: `W/"uat/${name}-12"`, ...o,
});

const okRun = run('r-ok', 'servicenow-applications', { counts: counts({ read: 1200, created: 4, updated: 6, unchanged: 1190, missing: 2 }) });
const heldRun = run('r-held', 'aris-scopes', { status: 'paused_limit', complete: true, counts: counts({ read: 50, created: 30, unchanged: 20 }), note: '30 of 50 records would change (limit 10%)' });
const failedRun = run('r-fail', 'git-tables', { status: 'failed', complete: false, note: 'read failed after 3 attempts: 503 from source' });
const runningRun = run('r-run', 'idp-people', { status: 'running', finished_at: null, complete: false });
const FIXTURE: ApiSyncJob[] = [
  job('servicenow-applications', okRun),
  job('aris-scopes', run('r-skip', 'aris-scopes', { status: 'skipped', note: 'a run is waiting for review' }), { awaiting_review: 'r-held' }),
  job('git-tables', failedRun),
  job('idp-people', runningRun),
  job('dstorm-legal-holds', null, { connection_type: null }),
  job('prod-only', run('r-p', 'prod-only', { environment: 'prod' }), { environment: 'prod', paused: true, etag: 'W/"prod/prod-only-9"' }),
];
const RUNS: Record<string, ApiSyncRun> = { 'r-ok': okRun, 'r-held': heldRun, 'r-fail': failedRun, 'r-run': runningRun };

const fake = (over: Record<string, unknown> = {}) => ({
  inbox: async () => ({ items: [], count: 0 }), syncJobs: async () => FIXTURE,
  syncRuns: async (_e: string, name: string) => ({ items: Object.values(RUNS).filter((r) => r.job === name), next_cursor: null }),
  syncRun: async (id: string) => RUNS[id] ?? heldRun,
  setSyncPaused: vi.fn(async () => FIXTURE[0]!), runSyncNow: vi.fn(async () => undefined), approveSyncRun: vi.fn(async () => undefined),
  ...over,
}) as unknown as DataSource & { setSyncPaused: ReturnType<typeof vi.fn>; runSyncNow: ReturnType<typeof vi.fn>; approveSyncRun: ReturnType<typeof vi.fn> };
const mount = async (ds: DataSource) => {
  render(<RouterProvider router={buildRouter({ data: ds, history: createMemoryHistory({ initialEntries: ['/admin/sync'] }) })} />);
  await screen.findByRole('heading', { level: 1, name: 'Sync' });
};
const row = (name: string) => screen.getByRole('button', { name: new RegExp(`Show runs of ${name} in`) }).closest('[role=row]') as HTMLElement;

describe('S12 navigation', () => {
  it('only an administrator sees Sync in the navigation, under Admin', () => {
    expect(visibleItems(['admin']).map((i) => i.label)).toContain('Sync');
    for (const r of ['viewer', 'steward', 'control-owner', 'auditor', 'policy-author'] as const) expect(visibleItems([r]).map((i) => i.label)).not.toContain('Sync');
    expect(visibleItems(['admin']).find((i) => i.label === 'Sync')!.to).toBe('/admin/sync');
  });
});

describe('S12 jobs table: one row per state', () => {
  it('shows a succeeded job with its counts', async () => {
    await mount(fake());
    const r = within(await waitFor(() => row('servicenow-applications')));
    expect(r.getByText('Succeeded')).toBeInTheDocument();
    expect(r.getByText(/4 new, 6 updated, 2 missing/)).toBeInTheDocument();
    expect(r.getByText('0 3 * * *')).toBeInTheDocument();
    expect(r.getByRole('button', { name: 'Run servicenow-applications in uat now' })).toBeEnabled();
  });
  it('shows a job held by the change limit, with its note and a way to review it; run now is off', async () => {
    await mount(fake());
    const r = within(await waitFor(() => row('aris-scopes')));
    expect(r.getByText('Held for review')).toBeInTheDocument();
    expect(r.getByRole('button', { name: 'Run aris-scopes in uat now' })).toBeDisabled();
    expect(r.getByRole('button', { name: 'Review the held run of aris-scopes in uat' })).toBeInTheDocument();
    expect(screen.getByText(/1 held for review/)).toBeInTheDocument();
  });
  it('shows a failed job with its error', async () => {
    await mount(fake());
    const r = within(await waitFor(() => row('git-tables')));
    expect(r.getByText('Failed')).toBeInTheDocument();
    expect(r.getByRole('alert')).toHaveTextContent('read failed after 3 attempts: 503 from source');
    expect(screen.getByText(/1 failed/)).toBeInTheDocument();
  });
  it('shows a running job, which cannot be run again', async () => {
    await mount(fake());
    const r = within(await waitFor(() => row('idp-people')));
    expect(r.getByText('Running')).toBeInTheDocument();
    expect(r.getByText('In progress')).toBeInTheDocument();
    expect(r.getByRole('button', { name: 'Run idp-people in uat now' })).toBeDisabled();
  });
  it('shows a job that never ran', async () => {
    await mount(fake());
    const r = within(await waitFor(() => row('dstorm-legal-holds')));
    expect(r.getByText('Never run')).toBeInTheDocument();
    expect(r.getByText('No runs yet')).toBeInTheDocument();
  });
  it('shows a paused job in its own environment, with Resume; filters by environment', async () => {
    await mount(fake());
    const r = within(await waitFor(() => row('prod-only')));
    expect(r.getByText('Paused')).toBeInTheDocument();
    expect(r.getByRole('button', { name: 'Resume prod-only in prod' })).toBeInTheDocument();
    expect(r.getByRole('button', { name: 'Run prod-only in prod now' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'UAT' }));
    expect(screen.queryByRole('button', { name: /Show runs of prod-only/ })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'PROD' }));
    expect(screen.queryByRole('button', { name: /Show runs of git-tables/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Show runs of prod-only/ })).toBeInTheDocument();
  });
  it('shows no connection secret or configuration: only the connection name and kind, and only when asked', async () => {
    await mount(fake());
    await screen.findByText('git-tables');
    expect(document.body.textContent).not.toMatch(/secret|password|project/i);
  });
});

describe('S12 empty, loading and error states', () => {
  it('says what DMC is doing when there are no jobs', async () => {
    await mount(fake({ syncJobs: async () => [] }));
    expect(await screen.findByText('No sync jobs yet')).toBeInTheDocument();
    expect(screen.getByText(/The worker installs the jobs/)).toBeInTheDocument();
  });
  it('shows a loading state, then the jobs', async () => {
    let release: (j: ApiSyncJob[]) => void = () => {};
    await mount(fake({ syncJobs: () => new Promise((r) => { release = r; }) }));
    expect(screen.getByRole('status', { name: 'Loading sync jobs' })).toBeInTheDocument();
    release(FIXTURE);
    expect(await screen.findByText('git-tables')).toBeInTheDocument();
  });
  it('shows an error with the request id, and tries again', async () => {
    let calls = 0;
    await mount(fake({ syncJobs: async () => { if (calls++ === 0) throw new ApiProblem(403, 'You do not have the sync_admin role', 'req-9'); return FIXTURE; } }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('You do not have the sync_admin role');
    expect(alert).toHaveTextContent('req-9');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('git-tables')).toBeInTheDocument();
  });
});

describe('S12 pause and resume', () => {
  it('asks first, then pauses with the ETag the job was read with', async () => {
    const ds = fake();
    await mount(ds);
    await userEvent.click(within(await waitFor(() => row('servicenow-applications'))).getByRole('button', { name: 'Pause servicenow-applications in uat' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Pause servicenow-applications in uat?');
    expect(ds.setSyncPaused).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(ds.setSyncPaused).not.toHaveBeenCalled();
    await userEvent.click(within(await waitFor(() => row('servicenow-applications'))).getByRole('button', { name: 'Pause servicenow-applications in uat' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Pause job' }));
    await waitFor(() => expect(ds.setSyncPaused).toHaveBeenCalledTimes(1));
    expect(ds.setSyncPaused.mock.calls[0]![0]).toMatchObject({ name: 'servicenow-applications', environment: 'uat', etag: 'W/"uat/servicenow-applications-12"' });
    expect(ds.setSyncPaused.mock.calls[0]![1]).toBe(true);
  });
  it('resumes a paused job', async () => {
    const ds = fake();
    await mount(ds);
    await userEvent.click(within(await waitFor(() => row('prod-only'))).getByRole('button', { name: 'Resume prod-only in prod' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Resume job' }));
    await waitFor(() => expect(ds.setSyncPaused).toHaveBeenCalledWith(expect.objectContaining({ name: 'prod-only' }), false));
  });
  it('says so when the job changed since the page was loaded (412), and refreshes the list', async () => {
    let loads = 0;
    const ds = fake({ syncJobs: async () => { loads++; return FIXTURE; }, setSyncPaused: vi.fn(async () => { throw new ApiProblem(412, 'Object changed since it was read'); }) });
    await mount(ds);
    await userEvent.click(within(await waitFor(() => row('git-tables'))).getByRole('button', { name: 'Pause git-tables in uat' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Pause job' }));
    expect(await screen.findByText(/changed since you loaded this page/)).toBeInTheDocument();
    await waitFor(() => expect(loads).toBe(2));
  });
});

describe('S12 run now', () => {
  it('asks first, then queues the run', async () => {
    const ds = fake();
    await mount(ds);
    await userEvent.click(within(await waitFor(() => row('git-tables'))).getByRole('button', { name: 'Run git-tables in uat now' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Run git-tables in uat now?');
    expect(ds.runSyncNow).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Run now' }));
    await waitFor(() => expect(ds.runSyncNow).toHaveBeenCalledWith(expect.objectContaining({ name: 'git-tables', environment: 'uat' })));
    expect(await screen.findByText('git-tables queued to run')).toBeInTheDocument();
  });
  it('shows what the API said when it refuses (409: a run is already queued)', async () => {
    const ds = fake({ runSyncNow: vi.fn(async () => { throw new ApiProblem(409, 'A run is already queued.'); }) });
    await mount(ds);
    await userEvent.click(within(await waitFor(() => row('git-tables'))).getByRole('button', { name: 'Run git-tables in uat now' }));
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Run now' }));
    expect(await screen.findByText('A run is already queued.')).toBeInTheDocument();
  });
});

describe('S12 runs and run detail', () => {
  it('shows the runs of a job with counts and notes, and opens one with its counts, notes and completeness', async () => {
    await mount(fake());
    await userEvent.click(await screen.findByRole('button', { name: 'Show runs of servicenow-applications in uat' }));
    expect(await screen.findByRole('heading', { name: 'Runs of servicenow-applications in UAT' })).toBeInTheDocument();
    expect(screen.getByText(/a run changing more than 10% of records waits for review/)).toBeInTheDocument();
    expect(screen.getByText(/connection snow \(bigquery\)/)).toBeInTheDocument();
    await userEvent.click(await screen.findByRole('button', { name: /^Show run of servicenow-applications/ }));
    const panel = await screen.findByRole('dialog');
    expect(within(panel).getByText('Run of servicenow-applications in UAT')).toBeInTheDocument();
    const counts = within(panel).getByRole('table');
    expect(within(counts.querySelectorAll('tr')[0] as HTMLElement).getByText('1,200')).toBeInTheDocument();
    for (const l of ['Read', 'Created', 'Updated', 'Unchanged', 'Missing', 'Errors', 'Refused']) expect(within(counts).getByRole('rowheader', { name: l })).toBeInTheDocument();
    expect(within(panel).getByText('This run has no notes.')).toBeInTheDocument();
    expect(within(panel).getByText(/Every page was read/)).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'Approve run' })).toBeNull();
  });
  it('says when a job has no runs yet', async () => {
    await mount(fake());
    await userEvent.click(await screen.findByRole('button', { name: 'Show runs of dstorm-legal-holds in uat' }));
    expect(await screen.findByText('No runs yet', { selector: 'h3' })).toBeInTheDocument();
    expect(screen.getByText(/It runs on its schedule/)).toBeInTheDocument();
  });
  it('shows a failed run’s note in the run list', async () => {
    await mount(fake());
    await userEvent.click(await screen.findByRole('button', { name: 'Show runs of git-tables in uat' }));
    const rows = await screen.findAllByText('read failed after 3 attempts: 503 from source');
    expect(rows.length).toBeGreaterThan(0);
  });
  it('pages through runs with the cursor', async () => {
    const syncRuns = vi.fn(async (_e: string, _n: string, cursor?: string) => (cursor ? { items: [run('r-old', 'git-tables', { note: 'older run' })], next_cursor: null } : { items: [failedRun], next_cursor: 'c2' }));
    await mount(fake({ syncRuns }));
    await userEvent.click(await screen.findByRole('button', { name: 'Show runs of git-tables in uat' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Next' }));
    expect(await screen.findByText('older run')).toBeInTheDocument();
    expect(syncRuns).toHaveBeenLastCalledWith('uat', 'git-tables', 'c2');
    await userEvent.click(screen.getByRole('button', { name: 'Previous' }));
    await waitFor(() => expect(syncRuns).toHaveBeenLastCalledWith('uat', 'git-tables', undefined));
  });
});

describe('S12 approving a held run', () => {
  it('opens the held run from the job, confirms in the panel, and approves with the run’s ETag', async () => {
    const ds = fake();
    await mount(ds);
    await userEvent.click(within(await waitFor(() => row('aris-scopes'))).getByRole('button', { name: 'Review the held run of aris-scopes in uat' }));
    const panel = await screen.findByRole('dialog');
    expect(await within(panel).findByText('Held for review')).toBeInTheDocument();
    expect(within(panel).getByText('30 of 50 records would change (limit 10%)')).toBeInTheDocument();
    expect(within(panel).getByText(/Approving sends the held changes to the catalog/)).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole('button', { name: 'Approve run' }));
    expect(ds.approveSyncRun).not.toHaveBeenCalled();
    expect(within(panel).getByText('Approve this run and apply its held changes?')).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole('button', { name: 'Cancel' }));
    expect(ds.approveSyncRun).not.toHaveBeenCalled();
    await userEvent.click(within(panel).getByRole('button', { name: 'Approve run' }));
    await userEvent.click(within(panel).getByRole('button', { name: 'Approve and apply' }));
    await waitFor(() => expect(ds.approveSyncRun).toHaveBeenCalledWith(expect.objectContaining({ id: 'r-held', etag: 'W/"r-held-1"' })));
    expect(await screen.findByText('Approval sent to the worker')).toBeInTheDocument();
  });
  it('keeps the panel open and says why when the API refuses (409)', async () => {
    const ds = fake({ approveSyncRun: vi.fn(async () => { throw new ApiProblem(409, 'The run is not waiting for review.'); }) });
    await mount(ds);
    await userEvent.click(within(await waitFor(() => row('aris-scopes'))).getByRole('button', { name: 'Review the held run of aris-scopes in uat' }));
    const panel = await screen.findByRole('dialog');
    await userEvent.click(await within(panel).findByRole('button', { name: 'Approve run' }));
    await userEvent.click(within(panel).getByRole('button', { name: 'Approve and apply' }));
    expect(await within(panel).findByText('The run is not waiting for review.')).toBeInTheDocument();
  });
});
