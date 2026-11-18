import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ArrowsClockwise, CheckCircle, CircleDashed, HourglassMedium, MinusCircle, PauseCircle, XCircle, type Icon } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';

/** How a job or one of its runs stands. `held` is a run the change limit stopped until an administrator accepts it; `paused` is the switch; `never` is a job with no run yet. */
export type RunState = 'succeeded' | 'running' | 'failed' | 'held' | 'skipped' | 'discarded' | 'paused' | 'disabled' | 'never';
const LOOK: Record<RunState, { label: string; icon: Icon; className: string }> = {
  succeeded: { label: 'Succeeded', icon: CheckCircle, className: 'border-success text-success' },
  running: { label: 'Running', icon: ArrowsClockwise, className: 'border-info text-info' },
  failed: { label: 'Failed', icon: XCircle, className: 'border-destructive text-destructive' },
  held: { label: 'Held for review', icon: HourglassMedium, className: 'border-warning text-warning' },
  skipped: { label: 'Skipped', icon: MinusCircle, className: 'border-border text-muted-foreground' },
  discarded: { label: 'Discarded', icon: MinusCircle, className: 'border-border text-muted-foreground' },
  paused: { label: 'Paused', icon: PauseCircle, className: 'border-warning text-warning' },
  disabled: { label: 'Disabled', icon: MinusCircle, className: 'border-border text-muted-foreground' },
  never: { label: 'Never run', icon: CircleDashed, className: 'border-border text-muted-foreground' },
};
/** P22. Colour is never the only signal: icon and text, as in P10. */
export function RunStatusBadge({ state }: { state: RunState }) {
  const { label, icon: I, className } = LOOK[state];
  return (
    <span data-kind="run" data-value={state} className={cn('inline-flex items-center gap-1 rounded-[var(--radius-badge)] border px-1.5 py-0.5 text-xs font-semibold whitespace-nowrap', className)}>
      <I aria-hidden className="size-3.5" />{label}
    </span>
  );
}

export type RunStatus = 'succeeded' | 'running' | 'failed' | 'paused';
export interface JobRow { id: string; name: string; environment: 'uat' | 'prod'; status: RunStatus; lastRunAt?: string; counts?: { created: number; updated: number; unchanged: number; deprecated: number }; error?: string; paused: boolean }

const WORD: Record<RunStatus, string> = { succeeded: 'Succeeded', running: 'Running', failed: 'Failed', paused: 'Paused' };

/** P22. Runs per job and environment with counts, errors, run now and pause. */
export function JobMonitor({ jobs, onRunNow, onTogglePause, can = { run: true, pause: true } }: { jobs: JobRow[]; onRunNow(id: string): void; onTogglePause(id: string, pause: boolean): void; can?: { run: boolean; pause: boolean } }) {
  return (
    <table className="w-full border-collapse text-sm">
      <caption className="sr-only">Sync jobs</caption>
      <thead className="bg-muted"><tr>{['Job', 'Environment', 'Status', 'Last run', 'Changes', 'Actions'].map((h) => <th key={h} scope="col" className="px-3 py-2 text-left font-semibold">{h}</th>)}</tr></thead>
      <tbody>
        {jobs.map((j) => (
          <tr key={j.id} className="border-b border-border align-top">
            <th scope="row" className="px-3 py-3 text-left font-normal">{j.name}{j.error && <p role="alert" className="mt-1 text-destructive">{j.error}</p>}</th>
            <td className="px-3 py-3"><Badge variant="outline">{j.environment.toUpperCase()}</Badge></td>
            <td className="px-3 py-3 font-semibold">{WORD[j.paused ? 'paused' : j.status]}</td>
            <td className="px-3 py-3">{j.lastRunAt ? <time dateTime={j.lastRunAt}>{j.lastRunAt.slice(0, 16).replace('T', ' ')} UTC</time> : 'Never'}</td>
            <td className="px-3 py-3">{j.counts ? `${j.counts.created} new, ${j.counts.updated} updated, ${j.counts.deprecated} deprecated` : 'None'}</td>
            <td className="flex gap-2 px-3 py-3">
              {can.run && <Button size="sm" variant="outline" isDisabled={j.paused || j.status === 'running'} onPress={() => onRunNow(j.id)}>Run {j.name} now</Button>}
              {can.pause && <Button size="sm" variant="outline" onPress={() => onTogglePause(j.id, !j.paused)}>{j.paused ? 'Resume' : 'Pause'}<span className="sr-only"> {j.name}</span></Button>}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
