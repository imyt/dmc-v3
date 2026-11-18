import { ProgressBar } from 'react-aria-components';

export interface Step { label: string; done: boolean }

/** P12. Percentage plus what is still missing. */
export function Completeness({ label, steps }: { label: string; steps: Step[] }) {
  const done = steps.filter((s) => s.done).length;
  const pct = steps.length ? Math.round((done / steps.length) * 100) : 0;
  const missing = steps.filter((s) => !s.done);
  return (
    <div>
      <ProgressBar aria-label={label} value={pct} className="space-y-1">
        {({ percentage }) => (
          <>
            <div className="flex justify-between text-sm"><span>{label}</span><span>{percentage}% ({done} of {steps.length})</span></div>
            <div className="h-2 bg-muted"><div className="h-full bg-brand" style={{ width: `${percentage}%` }} /></div>
          </>
        )}
      </ProgressBar>
      {missing.length > 0 && (
        <div className="mt-2 text-sm"><span className="text-muted-foreground">Still missing:</span>
          <ul className="list-disc pl-5">{missing.map((s) => <li key={s.label}>{s.label}</li>)}</ul>
        </div>
      )}
    </div>
  );
}
