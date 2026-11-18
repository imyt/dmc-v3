import { useMemo, useState } from 'react';
import { diffLines, type DiffLine } from '@/lib/diff';
import { Button } from '@/components/ui/button';

const MARK = { same: ' ', add: '+', del: '-' } as const;
const WORD = { same: 'unchanged', add: 'added', del: 'removed' } as const;
const TONE = { same: '', add: 'bg-success/15', del: 'bg-destructive/15' } as const;

/** P16. Inline or side by side. +/- marks and visually hidden words mean colour is not the only signal. */
export function DiffView({ before, after, title }: { before: string; after: string; title: string }) {
  const [mode, setMode] = useState<'inline' | 'split'>('inline');
  const lines = useMemo(() => diffLines(before, after), [before, after]);
  const added = lines.filter((l) => l.kind === 'add').length;
  const removed = lines.filter((l) => l.kind === 'del').length;
  return (
    <section aria-label={title}>
      <div className="mb-2 flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{added} added, {removed} removed</p>
        <div className="flex gap-1" role="group" aria-label="Diff layout">
          <Button size="sm" variant={mode === 'inline' ? 'default' : 'outline'} aria-pressed={mode === 'inline'} onPress={() => setMode('inline')}>Inline</Button>
          <Button size="sm" variant={mode === 'split' ? 'default' : 'outline'} aria-pressed={mode === 'split'} onPress={() => setMode('split')}>Side by side</Button>
        </div>
      </div>
      {mode === 'inline' ? <Inline lines={lines} /> : <Split lines={lines} />}
    </section>
  );
}

function Inline({ lines }: { lines: DiffLine[] }) {
  return (
    <pre className="overflow-x-auto border border-border font-mono text-sm" tabIndex={0}>
      {lines.map((l, i) => (
        <div key={i} data-kind={l.kind} className={`px-3 ${TONE[l.kind]}`}>
          <span aria-hidden>{MARK[l.kind]} </span><span className="sr-only">{WORD[l.kind]}: </span>{l.text || ' '}
        </div>
      ))}
    </pre>
  );
}

function Split({ lines }: { lines: DiffLine[] }) {
  const left = lines.filter((l) => l.kind !== 'add');
  const right = lines.filter((l) => l.kind !== 'del');
  const col = (ls: DiffLine[], label: string) => (
    <pre aria-label={label} tabIndex={0} className="overflow-x-auto border border-border font-mono text-sm">
      {ls.map((l, i) => <div key={i} data-kind={l.kind} className={`px-3 ${TONE[l.kind]}`}><span aria-hidden>{MARK[l.kind]} </span><span className="sr-only">{WORD[l.kind]}: </span>{l.text || ' '}</div>)}
    </pre>
  );
  return <div className="grid grid-cols-2 gap-2">{col(left, 'Before')}{col(right, 'After')}</div>;
}
