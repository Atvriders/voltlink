// Round-2 security regression tests (ROUND2_PLAN §R2): Z-AUTOXTENANT and
// Z-RETENTION. Each test reproduces the verifier's live finding.

process.env.NODE_ENV = 'test';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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

describe('Z-AUTOXTENANT', { tags: ['security'] }, () => {
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
      data: {
        organizationId: orgA.id,
        provider: 'demo',
        label: 'demo',
        status: 'connected',
        demo: true,
      },
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
    let res = await agent
      .post('/api/v1/providers/demo/webhook')
      .send({ vehicleId: vehicleA.id, type: 'trigger', payload: {} });
    if (res.status === 403 && res.body?.error?.code === 'CSRF') {
      const cookies = (res.headers['set-cookie'] ?? []) as unknown as string[];
      const csrfCookie =
        cookies.map((c) => (c ?? '').split(';')[0]).find((c) => c?.startsWith('vl_csrf=')) ?? '';
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

describe('NEW-02 / Z-ROLERANK invitations', () => {
  it('invitations need step-up and can never mint an OWNER', async () => {
    const u = await mkUser(`mx-inv-${Date.now()}@example.test`);
    const org = await prisma.organization.create({
      data: {
        kind: 'TEAM',
        name: 'Inv org',
        memberships: { create: { userId: u.id, role: 'OWNER' } },
      },
    });
    const { token, sessionId } = await createSession(u.id);
    const agent = request.agent(base).set('Cookie', `vl_session=${token}`);
    // No recent step-up -> refused.
    let res = await agent
      .post(`/api/v1/orgs/${org.id}/invitations`)
      .send({ email: 'x@example.test', role: 'VIEWER' });
    if (res.status === 403 && res.body?.error?.code === 'CSRF') {
      const cookies = (res.headers['set-cookie'] ?? []) as unknown as string[];
      const csrfCookie =
        cookies.map((c) => (c ?? '').split(';')[0]).find((c) => c?.startsWith('vl_csrf=')) ?? '';
      res = await agent
        .post(`/api/v1/orgs/${org.id}/invitations`)
        .set('x-vl-csrf', csrfCookie.split('=')[1] ?? '')
        .send({ email: 'x@example.test', role: 'VIEWER' });
    }
    expect(res.status).toBe(403);
    expect(res.body?.error?.code).toBe('STEP_UP_REQUIRED');
    // Even with step-up, an OWNER invitation is rejected.
    await prisma.userSession.update({
      where: { id: sessionId },
      data: { stepUpAt: new Date(), stepUpMethod: 'password' },
    });
    // CSRF handling: fetch a valid csrf for the step-upped session.
    const csrfRes = await agent.get('/api/v1/auth/csrf');
    const csrf = ((await csrfRes.body) as { data: { token: string } }).data.token;
    const res2 = await agent
      .post(`/api/v1/orgs/${org.id}/invitations`)
      .set('x-vl-csrf', csrf)
      .send({ email: 'x@example.test', role: 'OWNER' });
    expect(res2.status).toBe(400);
    expect(res2.body?.error?.code).toBe('ROLE_NOT_ASSIGNABLE');
    await prisma.organization.delete({ where: { id: org.id } });
    await prisma.user.delete({ where: { id: u.id } });
  }, 30_000);
});

describe('NEW-04 passkey verify body', () => {
  it('answers 400 instead of 500 for a bodyless passkey login verify', async () => {
    const agent = request.agent(base);
    const csrfRes = await agent.get('/api/v1/auth/csrf');
    const csrf = ((await csrfRes.body) as { data: { token: string } }).data.token;
    const res = await agent.post('/api/v1/auth/passkey/login/verify').set('x-vl-csrf', csrf).send();
    expect(res.status).toBe(400);
  }, 30_000);
});

describe('A-TOKENLOG mail console default', () => {
  it('MAIL_TO_CONSOLE defaults to false unless explicitly enabled', async () => {
    const { env } = await import('../src/core/env');
    expect(env.MAIL_TO_CONSOLE).toBe(false);
  });

  // A-TOKENLOG fix text: removing the production refusal in env.ts makes THIS
  // test fail. The module graph is reset so env.ts parses fresh with
  // production values (the file-level module is otherwise cached as test).
  it('production boot refuses MAIL_TO_CONSOLE=true', async () => {
    vi.resetModules();
    const saved = {
      NODE_ENV: process.env.NODE_ENV,
      JWT_SECRET: process.env.JWT_SECRET,
      VL_MASTER_KEY: process.env.VL_MASTER_KEY,
      PUBLIC_URL: process.env.PUBLIC_URL,
      MAIL_TO_CONSOLE: process.env.MAIL_TO_CONSOLE,
      SMTP_URL: process.env.SMTP_URL,
    };
    try {
      process.env.NODE_ENV = 'production';
      process.env.JWT_SECRET = 'j'.repeat(64);
      process.env.VL_MASTER_KEY = Buffer.alloc(32, 3).toString('base64');
      process.env.PUBLIC_URL = 'https://voltlink.example.com';
      process.env.MAIL_TO_CONSOLE = 'true';
      process.env.SMTP_URL = '';
      const { validateEnv } = await import('../src/core/env');
      expect(() => validateEnv()).toThrow(/MAIL_TO_CONSOLE=true is not allowed in production/);
    } finally {
      vi.resetModules();
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe('N-CHANSECRETS webhook url', () => {
  it('stores webhook endpoint URLs sealed at rest', async () => {
    const u = await mkUser(`mx-wh-${Date.now()}@example.test`);
    const { token } = await createSession(u.id);
    const agent = request.agent(base).set('Cookie', `vl_session=${token}`);
    const csrfRes = await agent.get('/api/v1/auth/csrf');
    const csrf = ((await csrfRes.body) as { data: { token: string } }).data.token;
    const secretUrl = 'https://example.com/hook?token=supersecret';
    const res = await agent
      .post('/api/v1/notifications/webhooks')
      .set('x-vl-csrf', csrf)
      .send({ name: 'Sealed', url: secretUrl });
    expect(res.status).toBe(201);
    const row = await prisma.webhookEndpoint.findFirstOrThrow({ where: { userId: u.id } });
    expect(row.url).not.toContain('supersecret');
    expect(row.url).not.toBe(secretUrl);
    await prisma.webhookEndpoint.delete({ where: { id: row.id } });
    await prisma.user.delete({ where: { id: u.id } });
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
    // TI-48: assert the FULL public title, not a slice that is the constant
    // 'PUBLIC' for every id.
    const publicDto = (
      res.body as {
        data: { id: string; title: string; updates: { author: string }[] }[];
      }
    ).data.find((i) => i.id === pub.id);
    expect(publicDto).toBeDefined();
    expect(publicDto?.title).toBe(pub.title);
    expect(publicDto?.updates[0]?.author).toBe('VoltLink');
    expect(text).not.toContain(u.id);
  }, 30_000);
});

describe('R2-11 fleet overview snapshot keys', () => {
  it('reads batteryPercent, chargingState and status from the snapshot state', async () => {
    const u = await mkUser(`mx-fl-${Date.now()}@example.test`);
    const org = await prisma.organization.create({
      data: {
        kind: 'TEAM',
        name: 'Fleet org',
        memberships: { create: { userId: u.id, role: 'OWNER' } },
      },
    });
    const prov = await prisma.providerAccount.create({
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
        state: JSON.parse(
          JSON.stringify({ batteryPercent: 42, chargingState: 'charging', status: 'offline' }),
        ),
        fetchedAt: new Date(),
      },
    });
    const { token } = await createSession(u.id);
    const agent = request.agent(base).set('Cookie', `vl_session=${token}`);
    const res = await agent.get('/api/v1/fleet/overview');
    expect(res.status).toBe(200);
    const row = (
      res.body as {
        data: {
          vehicles: {
            displayName: string;
            batteryPct: number | null;
            charging: boolean;
            offline: boolean;
          }[];
        };
      }
    ).data.vehicles.find((v) => v.displayName === 'Charging Car');
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
      data: {
        organizationId: org.id,
        provider: 'demo',
        label: 'demo',
        status: 'connected',
        demo: true,
      },
    });
    const v1 = await prisma.vehicle.create({
      data: {
        organizationId: org.id,
        providerAccountId: prov.id,
        provider: 'demo',
        providerVehicleId: randomId(),
        displayName: 'Granted',
        demo: true,
      },
    });
    await prisma.vehicle.create({
      data: {
        organizationId: org.id,
        providerAccountId: prov.id,
        provider: 'demo',
        providerVehicleId: randomId(),
        displayName: 'Hidden',
        demo: true,
      },
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

describe('Z-RETENTION', { tags: ['retention'] }, () => {
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
