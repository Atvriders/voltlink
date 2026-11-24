// R5: fleet reports produce real CSV (N-FLEETRPT).
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

describe('fleet report CSV (N-FLEETRPT)', () => {
  it('GET /report?format=csv returns text/csv with real rows', async () => {
    const user = await prisma.user.create({
      data: {
        email: `fr-${Date.now()}-${randomId()}@test.dev`,
        name: 'FR',
        passwordHash: 'x',
        webauthnUserId: randomId(),
      },
    });
    const org = await prisma.organization.create({
      data: {
        kind: 'TEAM',
        name: 'Report Org',
        createdById: user.id,
        memberships: { create: { userId: user.id, role: 'OWNER' } },
      },
    });
    const pa = await prisma.providerAccount.create({
      data: {
        organizationId: org.id,
        provider: 'demo',
        label: 'Demo',
        status: 'connected',
        demo: true,
      },
    });
    const veh = await prisma.vehicle.create({
      data: {
        organizationId: org.id,
        providerAccountId: pa.id,
        provider: 'demo',
        providerVehicleId: randomId(),
        displayName: 'Report Car',
        demo: true,
      },
    });
    await prisma.drive.create({
      data: {
        vehicleId: veh.id,
        startAt: new Date(Date.now() - 7200_000),
        endAt: new Date(Date.now() - 3600_000),
        distanceKm: 42.5,
        durationSec: 1800,
        avgSpeedKmh: 85,
        maxSpeedKmh: 120,
        energyKwh: 7.1,
        efficiencyWhPerKm: 167,
        estCost: 2.5,
      },
    });
    const session = await createSession(user.id, '127.0.0.1');
    const agent = request.agent(base).set('Cookie', `vl_session=${session.token}`);

    const res = await agent.get('/api/v1/fleet/report?format=csv');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    const text = String(res.text);
    expect(text).toContain('Vehicle');
    expect(text).toContain('Report Car');
    expect(text).toContain('42.5');
    expect(text).toContain('7.1');
  });
});
