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

export async function dropDatabases(
  admin: DbAdmin,
  prefix: string,
  opts: DropOptions = {},
): Promise<{ dropped: string[]; remaining: string[] }> {
  const retryMs = opts.retryMs ?? 30_000;
  const pollMs = opts.pollMs ?? 2_000;
  const like = prefix.replace(/[\\_%]/g, (ch) => `\\${ch}`) + '%';

  const list = async (): Promise<string[]> => {
    const { rows } = await admin.query(
      `SELECT datname FROM pg_database WHERE datname LIKE '${like}'`,
    );
    return (rows ?? []).map((r) => r.datname);
  };

  const names = await list();
  const dropped: string[] = [];
  for (const name of names) {
    const force = `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`;
    const plain = `DROP DATABASE IF EXISTS "${name}"`;
    let done = false;
    try {
      await admin.query(force);
      done = true;
    } catch (err) {
      const code = (err as { code?: string }).code ?? '';
      if (RETRYABLE.has(code)) {
        // Retry with plain DROP until the window closes.
        const deadline = Date.now() + retryMs;
        while (Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, pollMs));
          try {
            await admin.query(plain);
            done = true;
            break;
          } catch (err2) {
            const code2 = (err2 as { code?: string }).code ?? '';
            if (!RETRYABLE.has(code2)) break;
          }
        }
      }
      // Non-retryable failure or window closed: leave it listed; the final
      // leftover check names it and fails the run.
    }
    if (done) dropped.push(name);
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
