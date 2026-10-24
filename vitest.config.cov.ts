import { defineConfig } from 'vitest/config';

// One run over the unit and e2e suites, so the coverage report counts both
// (QA strategy 10). Integration tests need a database and run on their own.
export default defineConfig({
  test: {
    projects: ['./vitest.config.ts', './vitest.config.e2e.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.spec.ts', 'src/main.ts', 'src/cli/**', 'src/**/migrations/**'],
      reporter: ['text-summary', 'lcov'],
      // The floor the QA strategy sets (section 10), so a new module cannot
      // pull the total down unnoticed. Per-folder branch thresholds are added
      // as auth, fees, attendance and marks land: those business-rule
      // branches must be covered in full.
      thresholds: { statements: 80, lines: 80 },
    },
  },
});
