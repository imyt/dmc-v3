import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import axe from 'axe-core';
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import { screen } from '@testing-library/react';
import { buildRouter } from '@/router';

async function violations(el: Element) {
  // colour contrast needs real layout, so it is checked in the browser visual run, not jsdom
  const r = await axe.run(el, { rules: { 'color-contrast': { enabled: false } } });
  return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

describe('pattern gallery', () => {
  for (const theme of ['light', 'dark'] as const) {
    it(`has no axe violations (${theme})`, async () => {
      document.documentElement.classList.toggle('dark', theme === 'dark');
      const router = buildRouter({ shell: { env: 'local' }, history: createMemoryHistory({ initialEntries: ['/gallery'] }) });
      const { container } = render(<RouterProvider router={router} />);
      await screen.findByRole('heading', { name: 'Pattern gallery' });
      expect(await violations(container)).toEqual([]);
    });
  }

  it('shows every pattern section', async () => {
    const router = buildRouter({ shell: { env: 'prod' }, history: createMemoryHistory({ initialEntries: ['/gallery'] }) });
    const { container } = render(<RouterProvider router={router} />);
    await screen.findByRole('heading', { name: 'Pattern gallery' });
    const ids = [...container.querySelectorAll('[data-pattern]')].map((e) => e.getAttribute('data-pattern'));
    expect(ids).toEqual(['p10', 'p6', 'p20', 'p11', 'p12', 'p18', 'p3', 'p4', 'p9', 'p16', 'p19', 'p23', 'p5', 'p7', 'p8', 'p13', 'p14', 'p15', 'p22', 'p24']);
  });
});
