import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DataTable } from '@/components/patterns/data-table';
import { PageHeader } from '@/components/patterns/page-header';
import { ErrorState, LoadingState } from '@/components/patterns/states';
import { notify } from '@/components/patterns/toast';
import { ApiProblem, useData } from '@/lib/data';
import { PersonRef, PersonRefs, looksLikeStaffId } from '@/lib/people';
import { objectHref } from '@/features/object/model';
import { useAsync } from '@/lib/use-async';

const problem = (e: unknown) => (e instanceof ApiProblem ? e.detail : 'Something went wrong. Try again.');
const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

/** C6. The datasets an integration carries. Owners and delegates of its applications add and edit; everyone else reads. */
export function DatasetsRoute({ integration }: { integration: string }) {
  const data = useData();
  const [v, setV] = useState(0);
  const st = useAsync(() => data.datasets(integration), [integration, v]);
  // who looks after the integration: the applications at either end, with their owner and delegates
  const apps = useAsync(async () => {
    const edges = (await data.relationships(integration, 'in')).items.filter((e) => e.name === 'source_of' || e.name === 'target_of');
    return Promise.all(edges.map(async (e) => {
      const n = await data.node(e.from).catch(() => undefined);
      const a = (n?.attributes ?? {}) as Record<string, unknown>;
      return { qn: e.from, name: typeof a.name === 'string' ? a.name : e.from, end: e.name === 'source_of' ? 'Sends the data' : 'Receives the data',
        owner: looksLikeStaffId(a.owner) ? a.owner : undefined, delegates: Array.isArray(a.delegates) ? a.delegates.filter(looksLikeStaffId) : [] };
    }));
  }, [integration]);
  const [f, setF] = useState({ name: '', business_context: '', categories: '', record_class: '', columns: '' });
  const [editing, setEditing] = useState<string>();
  const can = st.status === 'done' && st.value.datasets.some((d) => d.can_edit);
  const submit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    try {
      await data.saveDataset(integration, editing, { name: f.name.trim(), business_context: f.business_context || undefined, categories: list(f.categories), columns: list(f.columns), ...(f.record_class ? { record_class: f.record_class } : editing ? { record_class: null } : {}) });
      notify({ tone: 'success', title: editing ? 'Dataset saved' : 'Dataset added', description: f.name }); setF({ name: '', business_context: '', categories: '', record_class: '', columns: '' }); setEditing(undefined); setV((x) => x + 1);
    } catch (e) { notify({ tone: 'error', title: editing ? 'Could not save the dataset' : 'Could not add the dataset', description: problem(e) }); }
  };
  const field = (k: keyof typeof f, label: string) => (<label className="block text-sm">{label}<Input value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></label>);
  return (
    <>
      <PageHeader title="Datasets" description={`What ${integration} carries: category, business context, record class and the columns behind it.`} crumbs={[{ label: 'Home', to: '/' }, { label: integration, to: objectHref(integration) }, { label: 'Datasets' }]} />
      <div className="mx-auto max-w-[var(--content-max)] space-y-6 px-8 py-6">
        {st.status === 'loading' && <LoadingState label="Loading datasets" />}
        {st.status === 'error' && <ErrorState message={problem(st.error)} />}
        {apps.status === 'done' && apps.value.length > 0 && (
          <section aria-labelledby="apps">
            <h2 id="apps" className="mb-2 text-lg font-semibold">Applications on this integration</h2>
            <DataTable label="Applications" exportName={`${integration}-applications`} rowId={(a) => `${a.qn}:${a.end}`} rows={apps.value}
              columns={[{ id: 'a', header: 'Application', cell: (a) => <a className="text-brand-text underline underline-offset-2" href={objectHref(a.qn)}>{a.name}</a>, text: (a) => a.name },
                { id: 'e', header: 'Role', cell: (a) => a.end, text: (a) => a.end },
                { id: 'o', header: 'Owner', cell: (a) => (a.owner ? <PersonRef id={a.owner} role="Owner" /> : 'Not set'), text: (a) => a.owner ?? '' },
                { id: 'd', header: 'Delegates', cell: (a) => <PersonRefs ids={a.delegates} role="Delegate" />, text: (a) => a.delegates.join('; ') }]} />
          </section>)}
        {st.status === 'done' && (<>
          <DataTable label="Datasets" exportName={`${integration}-datasets`} rowId={(d) => d.qualified_name} rows={st.value.datasets}
            empty={{ title: 'No datasets yet', doing: 'The owner of an application on this integration adds what it carries; a policy asks for at least one.' }}
            columns={[{ id: 'n', header: 'Name', cell: (d) => d.name, text: (d) => d.name }, { id: 'c', header: 'Categories', cell: (d) => d.categories.join(', '), text: (d) => d.categories.join('; ') },
              { id: 'r', header: 'Record class', cell: (d) => d.record_class ?? '', text: (d) => d.record_class ?? '' }, { id: 'b', header: 'Business context', cell: (d) => d.business_context ?? '', text: (d) => d.business_context ?? '' },
              { id: 'k', header: 'Columns', cell: (d) => d.columns.length, text: (d) => String(d.columns.length) },
              { id: 'e', header: 'Edit', cell: (d) => d.can_edit ? <Button size="sm" variant="outline" onPress={() => { setEditing(d.qualified_name); setF({ name: d.name, business_context: d.business_context ?? '', categories: d.categories.join(', '), record_class: d.record_class ?? '', columns: d.columns.join(', ') }); }}>Edit<span className="sr-only"> {d.name}</span></Button> : '', text: () => '' }]} />
          {(can || st.value.datasets.length === 0) && (
            <form onSubmit={(e) => void submit(e)} className="max-w-xl space-y-3" aria-label={editing ? 'Edit a dataset' : 'Add a dataset'}>
              <h2 className="text-lg font-semibold">{editing ? 'Edit dataset' : 'Add a dataset'}</h2>
              {field('name', 'Name')}{field('business_context', 'Who uses it')}{field('categories', 'Data categories (comma separated)')}{field('record_class', 'Record class')}{field('columns', 'Columns (comma separated)')}
              <Button type="submit">{editing ? 'Save dataset' : 'Add dataset'}</Button>
              {editing && <Button variant="outline" onPress={() => { setEditing(undefined); setF({ name: '', business_context: '', categories: '', record_class: '', columns: '' }); }}>Cancel</Button>}
            </form>)}
        </>)}
      </div>
    </>
  );
}
