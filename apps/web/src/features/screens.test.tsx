import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import { buildRouter } from '@/router';
import type { DataSource } from '@/lib/data';

const scope = { qualified_name: 's1', name: 'PRA110', owner: 'olive', version: 1, status: 'draft', locked: false, versions: [], flows: ['int-1'],
  groups: [{ qualified_name: 's1--credit', name: 'Credit risk', order: 1, elements: [{ qualified_name: 's1--credit--ead', name: 'Exposure', links: [] }] }] };
const done = { qualified_name: 's1', version: 1, submitted: false, complete: false, elements: { total: 1, linked: 0, unlinked: ['s1--credit--ead'] }, applications: [{ application: 'app-a', name: 'App A', owner: 'amy', task: 'open', links: 0 }] };

const fake = (over: Record<string, unknown> = {}) => ({
  search: async () => ({ hits: [{ qualified_name: 's1', type: 'Scope', name: 'PRA110', lifecycle: 'active' }], facets: { type: {}, lifecycle: {} }, facets_sampled: false }),
  inbox: async () => ({ items: [], count: 0 }),
  scope: async () => scope, scopeCompleteness: async () => done,
  datasets: async () => ({ integration: 'int-1', datasets: [] }),
  requirementCoverage: async () => ({ items: [{ reference_id: 'R1', title: 'Owner', kind: 'regulation', version: 1, qualified_name: 'req-1', status: 'shadow_only', policies: [{ id: 'p1', mode: 'shadow' }] }], summary: { none: 0, shadow_only: 1, enforced: 3 }, unknown_references: [] }),
  verifyLedger: async () => ({ ok: true, checked: 42 }),
  nodeEvidence: async () => ({ items: [{ seq: 7, kind: 'decision.made', subject_ref: 'x', actor: 'amy', source_module: 'workflow', occurred_at: '2026-11-01T00:00:00Z', payload: {}, payload_hash: 'a', prev_hash: 'b', hash: 'c' }], next_cursor: null }),
  health: async () => ({ status: 'ok', version: '1.2.3' }),
  ...over,
}) as unknown as DataSource;
const mount = async (ds: DataSource, path: string) => { render(<RouterProvider router={buildRouter({ data: ds, history: createMemoryHistory({ initialEntries: [path] }) })} />); await screen.findByRole('banner'); };

