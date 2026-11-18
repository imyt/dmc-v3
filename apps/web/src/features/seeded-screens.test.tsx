import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import { buildRouter } from '@/router';
import { ApiProblem, type DataSource } from '@/lib/data';
import { ADMIN, BEN, SNAP, apiFake, type FakeOptions } from '@/test/api-fake';

/**
 * Every screen against what the real API returns for the local seed (see test/api-fake.ts), not against hand-made stand-ins.
 * Each of these failed on the app the owner was unhappy with: the scope list asked search for an empty word (422), the column and person pages
 * crashed on a field with no sync time, the lineage canvas drew its links backwards, and Home was one line.
 */
const mount = async (path: string, o: FakeOptions = {}, data: DataSource = apiFake(o)) => {
  const roles = (o.user ?? ADMIN).roles;
  render(<RouterProvider router={buildRouter({ data, shell: { roles: (roles ?? 'all') as never }, history: createMemoryHistory({ initialEntries: [path] }) })} />);
  await screen.findByRole('banner');
  return data;
};
const enc = encodeURIComponent;
const main = () => screen.getByRole('main');
/** the app must never show the error panel on a screen the seed can fill */
const noError = () => expect(screen.queryByText('Something went wrong')).toBeNull();

describe('the fake answers like the API', () => {
  it('refuses a search without a word, and an unknown object', async () => {
    const d = apiFake();
    await expect(d.search('')).rejects.toMatchObject({ status: 422 });
    await expect(d.node('nope')).rejects.toBeInstanceOf(ApiProblem);
  });
});

describe('Home: what needs me, where do I go', () => {
  it('an application owner sees the inbox count, the top items and their own screens', async () => {
    await mount('/', { user: BEN });
    expect(await screen.findByText(/items are waiting for you/)).toBeInTheDocument();
    expect(within(main()).getAllByText('Link your tables and columns to this scope').length).toBe(2);
    expect(within(main()).getByRole('link', { name: /Scopes/ })).toBeInTheDocument();
    expect(within(main()).queryByRole('link', { name: /Admin/ })).toBeNull();
    expect(within(main()).getByRole('link', { name: /help page for application owners/ })).toBeInTheDocument();
  });
  it('an administrator with an empty inbox is told what DMC is doing, and gets every screen', async () => {
    await mount('/');
    expect(await screen.findByText('Nothing needs your attention right now')).toBeInTheDocument();
    for (const name of [/Scopes/, /Dashboard/, /Admin/, /Classifications/]) expect(within(main()).getByRole('link', { name })).toBeInTheDocument();
  });
});

describe('C6 scopes', () => {
  it('lists every seeded scope with owner, status and tier (the list used to ask search for an empty word)', async () => {
    await mount('/scopes');
    const grid = await screen.findByRole('grid', { name: 'Scopes' });
    noError();
    for (const n of ['PRA110', 'BCBS 239 exposure report', 'Customer onboarding', 'Legacy loan reporting']) expect(within(grid).getByRole('link', { name: n })).toBeInTheDocument();
    expect(within(grid).getByText('Submitted and locked')).toBeInTheDocument();
  });
  it('flags a scope whose owner has left the organisation', async () => {
    await mount('/scopes');
    const grid = await screen.findByRole('grid', { name: 'Scopes' });
    await waitFor(() => expect(within(grid).getByText('Owner has left')).toBeInTheDocument());
    expect(within(grid).getAllByText('Owner has left').length).toBe(1);
    expect(within(grid).getByText('Rae Retired (43000098)')).toBeInTheDocument();
  });
  it('opens a scope: groups, elements with links, flows, completeness and the applications on the flows', async () => {
    await mount('/scopes/scope-pra110');
    expect(await screen.findByRole('heading', { name: 'Core' })).toBeInTheDocument();
    noError();
    expect(screen.getByText(/git.risk-engine\/exposure\/positions\/exposure_at_default \(app-risk-engine, confirmed\)/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'int-ledger-to-risk' })).toBeInTheDocument();
    expect(screen.getByText(/50% \(1 of 2\)/)).toBeInTheDocument();
    expect(screen.getByLabelText('Trust tier this scope has to reach')).toHaveValue('gold');
    const apps = screen.getByRole('grid', { name: 'Applications' });
    expect(within(apps).getByText('Risk Engine')).toBeInTheDocument();
    await waitFor(() => expect(within(apps).getAllByText('Ben Brooks (43000002)').length).toBeGreaterThan(0));
  });
  it('a draft scope owned by someone who has left says so next to the owner', async () => {
    await mount('/scopes/scope-legacy-loans');
    expect(await screen.findByText('Owner has left')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Submit scope' })).toBeInTheDocument();
  });
  it('the column picker lists the columns of the catalog (it used to search for an empty word)', async () => {
    await mount('/scopes/scope-pra110', { user: BEN });
    await userEvent.click(await screen.findByRole('button', { name: /Link columns/ }));
    expect(await screen.findByRole('checkbox', { name: /positions\/exposure_at_default/ })).toBeInTheDocument();
    noError();
  });
  it('the flows picker lists the integrations of the catalog', async () => {
    await mount('/scopes/scope-legacy-loans');
    await userEvent.click(await screen.findByRole('button', { name: 'Edit integrations' }));
    expect(await screen.findByRole('checkbox', { name: /int-ledger-to-lake/ })).toBeInTheDocument();
    noError();
  });
});

