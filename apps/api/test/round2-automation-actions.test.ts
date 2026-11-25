// R5: automation action realism (N-ACTIONSTUBS, N-CONDITIONS):
// tag_drive really tags a drive, previous_result reads the last run's result,
// maxRetries actually retries, and the hourly budget prevents loops.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/core/db';
import { initRedis } from '../src/core/redis';
import { randomId, hashPassword } from '../src/core/crypto';
import { runAutomation, evaluateCondition } from '../src/automations/engine';
import { issueCommand } from '../src/commands/service';

// TI-13: count command-pipeline attempts. The engine imports the module
// dynamically, so mock it module-wide with a passthrough spy and count calls
// by action type below.
vi.mock('../src/commands/service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/commands/service')>();
  return { ...actual, issueCommand: vi.fn(actual.issueCommand) };
});

beforeAll(async () => {
  await initRedis();
}, 30_000);

afterAll(async () => {
  await prisma.$disconnect();
});

async function mkWorld() {
  const user = await prisma.user.create({
    data: {
      email: `au-${Date.now()}-${randomId()}@example.invalid`,
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
    data: {
      organizationId: org.id,
      provider: 'demo',
      label: 'Demo',
      status: 'connected',
      demo: true,
    },
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
      // TI-13: the vehicle must accept flash_lights so a successful command
      // action really creates a VehicleCommand row (the old fixture had no
      // capabilities, so every command action was UNSUPPORTED before any row).
      capabilities: JSON.parse('["flash_lights"]'),
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

describe('automation actions are real (N-ACTIONSTUBS)', { tags: ['automation'] }, () => {
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
    const res = await runAutomation(auto.id, {
      type: 'drive_started',
      vehicleId: vehicle.id,
    } as never);
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
      await evaluateCondition(
        'previous_result',
        { value: 'success' },
        {
          previousResult: 'success',
          now: new Date(),
        },
      ),
    ).toBe(true);
    expect(
      await evaluateCondition(
        'previous_result',
        { value: 'success' },
        {
          previousResult: 'failed',
          now: new Date(),
        },
      ),
    ).toBe(false);
    const ran = await runAutomation(auto.id, { type: 'drive_started' } as never);
    expect(ran.result).toBe('success');
  });

  // TI-13: the spec is per-ACTION retry — only the FAILING action is re-run,
  // and a PERMANENT failure (CommandError 4xx: VALIDATION / UNSUPPORTED /
  // UNKNOWN_COMMAND) is attempted exactly once. Successful actions
  // (notify_app, flash_lights) must fire exactly once.
  it('TI-13 maxRetries retries only the failed action, without duplicate side effects', async () => {
    const { vehicle, automation } = await mkWorld();
    const auto = await automation({
      maxRetries: 2,
      actions: JSON.parse(
        '[{"type":"notify_app","params":{"message":"attempt"}},{"type":"flash_lights","params":{}},{"type":"set_charge_limit","params":{"chargeLimitPct":5}}]',
      ),
    });
    const res = await runAutomation(auto.id, {
      type: 'drive_started',
      vehicleId: vehicle.id,
    } as never);
    expect(res.result).toBe('failed');

    // notify_app fires once — never once per attempt.
    const inbox = await prisma.appNotification.count({
      where: { userId: auto.userId, event: 'automation_fired' },
    });
    expect(inbox, 'notify_app must fire once, not once per retry').toBe(1);

    // The successful flash_lights command is issued exactly once.
    const cmds = await prisma.vehicleCommand.count({
      where: { vehicleId: vehicle.id, type: 'flash_lights' },
    });
    expect(cmds, 'a successful action must not be re-issued').toBe(1);

    // The permanent validation error (chargeLimitPct 5 is outside 50..100) is
    // attempted exactly once through the command pipeline, not once per retry.
    const setChargeCalls = vi
      .mocked(issueCommand)
      .mock.calls.filter((c) => c[2] === 'set_charge_limit');
    expect(
      setChargeCalls,
      'a permanent validation error must reach issueCommand exactly once',
    ).toHaveLength(1);

    const failed = res.actionResults.filter((r) => r.action === 'set_charge_limit');
    expect(failed).toHaveLength(1);
    expect(failed[0]!.ok).toBe(false);
    expect(res.actionResults.length).toBe(3);
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
    const res = await runAutomation(auto.id, { type: 'scheduled' } as never);
    expect(res.result).toBe('budget_exceeded');
    expect(res.actionResults).toEqual([]);
  });
});
