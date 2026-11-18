import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { parseCsv } from '@/lib/csv';
import { toCsv } from '@/lib/diff';

export interface ImportField { id: string; label: string; required?: boolean; validate?(v: string): string | null }
export interface ImportError { row: number; field: string; message: string }

/** Map CSV columns to fields and validate every row. Pure so it can be tested and reused server-side checks mirror it. */
export function validateImport(rows: string[][], mapping: Record<string, number | undefined>, fields: ImportField[]): { records: Record<string, string>[]; errors: ImportError[] } {
  const records: Record<string, string>[] = [], errors: ImportError[] = [];
  rows.slice(1).forEach((r, i) => {
    const rec: Record<string, string> = {};
    for (const f of fields) {
      const idx = mapping[f.id];
      const v = (idx == null ? '' : r[idx] ?? '').trim();
      rec[f.id] = v;
      if (f.required && v === '') errors.push({ row: i + 2, field: f.label, message: 'Required' });
      else if (v !== '' && f.validate) { const m = f.validate(v); if (m) errors.push({ row: i + 2, field: f.label, message: m }); }
    }
    records.push(rec);
  });
  return { records, errors };
}

/** P14. Upload, map, validate, dry run, commit, download the error report. */
export function BulkImport({ fields, onCommit, dryRun }: { fields: ImportField[]; onCommit(records: Record<string, string>[]): Promise<void>; dryRun?(records: Record<string, string>[]): Promise<string> }) {
  const [rows, setRows] = useState<string[][] | null>(null);
  const [mapping, setMapping] = useState<Record<string, number | undefined>>({});
  const [dry, setDry] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const result = useMemo(() => (rows ? validateImport(rows, mapping, fields) : null), [rows, mapping, fields]);

  const load = async (file: File) => {
    const parsed = parseCsv(await readText(file));
    setRows(parsed); setDry(null); setDone(false);
    const header = (parsed[0] ?? []).map((h) => h.trim().toLowerCase());
    setMapping(Object.fromEntries(fields.map((f) => { const i = header.indexOf(f.label.toLowerCase()); return [f.id, i >= 0 ? i : undefined]; })));
  };
  const errorReport = () => {
    if (!result) return;
    const url = URL.createObjectURL(new Blob([toCsv(['Row', 'Field', 'Problem'], result.errors.map((e) => [e.row, e.field, e.message]))], { type: 'text/csv' }));
    Object.assign(document.createElement('a'), { href: url, download: 'import-errors.csv' }).click(); URL.revokeObjectURL(url);
  };
  return (
    <section aria-label="Bulk import" className="space-y-4">
      <div><label htmlFor="bi-file" className="mb-1 block text-sm font-semibold">CSV file</label>
        <input id="bi-file" type="file" accept=".csv,text/csv" onChange={(e) => e.target.files?.[0] && void load(e.target.files[0])} /></div>
      {rows && result && (
        <>
          <fieldset className="grid grid-cols-2 gap-3"><legend className="mb-1 text-sm font-semibold">Match columns</legend>
            {fields.map((f) => (
              <label key={f.id} className="text-sm">{f.label}{f.required && ' *'}
                <select className="mt-1 h-10 w-full border border-input bg-background px-2" value={mapping[f.id] ?? ''} onChange={(e) => setMapping({ ...mapping, [f.id]: e.target.value === '' ? undefined : Number(e.target.value) })}>
                  <option value="">Not in file</option>{(rows[0] ?? []).map((h, i) => <option key={i} value={i}>{h}</option>)}
                </select></label>
            ))}
          </fieldset>
          <p role="status">{result.records.length} rows, {result.errors.length} problems</p>
          {result.errors.length > 0 && (
            <div><ul className="max-h-40 list-disc overflow-auto pl-5 text-sm">{result.errors.slice(0, 20).map((e, i) => <li key={i}>Row {e.row}, {e.field}: {e.message}</li>)}</ul>
              <Button variant="outline" onPress={errorReport}>Download error report</Button></div>
          )}
          {dry && <p className="border border-border p-3 text-sm">{dry}</p>}
          <div className="flex gap-2">
            {dryRun && <Button variant="outline" isDisabled={result.errors.length > 0} onPress={async () => setDry(await dryRun(result.records))}>Dry run</Button>}
            <Button isDisabled={result.errors.length > 0 || result.records.length === 0 || done} onPress={async () => { await onCommit(result.records); setDone(true); }}>Import {result.records.length} rows</Button>
          </div>
          {done && <p role="status">Imported.</p>}
        </>
      )}
    </section>
  );
}

const readText = (f: File) => new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(r.error); r.readAsText(f); });
