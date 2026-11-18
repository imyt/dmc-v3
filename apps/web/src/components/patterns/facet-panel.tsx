import { Checkbox, CheckboxGroup, Label } from 'react-aria-components';
import { Check } from '@phosphor-icons/react';

export interface FacetGroup { id: string; label: string; values: { value: string; label: string; count: number }[] }
export type FacetSelection = Record<string, string[]>;

/** P4. Filters with a count per value. Selection is owned by the caller (URL state in real pages). */
export function FacetPanel({ groups, selected, onChange }: { groups: FacetGroup[]; selected: FacetSelection; onChange(next: FacetSelection): void }) {
  const any = Object.values(selected).some((v) => v.length > 0);
  return (
    <aside aria-label="Filters" className="w-64 shrink-0 space-y-6">
      {any && <button type="button" className="text-sm text-brand-text underline underline-offset-2" onClick={() => onChange({})}>Clear all filters</button>}
      {groups.map((g) => (
        <CheckboxGroup key={g.id} aria-label={g.label} value={selected[g.id] ?? []} onChange={(v) => onChange({ ...selected, [g.id]: v })}>
          <Label className="mb-2 block text-sm font-semibold">{g.label}</Label>
          <div className="space-y-1">
            {g.values.map((v) => (
              <Checkbox key={v.value} value={v.value} className="group flex cursor-default items-center gap-2 py-1 text-sm">
                <span className="flex size-4 items-center justify-center border border-input bg-background group-data-[selected]:border-brand group-data-[selected]:bg-brand group-data-[focus-visible]:ring-2 group-data-[focus-visible]:ring-ring">
                  <Check aria-hidden className="hidden size-3 text-brand-foreground group-data-[selected]:block" />
                </span>
                <span className="flex-1">{v.label}</span>
                <span className="text-muted-foreground">{v.count}</span>
              </Checkbox>
            ))}
          </div>
        </CheckboxGroup>
      ))}
    </aside>
  );
}
