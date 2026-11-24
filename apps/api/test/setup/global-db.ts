// apps/api/test/setup/global-db.ts — once per run (guide 08 §6): build the
// shared migration template the per-worker databases are cloned from.
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { dropDatabases, validatePrefix } from './drop-databases';

// R2-24: a per-run prefix so teardown drops only what THIS run created — never
// every voltlink_test_% database on the shared server. The default is unique
// per run (pid + random, computed once here in global setup and passed to the
// workers via provide), so `npm run test:int` and CI without VL_TEST_DB_PREFIX
// can never touch another run's databases. Postgres pool is capped for the
// shared machine.
const PREFIX =
  process.env.VL_TEST_DB_PREFIX ??
  `voltlink_test_${process.pid}_${randomBytes(8).toString('hex')}_`;
// R2-24 (4a): reject an unsafe VL_TEST_DB_PREFIX before any SQL — `??` keeps
// an explicit empty string, which would make the teardown's LIKE match '%'.
validatePrefix(PREFIX);
const TEMPLATE = `${PREFIX}template`;
const CONNECTION_LIMIT = '5';

const withDb = (url: string, db: string) => {
  const u = new URL(url);
  u.pathname = `/${db}`;
  u.searchParams.set('connection_limit', CONNECTION_LIMIT);
  return u.toString();
};

/** FNV-1a over the prefix so concurrent runs with different prefixes never
 * serialise on the same advisory lock. */
const prefixLockKey = (() => {
  let h = 0x811c9dc5;
  for (const ch of Buffer.from(PREFIX)) {
    h ^= ch;
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
})();

export default async function setup(project: TestProject) {
  const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
  if (!adminUrl) {
    throw new Error(
      'api-int needs TEST_DATABASE_ADMIN_URL (a postgres role with CREATEDB); it never falls back to DATABASE_URL',
    );
  }
  const admin = new pg.Client({ connectionString: withDb(adminUrl, 'postgres') });
  // R2-24 (4d): every failure below must print the prefix and set a non-zero
  // exit code — a plain throw can leak this run's databases under a prefix no
  // later run matches while still reporting success.
  console.log(`[test-db] prefix ${PREFIX}: global setup starting`);
  try {
    await admin.connect();
    await admin.query('SELECT pg_advisory_lock($1)', [prefixLockKey]);
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${TEMPLATE} WITH (FORCE)`);
      await admin.query(`CREATE DATABASE ${TEMPLATE}`);
    } finally {
      await admin.query('SELECT pg_advisory_unlock($1)', [prefixLockKey]);
    }
    await admin.end();
    execFileSync(
      'npx',
      [
        'prisma',
        'migrate',
        'deploy',
        '--schema',
        fileURLToPath(new URL('../../prisma/schema.prisma', import.meta.url)),
      ],
      { stdio: 'inherit', env: { ...process.env, DATABASE_URL: withDb(adminUrl, TEMPLATE) } },
    );
    // Open registration in the template so API tests can register over HTTP.
    // R2-24 (4g): the template is seeded through Prisma, never raw SQL.
    const { PrismaClient } = await import('@prisma/client');
    const templatePrisma = new PrismaClient({
      datasources: { db: { url: withDb(adminUrl, TEMPLATE) } },
    });
    try {
      await templatePrisma.appSetting.upsert({
        where: { key: 'instance.registrationMode' },
        update: {},
        create: { key: 'instance.registrationMode', value: 'invite' },
      });
      await templatePrisma.appSetting.upsert({
        where: { key: 'instance.bootstrappedAt' },
        update: {},
        create: {
          key: 'instance.bootstrappedAt',
          value: new Date().toISOString(),
        },
      });
      // The instance must be bootstrapped (>= 1 user) or registration answers
      // SETUP_REQUIRED (403) even in open mode.
      await templatePrisma.user.upsert({
        where: { id: 'test-bootstrap' },
        update: {},
        create: {
          id: 'test-bootstrap',
          email: 'test-bootstrap@voltlink.test',
          name: 'Bootstrap',
          passwordHash: '$argon2id$test',
          webauthnUserId: null,
        },
      });
    } finally {
      await templatePrisma.$disconnect();
    }
  } catch (err) {
    console.error(`[test-db] prefix ${PREFIX}: setup failed: ${String(err)}`);
    process.exitCode = 1;
    throw err;
  }
  project.provide('dbAdminUrl', adminUrl);
  project.provide('dbTemplate', TEMPLATE);
  project.provide('dbPrefix', PREFIX);
  return async () => {
    // R2-24: drop each database separately, retry 42501/55006 with a plain
    // DROP, carry on when one fails, print everything, and fail the run if
    // anything remains (process.exitCode as well as throwing).
    const c = new pg.Client({ connectionString: withDb(adminUrl, 'postgres') });
    try {
      await c.connect();
      await dropDatabases(c, PREFIX);
    } catch (err) {
      console.error(`[test-db] prefix ${PREFIX}: teardown failed: ${String(err)}`);
      process.exitCode = 1;
      throw err;
    } finally {
      await c.end().catch(() => {});
    }
  };
}

declare module 'vitest' {
  export interface ProvidedContext {
    dbAdminUrl: string;
    dbTemplate: string;
    dbPrefix: string;
  }
}
