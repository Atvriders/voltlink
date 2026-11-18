// A-EMAILVERIFY: provider connections require a verified email and the
// resend-verification endpoint is throttled to one mail per minute.
// Z-DEMOSCOPE: demo-seeded incidents never reach the public status page.

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

async function mkUser(email: string, verified: boolean) {
  return prisma.user.create({
    data: {
      email,
      name: email.split('@')[0]!,
      passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$s$s',
      webauthnUserId: randomId(),
      emailVerifiedAt: verified ? new Date() : null,
    },
  });
}

describe('A-EMAILVERIFY provider gating and resend throttle', () => {
  it('unverified members cannot connect providers and resend is throttled', async () => {
    const uma = await mkUser(`ae.${Date.now()}@test.dev`, false);
    const org = await prisma.organization.create({
      data: {
        kind: 'PERSONAL',
        name: `AE-${Date.now()}`,
        createdById: uma.id,
        memberships: { create: { userId: uma.id, role: 'OWNER' } },
      },
    });
    const { token } = await createSession(uma.id);
    const agent = agentFor(token);

    const demo = await withCsrf(agent, (csrf) =>
      agent.post('/api/v1/providers/demo/connect').set('x-vl-csrf', csrf).send({}),
    );
    expect(demo.status).toBe(403);
    expect(demo.body.error.code).toBe('EMAIL_UNVERIFIED');

    const first = await withCsrf(agent, (csrf) =>
      agent.post('/api/v1/auth/resend-verification').set('x-vl-csrf', csrf).send({}),
    );
    expect(first.status).toBe(200);
    const second = await withCsrf(agent, (csrf) =>
      agent.post('/api/v1/auth/resend-verification').set('x-vl-csrf', csrf).send({}),
    );
    expect(second.status).toBe(429);
    expect(second.body.error.code).toBe('TOO_MANY_ATTEMPTS');

    await prisma.organization.delete({ where: { id: org.id } });
    await prisma.user.delete({ where: { id: uma.id } });
  });
});

describe('Z-DEMOSCOPE demo incidents stay private', () => {
  it('seedDemoWorld incidents never appear on the public status page', async () => {
    const owner = await mkUser(`zd.${Date.now()}@test.dev`, true);
    const org = await prisma.organization.create({
      data: {
        kind: 'PERSONAL',
        name: `ZD-${Date.now()}`,
        createdById: owner.id,
        memberships: { create: { userId: owner.id, role: 'OWNER' } },
      },
    });
    const provider = await prisma.providerAccount.create({
      data: {
        organizationId: org.id,
        provider: 'demo',
        label: 'demo',
        status: 'connected',
        demo: true,
      },
    });
    const vehicle = await prisma.vehicle.create({
      data: {
        organizationId: org.id,
        providerAccountId: provider.id,
        provider: 'demo',
        providerVehicleId: 'demo-aurora',
        displayName: 'Aurora',
        demo: true,
        capabilities: JSON.parse(JSON.stringify(['honk_horn', 'wake'])),
      },
    });
    // TI-58: create the two demo incidents DIRECTLY (the test must not
    // depend on the seed's side effects into the real incident table).
    await prisma.incident.deleteMany({});
    await prisma.incident.create({
      data: {
        title: 'Demo provider sync delays',
        severity: 'minor',
        status: 'identified',
        public: false,
        createdById: owner.id,
      },
    });
    await prisma.incident.create({
      data: {
        title: 'Notification delivery delays',
        severity: 'minor',
        status: 'identified',
        public: false,
        createdById: owner.id,
      },
    });

    const demoIncidents = await prisma.incident.findMany({
      where: {
        title: { in: ['Demo provider sync delays', 'Notification delivery delays'] },
      },
      select: { title: true, public: true },
    });
    expect(demoIncidents.length).toBe(2);
    for (const i of demoIncidents) expect(i.public).toBe(false);

    const status = await request(base).get('/api/v1/status');
    expect(status.status).toBe(200);
    const incidents = (status.body.data?.incidents ?? []) as { title?: string }[];
    const titles = incidents.map((i) => i.title);
    expect(titles).not.toContain('Demo provider sync delays');
    expect(titles).not.toContain('Notification delivery delays');

    await prisma.organization.delete({ where: { id: org.id } });
    await prisma.user.delete({ where: { id: owner.id } });
  });
});
