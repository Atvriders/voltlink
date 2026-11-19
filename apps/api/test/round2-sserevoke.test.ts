// A-SSEREVOKE: revoking a session (or logging out) ends that session's open
// SSE stream immediately instead of letting it live for up to a minute.

process.env.NODE_ENV = 'test';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import http from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildApp } from '../src/app';
import { prisma } from '../src/core/db';
import { initRedis } from '../src/core/redis';
import { randomId } from '../src/core/crypto';
import { createSession } from '../src/auth/service';
import { startHub, stopHub } from '../src/realtime/hub';
import { ssePublish } from '../src/core/sse';

let server: Server;
let base: string;
let port: number;

beforeAll(async () => {
  await initRedis();
  server = buildApp({ serveSpa: false }).listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
  await startHub();
}, 30_000);

afterAll(async () => {
  stopHub();
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

function openStream(token: string) {
  const chunks: string[] = [];
  let ended = false;
  const req = http.request(
    {
      host: '127.0.0.1',
      port,
      path: '/api/v1/realtime',
      headers: { Cookie: `vl_session=${token}` },
    },
    (res) => {
      res.on('data', (d: Buffer) => chunks.push(d.toString('utf8')));
      res.on('end', () => {
        ended = true;
      });
    },
  );
  req.end();
  return {
    text: () => chunks.join(''),
    ended: () => ended,
    close: () => req.destroy(),
  };
}

describe('A-SSEREVOKE immediate stream termination', { tags: ['realtime'] }, () => {
  it('revoke-others closes the victim stream with session_revoked', async () => {
    const owner = await prisma.user.create({
      data: {
        email: `ssr.${Date.now()}@test.dev`,
        name: 'ssr',
        passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$s$s',
        webauthnUserId: randomId(),
        emailVerifiedAt: new Date(),
      },
    });
    const org = await prisma.organization.create({
      data: {
        kind: 'PERSONAL',
        name: `SSR-${Date.now()}`,
        createdById: owner.id,
        memberships: { create: { userId: owner.id, role: 'OWNER' } },
      },
    });

    const a = await createSession(owner.id);
    const b = await createSession(owner.id);

    const stream = openStream(a.token);
    // Prove the stream is live by pushing an event through the bus.
    await new Promise((resolve) => setTimeout(resolve, 300));
    ssePublish({ userId: owner.id, type: 'notification', data: { message: 'ping' } });
    for (let i = 0; i < 20 && !stream.text().includes('ping'); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(stream.text()).toContain('ping');

    // Session B revokes every session but its own.
    const agent = agentFor(b.token);
    const res = await withCsrf(agent, (csrf) =>
      agent.post('/api/v1/auth/sessions/revoke-others').set('x-vl-csrf', csrf).send({}),
    );
    expect(res.status).toBe(200);

    let saw = false;
    for (let i = 0; i < 40; i++) {
      if (stream.text().includes('session_revoked')) {
        saw = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(saw).toBe(true);
    // TI-29: receiving the event is not enough — the stream must actually END.
    // (The old suite never checked this; a hub that keeps the socket open
    // passes it.)
    for (let i = 0; i < 40 && !stream.ended(); i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(stream.ended(), 'revoked stream must close').toBe(true);

    stream.close();
    await prisma.organization.delete({ where: { id: org.id } });
    await prisma.user.delete({ where: { id: owner.id } });
  });
});

async function mkStreamUser() {
  const owner = await prisma.user.create({
    data: {
      email: `ssr2.${Date.now()}.${Math.random().toString(36).slice(2, 6)}@test.dev`,
      name: 'ssr2',
      passwordHash: await import('../src/core/crypto').then((m) =>
        m.hashPassword('long-enough-123'),
      ),
      webauthnUserId: randomId(),
      emailVerifiedAt: new Date(),
    },
  });
  const org = await prisma.organization.create({
    data: {
      kind: 'PERSONAL',
      name: `SSR2-${Date.now()}`,
      createdById: owner.id,
      memberships: { create: { userId: owner.id, role: 'OWNER' } },
    },
  });
  return { owner, org };
}

async function expectRevokedEnd(stream: ReturnType<typeof openStream>): Promise<void> {
  let saw = false;
  for (let i = 0; i < 40 && !saw; i++) {
    if (stream.text().includes('session_revoked')) saw = true;
    else await new Promise((r) => setTimeout(r, 50));
  }
  expect(saw, 'session_revoked must be published').toBe(true);
  for (let i = 0; i < 40 && !stream.ended(); i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  expect(stream.ended(), 'revoked stream must close').toBe(true);
}

it('R2-31 single session revoke closes that stream', async () => {
  const { owner, org } = await mkStreamUser();
  const a = await createSession(owner.id);
  const stream = openStream(a.token);
  await new Promise((r) => setTimeout(r, 300));
  const agent = agentFor(a.token);
  const res = await withCsrf(agent, (csrf) =>
    agent.post(`/api/v1/auth/sessions/${a.sessionId}/revoke`).set('x-vl-csrf', csrf).send({}),
  );
  expect(res.status).toBe(200);
  await expectRevokedEnd(stream);
  stream.close();
  await prisma.organization.delete({ where: { id: org.id } });
  await prisma.user.delete({ where: { id: owner.id } });
});

it('R2-31 logout closes the stream', async () => {
  const { owner, org } = await mkStreamUser();
  const a = await createSession(owner.id);
  const stream = openStream(a.token);
  await new Promise((r) => setTimeout(r, 300));
  const agent = agentFor(a.token);
  const res = await withCsrf(agent, (csrf) =>
    agent.post('/api/v1/auth/logout').set('x-vl-csrf', csrf).send({}),
  );
  expect(res.status).toBe(200);
  await expectRevokedEnd(stream);
  stream.close();
  await prisma.organization.delete({ where: { id: org.id } });
  await prisma.user.delete({ where: { id: owner.id } });
});

it('R2-31 password change publishes the revocation (expected red until step 5)', async () => {
  const { owner, org } = await mkStreamUser();
  const a = await createSession(owner.id);
  const stream = openStream(a.token);
  await new Promise((r) => setTimeout(r, 300));
  await prisma.userSession.update({
    where: { id: a.sessionId },
    data: { stepUpAt: new Date(), stepUpMethod: 'password' },
  });
  const agent = agentFor(a.token);
  const res = await withCsrf(agent, (csrf) =>
    agent
      .post('/api/v1/users/change-password')
      .set('x-vl-csrf', csrf)
      .send({ currentPassword: 'long-enough-123', newPassword: 'another-long-123' }),
  );
  expect(res.status).toBe(200);
  await expectRevokedEnd(stream);
  stream.close();
  await prisma.organization.delete({ where: { id: org.id } });
  await prisma.user.delete({ where: { id: owner.id } });
});

it('R2-31 admin suspend publishes the revocation (expected red until step 5)', async () => {
  const { owner, org } = await mkStreamUser();
  const a = await createSession(owner.id);
  const stream = openStream(a.token);
  await new Promise((r) => setTimeout(r, 300));
  const admin = await prisma.user.create({
    data: {
      email: `ssr3.${Date.now()}.${Math.random().toString(36).slice(2, 6)}@test.dev`,
      name: 'ssr3admin',
      passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$s$s',
      webauthnUserId: randomId(),
      emailVerifiedAt: new Date(),
      isInstanceAdmin: true,
    },
  });
  const adminSession = await createSession(admin.id, '127.0.0.1');
  await prisma.userSession.update({
    where: { id: adminSession.sessionId },
    data: { stepUpAt: new Date(), stepUpMethod: 'password' },
  });
  const adminAgent = agentFor(adminSession.token);
  const res = await withCsrf(adminAgent, (csrf) =>
    adminAgent
      .patch(`/api/v1/admin/users/${owner.id}/suspend`)
      .set('x-vl-csrf', csrf)
      .send({ suspended: true }),
  );
  expect(res.status).toBe(200);
  await expectRevokedEnd(stream);
  stream.close();
  await prisma.organization.delete({ where: { id: org.id } });
  await prisma.user.deleteMany({ where: { id: { in: [owner.id, admin.id] } } });
});
