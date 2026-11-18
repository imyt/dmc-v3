import { defineConfig } from 'vitest/config';

// The web app has its own config (jsdom, path alias); run it with `pnpm run test:web`.
export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '.trash-nm/**', '.pnpm-store/**', 'apps/web/**'],
    // Many test files start their own embedded Postgres at once; the default 10 s setup limit is too tight on a busy machine.
    hookTimeout: 60_000,
    setupFiles: ['tests/support/windows-ebusy.ts'],
  },
});
