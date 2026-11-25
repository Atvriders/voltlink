// R6: F-FRESH — the freshness label is recomputed at read time from fetchedAt,
// never the stale label stored at ingest.
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

describe('freshness at read time (F-FRESH)', () => {
  it('recomputes freshness from fetchedAt instead of the stored label', async () => {
    const u = await prisma.user.create({
      data: {
        email: `ff-${Date.now()}-${randomId()}@example.invalid`,
        name: 'FF',
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
    const acct = await prisma.providerAccount.create({
      data: {
        label: 'demo',
        provider: 'demo',
        demo: true,
        status: 'active',
        organizationId: org.id,
      },
    });
    const v = await prisma.vehicle.create({
      data: {
        displayName: 'Atlas',
        provider: 'demo',
        providerVehicleId: 'demo-atlas',
        organizationId: org.id,
        providerAccountId: acct.id,
        demo: true,
      },
    });
    // Stored label says live, but fetchedAt is 14 minutes old.
    await prisma.vehicleSnapshot.create({
      data: {
        vehicleId: v.id,
        state: { status: 'charging', batteryPercent: 50, liveAtIngest: true },
        fetchedAt: new Date(Date.now() - 14 * 60000),
        freshness: 'live',
      },
    });
    const session = await createSession(u.id, '127.0.0.1');
    const agent = request.agent(base).set('Cookie', `vl_session=${session.token}`);
    const res = await agent.get('/api/v1/vehicles');
    expect(res.status).toBe(200);
    const atlas = res.body.data.find((x: { id: string }) => x.id === v.id);
    expect(atlas.state.freshness).not.toBe('live');
    expect(atlas.state.freshness).toBe('stale');
  });
});
