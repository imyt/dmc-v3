import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

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
