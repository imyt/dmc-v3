import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { BulkImport, type ImportField } from '@/components/patterns/bulk-import';
import { notify } from '@/components/patterns/toast';
import { toCsv } from '@/lib/diff';
import { DataTable } from '@/components/patterns/data-table';
import { PageHeader } from '@/components/patterns/page-header';
import { ErrorState, LoadingState } from '@/components/patterns/states';
import { ApiProblem, useData } from '@/lib/data';
import { useAsync } from '@/lib/use-async';

const KINDS = ['operating-instruction', 'technical-control-requirement'];
const FIELDS: ImportField[] = [
  { id: 'reference_id', label: 'reference_id', required: true }, { id: 'title', label: 'title', required: true },
  { id: 'kind', label: 'kind', required: true, validate: (v) => (KINDS.includes(v) ? null : `Must be ${KINDS.join(' or ')}`) },
  { id: 'owner', label: 'owner' }, { id: 'confluence_link', label: 'confluence_link' },
  { id: 'version', label: 'version', validate: (v) => (/^[1-9][0-9]*$/.test(v) ? null : 'A whole number from 1') },
];
const COLS = FIELDS.map((f) => f.id);
const asCsv = (rs: Record<string, string>[]) => toCsv(COLS, rs.map((r) => COLS.map((c) => r[c] ?? '')));
const summary = (r: { created: number; updated: number; unchanged: number; flagged_policies: string[] }) => `${r.created} new, ${r.updated} changed, ${r.unchanged} unchanged${r.flagged_policies.length ? `; ${r.flagged_policies.length} policies flagged for review` : ''}.`;

const LABEL = { none: 'No policy', shadow_only: 'Shadow only', enforced: 'Enforced' } as const;

/** C6. Which control requirements are covered by a policy, and how firmly. */
export function RequirementsRoute() {
  const data = useData();
  const [v, setV] = useState(0);
  const s = useAsync(() => data.requirementCoverage(), [v]);
  const [f, setF] = useState({ reference_id: '', title: '', kind: KINDS[0]!, owner: '', confluence_link: '' });
  const [showImport, setShowImport] = useState(false);
  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    try {
      const r = await data.saveRequirement({ reference_id: f.reference_id.trim(), title: f.title.trim(), kind: f.kind as never, ...(f.owner ? { owner: f.owner } : {}), ...(f.confluence_link ? { confluence_link: f.confluence_link } : {}) });
      notify({ tone: 'success', title: 'Requirement saved', description: summary(r) }); setF({ ...f, reference_id: '', title: '' }); setV((x) => x + 1);
    } catch (e) { notify({ tone: 'error', title: 'Could not save', description: e instanceof ApiProblem ? e.detail : 'Something went wrong.' }); }
  };
  return (
    <>
      <PageHeader title="Control requirements" description="Each requirement, and whether a policy implements it." crumbs={[{ label: 'Home', to: '/' }, { label: 'Requirements' }]} />
      <div className="mx-auto max-w-[var(--content-max)] space-y-4 px-8 py-6">
        {s.status === 'loading' && <LoadingState label="Loading requirements" />}
        {s.status === 'error' && <ErrorState message={s.error instanceof ApiProblem ? s.error.detail : 'Something went wrong.'} />}
        {s.status === 'done' && (<>
          <p className="text-sm">{s.value.summary.enforced} enforced · {s.value.summary.shadow_only} shadow only · {s.value.summary.none} with no policy</p>
          <DataTable label="Requirements" exportName="requirements" rowId={(r) => r.qualified_name} rows={s.value.items}
            empty={{ title: 'No requirements yet', doing: 'Import them from a CSV or register them one at a time.' }}
            columns={[{ id: 'id', header: 'Reference', cell: (r) => <Link to="/o/$qn" params={{ qn: r.qualified_name }} className="underline">{r.reference_id}</Link>, text: (r) => r.reference_id },
              { id: 't', header: 'Title', cell: (r) => r.title, text: (r) => r.title }, { id: 'k', header: 'Kind', cell: (r) => r.kind, text: (r) => r.kind },
              { id: 's', header: 'Coverage', cell: (r) => <strong>{LABEL[r.status]}</strong>, text: (r) => LABEL[r.status] },
              { id: 'p', header: 'Policies', cell: (r) => r.policies.map((p) => p.id).join(', '), text: (r) => r.policies.map((p) => p.id).join('; ') }]} />
          <section aria-labelledby="newreq" className="max-w-xl space-y-3">
            <h2 id="newreq" className="text-lg font-semibold">Register a requirement</h2>
            <form onSubmit={(e) => void submit(e)} className="space-y-3" aria-label="Register a requirement">
              <label className="block text-sm">Reference<Input value={f.reference_id} onChange={(e) => setF({ ...f, reference_id: e.target.value })} /></label>
              <label className="block text-sm">Title<Input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
              <label className="block text-sm">Kind<select className="mt-1 h-10 w-full border border-input bg-background px-2" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{KINDS.map((k) => <option key={k}>{k}</option>)}</select></label>
              <label className="block text-sm">Owner<Input value={f.owner} onChange={(e) => setF({ ...f, owner: e.target.value })} /></label>
              <label className="block text-sm">Confluence link<Input value={f.confluence_link} onChange={(e) => setF({ ...f, confluence_link: e.target.value })} /></label>
              <Button type="submit">Save requirement</Button>
            </form>
          </section>
          <section aria-labelledby="impreq" className="space-y-3">
            <h2 id="impreq" className="text-lg font-semibold">Import from a CSV</h2>
            <Button variant="outline" onPress={() => setShowImport(!showImport)}>{showImport ? 'Close import' : 'Import requirements'}</Button>
            {showImport && <BulkImport fields={FIELDS}
              dryRun={async (rs) => summary(await data.importRequirements(asCsv(rs), true))}
              onCommit={async (rs) => { const r = await data.importRequirements(asCsv(rs)); notify({ tone: 'success', title: 'Requirements imported', description: summary(r) }); setV((x) => x + 1); }} />}
          </section>
        </>)}
      </div>
    </>
  );
}
