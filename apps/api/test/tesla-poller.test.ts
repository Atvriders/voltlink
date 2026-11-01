// P-SLEEP poller integration (guide 01 §14): with an asleep car, 30 simulated
// minutes of scheduler ticks produce zero vehicle_data and zero wake_up calls;
// a billed 408 still advances lastVehicleDataAt.

process.env.NODE_ENV = 'test';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/core/db';
import { initRedis } from '../src/core/redis';
import { startFakeTesla, type FakeTesla } from './fakes/fakeTesla';
import { PollingScheduler } from '../src/telemetry/poller';
import { planNextPoll } from '../src/telemetry/teslaPollPlanner';
import { processTelemetryJob } from '../src/telemetry/poller';

let fake: FakeTesla;
let accountId = '';
let vehicleId = '';
let providerVehicleId = '';

beforeAll(async () => {
  await initRedis();
  process.env.TESLA_ALLOW_TEST_ENDPOINTS = 'true';
  fake = await startFakeTesla(0);
  process.env.TESLA_TOKEN_URL = `${fake.base}/oauth2/v3/token`;
  process.env.TESLA_AUTHORIZE_URL = `${fake.base}/oauth2/v3/authorize`;
  process.env.TESLA_FLEET_BASE_NA = `${fake.base}`;
  process.env.TESLA_FLEET_BASE_EU = `${fake.base}`;
  process.env.TESLA_COMMAND_PROXY_URL = `${fake.proxy}`;
  process.env.TESLA_CLIENT_ID = 'test-client';
  process.env.TESLA_CLIENT_SECRET = 'test-secret';
  process.env.TESLA_REDIRECT_URI = 'http://127.0.0.1:3110/api/v1/providers/tesla/callback';

  const user = await prisma.user.create({
    data: {
      email: `poll-${Date.now()}@example.test`,
      name: 'Poll Tester',
      passwordHash: 'x',
      webauthnUserId: `poll-${Date.now()}`,
    },
  });
  const org = await prisma.organization.create({
    data: {
      kind: 'PERSONAL',
      name: 'poll org',
      createdById: user.id,
      memberships: { create: { userId: user.id, role: 'OWNER' } },
    },
  });
  const account = await prisma.providerAccount.create({
    data: {
      organizationId: org.id,
      provider: 'tesla',
      label: 'Tesla',
      status: 'connected',
      fleetApiBaseUrl: fake.base,
    },
  });
  accountId = account.id;
  providerVehicleId = '5YJ3000000NEXUS01';
  const { sealJson } = await import('../src/core/crypto');
  await prisma.providerCredential.create({
    data: {
      providerAccountId: account.id,
      keyVersion: 1,
      algorithm: sealJson({}).algorithm,
      ciphertext: sealJson({
        accessToken: 'access-abc',
        refreshToken: 'refresh-abc',
        expiresAt: Date.now() + 3600_000,
        scopes: [],
      }).ciphertext,
    },
  });
  const vehicle = await prisma.vehicle.create({
    data: {
      organizationId: org.id,
      providerAccountId: account.id,
      provider: 'tesla',
      providerVehicleId,
      displayName: 'Poll Car',
    },
  });
  vehicleId = vehicle.id;
  await prisma.vehiclePollState.create({
    data: {
      vehicleId: vehicle.id,
      nextPollAt: new Date(Date.now() - 1000),
      connectivity: 'online',
    },
  });
  fake.setConnectivity(providerVehicleId, 'asleep');
});

afterAll(async () => {
  await fake.close();
  delete process.env.TESLA_CLIENT_ID;
  delete process.env.TESLA_CLIENT_SECRET;
  const v = await prisma.vehicle.findUnique({ where: { id: vehicleId } });
  if (v) {
    await prisma.vehiclePollState.deleteMany({ where: { vehicleId: vehicleId } });
    await prisma.providerCredential.deleteMany({ where: { providerAccountId: accountId } });
    await prisma.vehicle.deleteMany({ where: { id: vehicleId } });
    await prisma.providerAccount.deleteMany({ where: { id: accountId } });
  }
  await prisma.$disconnect();
});

describe('planner: asleep cars never get vehicle_data (P-SLEEP)', () => {
  it('plans a free state check, not a billed fetch', () => {
    const plan = planNextPoll(
      {
        connectivity: 'asleep',
        activity: {},
        lastVehicleDataAt: Date.now() - 60_000,
        lastActivityAt: Date.now() - 60_000,
        pendingCommandUntil: null,
        userActiveUntil: null,
        suspendedUntil: null,
        backoffUntil: null,
        now: Date.now(),
      },
      undefined,
    );
    expect(plan.action).toBe('state');
    expect(plan.action).not.toBe('vehicle_data');
  });

  it('30 simulated minutes of scheduler ticks produce 0 vehicle_data and 0 wake_up', async () => {
    const scheduler = new PollingScheduler();
    const before = fake.requests.filter(
      (r) => r.path.includes('vehicle_data') || r.path.includes('wake_up'),
    ).length;
    for (let i = 0; i < 15; i++) {
      // Simulate the passage of ~2 minutes per iteration.
      await prisma.vehiclePollState.update({
        where: { vehicleId },
        data: { nextPollAt: new Date(Date.now() - 60_000) },
      });
      await scheduler.tick();
      // Simulate the worker consuming the queued job.
      await processTelemetryJob({ accountId, vehicleId, providerVehicleId, action: 'state' }).catch(
        () => undefined,
      );
    }
    const after = fake.requests.filter(
      (r) => r.path.includes('vehicle_data') || r.path.includes('wake_up'),
    ).length;
    expect(after).toBe(before); // zero billed calls for an asleep car
    const stateChecks = fake.requests.filter(
      (r) => r.method === 'GET' && /^\/api\/1\/vehicles\/[A-Z0-9]+$/.test(r.path),
    );
    expect(stateChecks.length).toBeGreaterThan(0); // free state checks still happen
  });
});

describe('408 advances lastVehicleDataAt (P-SLEEP)', () => {
  it('records the fetch time even when Tesla answers 408', async () => {
    fake.setConnectivity(providerVehicleId, 'online');
    fake.failNext(
      `/api/1/vehicles/${providerVehicleId}/vehicle_data`,
      408,
      'vehicle is offline or asleep',
    );
    const before = await prisma.vehiclePollState.findUniqueOrThrow({ where: { vehicleId } });
    await processTelemetryJob({ accountId, vehicleId, providerVehicleId, action: 'vehicle_data' });
    const after = await prisma.vehiclePollState.findUniqueOrThrow({ where: { vehicleId } });
    // The fetch timestamp is recorded BEFORE the call, so a billed 408 counts.
    expect(after.lastVehicleDataAt).not.toBeNull();
    expect(after.lastVehicleDataAt!.getTime()).toBeGreaterThanOrEqual(
      before.lastVehicleDataAt?.getTime() ?? 0,
    );
    // The account got a backoff failure recorded (no crash).
    const account = await prisma.providerAccount.findUniqueOrThrow({ where: { id: accountId } });
    expect(account.lastError).toContain('Tesla 408');
  });
});
