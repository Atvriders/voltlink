// R2-60: the step-up challenge lists only the methods the account actually
// has — no Authenticator/Recovery/Passkey buttons for a bare-password user.

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
let base: string;

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

const csrfCache = new WeakMap<object, string>();
function agentFor(token: string) {
  return request.agent(base).set('Cookie', `vl_session=${token}`);
}
async function withCsrf(
  agent: ReturnType<typeof request.agent>,
  fn: (csrf: string) => Promise<request.Response>,
) {
  let csrf = csrfCache.get(agent);
  let res = await fn(csrf ?? '');
  if (res.status === 403 && res.body?.error?.code === 'CSRF') {
    const cookies = (res.headers['set-cookie'] ?? []) as unknown as string[];
    csrf =
      cookies
        .map((c) => (c ?? '').split(';')[0])
        .find((c) => c?.startsWith('vl_csrf='))
        ?.split('=')[1] ?? '';
    if (!csrf) throw new Error('CSRF cookie was not issued');
    csrfCache.set(agent, csrf);
    res = await fn(csrf);
  }
  return res;
}

describe('R2-60 step-up method list', () => {
  it('a bare-password account is offered only password', async () => {
    const user = await prisma.user.create({
      data: {
        email: `r260.${Date.now()}@example.invalid`,
        name: 'r260',
        passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$s$s',
        webauthnUserId: randomId(),
        emailVerifiedAt: new Date(),
      },
    });
    const org = await prisma.organization.create({
      data: {
        kind: 'PERSONAL',
        name: `R260-${Date.now()}`,
        createdById: user.id,
        memberships: { create: { userId: user.id, role: 'OWNER' } },
      },
    });
    const { token } = await createSession(user.id);
    const agent = agentFor(token);

    const res = await withCsrf(agent, (csrf) =>
      agent
        .post('/api/v1/auth/api-keys')
        .set('x-vl-csrf', csrf)
        .send({ name: 'r260', scopes: ['vehicles:read'], expiresInDays: 30 }),
    );
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('STEP_UP_REQUIRED');
    expect(res.body.error.details.methods).toEqual(['password']);

    // With a TOTP secret enrolled, totp + recovery_code appear too.
    await prisma.user.update({
      where: { id: user.id },
      data: { totpEnabled: true },
    });
    const res2 = await withCsrf(agent, (csrf) =>
      agent
        .post('/api/v1/auth/api-keys')
        .set('x-vl-csrf', csrf)
        .send({ name: 'r260b', scopes: ['vehicles:read'], expiresInDays: 30 }),
    );
    expect(res2.status).toBe(403);
    expect(res2.body.error.details.methods).toEqual(['password', 'totp', 'recovery_code']);

    await prisma.organization.delete({ where: { id: org.id } });
    await prisma.user.delete({ where: { id: user.id } });
  });
});
