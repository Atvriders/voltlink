// apps/api/test/setup/drop-databases.ts — R2-24 teardown drop loop.
// Drops every database of one run's unique prefix, one at a time. A fresh
// template can have an autovacuum worker that rejects DROP ... WITH (FORCE)
// with 42501 (non-superuser cannot terminate it); plain DROP DATABASE makes
// that worker exit, so 42501/55006 drops are retried without FORCE for a
// bounded window. If anything is left afterwards, the names are printed and
// the process exit code is set non-zero (a throw alone exits 0 from teardown).

export interface DbAdmin {
  query: (sql: string, params?: unknown[]) => Promise<{ rows?: { datname: string }[] }>;
}

export interface DropOptions {
  retryMs?: number;
  pollMs?: number;
}

const RETRYABLE = new Set(['42501', '55006']);

// R2-24 (4a): before ANY SQL, reject a prefix that would widen the teardown's
// LIKE to other databases on the shared server. `??` keeps an explicit empty
// string, so VL_TEST_DB_PREFIX='' would match LIKE '%' (every database), and
// the bare 'voltlink_test_' would drop every other run's databases too.
const PREFIX_PATTERN = /^voltlink_test_[a-z0-9_]+_$/;

export function validatePrefix(prefix: string): void {
  if (!PREFIX_PATTERN.test(prefix)) {
    throw new Error(
      `VL_TEST_DB_PREFIX must match ${PREFIX_PATTERN} (a safe per-run prefix); got ${JSON.stringify(prefix)}`,
    );
  }
}

const escapeLike = (prefix: string) => prefix.replace(/[\\_%]/g, (ch) => `\\${ch}`);

/** Drop one database with the shared retry policy: FORCE first, then plain
 * DROP for 42501/55006 (autovacuum/session-termination blockers) until the
 * window closes. Returns false when the database could not be dropped;
 * callers that must not leak throw on false. */
export async function dropOne(
  admin: DbAdmin,
  name: string,
  opts: DropOptions = {},
): Promise<boolean> {
  const retryMs = opts.retryMs ?? 30_000;
  const pollMs = opts.pollMs ?? 2_000;
  const force = `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`;
  const plain = `DROP DATABASE IF EXISTS "${name}"`;
  try {
    await admin.query(force);
    return true;
  } catch (err) {
    const code = (err as { code?: string }).code ?? '';
    if (!RETRYABLE.has(code)) return false;
    // Retry with plain DROP until the window closes.
    const deadline = Date.now() + retryMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, pollMs));
      try {
        await admin.query(plain);
        return true;
      } catch (err2) {
        const code2 = (err2 as { code?: string }).code ?? '';
        if (!RETRYABLE.has(code2)) return false;
      }
    }
    return false;
  }
}

export async function dropDatabases(
  admin: DbAdmin,
  prefix: string,
  opts: DropOptions = {},
): Promise<{ dropped: string[]; remaining: string[] }> {
  validatePrefix(prefix); // before any SQL
  const like = escapeLike(prefix) + '%';

  const list = async (): Promise<string[]> => {
    try {
      const { rows } = await admin.query(
        `SELECT datname FROM pg_database WHERE datname LIKE '${like}'`,
      );
      return (rows ?? []).map((r) => r.datname);
    } catch (err) {
      // R2-24 (4d): a failed SELECT must fail the run and name the prefix —
      // never exit 0 silently leaving the run's databases behind.
      console.error(`[test-db] prefix ${prefix}: listing databases failed: ${String(err)}`);
      process.exitCode = 1;
      throw err;
    }
  };

  const names = await list();
  const dropped: string[] = [];
  for (const name of names) {
    if (await dropOne(admin, name, opts)) dropped.push(name);
  }

  const remaining = await list();
  console.log(
    `[test-db] prefix ${prefix}: dropped ${dropped.length} database(s) ${
      dropped.map((d) => `"${d}"`).join(', ') || '(none)'
    }`,
  );
  if (remaining.length > 0) {
    console.error(
      `[test-db] prefix ${prefix}: could NOT drop: ${remaining.map((d) => `"${d}"`).join(', ')}`,
    );
    process.exitCode = 1;
    throw new Error(`test database teardown left: ${remaining.join(', ')}`);
  }
  return { dropped, remaining };
}
