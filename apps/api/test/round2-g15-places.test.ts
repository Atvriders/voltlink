// R6: G-15 — places have a real update route and the privacy-zone PATCH edits
// name/centre/radius, re-running redaction when a zone changes.
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
import { getQueue } from '../src/core/queue';

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

async function seedOrgManager() {
  const u = await prisma.user.create({
    data: {
      email: `g15-${Date.now()}-${randomId()}@test.dev`,
      name: 'G15',
      passwordHash: 'x',
      webauthnUserId: randomId(),
    },
  });
  const org = await prisma.organization.create({
    data: { name: `org-${randomId().slice(0, 8)}` },
  });
  await prisma.membership.create({
    data: { userId: u.id, organizationId: org.id, role: 'OWNER', status: 'ACTIVE' },
  });
  const session = await createSession(u.id, '127.0.0.1');
  const agent = request.agent(base).set('Cookie', `vl_session=${session.token}`);
  return { u, org, agent, token: session.token };
}

async function putJson(
  agent: ReturnType<typeof request.agent>,
  token: string,
  method: 'patch' | 'post',
  path: string,
  body: object,
) {
  let res = await agent[method](path).send(body);
  if (res.status === 403 && res.body?.error?.code === 'CSRF') {
    const cookies = (res.headers['set-cookie'] ?? []) as unknown as string[];
    const csrf = cookies
      .map((c) => (c ?? '').split(';')[0])
      .find((c) => c?.startsWith('vl_csrf='))
      ?.split('=')[1];
    res = await agent[method](path)
      .set('Cookie', `vl_session=${token}; vl_csrf=${csrf ?? ''}`)
      .set('x-vl-csrf', String(csrf ?? ''))
      .send(body);
  }
  return res;
}

describe('places + privacy-zone updates (G-15)', () => {
  it('PATCH /places/all/:id updates name, type and coordinates', async () => {
    const { u, org, agent, token } = await seedOrgManager();
    const place = await prisma.place.create({
      data: {
        organizationId: org.id,
        createdById: u.id,
        name: 'Old name',
        type: 'home',
        lat: 40,
        lon: -100,
        radiusM: 100,
      },
    });
    const res = await putJson(agent, token, 'patch', `/api/v1/vehicles/places/all/${place.id}`, {
      name: 'New HQ',
      type: 'office',
      lat: 40.5,
      lon: -100.5,
      radiusM: 250,
    });
    expect(res.status).toBe(200);
    const row = await prisma.place.findUniqueOrThrow({ where: { id: place.id } });
    expect(row.name).toBe('New HQ');
    expect(row.type).toBe('office');
    expect(row.lat).toBe(40.5);
    expect(row.lon).toBe(-100.5);
    expect(row.radiusM).toBe(250);
  });

  it('PATCH /privacy-zones/:id updates name, centre and radius', async () => {
    const { u, org, agent, token } = await seedOrgManager();
    const zone = await prisma.privacyZone.create({
      data: {
        organizationId: org.id,
        createdById: u.id,
        name: 'Zone A',
        lat: 40,
        lon: -100,
        radiusM: 500,
        enabled: true,
      },
    });
    const beforeDepth = await getQueue()
      .depth('privacy-redaction')
      .catch(() => 0);
    const res = await putJson(agent, token, 'patch', `/api/v1/vehicles/privacy-zones/${zone.id}`, {
      name: 'Zone B',
      lat: 41,
      lon: -101,
      radiusM: 800,
    });
    expect(res.status).toBe(200);
    const row = await prisma.privacyZone.findUniqueOrThrow({ where: { id: zone.id } });
    expect(row.name).toBe('Zone B');
    expect(row.lat).toBe(41);
    expect(row.lon).toBe(-101);
    expect(row.radiusM).toBe(800);
    const afterDepth = await getQueue()
      .depth('privacy-redaction')
      .catch(() => 0);
    expect(afterDepth).toBeGreaterThan(beforeDepth);
  });
});
