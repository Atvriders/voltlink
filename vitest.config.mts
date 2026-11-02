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
      thresholds: { lines: 30, statements: 30, functions: 28, branches: 25 },
    },
  },
});
