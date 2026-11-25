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
        email: `r222a-${Date.now()}-${randomId()}@example.invalid`,
        name: 'Admin',
        passwordHash: 'x',
        webauthnUserId: randomId(),
        isInstanceAdmin: true,
      },
    });
    const member = await prisma.user.create({
      data: {
        email: `r222m-${Date.now()}-${randomId()}@example.invalid`,
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
    // A fresh supertest agent per call: the CSRF cookie rotates with each
    // successful handshake, so a reused jar sends a stale token.
    const patchRole = async (userId: string, role: 'admin' | 'member') => {
      const callAgent = request.agent(base).set('Cookie', `vl_session=${session.token}`);
      let out = await callAgent.patch(`/api/v1/admin/users/${userId}/role`).send({ role });
      if (out.status === 403 && out.body?.error?.code === 'CSRF') {
        const cookies = (out.headers['set-cookie'] ?? []) as unknown as string[];
        const csrf = cookies
          .map((c) => (c ?? '').split(';')[0])
          .find((c) => c?.startsWith('vl_csrf='))
          ?.split('=')[1];
        out = await callAgent
          .patch(`/api/v1/admin/users/${userId}/role`)
          .set('Cookie', `vl_session=${session.token}; vl_csrf=${csrf ?? ''}`)
          .set('x-vl-csrf', String(csrf ?? ''))
          .send({ role });
      }
      return out;
    };

    let res = await patchRole(member.id, 'admin');
    expect(res.status).toBe(200);
    const promoted = await prisma.user.findUniqueOrThrow({ where: { id: member.id } });
    expect(promoted.isInstanceAdmin).toBe(true);

    // TI-48: the name promises a revoke — send { role: 'member' } back.
    // Step-up is single-use; re-arm it for this separate admin action.
    await prisma.userSession.update({
      where: { id: session.sessionId },
      data: { stepUpAt: new Date(), stepUpMethod: 'totp' },
    });
    res = await patchRole(member.id, 'member');
    expect(res.status).toBe(200);
    const demoted = await prisma.user.findUniqueOrThrow({ where: { id: member.id } });
    expect(demoted.isInstanceAdmin).toBe(false);

    // TI-48 / R2-78: the last remaining instance admin cannot be demoted.
    res = await patchRole(admin.id, 'member');
    expect(res.status).toBe(409);
    expect(res.body?.error?.code).toBe('LAST_ADMIN');
    const stillAdmin = await prisma.user.findUniqueOrThrow({ where: { id: admin.id } });
    expect(stillAdmin.isInstanceAdmin).toBe(true);
  });
});