describe('C6 datasets', () => {
  it('shows the datasets of an integration and who looks after the applications at its ends', async () => {
    await mount('/integrations/int-payments-to-ledger/datasets');
    expect(await screen.findByText('Payment postings')).toBeInTheDocument();
    noError();
    const apps = await screen.findByRole('grid', { name: 'Applications' });
    await waitFor(() => expect(within(apps).getByText('Amy Adams (43000001)')).toBeInTheDocument());
    expect(within(apps).getByText('Dan Davies (43000003)')).toBeInTheDocument();
    expect(within(apps).getByText('Ben Brooks (43000002)')).toBeInTheDocument();
  });
  it('flags an owner and a delegate who have left', async () => {
    await mount('/integrations/int-payments-to-ledger/datasets', { people: { '43000001': { lifecycle: 'deprecated' }, '43000003': { lifecycle: 'deprecated' } } });
    expect(await screen.findByText('Owner has left')).toBeInTheDocument();
    expect(screen.getByText('Delegate has left')).toBeInTheDocument();
  });
});

describe('U5 dashboard', () => {
  const PRD = ['Applications taken on', 'Priority returns with scopes submitted', 'Elements of submitted scopes with confirmed column links', 'Cross-border integrations with a current assessment',
    'Decisions made without a person', 'Exception age, median', 'Exception age, 95th percentile', 'Assets of submitted scopes at their required trust tier', 'Evidence checks passing'];
  it('shows every PRD success measure with its target, and the Collibra date', async () => {
    await mount('/dashboard');
    for (const label of PRD) {
      const panel = (await screen.findByRole('heading', { name: label })).closest('section')!;
      expect(panel).toHaveTextContent(/Target \d+/);
    }
    expect(screen.getByText(/March 2028 licence renewal/)).toBeInTheDocument();
    noError();
  });
  it('writes units in words, and judges ageing measures the other way round', async () => {
    await mount('/dashboard');
    const median = (await screen.findByRole('heading', { name: 'Exception age, median' })).closest('section')!;
    expect(median).toHaveTextContent('0 days');
    expect(median).toHaveTextContent('Target 15 days met');
    expect(screen.getByRole('heading', { name: 'Applications taken on' }).closest('section')).toHaveTextContent('0%Target 10% not met');
    expect(main()).not.toHaveTextContent(/\dpercent/);
  });
  it('shows the counts without a target in their own table', async () => {
    await mount('/dashboard');
    const t = (await screen.findByRole('heading', { name: 'Also tracked' })).closest('section')!;
    expect(within(t).getByText('Assets graded unverified')).toBeInTheDocument();
  });
  it('says so, with the request id, when the API fails', async () => {
    await mount('/dashboard', { over: { dashboardMeasures: async () => { throw new ApiProblem(500, 'The ledger could not be read', 'req-9'); } } });
    expect(await screen.findByText('The ledger could not be read')).toBeInTheDocument();
    expect(screen.getByText('req-9')).toBeInTheDocument();
  });
});

