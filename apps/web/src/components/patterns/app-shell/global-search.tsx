import { useEffect, useRef, useState } from 'react';
import { Collection, ComboBox, Input, Label, ListBox, ListBoxItem, ListBoxSection, Header as RacHeader, Popover } from 'react-aria-components';
import { MagnifyingGlass } from '@phosphor-icons/react';

export interface Suggestion { id: string; label: string; typeLabel: string; href: string }

/**
 * P2. MagnifyingGlass is the front door: always in the header, Ctrl/Cmd+K focuses it from anywhere.
 * Typeahead comes from the caller (the search API); with an empty box it shows recent items.
 */
export function GlobalSearch({ onSubmit, suggest, recent = [], onPick }: {
  onSubmit(query: string): void;
  suggest?(q: string): Promise<Suggestion[]>;
  recent?: Suggestion[];
  onPick?(s: Suggestion): void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [text, setText] = useState('');
  const [found, setFound] = useState<Suggestion[]>([]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); ref.current?.focus(); ref.current?.select(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (!suggest || text.trim().length < 2) { setFound([]); return; }
    let live = true;
    const t = setTimeout(() => { void suggest(text.trim()).then((r) => live && setFound(r)); }, 150);
    return () => { live = false; clearTimeout(t); };
  }, [text, suggest]);

  const showing = text.trim() === '' ? recent : found;
  const heading = text.trim() === '' ? 'Recent' : 'Suggestions';
  const all = [...recent, ...found];

  return (
    <ComboBox
      aria-label="Search DMC" allowsCustomValue allowsEmptyCollection={false} menuTrigger="focus"
      inputValue={text} onInputChange={setText}
      items={showing}
      onSelectionChange={(k) => { const s = all.find((x) => x.id === k); if (s) { onPick?.(s); setText(''); } }}
      className="group relative flex w-full max-w-xl items-center"
    >
      <Label className="sr-only">Search DMC</Label>
      <MagnifyingGlass aria-hidden className="pointer-events-none absolute left-3 size-4 text-muted-foreground" />
      <Input
        ref={ref}
        placeholder="Search assets, terms, policies, scopes"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.currentTarget.getAttribute('aria-activedescendant') && text.trim()) onSubmit(text.trim());
        }}
        className="h-10 w-full rounded-[var(--radius)] border border-input bg-background pr-16 pl-9 text-sm text-foreground placeholder:text-muted-foreground"
      />
      {text === '' && <kbd aria-hidden className="pointer-events-none absolute right-3 rounded-[var(--radius-badge)] border border-border px-1.5 text-xs text-muted-foreground">Ctrl K</kbd>}
      <Popover className="w-[var(--trigger-width)] border border-border bg-popover text-popover-foreground shadow-md">
        <ListBox className="max-h-80 overflow-auto p-1 outline-none">
          <ListBoxSection aria-label={heading}>
            <RacHeader className="px-3 py-1 text-xs font-semibold text-muted-foreground">{heading}</RacHeader>
            <Collection items={showing}>
              {(s: Suggestion) => (
                <ListBoxItem id={s.id} textValue={s.label} className="flex cursor-default items-center justify-between px-3 py-2 text-sm outline-none data-[focused]:bg-muted">
                  <span>{s.label}</span><span className="text-xs text-muted-foreground">{s.typeLabel}</span>
                </ListBoxItem>
              )}
            </Collection>
          </ListBoxSection>
        </ListBox>
      </Popover>
    </ComboBox>
  );
}
