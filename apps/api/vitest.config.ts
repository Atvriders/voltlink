import { resolve } from 'node:path';
import { config } from 'dotenv';
import { defineConfig } from 'vitest/config';

// `npm test` must work from a fresh shell: load apps/api/.env here (the
// integration tests need DATABASE_URL/REDIS_URL; TEST_DATABASE_ADMIN_URL
// defaults from DATABASE_URL via test/lib/admin-url.ts).
config({ path: resolve(__dirname, '.env') });

// API tests are integration-style: each file gets its own cloned Postgres
// database (test/setup/worker-db.ts) migrated from a shared template
// (test/setup/global-db.ts, guide 08 §6). The integration recipe exports
// TEST_DATABASE_ADMIN_URL (role with CREATEDB) and REDIS_URL; see
// verification/recipe2 for the verifiers' run procedure.
//
// Per-worker databases make parallel files safe: pool 'forks' with
// maxWorkers from the runner keeps fork teardown races (native-handle
// release after assertions) out of the equation, and teardownTimeout gives
// each file's afterAll() room to $disconnect() Prisma cleanly.
// (vitest 4 removed poolOptions; `forks + singleFork:true` is now expressed
// as `pool:'forks' + maxWorkers:1`.) Default isolation is kept deliberately
// — do NOT set isolate:false.
export default defineConfig({
  test: {
    pool: 'forks',
    // R2-24 (4b): cap the workers. Each worker opens Prisma
    // (connection_limit=5) plus the pg.Pool in src/core/db.ts (max 10;
    // node-postgres ignores connection_limit), so the previous default of 35
    // workers meant up to ~525 connections against max_connections=100 on a
    // server other projects share. Every run must stay under the cap.
    maxWorkers: Number(process.env.VL_TEST_MAX_WORKERS ?? 2),
    testTimeout: 30000,
    hookTimeout: 60000,
    teardownTimeout: 15000,
  },
});
