// apps/api/test/setup/worker-db.ts — before EVERY api-int test file (guide 08
// §6): clone the migrated template into a pristine per-worker database so
// files can run in parallel without cross-file state.
import { randomBytes } from 'node:crypto';
import { afterAll, inject } from 'vitest';
import pg from 'pg';

// R2-24: per-run prefix from the same env as global-db; teardown there drops
// only prefix% databases, so unrelated runs on the shared server are untouched.
const prefix = process.env.VL_TEST_DB_PREFIX ?? 'voltlink_test_';
const adminUrl = inject('dbAdminUrl');
const db = `${prefix}w${process.env.VITEST_POOL_ID ?? '1'}`;

/** FNV-1a over the prefix so concurrent runs with different prefixes never
 * serialise on the same advisory lock. */
const lockKey = (() => {
  let h = 0x811c9dc5;
  for (const ch of Buffer.from(prefix)) {
    h ^= ch;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
})();

const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();
await admin.query('SELECT pg_advisory_lock($1)', [lockKey]); // serialize template clones
// A fork that just exited can still hold a backend on this DB for a moment;
// FORCE-drops then fail with "permission denied to terminate process".
// Retry briefly instead of failing the whole file.
for (let attempt = 0; ; attempt++) {
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    break;
  } catch (err) {
    if (attempt >= 10) throw err;
    await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
  }
}
await admin.query(`CREATE DATABASE ${db} TEMPLATE ${inject('dbTemplate')}`);
await admin.query('SELECT pg_advisory_unlock($1)', [lockKey]);
await admin.end();

const url = new URL(adminUrl);
url.pathname = `/${db}`;
url.searchParams.set('connection_limit', '5');
process.env.DATABASE_URL = url.toString(); // before src/core/db.ts builds clients
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET ??= randomBytes(32).toString('hex');
process.env.VL_MASTER_KEY ??= randomBytes(32).toString('base64');
// Note: VL_OUTBOUND_ALLOW is deliberately NOT set here — the SSRF suite
// asserts that loopback is blocked when no owner allowlist exists.
// R2-24: per-fork queue prefix (recipe2 Appendix A model) so parallel workers
// never share BullMQ keys; the caller's prefix is used when it already sets one.
if (process.env.VL_QUEUE_PREFIX && !/w\d+$/.test(process.env.VL_QUEUE_PREFIX)) {
  process.env.VL_QUEUE_PREFIX = `${process.env.VL_QUEUE_PREFIX}w${process.env.VITEST_POOL_ID ?? '1'}`;
} else if (!process.env.VL_QUEUE_PREFIX) {
  process.env.VL_QUEUE_PREFIX = `vltest_w${process.env.VITEST_POOL_ID ?? '1'}`;
}
// R2-24: never rewrite the caller's Redis index; VL_REDIS_INDEX is opt-in.
if (process.env.VL_REDIS_INDEX && process.env.REDIS_URL) {
  process.env.REDIS_URL = `${process.env.REDIS_URL.replace(/\/\d+$/, '')}/${Number(process.env.VL_REDIS_INDEX)}`;
}

afterAll(async () => {
  const { prisma, pool } = await import('../../src/core/db');
  await prisma.$disconnect();
  await pool.end();
});
