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

describe('scheduler leader lock', () => {
  it('two concurrent ticks plan a due vehicle exactly once', async () => {
    const org = await prisma.organization.create({ data: { name: `SL-${Date.now()}` } });
    const account = await prisma.providerAccount.create({
      data: { organizationId: org.id, provider: 'demo', label: 'Demo', status: 'connected', demo: false },
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
        nextPollAt: new Date(Date.now() - 1_000),
        connectivity: 'online',
        activity: {},
        lastVehicleDataAt: new Date(),
      },
    });

    const [a, b] = await Promise.all([poller.tick(), poller.tick()]);
    expect(a + b).toBe(1);

    const after = await prisma.vehiclePollState.findUniqueOrThrow({
      where: { vehicleId: vehicle.id },
    });
    // The lease landed on the planned instant (never far in the past) and is
    // no longer the overdue value the concurrent ticks both loaded.
    expect(after.nextPollAt.getTime()).toBeGreaterThan(Date.now() - 5_000);
    expect(after.nextPollAt.getTime()).not.toBeLessThan(0);

    await prisma.vehiclePollState.delete({ where: { vehicleId: vehicle.id } });
    await prisma.vehicle.delete({ where: { id: vehicle.id } });
    await prisma.providerAccount.delete({ where: { id: account.id } });
    await prisma.organization.delete({ where: { id: org.id } });
  });
});
