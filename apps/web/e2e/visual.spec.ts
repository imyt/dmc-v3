import { expect, test, type Page } from '@playwright/test';

const json = (body: unknown, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
const dark = async (page: Page) => { await page.emulateMedia({ colorScheme: 'dark' }); await page.evaluate(() => document.documentElement.classList.add('dark')); };

test('pattern gallery, light and dark', async ({ page }) => {
  await page.route('**/v1/auth/me', (r) => r.fulfill(json({ displayName: 'Amy Adams', staffID: '1', groups: [] })));
  await page.route('**/v1/inbox', (r) => r.fulfill(json({ items: [], count: 0 })));
  await page.goto('/gallery');
  await expect(page.getByRole('banner')).toBeVisible();
  await expect(page).toHaveScreenshot('gallery-light.png', { fullPage: true });
  await dark(page);
  await expect(page).toHaveScreenshot('gallery-dark.png', { fullPage: true });
});

test('login when there is no session', async ({ page }) => {
  await page.route('**/v1/auth/me', (r) => r.fulfill(json({ detail: 'Not signed in' }, 401)));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /Sign in/ })).toBeVisible();
  await expect(page).toHaveScreenshot('login.png');
});

test('lineage canvas keeps the viewport when a side is expanded', async ({ page }) => {
  await page.route('**/v1/auth/me', (r) => r.fulfill(json({ displayName: 'Amy Adams', staffID: '1', groups: [] })));
  await page.route('**/v1/inbox', (r) => r.fulfill(json({ items: [], count: 0 })));
  const walk = (qn: string, direction: string) => {
    const up = direction === 'upstream';
    const near = qn === 'mart.sales.total' ? (up ? ['stg.sales.amount', 'stg.sales.fx'] : []) : up ? ['raw.orders.amt'] : [];
    return { root: qn, direction, truncated: { depth: false, nodes: false }, nodes: [{ qualified_name: qn, type: 'Column', depth: 0, container: qn.split('.').slice(0, 2).join('.') }, ...near.map((n) => ({ qualified_name: n, type: 'Column', depth: 1, container: n.split('.').slice(0, 2).join('.') }))], edges: near.map((n) => ({ from: up ? n : qn, to: up ? qn : n, source: 'dbt', job: 'nightly' })) };
  };
  await page.route('**/v1/nodes/*/lineage*', (r) => { const u = new URL(r.request().url()); r.fulfill(json(walk(decodeURIComponent(u.pathname.split('/')[3]!), u.searchParams.get('direction') ?? 'upstream'))); });
  await page.goto('/lineage/mart.sales.total');
  await expect(page.locator('.react-flow__node')).toHaveCount(3);
  await page.waitForTimeout(500);
  await expect(page.getByRole('group', { name: /Lineage canvas/ })).toHaveScreenshot('lineage-focus.png');
  const before = await page.locator('.react-flow__viewport').getAttribute('style');
  await page.locator('.react-flow__node', { hasText: 'sales.amount' }).click();
  await page.getByRole('button', { name: 'Expand upstream' }).click();
  await expect(page.locator('.react-flow__node')).toHaveCount(4);
  expect(await page.locator('.react-flow__viewport').getAttribute('style')).toBe(before);
});

const signedIn = async (page: Page, roles: string[]) => {
  await page.route('**/v1/auth/me', (r) => r.fulfill(json({ displayName: 'Amy Adams', staffID: '1', groups: [], roles })));
  await page.route('**/v1/inbox', (r) => r.fulfill(json({ items: [], count: 0 })));
};

test('admin page with kill switch', async ({ page }) => {
  await signedIn(page, ['admin']);
  await page.route('**/v1/admin/status', (r) => r.fulfill(json({ version: '0.1.0', metamodel_version: '7', enforcement: 'running', policies: [{ id: 'integration-has-dataset', mode: 'enforced', paused: false }, { id: 'cross-border', mode: 'shadow', paused: true }] })));
  await page.goto('/admin');
  await expect(page.getByRole('heading', { name: 'Enforcement' })).toBeVisible();
  await expect(page).toHaveScreenshot('admin.png');
  await page.getByRole('button', { name: 'Pause all enforcement' }).click();
  await expect(page.getByRole('heading', { name: 'Pause all enforcement?' })).toBeVisible();
  await expect(page).toHaveScreenshot('admin-confirm.png');
});

test('classification proposals', async ({ page }) => {
  await signedIn(page, ['steward']);
  await page.route('**/v1/classifications/proposals', (r) => r.fulfill(json([{ id: 'p1', subject: 'dwh.customer.email', classification: 'Confidential', reason: 'Source column is Confidential', source: 'crm.customer.email', status: 'open' }])));
  await page.goto('/classifications');
  await expect(page.getByRole('button', { name: /Accept/ })).toBeVisible();
  await expect(page).toHaveScreenshot('classifications.png');
});

test('management dashboard', async ({ page }) => {
  await signedIn(page, ['auditor']);
  await page.route('**/v1/dashboard/measures', (r) => r.fulfill(json([{ id: 'a', label: 'Control requirements enforced', value: 75, target: 100 }, { id: 'b', label: 'Applications taken on', value: 12, target: 60 }])));
  await page.goto('/dashboard');
  await expect(page.getByText('Applications taken on')).toBeVisible();
  await expect(page).toHaveScreenshot('dashboard.png');
});
