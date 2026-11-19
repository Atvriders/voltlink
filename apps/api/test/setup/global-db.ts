// apps/api/test/setup/global-db.ts — once per run (guide 08 §6): build the
// shared migration template the per-worker databases are cloned from.
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { TestProject } from 'vitest/node';
import { dropDatabases } from './drop-databases';

// R2-24: a per-run prefix so teardown drops only what THIS run created — never
// every voltlink_test_% database on the shared server. The default is unique
// per run (pid + random, computed once here in global setup and passed to the
// workers via provide), so `npm run test:int` and CI without VL_TEST_DB_PREFIX
// can never touch another run's databases. Postgres pool is capped for the
// shared machine.
const PREFIX =
  process.env.VL_TEST_DB_PREFIX ??
  `voltlink_test_${process.pid}_${randomBytes(8).toString('hex')}_`;
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
  const seed = new pg.Client({ connectionString: withDb(adminUrl, TEMPLATE) });
  await seed.connect();
  await seed.query(
    'INSERT INTO "AppSetting" (key, value, "updatedAt") VALUES ($1, $2, now()) ON CONFLICT (key) DO NOTHING',
    ['instance.registrationMode', 'invite'],
  );
  await seed.query(
    'INSERT INTO "AppSetting" (key, value, "updatedAt") VALUES ($1, $2, now()) ON CONFLICT (key) DO NOTHING',
    ['instance.bootstrappedAt', new Date().toISOString()],
  );
  // The instance must be bootstrapped (>= 1 user) or registration answers
  // SETUP_REQUIRED (403) even in open mode.
  await seed.query(
    `INSERT INTO "User" (id, email, name, "passwordHash", "webauthnUserId", "createdAt")
     VALUES ('test-bootstrap', 'test-bootstrap@voltlink.test', 'Bootstrap', '$argon2id$test', NULL, now())
     ON CONFLICT (id) DO NOTHING`,
  );
  await seed.end();
  project.provide('dbAdminUrl', adminUrl);
  project.provide('dbTemplate', TEMPLATE);
  project.provide('dbPrefix', PREFIX);
  return async () => {
    // R2-24: drop each database separately, retry 42501/55006 with a plain
    // DROP, carry on when one fails, print everything, and fail the run if
    // anything remains (process.exitCode as well as throwing).
    const c = new pg.Client({ connectionString: withDb(adminUrl, 'postgres') });
    await c.connect();
    try {
      await dropDatabases(c, PREFIX);
    } finally {
      await c.end();
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
