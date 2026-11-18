import { defineConfig } from '@playwright/test';

/** Visual tests (DESIGN.md §10). Not part of `pnpm run ci`, which has no browser; run with `pnpm run test:visual` after `pnpm exec playwright install chromium`. */
export default defineConfig({
  testDir: './e2e',
  snapshotPathTemplate: '{testDir}/__screenshots__/{testFilePath}/{arg}{ext}',
  use: { baseURL: 'http://localhost:5199', viewport: { width: 1280, height: 800 } },
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.01, animations: 'disabled' } },
  webServer: { command: 'pnpm exec vite --port 5199 --strictPort', url: 'http://localhost:5199', reuseExistingServer: true, timeout: 60_000 },
});
