// R6: F-ONBOARD — the notifications step actually saves the master in-app
// toggle (bulk channel update), and onboarding progress is server-persisted.
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

async function newSession() {
  const u = await prisma.user.create({
    data: {
      email: `ob-${Date.now()}-${randomId()}@test.dev`,
      name: 'OB',
      passwordHash: 'x',
      webauthnUserId: randomId(),
    },
  });
  const session = await createSession(u.id, '127.0.0.1');
  const agent = request.agent(base).set('Cookie', `vl_session=${session.token}`);
  return { u, agent, token: session.token };
}

async function putJson(
  agent: ReturnType<typeof request.agent>,
  token: string,
  path: string,
  body: object,
) {
  let res = await agent.put(path).send(body);
  if (res.status === 403 && res.body?.error?.code === 'CSRF') {
    const cookies = (res.headers['set-cookie'] ?? []) as unknown as string[];
    const csrf = cookies
      .map((c) => (c ?? '').split(';')[0])
      .find((c) => c?.startsWith('vl_csrf='))
      ?.split('=')[1];
    res = await agent
      .put(path)
      .set('Cookie', `vl_session=${token}; vl_csrf=${csrf ?? ''}`)
      .set('x-vl-csrf', String(csrf ?? ''))
      .send(body);
  }
  return res;
}

describe('onboarding persistence (F-ONBOARD)', () => {
  it('persists the step on the server', async () => {
    const { u, agent, token } = await newSession();
    const res = await putJson(agent, token, '/api/v1/users/onboarding', { step: 'units' });
    expect(res.status).toBe(200);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(row.onboardingStep).toBe('units');
  });

  it('saves the master in-app toggle for every event (bulk channel update)', async () => {
    const { u, agent, token } = await newSession();
    await prisma.notificationPreference.create({
      data: { userId: u.id, channel: 'in_app', event: 'system', severity: 'info', enabled: true },
    });
    const res = await putJson(agent, token, '/api/v1/notifications/preferences', {
      channel: 'in_app',
      allEvents: true,
      enabled: false,
    });
    expect(res.status).toBe(200);
    const rows = await prisma.notificationPreference.findMany({
      where: { userId: u.id, channel: 'in_app' },
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.enabled === false)).toBe(true);
  });

  it('stores the opt-out for a brand-new user with no preference rows (TI-20)', async () => {
    const { u, agent, token } = await newSession();
    // No seeded rows at all: the onboarding toggle must CREATE them.
    const before = await prisma.notificationPreference.count({
      where: { userId: u.id },
    });
    expect(before).toBe(0);
    const res = await putJson(agent, token, '/api/v1/notifications/preferences', {
      channel: 'in_app',
      allEvents: true,
      enabled: false,
    });
    expect(res.status).toBe(200);
    const get = await agent.get('/api/v1/notifications/preferences');
    expect(get.status).toBe(200);
    const prefs = (get.body.data.prefs ?? []) as {
      channel: string;
      event: string;
      enabled: boolean;
    }[];
    const inApp = prefs.filter((p) => p.channel === 'in_app');
    expect(inApp.length).toBeGreaterThanOrEqual(15); // every EVENT_TYPES row
    expect(inApp.every((p) => p.enabled === false)).toBe(true);
    const events = new Set(inApp.map((p) => p.event));
    const { EVENT_TYPES } = await import('@voltlink/shared');
    for (const event of EVENT_TYPES) expect(events.has(event)).toBe(true);
  });
});
