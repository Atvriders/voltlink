// Migration role + helpers (guide 04 §1): only the `migrate` role ever applies
// migrations, under a Postgres advisory lock so replicas cannot race. All other
// roles wait for the migrations to be current (2 s poll, 120 s ceiling).

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { pool, withAdvisoryLock } from '../core/db';
import { PATHS } from '../core/paths';
import { runDataTasks } from './dataTasks';

function prismaCli(): string {
  const local = path.join(PATHS.root, 'node_modules', '.bin', 'prisma');
  if (fs.existsSync(local)) return local;
  const root = path.join(PATHS.root, '..', '..', 'node_modules', '.bin', 'prisma');
  if (fs.existsSync(root)) return root;
  const prismaRoot = path.dirname(
    createRequire(path.join(PATHS.root, 'package.json')).resolve('prisma/package.json'),
  );
  return path.join(prismaRoot, 'build', 'index.js');
}

// Transient resolver/connection failures are retried: Compose recreates the
// project networks on an in-place upgrade (the new stack adds `egress`), and
// the container's embedded DNS can answer EAI_AGAIN for a moment right after
// that. Every other role polls for the schema; this role must not be the one
// that dies. The retry wraps the WHOLE pass because withAdvisoryLock acquires
// its pooled client (the first thing that resolves `postgres`) before the
// callback runs.
const TRANSIENT_DB_CODES = new Set([
  'EAI_AGAIN',
  'ENOTFOUND',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
]);

async function runMigrationPass(): Promise<void> {
  await withAdvisoryLock('voltlink:migrations', async () => {
    // Direct SQL connection check first — if the DB is down, fail fast with a
    // clear message instead of a stack of Prisma noise.
    const client = await pool.connect();
    try {
      await client.query('SELECT 1');
    } finally {
      client.release();
    }
    const bin = prismaCli();
    if (bin.endsWith('.js')) {
      execFileSync(process.execPath, [bin, 'migrate', 'deploy', '--schema', PATHS.schema], {
        stdio: 'inherit',
        env: { ...process.env, CHECKPOINT_DISABLE: '1' },
      });
    } else {
      execFileSync(bin, ['migrate', 'deploy', '--schema', PATHS.schema], {
        stdio: 'inherit',
        env: { ...process.env, CHECKPOINT_DISABLE: '1' },
      });
    }
    await runDataTasks();
  });
}

export async function runMigrations(): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      await runMigrationPass();
      return;
    } catch (err) {
      const code = (err as { code?: string }).code ?? '';
      if (!TRANSIENT_DB_CODES.has(code) || Date.now() >= deadline) throw err;
      console.error(`[voltlink] database not reachable yet (${code}); retrying in 2s`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

export async function pendingMigrations(): Promise<string[]> {
  const shipped = fs
    .readdirSync(PATHS.migrations, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  const { rows } = await pool.query<{ migration_name: string }>(
    'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL',
  );
  const applied = new Set(rows.map((r) => r.migration_name));
  return shipped.filter((n) => !applied.has(n)).sort();
}

export async function waitForMigrations(timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let pending: string[] | null = null;
    let errMsg: string | null = null;
    try {
      pending = await pendingMigrations();
    } catch (err) {
      // R2-21: a failed state read (fresh database without
      // _prisma_migrations, provider down) is NOT 'current' — treat it as
      // pending and keep polling to the ceiling instead of booting the role
      // on an unmigrated schema.
      errMsg = (err as Error).message;
      console.warn(`[voltlink] could not read migration state (will retry): ${errMsg}`);
    }
    if (errMsg === null && pending !== null && pending.length === 0) return;
    if (Date.now() >= deadline) {
      console.error(
        errMsg !== null
          ? `[voltlink] could not read migration state for ${timeoutMs / 1000}s: ${errMsg}`
          : `[voltlink] migrations not current after ${timeoutMs / 1000}s: ${pending?.join(', ')} — run the migrate role first.`,
      );
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// CLI entry for `node dist/cli/migrate.cjs`
if (process.argv[1]?.endsWith('migrate.cjs') || process.argv[1]?.endsWith('migrate.js')) {
  void runMigrations()
    .then(() => {
      console.log('[voltlink] migrations current');
      process.exit(0);
    })
    .catch((err) => {
      console.error('[voltlink] migration failed:', err);
      process.exit(1);
    });
}
