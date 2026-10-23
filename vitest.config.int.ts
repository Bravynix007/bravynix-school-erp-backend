import { defineConfig } from 'vitest/config';

// Integration tests against a real PostgreSQL 16 (test/integration).
// Needs TEST_DATABASE_MIGRATION_URL and TEST_DATABASE_URL (docker compose or
// the CI service). Files run one at a time because they share one database.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['test/integration/**/*.int-spec.ts'],
    setupFiles: ['./test/support/setup-env.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
