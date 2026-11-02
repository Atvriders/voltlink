// apps/api/test/setup/global-db.ts — once per run (guide 08 §6): build the
// shared migration template the per-worker databases are cloned from.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { TestProject } from 'vitest/node';

const TEMPLATE = 'voltlink_test_template';

const withDb = (url: string, db: string) => {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
};

export default async function setup(project: TestProject) {
  const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
  if (!adminUrl) {
    throw new Error(
      'api-int needs TEST_DATABASE_ADMIN_URL (a postgres role with CREATEDB); it never falls back to DATABASE_URL',
    );
  }
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEMPLATE} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${TEMPLATE}`);
  await admin.end();
  execFileSync(
    'npx',
    ['prisma', 'migrate', 'deploy', '--schema', fileURLToPath(new URL('../../prisma/schema.prisma', import.meta.url))],
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
  return async () => {
    const c = new pg.Client({ connectionString: adminUrl });
    await c.connect();
    const { rows } = await c.query<{ datname: string }>(
      `SELECT datname FROM pg_database WHERE datname LIKE 'voltlink\\_test\\_%'`,
    );
    for (const r of rows) await c.query(`DROP DATABASE IF EXISTS "${r.datname}" WITH (FORCE)`);
    await c.end();
  };
}

declare module 'vitest' {
  export interface ProvidedContext {
    dbAdminUrl: string;
    dbTemplate: string;
  }
}
