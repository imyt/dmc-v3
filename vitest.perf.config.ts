import { defineConfig } from 'vitest/config';

// Load and performance checks (implementation plan, "Testing and verification": Load). Slow, so not part of
// `pnpm run ci`; run with `pnpm run perf`. Each file starts its own embedded Postgres on ports 54560-54564.
export default defineConfig({
  test: {
    include: ['tests/perf/**/*.perf.ts'],
    hookTimeout: 300_000,
    testTimeout: 900_000,
    fileParallelism: false, // one server at a time: timings are only meaningful on an otherwise idle machine
    setupFiles: ['tests/support/windows-ebusy.ts'],
  },
});
