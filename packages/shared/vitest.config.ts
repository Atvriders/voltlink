import { defineConfig } from 'vitest/config';

// Only the TypeScript sources are tests. The compiled dist/ (including
// dist/roles.test.js) must never run — otherwise the counts in CI double and
// a stale build can mask a failing source test (C-TESTCOUNT).
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
