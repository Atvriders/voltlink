// Regression tests for R2-28, R2-29, R2-30 (round 2 verification report).
// R2-28: an inbound webhook fires exactly the automation it is bound to.
// R2-29: authenticated routes with target none must not let read-only
//         members write into their organization.
// R2-30: API-key creation, org deletion and role changes need re-auth.

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
import { outgoingHeaders } from '../src/webhooks/standardWebhooks';

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

async function mkUser(email: string) {
  return prisma.user.create({
    data: {
      email,
      name: email.split('@')[0]!,
      passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$s$s',
      webauthnUserId: randomId(),
      emailVerifiedAt: new Date(),
    },
  });
}

async function sessionFor(userId: string, stepped = false) {
  const { token, sessionId } = await createSession(userId);
  if (stepped) {
    await prisma.userSession.update({
      where: { id: sessionId },
      data: { stepUpAt: new Date(), stepUpMethod: 'password' },
    });
  }
  return { token, sessionId };
}

describe('R2-28 inbound webhook dispatch is bound to its automation', () => {
  it('fires only the bound automation, not every webhook automation of the owner', async () => {
    const bob = await mkUser(`r228bob.${Date.now()}@test.dev`);
    const org = await prisma.organization.create({
      data: {
        kind: 'TEAM',
        name: `R228-${Date.now()}`,
        createdById: bob.id,
        memberships: { create: { userId: bob.id, role: 'OWNER' } },
      },
    });
    const { token } = await sessionFor(bob.id);
    const agent = agentFor(token);

    const mkAuto = async (name: string) => {
      const res = await withCsrf(agent, (csrf) =>
        agent
          .post('/api/v1/automations')
          .set('x-vl-csrf', csrf)
          .send({
            name,
            enabled: true,
            trigger: { type: 'webhook', params: {} },
            conditions: [],
            actions: [{ type: 'notify_app', params: { message: 'fired' } }],
            cooldownSec: 0,
            maxRetries: 0,
          }),
      );
      expect(res.status).toBe(201);
      return res.body.data.id as string;
    };

    const boundId = await mkAuto('R228 bound');
    const unrelatedId = await mkAuto('R228 unrelated');

    const hookRes = await withCsrf(agent, (csrf) =>
      agent.post(`/api/v1/automations/${boundId}/inbound-webhook`).set('x-vl-csrf', csrf).send({}),
    );
    expect(hookRes.status).toBe(201);
    const { url, secret } = hookRes.body.data as { url: string; secret: string };

    const body = JSON.stringify({ hello: 'world' });
    const msgId = 'msg_r228_bound';
    const headers = outgoingHeaders([secret], msgId, body);
    const delivered = await request(base).post(new URL(url).pathname).set(headers).send(body);
    expect(delivered.status).toBe(200);

    const bound = await prisma.automation.findUniqueOrThrow({
      where: { id: boundId },
    });
    const unrelated = await prisma.automation.findUniqueOrThrow({
      where: { id: unrelatedId },
    });
    expect(bound.runCount).toBe(1);
    expect(unrelated.runCount).toBe(0);

    await prisma.organization.delete({ where: { id: org.id } });
    await prisma.user.delete({ where: { id: bob.id } });
  });
});

