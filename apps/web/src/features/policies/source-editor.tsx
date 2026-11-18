import { useRef } from 'react';

/** A monospace text area with line numbers. No code-editor library (rule 11); the server's check reports what is wrong with the text. */
export function SourceEditor({ id, label, value, onChange, readOnly, rows = 16, invalid, describedBy }: { id: string; label: string; value: string; onChange(v: string): void; readOnly?: boolean; rows?: number; invalid?: boolean; describedBy?: string }) {
  const gutter = useRef<HTMLDivElement>(null);
  const count = Math.max(value.split('\n').length, rows);
  return (
    <div>
      <label htmlFor={id} className="mb-1 block text-sm font-semibold">{label}</label>
      <div className="flex border border-input bg-background focus-within:ring-2 focus-within:ring-ring">
        <div ref={gutter} aria-hidden className="select-none overflow-hidden bg-muted px-2 py-3 text-right font-mono text-sm leading-6 text-muted-foreground" style={{ height: `${rows * 1.5 + 1.5}rem` }}>
          {Array.from({ length: count }, (_, i) => <div key={i}>{i + 1}</div>)}
        </div>
        <textarea id={id} spellCheck={false} wrap="off" readOnly={readOnly} value={value} onChange={(e) => onChange(e.target.value)} onScroll={(e) => { if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop; }}
          aria-invalid={invalid || undefined} aria-describedby={describedBy} className="w-full resize-y overflow-auto bg-transparent px-3 py-3 font-mono text-sm leading-6 outline-none read-only:text-muted-foreground" style={{ height: `${rows * 1.5 + 1.5}rem` }} />
      </div>
    </div>
  );
}
