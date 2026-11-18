import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import { buildRouter } from '@/router';
import { ApiProblem, type ApiInbox, type DataSource } from '@/lib/data';

const item = (id: string, over: Partial<ApiInbox['items'][number]> = {}): ApiInbox['items'][number] => ({
  id, assignee: 'alice', kind: 'missing-owner', title: 'Resolve or accept this exception', message: `Fix ${id}`, subject_ref: `app-${id}`,
  decisions: ['dismiss', 'resolve', 'accept_risk'], raised_at: '2026-11-01T00:00:00Z', escalated: false, severity: 'high', ...over,
});

function source(initial: ApiInbox['items'], decide?: DataSource['decide']) {
  let items = initial;
  const calls: [string, string, string][] = [];
  const ds = {
    search: async () => ({ hits: [], facets: { type: {}, lifecycle: {} }, facets_sampled: false }),
    node: async () => { throw new Error('unused'); }, relationships: async () => ({ items: [] }) as never, history: async () => ({ items: [] }) as never,
    inbox: async () => ({ items, count: items.length }),
    decide: decide ?? (async (id: string, d: string, k: string) => { calls.push([id, d, k]); items = items.filter((i) => i.id !== id); return { replayed: false }; }),
  } as unknown as DataSource;
  return { ds, calls };
}
const mount = async (ds: DataSource, path = '/inbox') => {
  render(<RouterProvider router={buildRouter({ data: ds, history: createMemoryHistory({ initialEntries: [path] }) })} />);
  await screen.findByRole('banner');
};

describe('inbox (W2)', () => {
  it('shows the waiting items, the count in the header, and the decisions the step offers', async () => {
    await mount(source([item('1'), item('2', { escalated: true })]).ds);
    expect(await screen.findByText('Fix 1 (app-1)')).toBeInTheDocument();
    expect(screen.getByText('Escalated')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Accept risk' })).toHaveLength(2);
    await waitFor(() => expect(screen.getByRole('link', { name: 'Inbox, 2 waiting' })).toBeInTheDocument());
  });

  it('decides in one click with an idempotency key, then the item leaves the queue', async () => {
    const { ds, calls } = source([item('1')]);
    await mount(ds);
    await userEvent.click(await screen.findByRole('button', { name: 'Resolve' }));
    expect(calls).toEqual([['1', 'resolve', '1:resolve']]);
    expect(await screen.findByText('Nothing is waiting for you')).toBeInTheDocument();
  });

  it('keeps the item and says why when the decision is refused', async () => {
    const { ds } = source([item('1')], async () => { throw new ApiProblem(403, 'This task is assigned to someone else'); });
    await mount(ds);
    await userEvent.click(await screen.findByRole('button', { name: 'Resolve' }));
    expect(await screen.findByText('This task is assigned to someone else')).toBeInTheDocument();
    expect(screen.getByText('Fix 1 (app-1)')).toBeInTheDocument();
  });

  it('shows an error with the request id when the inbox cannot load', async () => {
    const { ds } = source([]);
    await mount({ ...ds, inbox: async () => { throw new ApiProblem(500, 'The inbox is unavailable', 'req-9'); } });
    expect(await screen.findByText('The inbox is unavailable')).toBeInTheDocument();
    expect(screen.getByText(/req-9/)).toBeInTheDocument();
  });
});
