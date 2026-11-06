// R5: NEW-10 — admin health derives migrationsCurrent from the real applied
// migration set and reports beat freshness truthfully.
process.env.NODE_ENV = 'test';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildApp } from '../src/app';
import { prisma } from '../src/core/db';
import { initRedis } from '../src/core/redis';
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
        email: `ah-${Date.now()}-${randomId()}@test.dev`,
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
        email: `ah2-${Date.now()}-${randomId()}@test.dev`,
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
});