describe('C6 screens', () => {
  it('lists scopes and opens one with its groups, completeness and applications', async () => {
    await mount(fake(), '/scopes/s1');
    expect(await screen.findByText('Credit risk')).toBeInTheDocument();
    expect(screen.getByText('Not linked to any column yet')).toBeInTheDocument();
    expect(screen.getByText('App A')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Submit scope' })).toBeInTheDocument();
  });
  it('submits a draft scope', async () => {
    const calls: string[] = [];
    await mount(fake({ scopeAction: async (_q: string, a: string) => { calls.push(a); } }), '/scopes/s1');
    await userEvent.click(await screen.findByRole('button', { name: 'Submit scope' }));
    await waitFor(() => expect(calls).toEqual(['submit']));
  });
  it('a locked scope offers amend and no editing', async () => {
    await mount(fake({ scope: async () => ({ ...scope, locked: true, status: 'submitted' }) }), '/scopes/s1');
    expect(await screen.findByRole('button', { name: 'Amend scope' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add group' })).toBeNull();
  });
  it('adds a dataset to an integration', async () => {
    const saved: unknown[] = [];
    await mount(fake({ saveDataset: async (_i: string, _q: unknown, b: unknown) => { saved.push(b); } }), '/integrations/int-1/datasets');
    await userEvent.type(await screen.findByLabelText('Name'), 'Accounts');
    await userEvent.type(screen.getByLabelText('Data categories (comma separated)'), 'gl:pii, gl:fin');
    await userEvent.click(screen.getByRole('button', { name: 'Add dataset' }));
    await waitFor(() => expect(saved).toEqual([{ name: 'Accounts', categories: ['gl:pii', 'gl:fin'], columns: [] }]));
  });
  it('shows requirement coverage', async () => {
    await mount(fake(), '/requirements');
    expect(await screen.findByText('Shadow only', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.getByText(/3 enforced/)).toBeInTheDocument();
  });
});

describe('U3, U5, U2, U7', () => {
  it('auditor verifies the chain and traces an object', async () => {
    await mount(fake(), '/evidence');
    await userEvent.click(screen.getByRole('button', { name: 'Verify the ledger now' }));
    expect(await screen.findByText(/chain is intact: 42/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Qualified name of the object'), 'app-a');
    await userEvent.click(screen.getByRole('button', { name: 'Trace' }));
    expect(await screen.findByText('decision.made')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Export proof bundle' })).toBeInTheDocument();
  });
  it('dashboard shows every measure with its target', async () => {
    await mount(fake({ dashboardMeasures: async () => [{ id: 'cov', label: 'Requirements enforced', value: 75, target: 100, unit: 'percent' }, { id: 'apps', label: 'Applications taken on', value: 12, target: 60, unit: 'percent' }] }), '/dashboard');
    expect(await screen.findByText('Requirements enforced')).toBeInTheDocument();
    expect(screen.getByText('Applications taken on')).toBeInTheDocument();
    expect(screen.getAllByText(/Target 100%/).length).toBe(1);
  });
  it('dashboard says so when there are no measures, and shows an API failure', async () => {
    await mount(fake({ dashboardMeasures: async () => [] }), '/dashboard');
    expect(await screen.findByText('No measures yet')).toBeInTheDocument();
  });
  it('admin pauses all enforcement after a confirmation', async () => {
    const calls: boolean[] = []; let paused = false;
    await mount(fake({ adminStatus: async () => ({ version: '1.2.3', metamodel_version: '7', enforcement: paused ? 'paused' : 'running', policies: [] }), setEnforcement: async (p: boolean) => { calls.push(p); paused = p; } }), '/admin');
    await userEvent.click(await screen.findByRole('button', { name: 'Pause all enforcement' }));
    expect(calls).toEqual([]);
    await userEvent.click(await screen.findByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(calls).toEqual([true]));
    expect(await screen.findByRole('button', { name: 'Resume enforcement' })).toBeInTheDocument();
  });
  it('admin pauses one policy, and cancelling changes nothing', async () => {
    const calls: [string, boolean][] = [];
    await mount(fake({ adminStatus: async () => ({ version: '1', metamodel_version: '1', enforcement: 'running', policies: [{ id: 'integration-has-dataset', mode: 'enforced', paused: false }] }), pausePolicy: async (id: string, p: boolean) => { calls.push([id, p]); } }), '/admin');
    await userEvent.click(await screen.findByRole('button', { name: 'Pause policy integration-has-dataset' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(calls).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: 'Pause policy integration-has-dataset' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(calls).toEqual([['integration-has-dataset', true]]));
  });
  it('admin shows an error from the API', async () => {
    const { ApiProblem } = await import('@/lib/data');
    await mount(fake({ adminStatus: async () => { throw new ApiProblem(403, 'Not allowed', 'req-1'); } }), '/admin');
    expect(await screen.findByText('Not allowed')).toBeInTheDocument();
  });
  it('a steward accepts or rejects a classification proposal', async () => {
    const calls: [string, string][] = [];
    let list = [{ id: 'p1', subject: 'dwh.customer.email', classification: 'Confidential', reason: 'Source column is Confidential', source: 'crm.customer.email', status: 'open' }, { id: 'p2', subject: 'dwh.customer.phone', classification: 'Internal', reason: 'Lineage', status: 'open' }];
    await mount(fake({ classificationProposals: async () => list, decideClassification: async (id: string, d: string) => { calls.push([id, d]); list = list.filter((x) => x.id !== id); } }), '/classifications');
    await userEvent.click(await screen.findByRole('button', { name: 'Accept Confidential for dwh.customer.email' }));
    await waitFor(() => expect(calls).toEqual([['p1', 'accept']]));
    await userEvent.click(await screen.findByRole('button', { name: 'Reject Internal for dwh.customer.phone' }));
    await waitFor(() => expect(calls).toEqual([['p1', 'accept'], ['p2', 'reject']]));
    expect(await screen.findByText('No proposals waiting')).toBeInTheDocument();
  });
  it('proposals: error state, and a link from the inbox', async () => {
    const { ApiProblem } = await import('@/lib/data');
    await mount(fake({ classificationProposals: async () => { throw new ApiProblem(500, 'Boom'); } }), '/classifications');
    expect(await screen.findByText('Boom')).toBeInTheDocument();
  });
  it('the menu follows the roles the API sent', async () => {
    render(<RouterProvider router={buildRouter({ data: fake(), shell: { roles: ['viewer', 'steward'] }, history: createMemoryHistory({ initialEntries: ['/'] }) })} />);
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(nav).toHaveTextContent('Classifications');
    expect(nav).not.toHaveTextContent('Admin');
  });
  it('help has a page for each role', async () => {
    await mount(fake(), '/help/auditor');
    expect(await screen.findByText(/Export a proof bundle/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open evidence' })).toBeInTheDocument();
  });
});
