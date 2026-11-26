// apps/api/test/setup/worker-db.ts — before EVERY api-int test file (guide 08
// §6): clone the migrated template into a pristine per-worker database so
// files can run in parallel without cross-file state.
import { randomBytes } from 'node:crypto';
import { afterAll, inject } from 'vitest';
import pg from 'pg';
import { dropOne } from './drop-databases';

// R2-24: the per-run prefix is created once in global-db setup (unique default
// pid+random) and injected here; teardown drops only prefix% databases, so a
// run without VL_TEST_DB_PREFIX still never touches another run's databases.
const prefix = inject('dbPrefix');
const adminUrl = inject('dbAdminUrl');
// R2-24 / CI fix: the database is named per FILE (pool slot + random), never
// per pool slot alone. In CI the two api-int slots both report the same
// VITEST_POOL_ID, so a slot-only name made two files share one database — the
// next file's setup FORCE-dropped it while the other file was still running
// ('database … does not exist' cascades, 820 authz failures). A random suffix
// makes every file's database unique; the shared prefix keeps the global
// teardown able to drop the whole run.
const db = `${prefix}w${process.env.VITEST_POOL_ID ?? '1'}_${randomBytes(3).toString('hex')}`;

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
// R2-24 (4f): route through the shared drop loop (FORCE, then plain-DROP
// retries for 42501/55006) instead of FORCE-only retries.
if (!(await dropOne(admin, db))) {
  throw new Error(`could not drop previous worker database "${db}"`);
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
  // Drop this file's own database (unique per file since the CI fix) so the
  // catalog and connection count stay small during long combined runs.
  const admin = new pg.Client({ connectionString: adminUrl });
  try {
    await admin.connect();
    await dropOne(admin, db);
  } catch {
    // The global teardown still drops every prefix% database — a failed
    // best-effort drop here must never fail the file.
  } finally {
    await admin.end().catch(() => undefined);
  }
});
