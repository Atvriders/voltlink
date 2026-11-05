// Round-2 security regression tests (ROUND2_PLAN §R2): Z-AUTOXTENANT and
// Z-RETENTION. Each test reproduces the verifier's live finding.

process.env.NODE_ENV = 'test';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildApp } from '../src/app';
import { prisma } from '../src/core/db';
import { initRedis } from '../src/core/redis';
import { createSession } from '../src/auth/service';
import { dispatchTrigger } from '../src/automations/engine';
import { runRetention } from '../src/telemetry/retention';
import { randomId } from '../src/core/crypto';

let server: Server;
let base: string;

const pw = '$argon2id$v=19$m=19456,t=2,p=1$s$s';

async function mkUser(email: string) {
  return prisma.user.create({
    data: {
      email,
      name: email.split('@')[0]!,
      passwordHash: pw,
      emailVerifiedAt: new Date(),
      webauthnUserId: randomId(),
    },
  });
}

beforeAll(async () => {
  await initRedis();
  server = buildApp({ serveSpa: false }).listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 30_000);

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
}, 15_000);

describe('Z-AUTOXTENANT', () => {
  it('a system event only fires automations of the vehicle own organization', async () => {
    const alice = await mkUser(`mx-alice-${Date.now()}@example.test`);
    const bob = await mkUser(`mx-bob-${Date.now()}@example.test`);
    const orgA = await prisma.organization.create({
      data: {
        kind: 'TEAM',
        name: 'Alice org',
        memberships: { create: { userId: alice.id, role: 'OWNER' } },
      },
    });
    const orgB = await prisma.organization.create({
      data: {
        kind: 'TEAM',
        name: 'Bob org',
        memberships: { create: { userId: bob.id, role: 'OWNER' } },
      },
    });
    const provA = await prisma.providerAccount.create({
      data: { organizationId: orgA.id, provider: 'demo', label: 'demo', status: 'connected', demo: true },
    });
    const vehicleA = await prisma.vehicle.create({
      data: {
        organizationId: orgA.id,
        providerAccountId: provA.id,
        provider: 'demo',
        providerVehicleId: randomId(),
        displayName: 'Victim',
        demo: true,
      },
    });
    // Bob's 'all vehicles' drive_started automation must never see Alice's car.
    const bobAuto = await prisma.automation.create({
      data: {
        organizationId: orgB.id,
        userId: bob.id,
        name: 'Bob all-vehicles',
        triggerType: 'drive_started',
        triggerParams: {},
        conditions: [],
        actions: [],
      },
    });
    const fired = await dispatchTrigger({
      type: 'drive_started',
      vehicleId: vehicleA.id,
      data: {},
    });
    expect(fired).toBe(0);
    const runs = await prisma.automationExecution.count({ where: { automationId: bobAuto.id } });
    expect(runs).toBe(0);

    // The demo webhook refuses another tenant's vehicle.
    const { token: bobToken } = await createSession(bob.id);
    const agent = request.agent(base).set('Cookie', `vl_session=${bobToken}`);
    let res = await agent.post('/api/v1/providers/demo/webhook').send({ vehicleId: vehicleA.id, type: 'trigger', payload: {} });
    if (res.status === 403 && res.body?.error?.code === 'CSRF') {
      const cookies = (res.headers['set-cookie'] ?? []) as unknown as string[];
      const csrfCookie = cookies.map((c) => (c ?? '').split(';')[0]).find((c) => c?.startsWith('vl_csrf=')) ?? '';
      res = await agent
        .post('/api/v1/providers/demo/webhook')
        .set('x-vl-csrf', csrfCookie.split('=')[1] ?? '')
        .send({ vehicleId: vehicleA.id, type: 'trigger', payload: {} });
    }
    expect(res.status).toBe(404);

    await prisma.organization.deleteMany({ where: { id: { in: [orgA.id, orgB.id] } } });
    await prisma.user.deleteMany({ where: { id: { in: [alice.id, bob.id] } } });
  }, 30_000);
});

describe('R2-13 public incidents', () => {
  it('the public incident list serves public incidents only and scrubs authors', async () => {
    const u = await mkUser(`mx-op-${Date.now()}@example.test`);
    await prisma.incident.create({
      data: {
        title: `PRIVATE-${randomId()}`,
        severity: 'critical',
        status: 'investigating',
        components: JSON.parse('["api"]'),
        public: false,
        createdById: u.id,
      },
    });
    const pub = await prisma.incident.create({
      data: {
        title: `PUBLIC-${randomId()}`,
        severity: 'major',
        status: 'investigating',
        components: JSON.parse('["api"]'),
        public: true,
        createdById: u.id,
        updates: {
          create: { phase: 'investigating', message: 'internal detail', author: u.id },
        },
      },
    });
    const res = await request(base).get('/api/v1/status/incidents');
    expect(res.status).toBe(200);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain('PRIVATE-');
    expect(text).toContain(`PUBLIC-${pub.id}`.slice(0, 6)); // title visible
    const publicDto = (res.body as { data: { id: string; updates: { author: string }[] }[] }).data.find((i) => i.id === pub.id);
    expect(publicDto?.updates[0]?.author).toBe('VoltLink');
    expect(text).not.toContain(u.id);
  }, 30_000);
});

