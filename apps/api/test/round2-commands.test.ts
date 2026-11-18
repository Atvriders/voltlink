// Round-2 command pipeline tests (ROUND2_PLAN §R4): R2-08, R2-09, R2-10.

process.env.NODE_ENV = 'test';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/core/db';
import { initRedis, producerConnection } from '../src/core/redis';

import { randomId } from '../src/core/crypto';
import { runAutomation } from '../src/automations/engine';
import { processCommandJob, sweepStuckCommands } from '../src/commands/service';
import { queue } from '../src/jobs/queues';

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
}, 30_000);

afterAll(async () => {
  await prisma.$disconnect();
}, 15_000);

describe('R2-10 automation vehicle commands', () => {
  it('an automation can dispatch a command on its own vehicle', async () => {
    const u = await mkUser(`mx-a10-${Date.now()}@example.test`);
    const org = await prisma.organization.create({
      data: {
        kind: 'TEAM',
        name: 'Auto org',
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
        providerVehicleId: 'demo-aurora',
        displayName: 'Aurora',
        demo: true,
        capabilities: JSON.parse(JSON.stringify(['honk_horn', 'flash_lights', 'wake'])),
      },
    });
    const auto = await prisma.automation.create({
      data: {
        organizationId: org.id,
        userId: u.id,
        name: 'Flash Aurora',
        triggerType: 'scheduled',
        triggerParams: {},
        conditions: [],
        actions: JSON.parse(JSON.stringify([{ type: 'honk_horn', params: {} }])),
      },
    });
    const run = await runAutomation(auto.id, {
      type: 'scheduled',
      userId: u.id,
      organizationId: org.id,
      vehicleId: vehicle.id,
      data: {},
    });
    expect(run.result).toBe('success');
    expect(run.actionResults[0]?.ok).toBe(true);
    const cmd = await prisma.vehicleCommand.findFirst({
      where: { vehicleId: vehicle.id, automationId: auto.id },
    });
    expect(cmd).toBeTruthy();
    await prisma.organization.delete({ where: { id: org.id } });
    await prisma.user.delete({ where: { id: u.id } });
  }, 30_000);
});

describe('R2-08 sweeper spares accepted not_observable', () => {
  it('an accepted not_observable command is terminal and never swept', async () => {
    const u = await mkUser(`mx-a08-${Date.now()}@example.test`);
    const org = await prisma.organization.create({
      data: {
        kind: 'TEAM',
        name: 'Sweep org',
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
        providerVehicleId: 'demo-aurora',
        displayName: 'Aurora',
        demo: true,
      },
    });
    const cmd = await prisma.vehicleCommand.create({
      data: {
        organizationId: org.id,
        userId: u.id,
        vehicleId: vehicle.id,
        vehicleName: 'Aurora',
        providerAccountId: prov.id,
        actorKind: 'session',
        type: 'honk_horn',
        params: {},
        status: 'accepted',
        risk: 'low',
        idempotencyKey: `mx:${randomId()}`,
        confirmation: 'not_observable',
        submittedAt: new Date(Date.now() - 10 * 60_000),
      },
    });
    const swept = await sweepStuckCommands();
    expect(swept).toBe(0);
    const after = await prisma.vehicleCommand.findUniqueOrThrow({ where: { id: cmd.id } });
    expect(after.status).toBe('accepted');
    await prisma.organization.delete({ where: { id: org.id } });
    await prisma.user.delete({ where: { id: u.id } });
  }, 30_000);
});

describe('R2-09 dispatch lock reschedules instead of orphaning', () => {
  it('a busy vehicle dispatch reschedules its job with a delay', async () => {
    const u = await mkUser(`mx-a09-${Date.now()}@example.test`);
    const org = await prisma.organization.create({
      data: {
        kind: 'TEAM',
        name: 'Lock org',
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
        providerVehicleId: 'demo-aurora',
        displayName: 'Aurora',
        demo: true,
      },
    });
    const cmd = await prisma.vehicleCommand.create({
      data: {
        organizationId: org.id,
        userId: u.id,
        vehicleId: vehicle.id,
        vehicleName: 'Aurora',
        providerAccountId: prov.id,
        actorKind: 'session',
        type: 'honk_horn',
        params: {},
        status: 'queued',
        risk: 'low',
        idempotencyKey: `mx:${randomId()}`,
      },
    });
    // Simulate an in-flight dispatch holding the per-vehicle lock.
    await producerConnection().set(
      `voltlink:lock:vehicle-cmd:${vehicle.id}`,
      'other-command',
      'PX',
      60_000,
      'NX',
    );
    await processCommandJob({ commandId: cmd.id, stage: 'dispatch' });
    const delayed = await queue('vehicle-commands').getDelayed();
    // TI-54: the rescheduled job must be THIS command's job — the old test
    // accepted any delayed job in the queue.
    expect(delayed.some((j) => j.id === cmd.id)).toBe(true);
    const after = await prisma.vehicleCommand.findUniqueOrThrow({ where: { id: cmd.id } });
    expect(after.status).toBe('queued'); // untouched, rescheduled instead
    await producerConnection().del(`voltlink:lock:vehicle-cmd:${vehicle.id}`);
    await prisma.organization.delete({ where: { id: org.id } });
    await prisma.user.delete({ where: { id: u.id } });
  }, 30_000);
});
