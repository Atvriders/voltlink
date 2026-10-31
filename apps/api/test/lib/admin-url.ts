// Test-only helper: resolve the PostgreSQL "admin" connection used to create
// and drop throwaway test databases (migration tests need a role with
// CREATEDB). Prefers the explicit TEST_DATABASE_ADMIN_URL; otherwise it
// derives one from DATABASE_URL by pointing at the `postgres` maintenance
// database on the same server, so `npm test` works in a fresh shell.

export function adminDatabaseUrl(): string {
  const explicit = process.env.TEST_DATABASE_ADMIN_URL;
  if (explicit) return explicit;
  const db = process.env.DATABASE_URL;
  if (!db) {
    throw new Error(
      'TEST_DATABASE_ADMIN_URL (or DATABASE_URL to derive it from) is required: ' +
        'a postgres role with CREATEDB, e.g. postgresql://voltlink:pw@127.0.0.1:5433/postgres',
    );
  }
  try {
    const u = new URL(db);
    if (!['postgresql:', 'postgres:'].includes(u.protocol)) {
      throw new Error('DATABASE_URL is not a PostgreSQL URL');
    }
    u.pathname = '/postgres';
    u.search = '';
    u.hash = '';
    return u.toString();
  } catch (err) {
    throw new Error(
      `Could not derive TEST_DATABASE_ADMIN_URL from DATABASE_URL (${err instanceof Error ? err.message : 'invalid URL'}). ` +
        'Set TEST_DATABASE_ADMIN_URL to a postgres role with CREATEDB, e.g. postgresql://voltlink:pw@127.0.0.1:5433/postgres',
      { cause: err },
    );
  }
}
