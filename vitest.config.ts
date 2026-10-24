import { defineConfig } from 'vitest/config';

// Unit tests: src/**/*.spec.ts, with no database and no network.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    name: 'unit',
    globals: true,
    root: './',
    include: ['src/**/*.spec.ts'],
    setupFiles: ['./test/support/setup-env.ts'],
    // Coverage is measured over the unit and e2e suites together: see
    // vitest.config.cov.ts, which `npm run test:cov` uses.
  },
});
