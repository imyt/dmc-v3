import { useState } from 'react';
import { Clock } from '@phosphor-icons/react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { StatusBadge, type Severity } from './status-badge';

/** what a person may decide; the workflow step names them (approve, reject, resolve, accept_risk, ...) */
export type Decision = string;
export interface InboxItem {
  id: string; title: string; context: string; recommendation?: string; severity: Severity;
  dueAt?: string; allowed: Decision[]; escalated?: boolean;
}

/** P9. A task or exception with context, a recommendation, its deadline and one-click decisions. */
export function DecisionItem({ item, onDecide, now = new Date() }: { item: InboxItem; onDecide(id: string, d: Decision, comment: string): void; now?: Date }) {
  const [comment, setComment] = useState('');
  const hours = item.dueAt ? Math.round((new Date(item.dueAt).getTime() - now.getTime()) / 36e5) : undefined;
  const due = hours === undefined ? 'No deadline' : hours < 0 ? `Overdue by ${-hours} h` : hours < 48 ? `Due in ${hours} h` : `Due in ${Math.round(hours / 24)} days`;
  const label = (d: Decision) => { const t = d.replace(/_/g, ' '); return t.charAt(0).toUpperCase() + t.slice(1); };
  const primary = item.allowed.includes('approve') ? 'approve' : item.allowed[0];
  return (
    <article aria-labelledby={`t-${item.id}`} className="border border-border p-4">
      <header className="flex items-start justify-between gap-4">
        <h3 id={`t-${item.id}`} className="text-lg font-semibold">{item.title}</h3>
        <div className="flex items-center gap-3">
          {item.escalated && <span className="text-sm font-semibold">Escalated</span>}
          <StatusBadge kind="severity" value={item.severity} />
          <span className={`flex items-center gap-1 text-sm ${hours !== undefined && hours < 0 ? 'font-semibold text-destructive' : 'text-muted-foreground'}`}><Clock aria-hidden className="size-4" />{due}</span>
        </div>
      </header>
      <p className="mt-2">{item.context}</p>
      {item.recommendation && <p className="mt-2 bg-muted p-3 text-sm"><strong>Recommendation:</strong> {item.recommendation}</p>}
      <Textarea aria-label={`Comment on ${item.title}`} value={comment} onChange={(e) => setComment(e.target.value)} className="mt-3" rows={2} placeholder="Add a comment (optional)" />
      <div className="mt-3 flex gap-2">
        {item.allowed.map((d) => <Button key={d} variant={d === primary ? 'default' : 'outline'} onPress={() => onDecide(item.id, d, comment)}>{label(d)}</Button>)}
      </div>
    </article>
  );
}
