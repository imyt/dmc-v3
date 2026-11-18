import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Completeness } from '@/components/patterns/completeness';
import { LinkPicker } from '@/components/patterns/link-picker';
import { DataTable } from '@/components/patterns/data-table';
import { PageHeader } from '@/components/patterns/page-header';
import { EmptyState, ErrorState, LoadingState } from '@/components/patterns/states';
import { notify } from '@/components/patterns/toast';
import { ApiProblem, useData, type Tier } from '@/lib/data';
import { useAsync } from '@/lib/use-async';

const problem = (e: unknown) => (e instanceof ApiProblem ? e.detail : 'Something went wrong. Try again.');
const TIERS: { id: Tier; label: string }[] = [{ id: 'bronze', label: 'Bronze' }, { id: 'silver', label: 'Silver' }, { id: 'gold', label: 'Gold' }];

/** P13 for one business element: pick the columns or tables, name the application they belong to, confirm. */
function LinkEditor({ qn, element, apps, onDone }: { qn: string; element: string; apps: { application: string; name: string }[]; onDone(): void }) {
  const data = useData();
  const [app, setApp] = useState(apps[0]?.application ?? '');
  const cands = useAsync(async () => {
    const [c, t] = await Promise.all([data.search('', { types: ['Column'], limit: 100 }), data.search('', { types: ['Table'], limit: 100 })]);
    return [...c.hits, ...t.hits].map((h) => ({ id: h.qualified_name, label: h.name, group: h.type }));
  }, []);
  if (cands.status === 'loading') return <LoadingState label="Loading columns" />;
  if (cands.status === 'error') return <ErrorState message={problem(cands.error)} />;
  return (
    <div className="mt-3 space-y-3 border border-border p-3">
      <label className="block text-sm">Application these belong to
        <select className="mt-1 h-10 w-full border border-input bg-background px-2" value={app} onChange={(e) => setApp(e.target.value)}>{apps.map((a) => <option key={a.application} value={a.application}>{a.name}</option>)}</select></label>
      <LinkPicker label={`Link columns to ${element}`} candidates={cands.value}
        onConfirm={(ids) => void (async () => {
          try { for (const id of ids) await data.linkScopeElement(qn, { element, target: id, app }); notify({ tone: 'success', title: `${ids.length} link${ids.length === 1 ? '' : 's'} saved` }); onDone(); }
          catch (e) { notify({ tone: 'error', title: 'Could not save the links', description: problem(e) }); }
        })()} />
    </div>
  );
}

/** The integrations the scope's data flows through, chosen with the same picker. */
function FlowsEditor({ initial, onSave }: { initial: string[]; onSave(ids: string[]): void }) {
  const data = useData();
  const cands = useAsync(async () => (await data.search('', { types: ['Integration'], limit: 100 })).hits.map((h) => ({ id: h.qualified_name, label: h.name, group: 'Integration' })), []);
  if (cands.status === 'loading') return <LoadingState label="Loading integrations" />;
  if (cands.status === 'error') return <ErrorState message={problem(cands.error)} />;
  return <LinkPicker label="Integrations the data flows through" candidates={cands.value} initial={initial} onConfirm={onSave} />;
}

const Wrap = ({ children }: { children: React.ReactNode }) => <div className="mx-auto max-w-[var(--content-max)] space-y-6 px-8 py-6">{children}</div>;

