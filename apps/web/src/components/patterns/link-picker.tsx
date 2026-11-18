import { useId, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';

export interface LinkCandidate { id: string; label: string; group: string }

/** P13. Search and select on the left, selected links on the right, confirm. */
export function LinkPicker({ candidates, initial = [], onConfirm, label }: { candidates: LinkCandidate[]; initial?: string[]; onConfirm(ids: string[]): void; label: string }) {
  const sid = useId();
  const [q, setQ] = useState('');
  const [sel, setSel] = useState<string[]>(initial);
  const shown = useMemo(() => candidates.filter((c) => `${c.group} ${c.label}`.toLowerCase().includes(q.toLowerCase())), [candidates, q]);
  const toggle = (id: string) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const byId = new Map(candidates.map((c) => [c.id, c]));
  return (
    <section aria-label={label} className="grid grid-cols-2 gap-6">
      <div>
        <label className="mb-1 block text-sm font-semibold" htmlFor={sid}>Search</label>
        <input id={sid} type="search" value={q} onChange={(e) => setQ(e.target.value)} className="h-10 w-full rounded-[var(--radius)] border border-input bg-background px-3 text-sm" />
        <ul aria-label="Available" className="mt-2 max-h-72 overflow-auto border border-border">
          {shown.map((c) => (
            <li key={c.id}><label className="flex items-center gap-2 px-3 py-2 text-sm hover:bg-muted"><input type="checkbox" checked={sel.includes(c.id)} onChange={() => toggle(c.id)} /><span>{c.label}</span><span className="ml-auto text-muted-foreground">{c.group}</span></label></li>
          ))}
          {shown.length === 0 && <li className="px-3 py-2 text-sm text-muted-foreground">No matches</li>}
        </ul>
      </div>
      <div>
        <h3 className="mb-1 text-sm font-semibold">Selected ({sel.length})</h3>
        <ul aria-label="Selected" className="max-h-72 overflow-auto border border-border">
          {sel.map((id) => <li key={id} className="flex items-center justify-between px-3 py-2 text-sm"><span>{byId.get(id)?.label ?? id}</span><Button size="sm" variant="outline" onPress={() => toggle(id)}>Remove<span className="sr-only"> {byId.get(id)?.label}</span></Button></li>)}
          {sel.length === 0 && <li className="px-3 py-2 text-sm text-muted-foreground">Nothing selected yet</li>}
        </ul>
        <Button className="mt-3" isDisabled={sel.length === 0} onPress={() => onConfirm(sel)}>Confirm links</Button>
      </div>
    </section>
  );
}
