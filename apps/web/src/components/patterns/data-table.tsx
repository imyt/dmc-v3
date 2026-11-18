import { useState, type ReactNode } from 'react';
import { Cell, Checkbox, Column, Row, Table, TableBody, TableHeader, type SortDescriptor, type Selection } from 'react-aria-components';
import { Check, CaretDown, CaretUp, DownloadSimple } from '@phosphor-icons/react';
import { Button } from '@/components/ui/button';
import { toCsv } from '@/lib/diff';
import { EmptyState } from './states';

export interface Col<T> { id: string; header: string; cell(row: T): ReactNode; text?(row: T): string; sortable?: boolean; hidden?: boolean }

export interface DataTableProps<T> {
  label: string;
  columns: Col<T>[];
  rows: T[];
  rowId(row: T): string;
  sort?: SortDescriptor;
  onSort?(s: SortDescriptor): void;
  /** server-side paging: the caller fetches; these only drive the controls */
  paging?: { hasPrevious: boolean; hasNext: boolean; onPrevious(): void; onNext(): void; total?: number };
  bulkActions?(selected: string[]): ReactNode;
  exportName?: string;
  empty?: { title: string; doing: string };
}

/** P3. Server-side paging and sort, density, column visibility, row selection, CSV of the rows as filtered. */
export function DataTable<T>(p: DataTableProps<T>) {
  const [dense, setDense] = useState(false);
  const [hidden, setHidden] = useState<Set<string>>(() => new Set(p.columns.filter((c) => c.hidden).map((c) => c.id)));
  const [selection, setSelection] = useState<Selection>(new Set());
  const cols = p.columns.filter((c) => !hidden.has(c.id));
  const selected = selection === 'all' ? p.rows.map(p.rowId) : [...selection].map(String);

  const exportCsv = () => {
    const csv = toCsv(cols.map((c) => c.header), p.rows.map((r) => cols.map((c) => c.text?.(r) ?? '')));
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `${p.exportName ?? 'export'}.csv` });
    a.click(); URL.revokeObjectURL(url);
  };

  if (p.rows.length === 0 && p.empty) return <EmptyState {...p.empty} />;
  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-4">
        <div className="min-h-9">{selected.length > 0 && <div className="flex items-center gap-3"><span className="text-sm">{selected.length} selected</span>{p.bulkActions?.(selected)}</div>}</div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" aria-pressed={dense} onPress={() => setDense(!dense)}>{dense ? 'Comfortable rows' : 'Compact rows'}</Button>
          <details className="relative">
            <summary className="flex h-8 cursor-pointer list-none items-center border border-input px-3 text-sm">Columns</summary>
            <fieldset className="absolute right-0 z-20 mt-1 min-w-48 border border-border bg-popover p-3 shadow-md">
              <legend className="sr-only">Visible columns</legend>
              {p.columns.map((c) => (
                <label key={c.id} className="flex items-center gap-2 py-1 text-sm">
                  <input type="checkbox" checked={!hidden.has(c.id)} onChange={(e) => { const n = new Set(hidden); if (e.target.checked) n.delete(c.id); else n.add(c.id); setHidden(n); }} />{c.header}
                </label>
              ))}
            </fieldset>
          </details>
          {p.exportName && <Button size="sm" variant="outline" onPress={exportCsv}><DownloadSimple aria-hidden className="size-4" />Export CSV</Button>}
        </div>
      </div>
      <div className="max-h-[70vh] overflow-auto border border-border">
        <Table aria-label={p.label} selectionMode="multiple" selectedKeys={selection} onSelectionChange={setSelection} sortDescriptor={p.sort} onSortChange={p.onSort} className="w-full border-collapse text-sm">
          <TableHeader className="sticky top-0 z-10 bg-muted">
            <Column className="w-10 px-2 text-left"><SelectBox label="Select all rows" /></Column>
            {cols.map((c, i) => (
              <Column key={c.id} id={c.id} isRowHeader={i === 0} allowsSorting={c.sortable} className="border-b border-border px-3 py-2 text-left font-semibold">
                {({ sortDirection }) => <span className="inline-flex items-center gap-1">{c.header}{sortDirection === 'ascending' && <CaretUp aria-hidden className="size-4" />}{sortDirection === 'descending' && <CaretDown aria-hidden className="size-4" />}</span>}
              </Column>
            ))}
          </TableHeader>
          <TableBody items={p.rows.map((r) => ({ id: p.rowId(r), r }))}>
            {({ id, r }) => (
              <Row id={id} className="border-b border-border data-[selected]:bg-muted data-[hovered]:bg-muted/60">
                <Cell className="px-2"><SelectBox label={`Select ${id}`} /></Cell>
                {cols.map((c) => <Cell key={c.id} className={dense ? 'px-3 py-1' : 'px-3 py-3'}>{c.cell(r)}</Cell>)}
              </Row>
            )}
          </TableBody>
        </Table>
      </div>
      {p.paging && (
        <div className="mt-2 flex items-center justify-between text-sm">
          <span className="text-muted-foreground">{p.paging.total != null ? `${p.paging.total} results` : ''}</span>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" isDisabled={!p.paging.hasPrevious} onPress={p.paging.onPrevious}>Previous</Button>
            <Button size="sm" variant="outline" isDisabled={!p.paging.hasNext} onPress={p.paging.onNext}>Next</Button>
          </div>
        </div>
      )}
    </div>
  );
}

function SelectBox({ label }: { label: string }) {
  return (
    <Checkbox slot="selection" aria-label={label} className="group inline-flex">
      <span className="flex size-4 items-center justify-center border border-input bg-background group-data-[selected]:border-brand group-data-[selected]:bg-brand group-data-[indeterminate]:border-brand group-data-[focus-visible]:ring-2 group-data-[focus-visible]:ring-ring">
        <Check aria-hidden className="hidden size-3 text-brand-foreground group-data-[selected]:block" />
      </span>
    </Checkbox>
  );
}
