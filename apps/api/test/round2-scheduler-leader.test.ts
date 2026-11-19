// R4: scheduler leader lock — two concurrent ticks must never double-plan a
// vehicle (the compare-and-set lease on nextPollAt is the leader lock).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/core/db';
import { initRedis } from '../src/core/redis';
import { poller } from '../src/telemetry/poller';
import { randomId } from '../src/core/crypto';

beforeAll(async () => {
  await initRedis();
}, 30_000);

afterAll(async () => {
  poller.stop();
  await prisma.$disconnect();
});

describe('scheduler leader lock', { tags: ['scheduler'] }, () => {
  it('two concurrent ticks plan a due vehicle exactly once', async () => {
    const org = await prisma.organization.create({ data: { name: `SL-${Date.now()}` } });
    const account = await prisma.providerAccount.create({
      data: {
        organizationId: org.id,
        provider: 'demo',
        label: 'Demo',
        status: 'connected',
        demo: false,
      },
    });
    const vehicle = await prisma.vehicle.create({
      data: {
        organizationId: org.id,
        providerAccountId: account.id,
        provider: 'demo',
        providerVehicleId: randomId(),
        displayName: 'L',
      },
    });
    await prisma.vehiclePollState.create({
      data: {
        vehicleId: vehicle.id,
        // TI-16/TI-48: clearly overdue, so a stale row FAILS the assertions
        // below (the old row started at now-1s and the weak '> now-5s' check
        // passed without any tick doing anything).
        nextPollAt: new Date(Date.now() - 60_000),
        connectivity: 'online',
        activity: {},
        lastVehicleDataAt: new Date(),
        // The planner plans a first-fetch IMMEDIATELY (nextAt = now) when
        // lastActivityAt is missing; give the vehicle an idle history so the
        // lease lands at least the idle interval in the future.
        lastActivityAt: new Date(Date.now() - 60_000),
      },
    });

    const tickStart = Date.now();
    const [a, b] = await Promise.all([poller.tick(), poller.tick()]);
    expect(a + b).toBe(1);

    const after = await prisma.vehiclePollState.findUniqueOrThrow({
      where: { vehicleId: vehicle.id },
    });
    // The lease landed on the PLANNED instant: at least the planner's minimum
    // interval (DEFAULT_TUNING.pendingSec = 15 s) into the future from the
    // tick, never the stale overdue value both ticks loaded.
    const minIntervalMs = 15_000;
    expect(after.nextPollAt.getTime()).toBeGreaterThanOrEqual(tickStart + minIntervalMs - 2_000);

    await prisma.vehiclePollState.delete({ where: { vehicleId: vehicle.id } });
    await prisma.vehicle.delete({ where: { id: vehicle.id } });
    await prisma.providerAccount.delete({ where: { id: account.id } });
    await prisma.organization.delete({ where: { id: org.id } });
  });
});
