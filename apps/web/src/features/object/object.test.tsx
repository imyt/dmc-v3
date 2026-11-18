import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import { buildRouter } from '@/router';
import { ApiProblem, type ApiNode, type DataSource } from '@/lib/data';
import { stateOf, toObjectModel } from './model';

const node = {
  qualified_name: 'BusinessTerm:Customer', type: 'BusinessTerm', lifecycle: 'confirmed',
  attributes: { name: 'Customer', definition: 'A party we serve', owner: 'Ada' },
  attribute_sources: { name: 'dmc', definition: 'collibra', owner: 'dmc' },
  provenance: { definition: { by: 'sync/collibra', at: '2026-11-01T00:00:00Z' } },
} as unknown as ApiNode;
const edges = (items: unknown[]) => ({ items }) as never;
const history = { items: [
  { recorded_from: '2026-11-01T00:00:00Z', actor: 'sync/collibra', lifecycle: 'discovered', attributes: { name: 'Customer' } },
  { recorded_from: '2026-11-02T00:00:00Z', actor: 'Ada', lifecycle: 'confirmed', attributes: { name: 'Customer' } },
  { recorded_from: '2026-11-03T00:00:00Z', actor: 'svc for Ada', lifecycle: 'confirmed', attributes: { name: 'Client' } },
] } as never;

const fake = (over: Partial<DataSource> = {}): DataSource => ({
  search: async () => ({ hits: [{ qualified_name: 'BusinessTerm:Customer', type: 'BusinessTerm', name: 'Customer', lifecycle: 'confirmed' }, { qualified_name: 'Dataset:crm.accounts', type: 'Dataset', name: 'accounts', lifecycle: 'discovered' }], facets: { type: { BusinessTerm: 1, Dataset: 1 }, lifecycle: { confirmed: 1, discovered: 1 } }, facets_sampled: false }),
  node: async (qn: string) => { if (qn === node.qualified_name) return node; throw new ApiProblem(404, 'not found'); },
  relationships: async (_qn: string, dir: string) => edges(dir === 'out' ? [{ name: 'describes', from: 'BusinessTerm:Customer', to: 'Dataset:crm.accounts' }] : []),
  history: async () => history,
  inbox: async () => ({ items: [], count: 0 }),
  decide: async () => ({ replayed: false }),
  ...over,
} as unknown as DataSource);
const mount = async (path: string, data: DataSource) => {
  render(<RouterProvider router={buildRouter({ data, history: createMemoryHistory({ initialEntries: [path] }) })} />);
  await screen.findByRole('banner');
};

describe('object model (U1)', () => {
  it('maps lifecycle names onto the status vocabulary', () => {
    expect([stateOf('discovered'), stateOf('confirmed'), stateOf('deprecated'), stateOf('x')]).toEqual(['draft', 'active', 'deprecated', 'draft']);
  });
  it('builds fields from the declared attribute sources, marking synced ones', () => {
    const m = toObjectModel(node, edges([]), edges([]), history);
    expect(m.typeLabel).toBe('Business term');
    expect(m.fields.find((f) => f.id === 'definition')?.source?.tool).toBe('collibra');
    expect(m.fields.find((f) => f.id === 'name')?.source).toBeUndefined();
  });
  it('lists one event per real change, newest first, naming who acted', () => {
    const m = toObjectModel(node, edges([]), edges([]), history);
    expect(m.events.map((e) => e.actor.kind)).toEqual(['agent', 'person', 'sync']);
    expect(m.events[0]!.summary).toContain('changed name');
  });
});

describe('object route (U1)', () => {
  it('renders the object with its relationships', async () => {
    await mount('/o/' + encodeURIComponent('BusinessTerm:Customer'), fake());
    expect(await screen.findByRole('heading', { name: 'Customer', level: 1 })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: 'Relationships' }));
    expect(screen.getByRole('link', { name: 'Dataset:crm.accounts' })).toHaveAttribute('href', '/o/' + encodeURIComponent('Dataset:crm.accounts'));
  });
  it('says so plainly when the object is missing', async () => {
    await mount('/o/nope', fake({ node: async () => { throw new ApiProblem(404, 'not found', 'r1'); } }));
    expect(await screen.findByText(/does not exist, or you cannot see it/i)).toBeInTheDocument();
  });
});

describe('search route (U1)', () => {
  it('lists hits and filters by facet', async () => {
    const calls: unknown[] = [];
    await mount('/search?q=cust', fake({ search: async (q, o) => { calls.push(o?.types); return fake().search(q, o); } }));
    expect(await screen.findByRole('link', { name: 'Customer' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('checkbox', { name: /Dataset/ }));
    await waitFor(() => expect(calls.some((t) => Array.isArray(t) && t[0] === 'Dataset')).toBe(true));
  });
  it('shows an empty state', async () => {
    await mount('/search?q=zzz', fake({ search: async () => ({ hits: [], facets: { type: {}, lifecycle: {} }, facets_sampled: false }) }));
    expect(await screen.findByText('No matches')).toBeInTheDocument();
  });
  it('offers typeahead suggestions that open the object', async () => {
    await mount('/', fake());
    await userEvent.type(screen.getByRole('combobox', { name: /search dmc/i }), 'cust');
    await userEvent.click(await screen.findByRole('option', { name: /Customer/ }));
    expect(await screen.findByRole('heading', { name: 'Customer', level: 1 })).toBeInTheDocument();
  });
});
