/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import { configDefaults } from 'vitest/config';

export default defineConfig({
  base: './',
  worker: { format: 'es' },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  server: { host: true },
  // Subagent worktrees live under .claude/; their in-progress suites are not ours to run.
  // World generation in tests can take seconds on a loaded machine. Timing budgets live in
  // *.perf.test.ts and run alone, one file at a time: `npm run test:perf`.
  test: {
    exclude: [...configDefaults.exclude, '.claude/**', ...(process.env.PERF ? [] : ['**/*.perf.test.ts'])],
    testTimeout: 30000,
  },
});
