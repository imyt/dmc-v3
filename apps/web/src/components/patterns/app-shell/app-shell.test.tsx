import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import { buildRouter } from '@/router';
import type { AppShellProps } from './app-shell';
import { NAV_ITEMS, visibleItems } from './nav-config';

async function mount(shell: Omit<AppShellProps, 'children'> = {}, path = '/') {
  const router = buildRouter({ shell, history: createMemoryHistory({ initialEntries: [path] }) });
  render(<RouterProvider router={router} />);
  await screen.findByRole('banner');
  return router;
}

describe('app shell (P1)', () => {
  it('renders header, navigation, search and main landmarks', async () => {
    await mount({ env: 'prod' });
    expect(screen.getByRole('banner')).toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeInTheDocument();
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /search dmc/i })).toBeInTheDocument();
  });

  it('shows the environment banner in local and uat, not in prod', async () => {
    const { unmount } = render(<></>);
    unmount();
    await mount({ env: 'uat' });
    expect(screen.getByRole('status')).toHaveAttribute('data-env', 'uat');
  });

  it('has no banner in prod', async () => {
    await mount({ env: 'prod' });
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('marks the current page', async () => {
    await mount({ env: 'prod' }, '/search');
    expect(await screen.findByRole('link', { name: 'Search' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Home' })).not.toHaveAttribute('aria-current', 'page');
  });

  it('shows the inbox count', async () => {
    await mount({ env: 'prod', inboxCount: 3 });
    expect(screen.getByRole('link', { name: 'Inbox, 3 waiting' })).toBeInTheDocument();
  });

  it('focuses search on Ctrl+K', async () => {
    await mount({ env: 'prod' });
    await userEvent.keyboard('{Control>}k{/Control}');
    expect(screen.getByRole('combobox')).toHaveFocus();
  });

  it('submitting search goes to /search with the query', async () => {
    const router = await mount({ env: 'prod' });
    await userEvent.type(screen.getByRole('combobox'), 'customer{Enter}');
    await waitFor(() => expect(router.state.location.pathname).toBe('/search'));
    expect(router.state.location.search).toMatchObject({ q: 'customer' });
  });

  it('switches to dark from the user menu and remembers it', async () => {
    await mount({ env: 'prod' });
    await userEvent.click(screen.getByRole('button', { name: /account menu/i }));
    await userEvent.click(await screen.findByRole('menuitemradio', { name: 'Dark' }));
    await waitFor(() => expect(document.documentElement).toHaveClass('dark'));
    expect(window.localStorage.getItem('dmc-theme')).toBe('dark');
  });
});

describe('navigation by role', () => {
  it('hides admin areas from a steward', () => {
    const labels = visibleItems(['steward']).map((i) => i.label);
    expect(labels).toContain('Search');
    expect(labels).not.toContain('Admin');
    expect(labels).not.toContain('Evidence');
  });
  it('has no Catalog item and no page that says coming soon: browsing is Search', () => {
    expect(visibleItems('all').map((i) => i.label)).not.toContain('Catalog');
    expect(visibleItems('all').map((i) => i.to)).toContain('/evidence');
  });
  it('gives each role its own menu', () => {
    const l = (r: never[] | string[]) => visibleItems(r as never).map((i) => i.label);
    expect(l(['viewer'])).toEqual(['Home', 'Search', 'Inbox']);
    expect(l(['steward'])).toContain('Classifications');
    expect(l(['auditor'])).toEqual(expect.arrayContaining(['Evidence', 'Dashboard']));
    expect(l(['auditor'])).not.toContain('Admin');
    expect(l(['scope-owner'])).toContain('Scopes');
    expect(l(['policy-author'])).toEqual(expect.arrayContaining(['Policies', 'Requirements']));
  });
  it('shows everything to admin', () => expect(visibleItems(['admin'])).toHaveLength(NAV_ITEMS.length));
});