describe('R2-11 fleet overview snapshot keys', () => {
  it('reads batteryPercent, chargingState and status from the snapshot state', async () => {
    const u = await mkUser(`mx-fl-${Date.now()}@example.test`);
    const org = await prisma.organization.create({
      data: { kind: 'TEAM', name: 'Fleet org', memberships: { create: { userId: u.id, role: 'OWNER' } } },
    });
    const prov = await prisma.providerAccount.create({
      data: { organizationId: org.id, provider: 'demo', label: 'demo', status: 'connected', demo: true },
    });
    const vehicle = await prisma.vehicle.create({
      data: {
        organizationId: org.id,
        providerAccountId: prov.id,
        provider: 'demo',
        providerVehicleId: randomId(),
        displayName: 'Charging Car',
        demo: true,
      },
    });
    await prisma.vehicleSnapshot.create({
      data: {
        vehicleId: vehicle.id,
        state: JSON.parse(JSON.stringify({ batteryPercent: 42, chargingState: 'charging', status: 'offline' })),
        fetchedAt: new Date(),
      },
    });
    const { token } = await createSession(u.id);
    const agent = request.agent(base).set('Cookie', `vl_session=${token}`);
    const res = await agent.get('/api/v1/fleet/overview');
    expect(res.status).toBe(200);
    const row = (res.body as { data: { vehicles: { displayName: string; batteryPct: number | null; charging: boolean; offline: boolean }[] } }).data.vehicles.find((v) => v.displayName === 'Charging Car');
    expect(row?.batteryPct).toBe(42);
    expect(row?.charging).toBe(true);
    expect(row?.offline).toBe(true);
    await prisma.organization.delete({ where: { id: org.id } });
    await prisma.user.delete({ where: { id: u.id } });
  }, 30_000);
});

describe('R2-06 export honors grants', () => {
  it('a GRANTED member exports only the granted vehicle', async () => {
    const owner = await mkUser(`mx-eo-${Date.now()}@example.test`);
    const grantee = await mkUser(`mx-eg-${Date.now()}@example.test`);
    const org = await prisma.organization.create({
      data: {
        kind: 'TEAM',
        name: 'Export org',
        memberships: {
          create: [
            { userId: owner.id, role: 'OWNER' },
            { userId: grantee.id, role: 'VIEWER', vehicleScope: 'GRANTED' },
          ],
        },
      },
    });
    const prov = await prisma.providerAccount.create({
      data: { organizationId: org.id, provider: 'demo', label: 'demo', status: 'connected', demo: true },
    });
    const v1 = await prisma.vehicle.create({
      data: { organizationId: org.id, providerAccountId: prov.id, provider: 'demo', providerVehicleId: randomId(), displayName: 'Granted', demo: true },
    });
    await prisma.vehicle.create({
      data: { organizationId: org.id, providerAccountId: prov.id, provider: 'demo', providerVehicleId: randomId(), displayName: 'Hidden', demo: true },
    });
    await prisma.vehicleGrant.create({
      data: { vehicleId: v1.id, userId: grantee.id, level: 'VIEWER', grantedById: owner.id },
    });
    const { token } = await createSession(grantee.id);
    const agent = request.agent(base).set('Cookie', `vl_session=${token}`);
    const res = await agent.get('/api/v1/users/export');
    expect(res.status).toBe(200);
    const body = JSON.parse(res.text) as { vehicles: { displayName: string }[] };
    expect(body.vehicles.map((v) => v.displayName)).toEqual(['Granted']);
    await prisma.organization.delete({ where: { id: org.id } });
    await prisma.user.deleteMany({ where: { id: { in: [owner.id, grantee.id] } } });
  }, 30_000);
});

describe('Z-RETENTION', () => {
  it('applies each organization own retention, not only the global value', async () => {
    const u = await mkUser(`mx-ret-${Date.now()}@example.test`);
    const org = await prisma.organization.create({
      data: {
        kind: 'TEAM',
        name: 'Short retention org',
        telemetryRetentionDays: 1,
        locationRetentionDays: 1,
        memberships: { create: { userId: u.id, role: 'OWNER' } },
      },
    });
    const prov = await prisma.providerAccount.create({
      data: { organizationId: org.id, provider: 'demo', label: 'demo', status: 'connected', demo: true },
    });
    const vehicle = await prisma.vehicle.create({
      data: {
        organizationId: org.id,
        providerAccountId: prov.id,
        provider: 'demo',
        providerVehicleId: randomId(),
        displayName: 'Old',
        demo: true,
      },
    });
    const oldDrive = await prisma.drive.create({
      data: {
        vehicleId: vehicle.id,
        startAt: new Date(Date.now() - 5 * 86400000),
        endAt: new Date(Date.now() - 5 * 86400000 + 60000),
        distanceKm: 1,
        durationSec: 60,
        avgSpeedKmh: 60,
        maxSpeedKmh: 60,
        energyKwh: 0.2,
        efficiencyWhPerKm: 200,
      },
    });
    await prisma.driveRoutePoint.create({
      data: {
        driveId: oldDrive.id,
        seq: 1,
        ts: new Date(Date.now() - 5 * 86400000),
        lat: 1,
        lon: 1,
        speedKmh: 30,
      },
    });

    await runRetention();

    const remainingPoints = await prisma.driveRoutePoint.count({ where: { driveId: oldDrive.id } });
    expect(remainingPoints, 'org with 1-day retention loses old route points').toBe(0);

    await prisma.organization.delete({ where: { id: org.id } });
    await prisma.user.delete({ where: { id: u.id } });
  }, 30_000);
});
