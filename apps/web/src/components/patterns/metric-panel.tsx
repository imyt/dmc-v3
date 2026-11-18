import { useId, useState } from 'react';
import { ArrowDownRight, ArrowUpRight, Minus } from '@phosphor-icons/react';
import { Button } from '@/components/ui/button';

export interface MetricBreakdown { label: string; value: number }
export interface MetricProps {
  title: string; value: number; target: number; unit?: string;
  /** change since the previous period, in the same unit */
  delta?: number; breakdownLabel?: string; breakdown?: MetricBreakdown[];
  /** true when a higher value is better (default) */ higherIsBetter?: boolean;
  /** what the number is made of, for example "3 of 6 applications in the catalog" */ detail?: string;
}

/** P23. A measure with target, trend and breakdown. The table is the accessible equivalent of the bars. */
export function MetricPanel({ title, value, target, unit = '%', delta, breakdown, breakdownLabel = 'Breakdown', higherIsBetter = true, detail }: MetricProps) {
  const [table, setTable] = useState(false);
  const id = useId();
  const meets = higherIsBetter ? value >= target : value <= target;
  const Trend = delta == null || delta === 0 ? Minus : delta > 0 ? ArrowUpRight : ArrowDownRight;
  const max = Math.max(target, ...(breakdown?.map((b) => b.value) ?? [0]), value);
  return (
    <section aria-labelledby={id} className="border border-border p-4">
      <h3 id={id} className="text-sm text-muted-foreground">{title}</h3>
      <p className="mt-1 flex items-baseline gap-3">
        <span className="text-4xl font-semibold">{value}{unit}</span>
        <span className="text-sm">Target {target}{unit} <strong className={meets ? 'text-success' : 'text-destructive'}>{meets ? 'met' : 'not met'}</strong></span>
        {delta != null && <span className="flex items-center gap-1 text-sm"><Trend aria-hidden className="size-4" />{delta > 0 ? '+' : ''}{delta}{unit} vs last period</span>}
      </p>
      {detail && <p className="mt-1 text-sm text-muted-foreground">{detail}</p>}
      {!breakdown && (
        <div aria-hidden className="relative mt-3 h-2 bg-muted">
          <span className="absolute inset-y-0 left-0 bg-brand" style={{ width: `${max === 0 ? 0 : Math.min(100, (value / max) * 100)}%` }} />
          <span className="absolute inset-y-[-3px] w-0.5 bg-foreground" style={{ left: `${max === 0 ? 0 : (target / max) * 100}%` }} />
        </div>
      )}
      {breakdown && (
        <div className="mt-4">
          <div className="mb-2 flex items-center justify-between"><h4 className="text-sm font-semibold">{breakdownLabel}</h4>
            <Button size="sm" variant="outline" aria-pressed={table} onPress={() => setTable(!table)}>{table ? 'Show bars' : 'Show table'}</Button></div>
          {table ? (
            <table className="w-full text-sm"><thead><tr><th className="text-left">{breakdownLabel}</th><th className="text-right">Value</th></tr></thead>
              <tbody>{breakdown.map((b) => <tr key={b.label}><td>{b.label}</td><td className="text-right">{b.value}{unit}</td></tr>)}</tbody></table>
          ) : (
            <ul className="space-y-2" aria-hidden>
              {breakdown.map((b) => (
                <li key={b.label} className="grid grid-cols-[8rem_1fr_3rem] items-center gap-2 text-sm">
                  <span>{b.label}</span>
                  <span className="relative h-3 bg-muted"><span className="absolute inset-y-0 left-0 bg-brand" style={{ width: `${(b.value / max) * 100}%` }} /><span className="absolute inset-y-[-2px] w-0.5 bg-foreground" style={{ left: `${(target / max) * 100}%` }} /></span>
                  <span className="text-right">{b.value}{unit}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
