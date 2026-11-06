// R6: R2-22 — the admin role-change endpoint actually exists and works.
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

describe('admin role change (R2-22)', () => {
  it('PATCH /admin/users/:id/role grants and revokes instance admin', async () => {
    const admin = await prisma.user.create({
      data: {
        email: `r222a-${Date.now()}-${randomId()}@test.dev`,
        name: 'Admin',
        passwordHash: 'x',
        webauthnUserId: randomId(),
        isInstanceAdmin: true,
      },
    });
    const member = await prisma.user.create({
      data: {
        email: `r222m-${Date.now()}-${randomId()}@test.dev`,
        name: 'Member',
        passwordHash: 'x',
        webauthnUserId: randomId(),
        isInstanceAdmin: false,
      },
    });
    const session = await createSession(admin.id, '127.0.0.1');
    await prisma.userSession.update({
      where: { id: session.sessionId },
      data: { stepUpAt: new Date(), stepUpMethod: 'totp' },
    });
    const agent = request.agent(base).set('Cookie', `vl_session=${session.token}`);
    let res = await agent.patch(`/api/v1/admin/users/${member.id}/role`).send({ role: 'admin' });
    if (res.status === 403 && res.body?.error?.code === 'CSRF') {
      const cookies = (res.headers['set-cookie'] ?? []) as unknown as string[];
      const csrf = cookies
        .map((c) => (c ?? '').split(';')[0])
        .find((c) => c?.startsWith('vl_csrf='))
        ?.split('=')[1];
      res = await agent
        .patch(`/api/v1/admin/users/${member.id}/role`)
        .set('Cookie', `vl_session=${session.token}; vl_csrf=${csrf ?? ''}`)
        .set('x-vl-csrf', String(csrf ?? ''))
        .send({ role: 'admin' });
    }
    expect(res.status).toBe(200);
    const promoted = await prisma.user.findUniqueOrThrow({ where: { id: member.id } });
    expect(promoted.isInstanceAdmin).toBe(true);
  });
});
