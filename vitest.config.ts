import { defineConfig } from 'vitest/config';

// Unit tests: src/**/*.spec.ts, with no database and no network.
export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['src/**/*.spec.ts'],
    setupFiles: ['./test/support/setup-env.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.spec.ts', 'src/main.ts', 'src/cli/**', 'src/**/migrations/**'],
      reporter: ['text-summary', 'lcov'],
    },
  },
});
