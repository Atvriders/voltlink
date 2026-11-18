// apps/api/test/setup/global-db.ts — once per run (guide 08 §6): build the
// shared migration template the per-worker databases are cloned from.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { TestProject } from 'vitest/node';

// R2-24: a per-run prefix (safe default voltlink_test_) so teardown drops only
// what this run created — never every voltlink_test_% database on the shared
// server. Postgres connection pool is capped for the shared machine.
const PREFIX = process.env.VL_TEST_DB_PREFIX ?? 'voltlink_test_';
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
    const c = new pg.Client({ connectionString: withDb(adminUrl, 'postgres') });
    await c.connect();
    // Escape LIKE wildcards so the prefix is matched literally.
    const like = PREFIX.replace(/[\\_%]/g, (ch) => `\\${ch}`) + '%';
    const { rows } = await c.query<{ datname: string }>(
      `SELECT datname FROM pg_database WHERE datname LIKE '${like}'`,
    );
    for (const r of rows) await c.query(`DROP DATABASE IF EXISTS "${r.datname}" WITH (FORCE)`);
    await c.end();
  };
}

declare module 'vitest' {
  export interface ProvidedContext {
    dbAdminUrl: string;
    dbTemplate: string;
    dbPrefix: string;
  }
}
