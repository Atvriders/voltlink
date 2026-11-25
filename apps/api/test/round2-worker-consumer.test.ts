// round2-worker-consumer.test.ts — R2-18 / MW1: the REAL worker consumer
// (worker.ts main -> startWorker('vehicle-commands') -> processCommandJob) runs
// end to end: a honk issued over the queue reaches a terminal state and the
// event chain is queued -> submitted -> accepted. Mutant MW1 (the consumer
// never calls processCommandJob) leaves the command in 'queued' and this test
// fails.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/core/db';
import { initRedis } from '../src/core/redis';
import { randomId } from '../src/core/crypto';
import { issueCommand, getCommand } from '../src/commands/service';
import type { SessionActor } from '../src/authz/types';

const TERMINAL = ['accepted', 'not_observable', 'rejected', 'failed', 'timed_out'];

let vehicleId = '';
let cmdId = '';

const actor: SessionActor = {
  kind: 'session',
  userId: '',
  sessionId: randomId(),
  isInstanceAdmin: true,
  emailVerified: true,
  mfaEnrolled: true,
  stepUpAt: new Date(),
  stepUpMethod: 'password',
};

beforeAll(async () => {
  await initRedis();
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const org = await prisma.organization.create({
    data: {
      kind: 'PERSONAL',
      name: `MW1-${suffix}`,
      createdById: 'mw1',
    },
  });
  const user = await prisma.user.create({
    data: {
      email: `mw1-${suffix}@example.invalid`,
      name: 'MW1 user',
      passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$s$s',
      webauthnUserId: randomId(),
      emailVerifiedAt: new Date(),
    },
  });
  await prisma.membership.create({
    data: { organizationId: org.id, userId: user.id, role: 'OWNER' },
  });
  const prov = await prisma.providerAccount.create({
    data: {
      organizationId: org.id,
      provider: 'demo',
      label: 'demo',
      status: 'connected',
      connectedById: user.id,
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
      capabilities: ['honk_horn', 'flash_lights', 'lock', 'unlock'],
    },
  });
  vehicleId = vehicle.id;
  actor.userId = user.id;
  // Start the REAL worker wiring from worker.ts (MW1 target).
  const { main } = await import('../src/worker');
  await main();
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe('R2-18 MW1: real worker consumer drives a command to terminal', () => {
  it('honk leaves queued and reaches accepted/not_observable with the event chain', async () => {
    const { command } = await issueCommand(actor, vehicleId, 'honk_horn', {}, {});
    cmdId = command.id;
    expect(['queued', 'submitted']).toContain(command.status);

    const deadline = Date.now() + 60_000;
    let status = command.status;
    let detail = { command, events: [] as { event: string }[] };
    // R2-18 (review 1b): the worker writes the status first (service.ts:608)
    // and the audit event in a separate write (:613). Poll until BOTH the
    // status is terminal AND the terminal event exists in the chain — reading
    // events once after the status turns terminal can see 'accepted' before
    // the 'accepted' event is written.
    while (Date.now() < deadline) {
      detail = await getCommand(cmdId);
      status = detail.command.status;
      const chain = detail.events.map((e) => e.event);
      if (TERMINAL.includes(status) && chain.includes(status)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(status, 'command must reach a terminal state via the real worker').toMatch(
      /^(accepted|not_observable)$/,
    );

    const events = detail.events.map((e) => e.event);
    expect(events, 'the terminal event itself must be in the chain').toContain(status);
    expect(events, 'event chain must contain queued and submitted').toEqual(
      expect.arrayContaining(['queued', 'submitted']),
    );
    const q = events.indexOf('queued');
    const s = events.indexOf('submitted');
    const a = events.indexOf(status);
    expect(q).toBeGreaterThanOrEqual(0);
    expect(s).toBeGreaterThan(q);
    expect(a).toBeGreaterThan(s);
  });
});
