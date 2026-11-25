// R2-32 / P-TESLAMAP end-to-end PIN handoff (commands-7): the PIN leaves
// issueCommand only inside a sealed VehicleCommandSecret, reaches the Tesla
// fake only inside the dispatch body, the secret is consumed and pruned, and
// an unreadable secret FAILS the command instead of dispatching without the
// PIN (policy documented 2026-11-24).

process.env.NODE_ENV = 'test';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/core/db';
import { initRedis } from '../src/core/redis';
import { randomId, hashPassword } from '../src/core/crypto';
import { createSession } from '../src/auth/service';
import { issueCommand, processCommandJob } from '../src/commands/service';
import { runRetention } from '../src/telemetry/retention';
import { startFakeTesla, type FakeTesla } from './fakes/fakeTesla';
import { seal } from '../src/core/keyring';
import { queue } from '../src/jobs/queues';
import type { SessionActor } from '../src/authz/types';

let fake: FakeTesla;

beforeAll(async () => {
  await initRedis();
  process.env.TESLA_ALLOW_TEST_ENDPOINTS = 'true';
  fake = await startFakeTesla(0);
  process.env.TESLA_TOKEN_URL = `${fake.base}/oauth2/v3/token`;
  process.env.TESLA_AUTHORIZE_URL = `${fake.base}/oauth2/v3/authorize`;
  process.env.TESLA_FLEET_BASE_NA = `${fake.base}`;
  process.env.TESLA_FLEET_BASE_EU = `${fake.base}`;
  process.env.TESLA_DEFAULT_AUDIENCE = `${fake.base}`;
  process.env.TESLA_COMMAND_PROXY_URL = `${fake.proxy}`;
  process.env.TESLA_CLIENT_ID = 'test-client';
  process.env.TESLA_CLIENT_SECRET = 'test-secret';
  process.env.TESLA_REDIRECT_URI = 'http://127.0.0.1:3110/api/v1/providers/tesla/callback';
  process.env.TESLA_PUBLIC_KEY_FILE = '/nonexistent-test-key.pem';
  process.env.TESLA_PARTNER_DOMAIN = '127.0.0.1';
}, 30_000);

afterAll(async () => {
  await fake.close();
  await prisma.$disconnect();
});

const VIN = '5YJ3000000NEXUS01';

