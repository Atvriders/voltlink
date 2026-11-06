// R5: automation action realism (N-ACTIONSTUBS, N-CONDITIONS):
// tag_drive really tags a drive, previous_result reads the last run's result,
// maxRetries actually retries, and the hourly budget prevents loops.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/core/db';
import { initRedis } from '../src/core/redis';
import { randomId, hashPassword } from '../src/core/crypto';
import { runAutomation, evaluateCondition } from '../src/automations/engine';

beforeAll(async () => {
  await initRedis();
}, 30_000);

afterAll(async () => {
  await prisma.$disconnect();
});

async function mkWorld() {
  const user = await prisma.user.create({
    data: {
      email: `au-${Date.now()}-${randomId()}@test.dev`,
      name: 'Auto',
      passwordHash: await hashPassword('long-enough-123'),
      webauthnUserId: randomId(),
    },
  });
  const org = await prisma.organization.create({
    data: {
      kind: 'PERSONAL',
      name: 'Auto Org',
      createdById: user.id,
      memberships: { create: { userId: user.id, role: 'OWNER' } },
    },
  });
  const pa = await prisma.providerAccount.create({
    data: { organizationId: org.id, provider: 'demo', label: 'Demo', status: 'connected', demo: true },
  });
  const vehicle = await prisma.vehicle.create({
    data: {
      organizationId: org.id,
      providerAccountId: pa.id,
      provider: 'demo',
      providerVehicleId: randomId(),
      displayName: 'A',
      demo: true,
      addedById: user.id,
    },
  });
  const automation = (over: Record<string, unknown> = {}) =>
    prisma.automation.create({
      data: {
        organizationId: org.id,
        userId: user.id,
        name: `A-${randomId()}`,
        triggerType: 'drive_started',
        conditions: JSON.parse('[]'),
        actions: JSON.parse('[]'),
        ...over,
      },
    });
  return { user, org, vehicle, automation };
}

describe('automation actions are real (N-ACTIONSTUBS)', () => {
  it('tag_drive appends a tag to the latest drive', async () => {
    const { vehicle, automation } = await mkWorld();
    const drive = await prisma.drive.create({
      data: {
        vehicleId: vehicle.id,
        startAt: new Date(Date.now() - 3600_000),
        endAt: new Date(Date.now() - 3500_000),
        distanceKm: 12.3,
        durationSec: 600,
        avgSpeedKmh: 74,
        maxSpeedKmh: 110,
        energyKwh: 2.1,
        efficiencyWhPerKm: 170,
        currency: 'USD',
        tags: JSON.parse('["morning"]'),
      },
    });
    const auto = await automation({
      actions: JSON.parse('[{"type":"tag_drive","params":{"tag":"automation-trip"}}]'),
    });
    const res = await runAutomation(auto.id, { type: 'drive_started', vehicleId: vehicle.id });
    expect(res.result).toBe('success');
    const after = await prisma.drive.findUniqueOrThrow({ where: { id: drive.id } });
    expect(after.tags).toContain('automation-trip');
    expect(after.tags).toContain('morning');
  });

  it('previous_result condition matches the last run result', async () => {
    const { automation } = await mkWorld();
    const auto = await automation({
      lastResult: 'success',
      conditions: JSON.parse('[{"type":"previous_result","params":{"value":"success"}}]'),
      actions: JSON.parse('[{"type":"notify_app","params":{"message":"hi"}}]'),
    });
    expect(
      await evaluateCondition('previous_result', { value: 'success' }, {
        previousResult: 'success',
        now: new Date(),
      }),
    ).toBe(true);
    expect(
      await evaluateCondition('previous_result', { value: 'success' }, {
        previousResult: 'failed',
        now: new Date(),
      }),
    ).toBe(false);
    const ran = await runAutomation(auto.id, { type: 'drive_started' });
    expect(ran.result).toBe('success');
  });

  it('maxRetries retries failed actions up to the configured count', async () => {
    const { vehicle, automation } = await mkWorld();
    const auto = await automation({
      maxRetries: 2,
      actions: JSON.parse(
        '[{"type":"notify_app","params":{"message":"attempt"}},{"type":"set_charge_limit","params":{"chargeLimitPct":5}}]',
      ),
    });
    const res = await runAutomation(auto.id, { type: 'drive_started', vehicleId: vehicle.id });
    expect(res.result).toBe('failed');
    // notify_app runs once per attempt: 1 + maxRetries = 3 in-app rows.
    const inbox = await prisma.appNotification.count({
      where: { userId: auto.userId, event: 'automation_fired' },
    });
    expect(inbox).toBe(3);
    expect(res.actionResults.length).toBeGreaterThan(0);
  });

  it('the hourly budget blocks a runaway automation (loop prevention)', async () => {
    const { automation } = await mkWorld();
    const auto = await automation({
      actions: JSON.parse('[{"type":"notify_app","params":{"message":"loop"}}]'),
    });
    const hourAgo = new Date(Date.now() - 1800_000);
    for (let i = 0; i < 60; i++) {
      await prisma.automationExecution.create({
        data: {
          automationId: auto.id,
          triggeredAt: hourAgo,
          triggerEvent: 'scheduled',
          result: 'success',
          actionResults: JSON.parse('[]'),
        },
      });
    }
    const res = await runAutomation(auto.id, { type: 'scheduled' });
    expect(res.result).toBe('budget_exceeded');
    expect(res.actionResults).toEqual([]);
  });
});
