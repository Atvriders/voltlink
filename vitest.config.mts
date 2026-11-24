// vitest.config.mts — root configuration (guide 08 §5). Projects, strict tags
// and coverage. C-TESTCOUNT: include globs never scan compiled dist output.
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const abs = (p: string) => fileURLToPath(new URL(p, import.meta.url));

const TAGS = [
  'unit',
  'api',
  'db',
  'provider-adapter',
  'telemetry',
  'command-validation',
  'authz',
  'authn',
  'session-revocation',
  'automation',
  'notification',
  'rate-limit',
  'encryption',
  'retention',
  'realtime',
  'status-page',
  'incident',
  'worker',
  'scheduler',
  'migration',
  'queue',
  'component',
  'legacy-content',
  'security',
  'observability',
] as const;

export default defineConfig({
  test: {
    tags: TAGS.map((name) => ({ name })),
    projects: [
      {
        test: {
          name: 'shared',
          root: abs('./packages/shared'),
          include: ['src/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        extends: abs('./apps/api/vitest.config.ts'),
        test: {
          name: 'api-unit',
          root: abs('./apps/api'),
          include: ['test/unit/**/*.test.ts', 'src/**/*.test.ts'],
        },
      },
      {
        extends: abs('./apps/api/vitest.config.ts'),
        test: {
          name: 'api-int',
          root: abs('./apps/api'),
          include: ['test/**/*.test.ts'],
          globalSetup: ['./test/setup/global-db.ts'],
          setupFiles: ['./test/setup/worker-db.ts'],
          // R2-24 (4b): cap the workers on the integration project only.
          // Each worker opens Prisma (connection_limit=5) plus the pg.Pool
          // in src/core/db.ts (max 10; node-postgres ignores
          // connection_limit), so the previous default of 35 workers meant
          // up to ~525 connections against max_connections=100 on a server
          // other projects share. Own sequence group so the cap never
          // collides with the other projects in CI's combined command.
          maxWorkers: Number(process.env.VL_TEST_MAX_WORKERS ?? 2),
          sequence: { groupOrder: 1 },
        },
      },
      {
        extends: abs('./apps/web/vite.config.ts'),
        test: {
          name: 'web',
          root: abs('./apps/web'),
          include: ['src/**/*.test.{ts,tsx}'],
        },
      },
      {
        test: {
          name: 'e2e-helpers',
          root: abs('./tests/e2e'),
          include: ['**/*.test.ts'],
          environment: 'node',
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: [
        'packages/shared/src/**/*.ts',
        'apps/api/src/**/*.ts',
        'apps/web/src/**/*.{ts,tsx}',
      ],
      exclude: ['**/*.test.*', '**/*.d.ts', 'apps/web/src/main.tsx', 'apps/api/src/cli/**'],
      reporter: ['text-summary', 'json-summary', 'lcov', 'html'],
      // Guide 08 §5 (restored from the weakened 30/30/28/25): global 75/75/75/
      // 65, auth + commands at 90/85, and the access resolver at 95/90.
      thresholds: {
        lines: 75,
        statements: 75,
        functions: 75,
        branches: 65,
        '**/auth/**/*.ts': { lines: 90, statements: 90, functions: 85, branches: 85 },
        // TI-56: the web auth module is a .tsx file, so the glob above never
        // applied to AuthContext.tsx (login()/loginMfa() were never executed).
        '**/auth/**/*.tsx': { lines: 90, statements: 90, functions: 85, branches: 85 },
        '**/commands/**/*.ts': { lines: 90, statements: 90, functions: 85, branches: 85 },
        '**/authz/access.ts': { lines: 95, statements: 95, functions: 90, branches: 90 },
      },
    },
  },
});
