// apps/api/test/setup/worker-db.ts — before EVERY api-int test file (guide 08
// §6): clone the migrated template into a pristine per-worker database so
// files can run in parallel without cross-file state.
import { randomBytes } from 'node:crypto';
import { afterAll, inject } from 'vitest';
import pg from 'pg';

const adminUrl = inject('dbAdminUrl');
const db = `voltlink_test_w${process.env.VITEST_POOL_ID ?? '1'}`;
const admin = new pg.Client({ connectionString: adminUrl });
await admin.connect();
await admin.query('SELECT pg_advisory_lock(73470815)'); // serialize template clones
await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
await admin.query(`CREATE DATABASE ${db} TEMPLATE ${inject('dbTemplate')}`);
await admin.query('SELECT pg_advisory_unlock(73470815)');
await admin.end();

const url = new URL(adminUrl);
url.pathname = `/${db}`;
process.env.DATABASE_URL = url.toString(); // before src/core/db.ts builds clients
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET ??= randomBytes(32).toString('hex');
process.env.VL_MASTER_KEY ??= randomBytes(32).toString('base64');
// Note: VL_OUTBOUND_ALLOW is deliberately NOT set here — the SSRF suite
// asserts that loopback is blocked when no owner allowlist exists.
if (process.env.REDIS_URL) {
  process.env.REDIS_URL = `${process.env.REDIS_URL.replace(/\/\d+$/, '')}/${Number(process.env.VITEST_POOL_ID ?? 1) % 16}`;
}

afterAll(async () => {
  const { prisma, pool } = await import('../../src/core/db');
  await prisma.$disconnect();
  await pool.end();
});
