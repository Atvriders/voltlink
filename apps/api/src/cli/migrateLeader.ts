// Migration leader: runs `prisma migrate deploy` under a Postgres advisory
// lock so multiple replicas cannot race to apply migrations.

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { pool, withAdvisoryLock } from '../core/db';
import { runDataTasks } from './dataTasks';

export async function runMigrationLeader(): Promise<void> {
  await withAdvisoryLock('voltlink:migrations', async () => {
    // Direct SQL connection check first — if the DB is down, fail fast with a
    // clear message instead of a stack of Prisma noise.
    const client = await pool.connect();
    try {
      await client.query('SELECT 1');
    } finally {
      client.release();
    }
    const prismaBin = findPrismaBin();
    if (prismaBin.endsWith('.js')) {
      execFileSync(process.execPath, [prismaBin, 'migrate', 'deploy'], { cwd: process.cwd(), stdio: 'inherit', env: process.env });
    } else {
      execFileSync(prismaBin, ['migrate', 'deploy'], { cwd: process.cwd(), stdio: 'inherit', env: process.env });
    }
    await runDataTasks();
  });
}

function findPrismaBin(): string {
  const candidates = [
    path.resolve(process.cwd(), 'node_modules', '.bin', 'prisma'),
    path.resolve(process.cwd(), '..', '..', 'node_modules', '.bin', 'prisma'),
    path.resolve(process.cwd(), '..', 'node_modules', '.bin', 'prisma'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  const js = require.resolve('prisma/build/index.js');
  if (js) return js;
  throw new Error('Prisma CLI not found — run `npm install` first.');
}

// CLI entry for `node dist/cli/migrateLeader.js`
if (process.argv[1]?.endsWith('migrateLeader.js') || process.argv[1]?.endsWith('migrateLeader.cjs')) {
  void runMigrationLeader()
    .then(() => {
      console.log('[voltlink] migrations current');
      process.exit(0);
    })
    .catch((err) => {
      console.error('[voltlink] migration failed:', err);
      process.exit(1);
    });
}
