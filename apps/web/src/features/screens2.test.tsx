import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import { buildRouter } from '@/router';
import { AuthGate } from '@/features/auth/auth-gate';
import { emptyGraph, mergeLineage, tableLevel, edgeRows } from '@/features/lineage/model';
import type { DataSource } from '@/lib/data';

const scope = { qualified_name: 's1', name: 'PRA110', owner: 'olive', version: 1, status: 'submitted', locked: true, versions: [], flows: ['int-1'], required_tier: 'silver',
  groups: [{ qualified_name: 's1--credit', name: 'Credit risk', order: 1, elements: [{ qualified_name: 's1--credit--ead', name: 'Exposure', links: [{ target: 'col-9', app: 'app-a', state: 'proposed' }] }] }] };
const done = { qualified_name: 's1', version: 1, submitted: true, complete: false, elements: { total: 1, linked: 0, unlinked: ['s1--credit--ead'] }, applications: [{ application: 'app-a', name: 'App A', owner: 'amy', task: 'open', links: 0 }] };
const hit = (qualified_name: string, type: string) => ({ qualified_name, type, name: qualified_name, lifecycle: 'active' });
const fake = (over: Record<string, unknown> = {}) => ({
  search: async (_q: string, o: { types?: string[] } = {}) => ({ hits: o.types?.[0] === 'Integration' ? [hit('int-1', 'Integration'), hit('int-2', 'Integration')] : o.types?.[0] === 'Column' ? [hit('col-1', 'Column')] : [], facets: { type: {}, lifecycle: {} }, facets_sampled: false }),
  listNodes: async (type: string) => (type === 'Integration' ? ['int-1', 'int-2'] : type === 'Column' ? ['col-1'] : []).map((q) => ({ qualified_name: q, type, attributes: {} })),
  inbox: async () => ({ items: [], count: 0 }), scope: async () => scope, scopeCompleteness: async () => done,
  datasets: async () => ({ integration: 'int-1', datasets: [{ qualified_name: 'int-1--accounts', name: 'Accounts', categories: ['gl:pii'], columns: ['col-1'], record_class: 'rc-1', business_context: 'Credit', can_edit: true }] }),
  requirementCoverage: async () => ({ items: [], summary: { none: 0, shadow_only: 0, enforced: 0 }, unknown_references: [] }),
  ...over,
}) as unknown as DataSource;
const mount = async (ds: DataSource, path: string) => { render(<RouterProvider router={buildRouter({ data: ds, history: createMemoryHistory({ initialEntries: [path] }) })} />); await screen.findByRole('banner'); };

