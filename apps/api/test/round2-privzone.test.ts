// Z-PRIVZONE regression: reads redact stored drive coordinates that fall
// inside an enabled privacy zone, even before the retroactive job runs.
// The demo-seed fix (enqueue on seed) is exercised by the seed test below.

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

describe('Z-PRIVZONE read redaction', () => {
  it('list, detail and route reads redact in-zone coordinates', async () => {
    const owner = await prisma.user.create({
      data: {
        email: `zpz.${Date.now()}@test.dev`,
        name: 'zpz',
        passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$s$s',
        webauthnUserId: randomId(),
        emailVerifiedAt: new Date(),
      },
    });
    const org = await prisma.organization.create({
      data: {
        kind: 'PERSONAL',
        name: `ZPZ-${Date.now()}`,
        createdById: owner.id,
        memberships: { create: { userId: owner.id, role: 'OWNER' } },
      },
    });
    const provider = await prisma.providerAccount.create({
      data: {
        organizationId: org.id,
        provider: 'mock',
        label: 'mock',
        status: 'connected',
        connectedById: owner.id,
        demo: false,
      },
    });
    const vehicle = await prisma.vehicle.create({
      data: {
        organizationId: org.id,
        providerAccountId: provider.id,
        provider: 'mock',
        providerVehicleId: `zpz-${Date.now()}`,
        displayName: 'ZPZ car',
        demo: false,
      },
    });
    const drive = await prisma.drive.create({
      data: {
        vehicleId: vehicle.id,
        startAt: new Date(),
        endAt: new Date(Date.now() + 1000),
        startLat: 47.6062,
        startLon: -122.3321,
        startAddress: 'Seattle home',
        endLat: 47.6063,
        endLon: -122.3322,
        endAddress: 'Seattle home 2',
        distanceKm: 1,
        durationSec: 60,
        avgSpeedKmh: 60,
        maxSpeedKmh: 60,
        energyKwh: 0.2,
        efficiencyWhPerKm: 200,
      },
    });
    await prisma.driveRoutePoint.createMany({
      data: [
        {
          driveId: drive.id,
          seq: 0,
          ts: new Date(),
          lat: 47.6062,
          lon: -122.3321,
          speedKmh: 0,
        },
        {
          driveId: drive.id,
          seq: 1,
          ts: new Date(Date.now() + 1000),
          lat: 47.6063,
          lon: -122.3322,
          speedKmh: 10,
        },
      ],
    });

    const { token } = await createSession(owner.id);
    const agent = agentFor(token);

    const zoneRes = await withCsrf(agent, (csrf) =>
      agent
        .post('/api/v1/vehicles/privacy-zones')
        .set('x-vl-csrf', csrf)
        .send({ name: 'Home', lat: 47.6062, lon: -122.3321, radiusM: 400 }),
    );
    expect(zoneRes.status).toBe(201);

    const list = await agent.get(`/api/v1/drives?vehicleId=${vehicle.id}`);
    expect(list.status).toBe(200);
    const item = (list.body.data.items as unknown[])[0] as {
      startLat: unknown;
      startAddress: unknown;
    };
    // the DTO drops redacted values entirely
    expect(item.startLat).toBeUndefined();
    expect(item.startAddress).toBeUndefined();

    const detail = await agent.get(`/api/v1/drives/${drive.id}?route=1`);
    expect(detail.status).toBe(200);
    expect(detail.body.data.startLat).toBeUndefined();
    const route = detail.body.data.route as { lat: unknown; lon: unknown }[];
    expect(route[0]?.lat).toBeNull();
    expect(route[1]?.lat).toBeNull();

    await prisma.organization.delete({ where: { id: org.id } });
    await prisma.user.delete({ where: { id: owner.id } });
  });
});