/** C6. Every scope the person can see. */
export function ScopeListRoute() {
  const data = useData();
  const s = useAsync(() => data.search('', { types: ['Scope'], limit: 100 }), []);
  return (
    <>
      <PageHeader title="Scopes" description="Regulatory returns, reports and processes, and where their data lives." crumbs={[{ label: 'Home', to: '/' }, { label: 'Scopes' }]} />
      <Wrap>
        {s.status === 'loading' && <LoadingState label="Loading scopes" />}
        {s.status === 'error' && <ErrorState message={problem(s.error)} />}
        {s.status === 'done' && (
          <DataTable label="Scopes" exportName="scopes" rowId={(h) => h.qualified_name} rows={s.value.hits}
            empty={{ title: 'No scopes yet', doing: 'Scopes arrive from the scope sources, or a scope owner defines one.' }}
            columns={[{ id: 'name', header: 'Name', cell: (h) => <Link to="/scopes/$qn" params={{ qn: h.qualified_name }} className="underline">{h.name}</Link>, text: (h) => h.name },
              { id: 'qn', header: 'Identifier', cell: (h) => h.qualified_name, text: (h) => h.qualified_name }]} />
        )}
      </Wrap>
    </>
  );
}

/** C6. One scope: its groups and elements, where each element is linked, who still owes a link, and the owner's actions. */
export function ScopeRoute({ qn }: { qn: string }) {
  const data = useData();
  const [v, setV] = useState(0);
  const st = useAsync(async () => ({ scope: await data.scope(qn), done: await data.scopeCompleteness(qn) }), [qn, v]);
  const [linking, setLinking] = useState<string | null>(null); const [editFlows, setEditFlows] = useState(false);
  const [group, setGroup] = useState(''); const [el, setEl] = useState<{ group: string; name: string }>({ group: '', name: '' });
  const act = async (fn: () => Promise<unknown>, ok: string) => {
    try { await fn(); notify({ tone: 'success', title: ok }); setV((x) => x + 1); } catch (e) { notify({ tone: 'error', title: 'Could not save', description: problem(e) }); }
  };
  return (
    <>
      <PageHeader title={st.status === 'done' ? st.value.scope.name : 'Scope'} description="Groups of business elements, the integrations the data flows through, and where each element lives."
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Scopes', to: '/scopes' }, { label: qn }]} />
      <Wrap>
        {st.status === 'loading' && <LoadingState label="Loading the scope" />}
        {st.status === 'error' && <ErrorState message={problem(st.error)} requestId={st.error instanceof ApiProblem ? st.error.requestId : undefined} />}
        {st.status === 'done' && (() => {
          const { scope, done } = st.value;
          return (<>
            <p className="text-sm">Version {scope.version} · {scope.locked ? 'submitted and locked' : scope.status === 'amended' ? 'amended, being rewritten' : 'draft'} · owner {scope.owner ?? 'unknown'}</p>
            <Completeness label="Ready for use" steps={[
              { label: `Every element linked (${done.elements.linked} of ${done.elements.total})`, done: done.elements.unlinked.length === 0 && done.elements.total > 0 },
              { label: 'Every application has finished its task', done: done.applications.length > 0 && done.applications.every((a) => a.task === 'done' || a.task === 'none_held') }]} />
            <label className="block max-w-xs text-sm">Trust tier this scope has to reach
              <select className="mt-1 h-10 w-full border border-input bg-background px-2" value={scope.required_tier ?? ''} onChange={(e) => void act(() => data.setScopeTier(qn, e.target.value as Tier), 'Trust tier saved')}>
                <option value="" disabled>Not chosen yet</option>{TIERS.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select></label>
            <div className="flex gap-3">
              {!scope.locked && <Button onPress={() => void act(() => data.scopeAction(qn, 'submit'), 'Scope submitted')}>Submit scope</Button>}
              {scope.locked && <Button variant="outline" onPress={() => void act(() => data.scopeAction(qn, 'amend'), 'Scope reopened as the next version')}>Amend scope</Button>}
            </div>
            <section aria-labelledby="flows"><h2 id="flows" className="mb-2 text-lg font-semibold">Integrations the data flows through</h2>
              {!scope.locked && <Button variant="outline" onPress={() => setEditFlows(!editFlows)}>{editFlows ? 'Close' : 'Edit integrations'}</Button>}
              {editFlows && <FlowsEditor initial={scope.flows} onSave={(ids) => void act(() => data.setScopeFlows(qn, ids), 'Integrations saved').then(() => setEditFlows(false))} />}
              {scope.flows.length ? <ul className="list-disc pl-5">{scope.flows.map((f) => <li key={f}><Link to="/integrations/$qn/datasets" params={{ qn: f }} className="underline">{f}</Link></li>)}</ul> : <EmptyState title="No integrations yet" doing="Say which integrations carry this scope's data, then submit." />}
            </section>
            {scope.groups.map((g) => (
              <section key={g.qualified_name} aria-label={g.name} className="border border-border p-4">
                <h2 className="text-lg font-semibold">{g.name}</h2>
                {g.elements.length === 0 && <p className="text-sm text-muted-foreground">No business elements in this group.</p>}
                <ul className="mt-2 space-y-2">{g.elements.map((e) => (
                  <li key={e.qualified_name}><strong>{e.name}</strong>{e.definition ? ` — ${e.definition}` : ''}
                    <div className="text-sm text-muted-foreground">{e.links.length === 0 ? 'Not linked to any column yet' : e.links.map((l) => `${l.target} (${l.app ?? 'unknown app'}, ${l.state})`).join('; ')}</div>
                    {e.links.filter((l) => l.state === 'proposed').map((l) => (
                      <Button key={l.target} size="sm" variant="outline" onPress={() => void act(() => data.confirmScopeLink(qn, { element: e.qualified_name, target: l.target }), 'Link confirmed')}>Confirm link to {l.target}</Button>))}
                    {scope.locked && done.applications.length > 0 && <Button size="sm" variant="outline" onPress={() => setLinking(linking === e.qualified_name ? null : e.qualified_name)}>{linking === e.qualified_name ? 'Close' : 'Link columns'}<span className="sr-only"> for {e.name}</span></Button>}
                    {linking === e.qualified_name && <LinkEditor qn={qn} element={e.qualified_name} apps={done.applications} onDone={() => { setLinking(null); setV((x) => x + 1); }} />}
                  </li>))}</ul>
                {!scope.locked && (
                  <form className="mt-3 flex gap-2" onSubmit={(ev) => { ev.preventDefault(); if (el.group === g.qualified_name && el.name.trim()) void act(() => data.addScopeElement(qn, g.qualified_name, el.name.trim()), 'Element added').then(() => setEl({ group: '', name: '' })); }}>
                    <Input aria-label={`New element in ${g.name}`} value={el.group === g.qualified_name ? el.name : ''} onChange={(e) => setEl({ group: g.qualified_name, name: e.target.value })} />
                    <Button type="submit" variant="outline">Add element</Button>
                  </form>)}
              </section>))}
            {!scope.locked && (
              <form className="flex gap-2" onSubmit={(ev) => { ev.preventDefault(); if (group.trim()) void act(() => data.addScopeGroup(qn, group.trim()), 'Group added').then(() => setGroup('')); }}>
                <Input aria-label="New group name" value={group} onChange={(e) => setGroup(e.target.value)} /><Button type="submit">Add group</Button>
              </form>)}
            <section aria-labelledby="apps"><h2 id="apps" className="mb-2 text-lg font-semibold">Applications on the flows</h2>
              <DataTable label="Applications" exportName={`${qn}-applications`} rowId={(a) => a.application} rows={done.applications}
                empty={{ title: 'No applications', doing: 'Applications appear once the scope’s integrations are known.' }}
                columns={[{ id: 'a', header: 'Application', cell: (a) => a.name, text: (a) => a.name }, { id: 'o', header: 'Owner', cell: (a) => a.owner ?? '', text: (a) => a.owner ?? '' },
                  { id: 't', header: 'Link task', cell: (a) => a.task + (a.escalated ? ' (escalated)' : ''), text: (a) => a.task }, { id: 'l', header: 'Links', cell: (a) => a.links, text: (a) => String(a.links) }]} />
            </section>
          </>);
        })()}
      </Wrap>
    </>
  );
}