describe('U1 object page: any type, no type-specific code', () => {
  const types = [...new Set(Object.values(SNAP.nodes).map((n) => n.type))];
  it.each(types)('renders a %s from the seed: heading, every attribute the metamodel declares, relationships, activity', async (type) => {
    const n = Object.values(SNAP.nodes).find((x) => x.type === type)!;
    await mount(`/o/${enc(n.qualified_name)}`);
    expect(await screen.findByRole('heading', { level: 1 })).toBeInTheDocument();
    noError();
    for (const id of Object.keys(n.attribute_sources)) expect(main()).toHaveTextContent(new RegExp(id.replace(/_/g, ' '), 'i'));
    await userEvent.click(screen.getByRole('tab', { name: 'Relationships' }));
    await userEvent.click(screen.getByRole('tab', { name: 'Activity' }));
    noError();
  });
  it('a synced field the source has not filled in yet says so instead of crashing the page (Column, Person)', async () => {
    await mount(`/o/${enc('git.risk-engine/exposure/positions/exposure_at_default')}`);
    expect((await screen.findAllByText('Not synced yet')).length).toBeGreaterThan(0);
  });
  it('relationships say what and which type is at the other end', async () => {
    await mount(`/o/${enc('git.risk-engine/exposure/positions/exposure_at_default')}`);
    await userEvent.click(await screen.findByRole('tab', { name: 'Relationships' }));
    const sec = await screen.findByRole('region', { name: 'Represents' });
    await waitFor(() => expect(within(sec).getByRole('link', { name: 'Exposure at default' })).toBeInTheDocument());
    expect(within(sec).getByText('Business term')).toBeInTheDocument();
  });
  it('an application shows its owner and delegates by name, and flags each who has left', async () => {
    await mount('/o/app-payments-hub', { people: { '43000001': { lifecycle: 'deprecated' }, '43000003': { lifecycle: 'deprecated' } } });
    await screen.findByRole('heading', { name: 'Payments Hub', level: 1 });
    await waitFor(() => expect(screen.getAllByText('Owner has left').length).toBeGreaterThan(0));
    expect(screen.getByText('Delegate has left')).toBeInTheDocument();
    expect(main()).toHaveTextContent('Dan Davies (43000003)');
  });
  it('nobody is flagged while everyone is still here', async () => {
    await mount('/o/app-payments-hub');
    await waitFor(() => expect(main()).toHaveTextContent(/Amy Adams \(43000001\)/));
    expect(screen.queryByText(/has left/)).toBeNull();
  });
  it('a scope owner who has left is flagged on the scope object page', async () => {
    await mount('/o/scope-legacy-loans');
    expect((await screen.findAllByText('Owner has left')).length).toBeGreaterThan(0);
  });
  it('the person who left is a deprecated Person record, and is not flagged as their own owner', async () => {
    await mount('/o/43000098');
    expect(await screen.findByRole('heading', { name: 'Rae Retired', level: 1 })).toBeInTheDocument();
    expect(screen.queryByText(/Staff id has left/)).toBeNull();
  });
});

describe('L5 lineage', () => {
  // the canvas needs these in jsdom; the table view and the numbers do not
  beforeAll(() => { vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }); vi.stubGlobal('DOMMatrixReadOnly', class { m22 = 1; }); });
  afterAll(() => { vi.unstubAllGlobals(); });
  const col = 'git.risk-engine/exposure/positions/exposure_at_default';
  it('reads upstream to downstream: what the column is built from comes first, and both sides are known (not "no links loaded")', async () => {
    await mount(`/lineage/${enc(col)}`);
    await userEvent.click(await screen.findByRole('button', { name: 'Table view' }));
    const grid = await screen.findByRole('grid', { name: 'Lineage links' });
    const rows = within(grid).getAllByRole('row').slice(1).map((r) => r.textContent ?? '');
    expect(rows[0]).toContain('git.core-banking/ledger/accounts/closing_balance');
    expect(rows[0]!.indexOf('closing_balance')).toBeLessThan(rows[0]!.indexOf('exposure_at_default'));
    expect(rows[1]!.indexOf('exposure_at_default')).toBeLessThan(rows[1]!.indexOf('pra110_lines/amount'));
    expect(screen.getByText(/3 columns, 2 links/)).toBeInTheDocument();
    expect(screen.queryByText(/No links loaded/)).toBeNull();
  });
  it('rolls up to the tables', async () => {
    await mount(`/lineage/${enc(col)}`);
    await userEvent.click(await screen.findByRole('button', { name: 'Show tables' }));
    expect(await screen.findByText(/\d tables, \d links/)).toHaveTextContent('3 tables, 2 links');
  });
});

describe('the other screens against the seed', () => {
  it('search finds seeded objects and never calls the API with an empty word', async () => {
    await mount('/search?q=balance');
    expect(await screen.findByRole('link', { name: 'Closing balance' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Account balance' })).toBeInTheDocument();
    noError();
  });
  it('search with no word asks for one instead of failing', async () => {
    await mount('/search');
    expect(await screen.findByText('Type a term in the search box above.')).toBeInTheDocument();
    noError();
  });
  it('requirements lists the seeded requirements with their coverage', async () => {
    await mount('/requirements');
    expect(await screen.findByText('Every application has an owner')).toBeInTheDocument();
    noError();
  });
  it('the inbox lists the application owner’s link tasks with their decisions', async () => {
    await mount('/inbox', { user: BEN });
    expect((await screen.findAllByText('Link your tables and columns to this scope')).length).toBe(2);
    expect(screen.getAllByRole('button', { name: 'Done' }).length).toBe(2);
  });
  it('classifications says nothing is waiting when nothing is', async () => {
    await mount('/classifications');
    expect(await screen.findByText('No proposals waiting')).toBeInTheDocument();
  });
});