async function mkWorld(): Promise<{
  actor: SessionActor;
  vehicleId: string;
  orgId: string;
  userId: string;
}> {
  const user = await prisma.user.create({
    data: {
      email: `pin-${Date.now()}-${randomId()}@example.invalid`,
      name: 'PIN',
      passwordHash: await hashPassword('long-enough-123'),
      webauthnUserId: randomId(),
      emailVerifiedAt: new Date(),
    },
  });
  const org = await prisma.organization.create({
    data: {
      kind: 'PERSONAL',
      name: `PIN-${Date.now()}`,
      createdById: user.id,
      memberships: { create: { userId: user.id, role: 'OWNER' } },
    },
  });
  const pa = await prisma.providerAccount.create({
    data: {
      organizationId: org.id,
      provider: 'tesla',
      label: 'Tesla PIN',
      status: 'connected',
      demo: false,
    },
  });
  const jwt = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ scp: ['vehicle_cmds'] })).toString('base64url')}.sig`;
  await prisma.providerCredential.create({
    data: {
      providerAccountId: pa.id,
      keyVersion: seal(
        JSON.stringify({ accessToken: jwt, refreshToken: 'rt', expiresAt: Date.now() + 3600_000 }),
        `provider-credential:${pa.id}`,
      ).keyVersion,
      algorithm: 'v1',
      ciphertext: seal(
        JSON.stringify({ accessToken: jwt, refreshToken: 'rt', expiresAt: Date.now() + 3600_000 }),
        `provider-credential:${pa.id}`,
      ).ciphertext,
    },
  });
  const vehicle = await prisma.vehicle.create({
    data: {
      organizationId: org.id,
      providerAccountId: pa.id,
      provider: 'tesla',
      providerVehicleId: VIN,
      displayName: 'PIN car',
      demo: false,
      addedById: user.id,
      capabilities: JSON.parse(JSON.stringify(['speed_limit'])),
    },
  });
  fake.pairKey(VIN);
  fake.setConnectivity(VIN, 'online');
  const { sessionId } = await createSession(user.id, '127.0.0.1');
  await prisma.userSession.update({
    where: { id: sessionId },
    data: { stepUpAt: new Date(), stepUpMethod: 'password' },
  });
  return {
    actor: {
      kind: 'session',
      userId: user.id,
      sessionId,
      isInstanceAdmin: false,
      emailVerified: true,
      mfaEnrolled: false,
      stepUpAt: new Date(),
    } as SessionActor,
    vehicleId: vehicle.id,
    orgId: org.id,
    userId: user.id,
  };
}

describe('R2-32 PIN handoff end to end (P-TESLAMAP)', () => {
  it('the PIN is sealed at issue time and never appears in params, audit rows or the job payload', async () => {
    const { actor, vehicleId } = await mkWorld();
    const { command } = await issueCommand(actor, vehicleId, 'speed_limit', {
      speedLimitOn: true,
      speedLimitKmh: 80,
      pin: '1234',
    });
    const secret = await prisma.vehicleCommandSecret.findUnique({
      where: { commandId: command.id },
    });
    expect(secret, 'a sealed secret row must exist').toBeTruthy();
    expect(secret!.ciphertext).not.toContain('1234');
    expect(JSON.stringify(command.params)).not.toContain('1234');
    const events = await prisma.commandAuditEvent.findMany({ where: { commandId: command.id } });
    expect(JSON.stringify(events)).not.toContain('1234');
    const jobs = await queue('vehicle-commands').getJobs(['waiting', 'delayed', 'active']);
    const job = jobs.find((j) => j.data.commandId === command.id);
    if (job) expect(JSON.stringify(job.data)).not.toContain('1234');
  });

  it('the worker consumes the secret and the dispatch body carries the PIN; the secret row is gone', async () => {
    const { actor, vehicleId } = await mkWorld();
    const { command } = await issueCommand(actor, vehicleId, 'speed_limit', {
      speedLimitOn: true,
      speedLimitKmh: 80,
      pin: '1234',
    });
    const before = fake.requests.length;
    await processCommandJob({ commandId: command.id, stage: 'dispatch', n: 1 });
    const calls = fake.requests.slice(before);
    const activate = calls.find((r) => r.path.endsWith('/command/speed_limit_activate'));
    expect(activate, 'speed_limit_activate must be requested').toBeTruthy();
    expect((activate!.body as { pin?: string } | undefined)?.pin).toBe('1234');
    const setLimit = calls.find((r) => r.path.endsWith('/command/speed_limit_set_limit'));
    expect(setLimit, 'speed_limit_set_limit must be requested').toBeTruthy();
    const secret = await prisma.vehicleCommandSecret.findUnique({
      where: { commandId: command.id },
    });
    expect(secret, 'the one-time secret must be consumed').toBeNull();
  });

  it('an unreadable secret fails the command instead of dispatching without the PIN', async () => {
    const { actor, vehicleId, orgId } = await mkWorld();
    // Build the command row directly so this test depends only on the
    // decrypt policy, not on issueCommand's seal (the seal has its own test).
    const command = await prisma.vehicleCommand.create({
      data: {
        vehicleId,
        organizationId: orgId,
        vehicleName: 'PIN car',
        providerAccountId: (await prisma.vehicle.findUniqueOrThrow({ where: { id: vehicleId } }))
          .providerAccountId,
        userId: actor.userId,
        actorKind: 'user',
        type: 'speed_limit',
        params: JSON.parse('{}'),
        status: 'queued',
        risk: 'high',
      },
    });
    await prisma.vehicleCommandSecret.create({
      data: {
        commandId: command.id,
        ciphertext: '{"ciphertext":"garbage-not-a-seal"}',
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });
    const before = fake.requests.length;
    await processCommandJob({ commandId: command.id, stage: 'dispatch', n: 1 });
    const row = await prisma.vehicleCommand.findUniqueOrThrow({ where: { id: command.id } });
    expect(row.status).toBe('failed');
    expect(row.errorMessage).toContain('PIN secret');
    const events = await prisma.commandAuditEvent.findMany({ where: { commandId: command.id } });
    expect(events.map((e) => e.event)).toContain('failed');
    // No command request reached the fake: the broken seal must not dispatch.
    expect(fake.requests.length).toBe(before);
  });

  it('retention prunes expired PIN secrets and keeps unexpired ones', async () => {
    const expired = await prisma.vehicleCommandSecret.create({
      data: {
        commandId: `pin-expired-${Date.now()}`,
        ciphertext: 'sealed',
        expiresAt: new Date(Date.now() - 60_000),
      },
    });
    expect(expired.commandId).toContain('pin-expired');
    const keep = await prisma.vehicleCommandSecret.create({
      data: {
        commandId: `pin-keep-${Date.now()}`,
        ciphertext: 'sealed',
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });
    await runRetention();
    expect(
      await prisma.vehicleCommandSecret.findUnique({ where: { commandId: expired.commandId } }),
      'expired secret must be pruned',
    ).toBeNull();
    expect(
      await prisma.vehicleCommandSecret.findUnique({ where: { commandId: keep.commandId } }),
      'unexpired secret must be kept',
    ).toBeTruthy();
  });
});
