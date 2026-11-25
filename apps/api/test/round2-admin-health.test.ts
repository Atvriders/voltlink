// R5: NEW-10 — admin health derives migrationsCurrent from the real applied
// migration set and reports beat freshness truthfully.
process.env.NODE_ENV = 'test';

import { execFileSync, spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Server } from 'node:http';
import pg from 'pg';
import { buildApp } from '../src/app';
import { prisma } from '../src/core/db';
import { initRedis } from '../src/core/redis';
import { PATHS } from '../src/core/paths';
import { randomId } from '../src/core/crypto';
import { createSession } from '../src/auth/service';
import { setSetting } from '../src/core/settings';

let server: Server;
let base = '';

beforeAll(async () => {
  await initRedis();
  server = buildApp({ serveSpa: false }).listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe('admin health (NEW-10)', () => {
  it('migrationsCurrent reflects the real applied migration set', async () => {
    const admin = await prisma.user.create({
      data: {
        email: `ah-${Date.now()}-${randomId()}@example.invalid`,
        name: 'AH',
        passwordHash: 'x',
        webauthnUserId: randomId(),
        isInstanceAdmin: true,
      },
    });
    const session = await createSession(admin.id, '127.0.0.1');
    const agent = request.agent(base).set('Cookie', `vl_session=${session.token}`);

    const before = await agent.get('/api/v1/admin/health');
    expect(before.status).toBe(200);
    expect(before.body.data.migrationsCurrent).toBe(true);

    // Remove one applied migration row: the health report must notice.
    const row = await prisma.$queryRaw<{ migration_name: string }[]>`
      SELECT migration_name FROM _prisma_migrations LIMIT 1`;
    expect(row.length).toBeGreaterThan(0);
    await prisma.$executeRaw`DELETE FROM _prisma_migrations WHERE migration_name = ${row[0]!.migration_name}`;

    const after = await agent.get('/api/v1/admin/health');
    expect(after.body.data.migrationsCurrent).toBe(false);
  });

  it('reports stale beats as inactive', async () => {
    const admin = await prisma.user.create({
      data: {
        email: `ah2-${Date.now()}-${randomId()}@example.invalid`,
        name: 'AH2',
        passwordHash: 'x',
        webauthnUserId: randomId(),
        isInstanceAdmin: true,
      },
    });
    await setSetting('workerBeat', new Date(Date.now() - 600_000).toISOString());
    await setSetting('schedulerBeat', String(Date.now() - 600_000));
    const session = await createSession(admin.id, '127.0.0.1');
    const agent = request.agent(base).set('Cookie', `vl_session=${session.token}`);
    const res = await agent.get('/api/v1/admin/health');
    expect(res.status).toBe(200);
    expect(res.body.data.workersActive).toBe(false);
    expect(res.body.data.schedulerActive).toBe(false);
  });

  it('NEW-10: rolled-back migration rows do not count against migrationsCurrent', async () => {
    const admin = await prisma.user.create({
      data: {
        email: `ah3-${Date.now()}-${randomId()}@example.invalid`,
        name: 'AH3',
        passwordHash: 'x',
        webauthnUserId: randomId(),
        isInstanceAdmin: true,
      },
    });
    const session = await createSession(admin.id, '127.0.0.1');
    const agent = request.agent(base).set('Cookie', `vl_session=${session.token}`);

    // Self-sufficient: the earlier test deleted one row from this shared
    // worker DB, so restore a full applied set first (synthetic rows for
    // any missing names).
    const bundled = readdirSync(PATHS.migrations, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    const applied = await prisma.$queryRaw<{ migration_name: string }[]>`
      SELECT migration_name FROM _prisma_migrations
      WHERE rolled_back_at IS NULL AND finished_at IS NOT NULL`;
    const appliedNames = new Set(applied.map((r) => r.migration_name));
    for (const name of bundled) {
      if (!appliedNames.has(name)) {
        await prisma.$executeRaw`
          INSERT INTO _prisma_migrations (id, migration_name, checksum, started_at, finished_at)
          VALUES (gen_random_uuid(), ${name}, 'beefcafe', now(), now())`;
      }
    }

    // A rolled-back row for a migration that is ALSO applied (the normal
    // Prisma shape after a roll-back + re-apply): the filtered query must
    // count only the finished row, so migrationsCurrent stays true.
    await prisma.$executeRaw`
      INSERT INTO _prisma_migrations (id, migration_name, checksum, started_at, rolled_back_at)
      VALUES (gen_random_uuid(), ${bundled[0]!}, 'deadbeef', now(), now())`;

    const res = await agent.get('/api/v1/admin/health');
    expect(res.body.data.migrationsCurrent).toBe(true);
  });

  it('NEW-10: the BUILT dist bundle boots a fresh database with database ok + migrations current', async () => {
    const adminUrl = process.env.TEST_DATABASE_ADMIN_URL;
    if (!adminUrl) throw new Error('TEST_DATABASE_ADMIN_URL required for the built-dist boot');
    const repoRoot = new URL('../../..', import.meta.url).pathname;
    const apiDir = `${repoRoot}apps/api`;
    // Build the flat dist bundle the image runs.
    execFileSync(process.execPath, ['build.mjs'], { cwd: apiDir, stdio: 'ignore' });

    // Fresh database, migrated by the built dist CLI.
    const dbName = `n10_${Date.now()}_${randomId().slice(0, 6)}`;
    const admin = new pg.Client({ connectionString: adminUrl.replace(/\/[^/]*$/, '/postgres') });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    const dbUrl = `${adminUrl.replace(/\/[^/]*$/, `/${dbName}`)}`;
    execFileSync(process.execPath, ['dist/cli/migrate.cjs'], {
      cwd: apiDir,
      env: { ...process.env, DATABASE_URL: dbUrl },
      stdio: 'ignore',
    });

    const port = await freePort();
    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      PUBLIC_URL: `http://127.0.0.1:${port}`,
      DATABASE_URL: dbUrl,
      NODE_ENV: 'production',
      VL_ALLOW_INSECURE_HTTP: 'true',
      VL_SETUP_TOKEN: 'n10-setup-token-0123456789abcdef01234567',
      JWT_SECRET: 'n10-jwt-key-0123456789abcdef0123456789abcdef-42',
      VL_MASTER_KEY: 'bm90LWEtcmVhbC1tYXN0ZXIta2V5LTAxMjM0NTY3ODk=',
    };
    delete childEnv.VL_TEST_DB_PREFIX;
    const child = spawn(process.execPath, ['dist/index.cjs'], {
      cwd: apiDir,
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let childErr = '';
    child.stderr?.on('data', (d: Buffer) => (childErr += d.toString()));
    if (process.env.VL_BOOT_PID_FILE) {
      import('node:fs').then((fs) =>
        fs.appendFileSync(process.env.VL_BOOT_PID_FILE!, `${child.pid}\n`),
      );
    }
    const childBase = `http://127.0.0.1:${port}`;
    try {
      const deadline = Date.now() + 20_000;
      let ready = false;
      while (Date.now() < deadline) {
        if (child.exitCode !== null) break;
        try {
          const r = await fetch(`${childBase}/healthz`);
          if (r.ok) {
            ready = true;
            break;
          }
        } catch {
          /* not up yet */
        }
        await new Promise((res) => setTimeout(res, 250));
      }
      expect(
        ready,
        `built dist web role must become healthy (stderr: ${childErr.slice(-800)})`,
      ).toBe(true);

      const agent = request.agent(childBase);
      const csrfRes = await agent.get('/api/v1/auth/csrf');
      expect(csrfRes.status).toBe(200);
      const csrf = (csrfRes.body as { data?: { token?: string } }).data?.token;
      expect(csrf, 'csrf token').toBeTruthy();
      const email = `n10-${Date.now()}@example.invalid`;
      const reg = await agent.post('/api/v1/auth/register').set('x-vl-csrf', csrf!).send({
        email,
        name: 'Built Dist Admin',
        password: 'n10-password-123',
        setupToken: 'n10-setup-token-0123456789abcdef01234567',
      });
      expect(reg.status).toBe(201);
      const loginRes = await agent.post('/api/v1/auth/login').set('x-vl-csrf', csrf!).send({
        email,
        password: 'n10-password-123',
      });
      expect(loginRes.status).toBe(200);

      const health = await agent.get('/api/v1/admin/health');
      expect(health.status).toBe(200);
      expect(health.body.data.database).toBe('ok');
      expect(health.body.data.migrationsCurrent).toBe(true);
    } finally {
      if (child.exitCode === null) child.kill('SIGTERM');
      const dropAdmin = new pg.Client({
        connectionString: adminUrl.replace(/\/[^/]*$/, '/postgres'),
      });
      await dropAdmin.connect();
      await dropAdmin
        .query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`)
        .catch(() => undefined);
      await dropAdmin.end();
    }
  }, 90_000);
});

async function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const a = srv.address() as AddressInfo;
      srv.close(() => resolve(a.port));
    });
  });
}