describe('R2-29 target-none write routes reject read-only members', () => {
  it('VIEWER cannot create automations or connect providers', async () => {
    const alice = await mkUser(`r229alice.${Date.now()}@test.dev`);
    const carol = await mkUser(`r229carol.${Date.now()}@test.dev`);
    const org = await prisma.organization.create({
      data: {
        kind: 'TEAM',
        name: `R229-${Date.now()}`,
        createdById: alice.id,
        memberships: {
          create: [
            { userId: alice.id, role: 'OWNER' },
            { userId: carol.id, role: 'VIEWER' },
          ],
        },
      },
    });
    const { token } = await sessionFor(carol.id);
    const agent = agentFor(token);

    const autoRes = await withCsrf(agent, (csrf) =>
      agent
        .post('/api/v1/automations')
        .set('x-vl-csrf', csrf)
        .send({
          name: 'viewer write attempt',
          enabled: true,
          trigger: { type: 'scheduled', params: { cron: '* * * * *' } },
          conditions: [],
          actions: [{ type: 'notify_app', params: { message: 'x' } }],
          cooldownSec: 0,
          maxRetries: 0,
        }),
    );
    expect(autoRes.status).toBe(403);
    expect(autoRes.body.error.code).toBe('FORBIDDEN');

    const demoRes = await withCsrf(agent, (csrf) =>
      agent.post('/api/v1/providers/demo/connect').set('x-vl-csrf', csrf).send({}),
    );
    expect(demoRes.status).toBe(403);
    expect(demoRes.body.error.code).toBe('FORBIDDEN');

    await prisma.organization.delete({ where: { id: org.id } });
    await prisma.user.deleteMany({ where: { id: { in: [alice.id, carol.id] } } });
  });
});

describe('R2-30 re-authentication gates', () => {
  it('API-key creation, org deletion and role changes require step-up', async () => {
    const owner = await mkUser(`r230owner.${Date.now()}@test.dev`);
    const member = await mkUser(`r230member.${Date.now()}@test.dev`);
    const org = await prisma.organization.create({
      data: {
        kind: 'TEAM',
        name: `R230-${Date.now()}`,
        createdById: owner.id,
        memberships: {
          create: [
            { userId: owner.id, role: 'OWNER' },
            { userId: member.id, role: 'VIEWER' },
          ],
        },
      },
    });

    // Fresh session, never stepped up.
    const { token } = await sessionFor(owner.id, false);
    const agent = agentFor(token);

    const keyRes = await withCsrf(agent, (csrf) =>
      agent
        .post('/api/v1/auth/api-keys')
        .set('x-vl-csrf', csrf)
        .send({ name: 'r230', scopes: ['vehicles:read'], expiresInDays: 30 }),
    );
    expect(keyRes.status).toBe(403);
    expect(keyRes.body.error.code).toBe('STEP_UP_REQUIRED');

    const delRes = await withCsrf(agent, (csrf) =>
      agent.delete(`/api/v1/orgs/${org.id}`).set('x-vl-csrf', csrf),
    );
    expect(delRes.status).toBe(403);
    expect(delRes.body.error.code).toBe('STEP_UP_REQUIRED');

    const roleRes = await withCsrf(agent, (csrf) =>
      agent
        .patch(`/api/v1/orgs/${org.id}/members/${member.id}`)
        .set('x-vl-csrf', csrf)
        .send({ role: 'ADMIN' }),
    );
    expect(roleRes.status).toBe(403);
    expect(roleRes.body.error.code).toBe('STEP_UP_REQUIRED');

    // After step-up all three succeed.
    await prisma.userSession.update({
      where: {
        id: (await prisma.userSession.findFirstOrThrow({ where: { userId: owner.id } })).id,
      },
      data: { stepUpAt: new Date(), stepUpMethod: 'password' },
    });

    const keyOk = await withCsrf(agent, (csrf) =>
      agent
        .post('/api/v1/auth/api-keys')
        .set('x-vl-csrf', csrf)
        .send({ name: 'r230', scopes: ['vehicles:read'], expiresInDays: 30 }),
    );
    expect(keyOk.status).toBe(201);

    const roleOk = await withCsrf(agent, (csrf) =>
      agent
        .patch(`/api/v1/orgs/${org.id}/members/${member.id}`)
        .set('x-vl-csrf', csrf)
        .send({ role: 'ADMIN' }),
    );
    expect(roleOk.status).toBe(200);

    const delOk = await withCsrf(agent, (csrf) =>
      agent.delete(`/api/v1/orgs/${org.id}`).set('x-vl-csrf', csrf),
    );
    expect(delOk.status).toBe(200);

    await prisma.user.deleteMany({ where: { id: { in: [owner.id, member.id] } } });
  });
});
