import { defineConfig } from 'vitest/config';

// HTTP tests through the full Nest stack: test/e2e/**/*.e2e-spec.ts.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['test/e2e/**/*.e2e-spec.ts'],
    setupFiles: ['./test/support/setup-env.ts'],
  },
});