describe('C6 linking, flows, tier', () => {
  it('the scope owner chooses the trust tier', async () => {
    const tiers: string[] = [];
    await mount(fake({ setScopeTier: async (_q: string, t: string) => { tiers.push(t); } }), '/scopes/s1');
    const sel = await screen.findByLabelText('Trust tier this scope has to reach');
    expect(sel).toHaveValue('silver');
    await userEvent.selectOptions(sel, 'gold');
    await waitFor(() => expect(tiers).toEqual(['gold']));
  });
  it('confirms a proposed link', async () => {
    const calls: unknown[] = [];
    await mount(fake({ confirmScopeLink: async (_q: string, l: unknown) => { calls.push(l); } }), '/scopes/s1');
    await userEvent.click(await screen.findByRole('button', { name: 'Confirm link to col-9' }));
    await waitFor(() => expect(calls).toEqual([{ element: 's1--credit--ead', target: 'col-9' }]));
  });
  it('links an element to columns with the picker, naming the application', async () => {
    const calls: unknown[] = [];
    await mount(fake({ linkScopeElement: async (_q: string, l: unknown) => { calls.push(l); } }), '/scopes/s1');
    await userEvent.click(await screen.findByRole('button', { name: /Link columns/ }));
    await userEvent.click(await screen.findByRole('checkbox', { name: /col-1/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Confirm links' }));
    await waitFor(() => expect(calls).toEqual([{ element: 's1--credit--ead', target: 'col-1', app: 'app-a' }]));
  });
  it('a locked scope has no flows editor; an open one saves the chosen integrations', async () => {
    await mount(fake(), '/scopes/s1');
    await screen.findByText('Credit risk');
    expect(screen.queryByRole('button', { name: 'Edit integrations' })).toBeNull();
  });
  it('edits the flows of a draft scope', async () => {
    const saved: string[][] = [];
    await mount(fake({ scope: async () => ({ ...scope, locked: false, status: 'draft' }), setScopeFlows: async (_q: string, i: string[]) => { saved.push(i); } }), '/scopes/s1');
    await userEvent.click(await screen.findByRole('button', { name: 'Edit integrations' }));
    await userEvent.click(await screen.findByRole('checkbox', { name: /int-2/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Confirm links' }));
    await waitFor(() => expect(saved).toEqual([['int-1', 'int-2']]));
  });
});

describe('C6 requirements and datasets', () => {
  it('registers a requirement', async () => {
    const got: unknown[] = [];
    await mount(fake({ saveRequirement: async (i: unknown) => { got.push(i); return { dry_run: false, rows: [], created: 1, updated: 0, unchanged: 0, flagged_policies: [] }; } }), '/requirements');
    await userEvent.type(await screen.findByLabelText('Reference'), 'OI-1');
    await userEvent.type(screen.getByLabelText('Title'), 'Every table has an owner');
    await userEvent.click(screen.getByRole('button', { name: 'Save requirement' }));
    await waitFor(() => expect(got).toEqual([{ reference_id: 'OI-1', title: 'Every table has an owner', kind: 'operating-instruction' }]));
  });
  it('imports requirements from a CSV: dry run first, then commit', async () => {
    const calls: [string, boolean | undefined][] = [];
    const rep = (n: number) => ({ dry_run: false, rows: [], created: n, updated: 0, unchanged: 0, flagged_policies: [] });
    await mount(fake({ importRequirements: async (csv: string, dry?: boolean) => { calls.push([csv, dry]); return rep(2); } }), '/requirements');
    await userEvent.click(await screen.findByRole('button', { name: 'Import requirements' }));
    const file = new File(['reference_id,title,kind\nR1,First,operating-instruction\nR2,Second,technical-control-requirement\n'], 'r.csv', { type: 'text/csv' });
    await userEvent.upload(await screen.findByLabelText('CSV file'), file);
    expect(await screen.findByText(/2 rows, 0 problems/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Dry run' }));
    expect(await screen.findByText(/2 new, 0 changed/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Import 2 rows' }));
    await waitFor(() => expect(calls.map((c) => c[1])).toEqual([true, undefined]));
    expect(calls[1]![0].split(/\r?\n/)[1]).toBe('R1,First,operating-instruction,,,');
  });
  it('a bad kind in the CSV is reported and blocks the import', async () => {
    await mount(fake(), '/requirements');
    await userEvent.click(await screen.findByRole('button', { name: 'Import requirements' }));
    await userEvent.upload(await screen.findByLabelText('CSV file'), new File(['reference_id,title,kind\nR1,First,nonsense\n'], 'r.csv', { type: 'text/csv' }));
    expect(await screen.findByText(/Row 2, kind: Must be/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import 1 rows' })).toBeDisabled();
  });
  it('edits a dataset', async () => {
    const saved: unknown[][] = [];
    await mount(fake({ saveDataset: async (i: string, q: string | undefined, b: unknown) => { saved.push([i, q, b]); } }), '/integrations/int-1/datasets');
    await userEvent.click(await screen.findByRole('button', { name: /Edit Accounts/ }));
    const name = screen.getByRole('textbox', { name: 'Name' }); await userEvent.clear(name); await userEvent.type(name, 'Accounts v2');
    await userEvent.click(screen.getByRole('button', { name: 'Save dataset' }));
    await waitFor(() => expect(saved).toEqual([['int-1', 'int-1--accounts', { name: 'Accounts v2', business_context: 'Credit', categories: ['gl:pii'], columns: ['col-1'], record_class: 'rc-1' }]]));
  });
});

describe('login', () => {
  const ds = (me: unknown, extra: Record<string, unknown> = {}) => fake({ me: async () => me, ...extra });
  const build = (data: DataSource) => (u: { displayName: string; staffID: string }, signOut: () => void) => buildRouter({ data, shell: { userName: u.displayName, userDetail: `Staff ID ${u.staffID}`, onSignOut: signOut }, history: createMemoryHistory({ initialEntries: ['/'] }) });
  it('shows the login when there is no session, signs in, and shows who is signed in', async () => {
    const logins: unknown[] = [];
    const data = ds(null, { mockLogin: async (u: unknown) => { logins.push(u); return u; } });
    render(<AuthGate data={data} build={build(data)} />);
    await userEvent.type(await screen.findByLabelText('Staff ID'), '43001234');
    await userEvent.type(screen.getByLabelText('Display name'), 'Amy Adams');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(logins).toEqual([{ staffID: '43001234', displayName: 'Amy Adams', groups: ['dmc-scope-owner'] }]));
    expect(await screen.findByRole('button', { name: 'Account menu for Amy Adams' })).toBeInTheDocument();
  });
  it('goes straight in with a session, and signing out returns to the login', async () => {
    const out = vi.fn(async () => {});
    const data = ds({ displayName: 'Amy Adams', staffID: '1', groups: [] }, { logout: out });
    render(<AuthGate data={data} build={build(data)} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Account menu for Amy Adams' }));
    expect(await screen.findByText('Staff ID 1')).toBeInTheDocument();
    await userEvent.click(await screen.findByText('Sign out'));
    expect(await screen.findByRole('heading', { name: /Sign in/ })).toBeInTheDocument();
    expect(out).toHaveBeenCalled();
  });
  it('a refused request after the session ended brings the login back', async () => {
    const data = ds({ displayName: 'Amy Adams', staffID: '1', groups: [] });
    render(<AuthGate data={data} build={build(data)} />);
    await screen.findByRole('banner');
    window.dispatchEvent(new Event('dmc:unauthorized'));
    expect(await screen.findByRole('heading', { name: /Sign in/ })).toBeInTheDocument();
  });
  it('refuses an empty login without calling the API', async () => {
    const data = ds(null);
    render(<AuthGate data={data} build={build(data)} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter a staff ID');
  });
});

describe('L5 lineage', () => {
  const walk = (root: string, direction: 'upstream' | 'downstream', pairs: [string, string][], container?: Record<string, string>) => ({
    root, direction, truncated: { depth: false, nodes: false },
    nodes: [...new Set(pairs.flat())].map((n) => ({ qualified_name: n, type: 'Column', depth: 1, ...(container?.[n] ? { container: container[n] } : {}) })),
    // pairs are [upstream, downstream]; the API names the dependent first: `from` is built from `to`
    edges: pairs.map(([up, down]) => ({ from: down, to: up, source: 'dbt', job: 'nightly' })),
  });
  it('merges walks without losing what is shown, and rolls columns up to tables', () => {
    const c = { 'a.x': 'a', 'a.y': 'a', 'b.z': 'b', 's.q': 's' };
    let g = mergeLineage(emptyGraph('b.z'), walk('b.z', 'upstream', [['a.x', 'b.z'], ['a.y', 'b.z']], c));
    g = mergeLineage(g, walk('a.x', 'upstream', [['s.q', 'a.x']], c));
    expect(g.nodes.size).toBe(4); expect(g.edges.size).toBe(3);
    const t = tableLevel(g);
    expect([...t.edges.keys()].sort()).toEqual(['a>b', 's>a']);
    expect(t.root).toBe('b');
    expect(edgeRows(g)[0]).toMatchObject({ from: 'a.x', to: 'b.z', job: 'nightly' });
  });
  it('shows the links as a table and expands on demand', async () => {
    const calls: string[] = [];
    const ds = fake({ lineage: async (qn: string, d: 'upstream' | 'downstream') => { calls.push(`${qn}:${d}`); return qn === 'b.z' ? (d === 'upstream' ? walk('b.z', d, [['a.x', 'b.z']]) : walk('b.z', d, [])) : walk(qn, d, [['s.q', qn]]); } });
    render(<RouterProvider router={buildRouter({ data: ds, history: createMemoryHistory({ initialEntries: ['/lineage/b.z'] }) })} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Table view' }));
    const table = await screen.findByRole('grid', { name: 'Lineage links' });
    expect(within(table).getByText('nightly')).toBeInTheDocument();
    await userEvent.click(within(table).getByRole('button', { name: 'a.x' }));
    await userEvent.click(screen.getByRole('button', { name: 'Expand upstream' }));
    await waitFor(() => expect(calls).toContain('a.x:upstream'));
    expect(await within(await screen.findByRole('grid', { name: 'Lineage links' })).findByRole('button', { name: 's.q' })).toBeInTheDocument();
    expect(screen.getByText(/3 columns, 2 links/)).toBeInTheDocument();
  });
});

describe('P17 canvas', () => {
  it('draws the focus node and its neighbours with the table view offered as the alternative', async () => {
    class RO { observe() {} unobserve() {} disconnect() {} }
    vi.stubGlobal('ResizeObserver', RO);
    vi.stubGlobal('DOMMatrixReadOnly', class { m22 = 1; constructor() {} });
    const ds = fake({ lineage: async (qn: string, d: string) => ({ root: qn, direction: d, truncated: { depth: false, nodes: false }, nodes: [{ qualified_name: qn, type: 'Column', depth: 0 }, ...(d === 'upstream' ? [{ qualified_name: 'a.up', type: 'Column', depth: 1 }] : [])], edges: d === 'upstream' ? [{ from: qn, to: 'a.up', source: 'dbt' }] : [] }) });
    render(<RouterProvider router={buildRouter({ data: ds, history: createMemoryHistory({ initialEntries: ['/lineage/b.z'] }) })} />);
    expect(await screen.findByRole('group', { name: /Lineage canvas/ }, { timeout: 5000 })).toBeInTheDocument();
    await waitFor(() => expect(document.querySelectorAll('.react-flow__node').length).toBe(2), { timeout: 5000 });
    expect(screen.getByRole('button', { name: 'Table view' })).toBeInTheDocument();
    vi.unstubAllGlobals();
  });
});
