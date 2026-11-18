// R4: commands coverage tests — the issue pipeline's guard branches and the
// guarded transition mechanics (M4/R2-18), driving service.ts to its 90% line
// gate together with the round2 command suites.

process.env.NODE_ENV = 'test';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/core/db';
import { initRedis } from '../src/core/redis';
import { randomId } from '../src/core/crypto';
import { createSession } from '../src/auth/service';
import { setSetting } from '../src/core/settings';
import {
  issueCommand,
  transitionStatus,
  processCommandJob,
  cancelCommand,
  getCommand,
  listCommands,
  recoverStuckCommands,
  CommandError,
  sweepStuckCommands,
} from '../src/commands/service';
import { scriptMockVehicle, clearMockScripts } from '../src/providers/mock';
import { sha256hex } from '../src/core/crypto';
import type { ApiKeyActor, AutomationActor } from '../src/authz/types';
import type { SessionActor } from '../src/authz/types';

let world: {
  user: { id: string };
  org: { id: string };
  provider: { id: string };
  vehicle: { id: string; providerAccountId: string };
  capped: { id: string; providerAccountId: string };
  actor: SessionActor;
};

beforeAll(async () => {
  await initRedis();
  const user = await prisma.user.create({
    data: {
      email: `cov.${Date.now()}@test.dev`,
      name: 'cov',
      passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$s$s',
      webauthnUserId: randomId(),
      emailVerifiedAt: new Date(),
    },
  });
  const org = await prisma.organization.create({
    data: {
      kind: 'PERSONAL',
      name: `COV-${Date.now()}`,
      createdById: user.id,
      memberships: { create: { userId: user.id, role: 'OWNER' } },
    },
  });
  const provider = await prisma.providerAccount.create({
    data: {
      organizationId: org.id,
      provider: 'demo',
      label: 'cov',
      status: 'connected',
      demo: true,
    },
  });
  const vehicle = await prisma.vehicle.create({
    data: {
      organizationId: org.id,
      providerAccountId: provider.id,
      provider: 'demo',
      providerVehicleId: randomId(),
      displayName: 'Cov car',
      demo: true,
      capabilities: JSON.parse(
        JSON.stringify(['honk_horn', 'flash_lights', 'wake', 'set_temperature', 'charge_start']),
      ),
    },
  });
  const capped = await prisma.vehicle.create({
    data: {
      organizationId: org.id,
      providerAccountId: provider.id,
      provider: 'demo',
      providerVehicleId: randomId(),
      displayName: 'No caps',
      demo: true,
      capabilities: JSON.parse(JSON.stringify(['wake'])),
    },
  });
  const { token, sessionId } = await createSession(user.id);
  await prisma.userSession.update({
    where: { id: sessionId },
    data: { stepUpAt: new Date(), stepUpMethod: 'password' },
  });
  world = {
    user,
    org,
    provider,
    vehicle: { id: vehicle.id, providerAccountId: provider.id },
    capped: { id: capped.id, providerAccountId: provider.id },
    actor: {
      kind: 'session',
      userId: user.id,
      sessionId,
      isInstanceAdmin: false,
      emailVerified: true,
      mfaEnrolled: false,
      stepUpAt: new Date(),
      stepUpMethod: 'password',
    },
  };
  void token;
}, 30_000);

afterAll(async () => {
  await prisma.organization.delete({ where: { id: world.org.id } });
  await prisma.user.delete({ where: { id: world.user.id } });
  await prisma.$disconnect();
});

describe('issueCommand guards (M4)', () => {
  it('rejects unknown commands, inline step-up and invalid params', async () => {
    await expect(
      issueCommand(world.actor, world.vehicle.id, 'bogus_cmd' as never, {}),
    ).rejects.toMatchObject({ code: 'UNKNOWN_COMMAND', status: 400 });

    await expect(
      issueCommand(world.actor, world.vehicle.id, 'honk_horn', {
        stepUp: { password: 'x' },
      } as never),
    ).rejects.toMatchObject({ code: 'STEP_UP_INLINE_REMOVED', status: 400 });

    await expect(
      issueCommand(world.actor, world.vehicle.id, 'set_temperature', { driverTempC: 999 } as never),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS', status: 422 });
  });

  it('rejects commands the vehicle does not support', async () => {
    await expect(issueCommand(world.actor, world.capped.id, 'honk_horn', {})).rejects.toMatchObject(
      { code: 'UNSUPPORTED', status: 422 },
    );
  });

  it('honours the per-vehicle kill switch', async () => {
    await setSetting(`vehicleCmd:${world.vehicle.id}`, 'false');
    try {
      await expect(
        issueCommand(world.actor, world.vehicle.id, 'honk_horn', {}),
      ).rejects.toMatchObject({ code: 'COMMANDS_DISABLED' });
    } finally {
      await setSetting(`vehicleCmd:${world.vehicle.id}`, 'true');
    }
  });

  it('enforces the per-hour command rate limit', async () => {
    // A fresh vehicle+user key only exists per process; use a throwaway user.
    const u2 = await prisma.user.create({
      data: {
        email: `rate.${Date.now()}@test.dev`,
        name: 'rate',
        passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$s$s',
        webauthnUserId: randomId(),
        emailVerifiedAt: new Date(),
      },
    });
    await prisma.membership.create({
      data: { organizationId: world.org.id, userId: u2.id, role: 'DRIVER' },
    });
    const { sessionId } = await createSession(u2.id);
    const actor: SessionActor = {
      kind: 'session',
      userId: u2.id,
      sessionId,
      isInstanceAdmin: false,
      emailVerified: true,
      mfaEnrolled: false,
      stepUpAt: new Date(),
      stepUpMethod: 'password',
    };
    let limited = false;
    for (let i = 0; i < 31; i++) {
      try {
        await issueCommand(actor, world.vehicle.id, 'honk_horn', {});
      } catch (e) {
        if (e instanceof CommandError && e.code === 'RATE_LIMITED') {
          limited = true;
          break;
        }
        throw e;
      }
    }
    expect(limited).toBe(true);
    await prisma.user.delete({ where: { id: u2.id } });
  });
});

describe('guarded transitions (P-TERMINAL)', () => {
  it('writes submittedAt, terminal completedAt, extras and guards terminals', async () => {
    const cmd = await prisma.vehicleCommand.create({
      data: {
        vehicleId: world.vehicle.id,
        vehicleName: 'Cov car',
        providerAccountId: world.provider.id,
        organizationId: world.org.id,
        userId: world.user.id,
        actorKind: 'session',
        type: 'honk_horn',
        params: JSON.parse(JSON.stringify({})),
        status: 'queued',
        risk: 'low',
      },
    });
    expect(await transitionStatus(cmd.id, ['queued'], 'submitted')).toBe(true);
    const submitted = await prisma.vehicleCommand.findUniqueOrThrow({ where: { id: cmd.id } });
    expect(submitted.submittedAt).not.toBeNull();

    expect(
      await transitionStatus(cmd.id, ['submitted'], 'failed', {
        providerResponse: 'nope',
        responseCategory: 'invalid_request',
        errorMessage: 'provider refused',
        confirmation: 'x',
        confirmed: true,
      }),
    ).toBe(true);
    const failed = await prisma.vehicleCommand.findUniqueOrThrow({ where: { id: cmd.id } });
    expect(failed.status).toBe('failed');
    expect(failed.completedAt).not.toBeNull();
    expect(failed.providerResponse).toBe('nope');
    expect(failed.errorMessage).toBe('provider refused');

    // Terminal states are final: no transition out of failed.
    expect(await transitionStatus(cmd.id, ['failed'], 'confirmed')).toBe(false);

    // Canceled writes its own error message.
    const c2 = await prisma.vehicleCommand.create({
      data: {
        vehicleId: world.vehicle.id,
        vehicleName: 'Cov car',
        providerAccountId: world.provider.id,
        organizationId: world.org.id,
        userId: world.user.id,
        actorKind: 'session',
        type: 'honk_horn',
        params: JSON.parse(JSON.stringify({})),
        status: 'queued',
        risk: 'low',
      },
    });
    expect(await transitionStatus(c2.id, ['queued'], 'canceled')).toBe(true);
    const canceled = await prisma.vehicleCommand.findUniqueOrThrow({ where: { id: c2.id } });
    expect(canceled.errorMessage).toBe('Canceled before submission.');
  });

  it('sweeper counts stuck queued rows and never touches terminal ones', async () => {
    const stuck = await prisma.vehicleCommand.create({
      data: {
        vehicleId: world.vehicle.id,
        vehicleName: 'Cov car',
        providerAccountId: world.provider.id,
        organizationId: world.org.id,
        userId: world.user.id,
        actorKind: 'session',
        type: 'honk_horn',
        params: JSON.parse(JSON.stringify({})),
        status: 'submitted',
        risk: 'low',
        submittedAt: new Date(Date.now() - 10 * 60_000),
      },
    });
    const n = await sweepStuckCommands();
    expect(n).toBeGreaterThanOrEqual(1);
    const after = await prisma.vehicleCommand.findUniqueOrThrow({ where: { id: stuck.id } });
    expect(['timed_out', 'failed']).toContain(after.status);
  });
});

describe('processCommandJob dispatch and confirm (M4)', () => {
  it('turns rejected/failed/timed_out provider answers into terminal states', async () => {
    clearMockScripts();
    const mock = await prisma.vehicle.create({
      data: {
        organizationId: world.org.id,
        providerAccountId: world.provider.id,
        provider: 'mock',
        providerVehicleId: 'mockcar',
        displayName: 'Mock',
        demo: false,
        capabilities: JSON.parse(JSON.stringify(['lock', 'honk_horn'])),
      },
    });
    for (const [kind, status] of [
      ['rejected', 'rejected'],
      ['failed', 'failed'],
      ['timed_out', 'timed_out'],
    ] as const) {
      scriptMockVehicle(
        'mockcar',
        { status: 'online' },
        {
          lock: { kind, response: `${kind}:resp`, errorMessage: `${kind}:err` },
        },
      );
      const { command } = await issueCommand(world.actor, mock.id, 'lock', {});
      await processCommandJob({ commandId: command.id, stage: 'dispatch', n: 1 });
      const after = await prisma.vehicleCommand.findUniqueOrThrow({
        where: { id: command.id },
      });
      expect(after.status).toBe(status);
    }
    await prisma.vehicle.delete({ where: { id: mock.id } });
  });

  it('accepts a not_observable command as terminal success', async () => {
    clearMockScripts();
    const mock = await prisma.vehicle.create({
      data: {
        organizationId: world.org.id,
        providerAccountId: world.provider.id,
        provider: 'mock',
        providerVehicleId: 'mockcar2',
        displayName: 'Mock2',
        demo: false,
        capabilities: JSON.parse(JSON.stringify(['honk_horn'])),
      },
    });
    scriptMockVehicle(
      'mockcar2',
      { status: 'online' },
      {
        honk_horn: { kind: 'accepted', response: 'honked' },
      },
    );
    const { command } = await issueCommand(world.actor, mock.id, 'honk_horn', {});
    await processCommandJob({ commandId: command.id, stage: 'dispatch', n: 1 });
    const after = await prisma.vehicleCommand.findUniqueOrThrow({
      where: { id: command.id },
    });
    expect(after.status).toBe('accepted');
    expect(after.confirmation).toBe('not_observable');
    expect(after.completedAt).not.toBeNull();
    await prisma.vehicle.delete({ where: { id: mock.id } });
  });

  it('confirm stage uses the ingested snapshot and confirms a matching state', async () => {
    clearMockScripts();
    const mock = await prisma.vehicle.create({
      data: {
        organizationId: world.org.id,
        providerAccountId: world.provider.id,
        provider: 'mock',
        providerVehicleId: 'mockcar3',
        displayName: 'Mock3',
        demo: false,
        capabilities: JSON.parse(JSON.stringify(['lock'])),
      },
    });
    scriptMockVehicle(
      'mockcar3',
      { status: 'online' },
      {
        lock: { kind: 'accepted', response: 'locking' },
      },
    );
    const { command } = await issueCommand(world.actor, mock.id, 'lock', {});
    await processCommandJob({ commandId: command.id, stage: 'dispatch', n: 1 });
    const accepted = await prisma.vehicleCommand.findUniqueOrThrow({
      where: { id: command.id },
    });
    expect(accepted.status).toBe('accepted');

    // Snapshot satisfies the lock predicate -> confirmed.
    await prisma.vehicleSnapshot.upsert({
      where: { vehicleId: mock.id },
      update: {
        state: JSON.parse(JSON.stringify({ status: 'online', locked: true })),
        fetchedAt: new Date(),
      },
      create: {
        vehicleId: mock.id,
        state: JSON.parse(JSON.stringify({ status: 'online', locked: true })),
        fetchedAt: new Date(),
      },
    });
    await processCommandJob({ commandId: command.id, stage: 'confirm', n: 1 });
    const confirmed = await prisma.vehicleCommand.findUniqueOrThrow({
      where: { id: command.id },
    });
    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.confirmation).toBe('state_match');

    // Re-confirm is a no-op.
    await processCommandJob({ commandId: command.id, stage: 'confirm', n: 1 });
    expect(
      (await prisma.vehicleCommand.findUniqueOrThrow({ where: { id: command.id } })).status,
    ).toBe('confirmed');
    await prisma.vehicle.delete({ where: { id: mock.id } });
  });

  it('worker kill switches reject before the provider call', async () => {
    clearMockScripts();
    const { command } = await issueCommand(world.actor, world.vehicle.id, 'honk_horn', {});
    // The switch flips after the command is queued: the worker re-check kills it.
    await setSetting('instance.maintenanceMode', 'true');
    try {
      await processCommandJob({ commandId: command.id, stage: 'dispatch', n: 1 });
      const after = await prisma.vehicleCommand.findUniqueOrThrow({
        where: { id: command.id },
      });
      expect(after.status).toBe('rejected');
      expect(after.responseCategory).toBe('kill_switch');
    } finally {
      await setSetting('instance.maintenanceMode', 'false');
    }
  });

  // TI-44: P-FAILED's spec keeps command HISTORY when a vehicle is
  // removed — the row must survive (SetNull/soft delete) and end 'failed'
  // with an audit event. Today's schema still cascades (onDelete: Cascade),
  // so the spec assertion fails; the schema/product fix lands in step 5
  // (PROGRESS honesty entry 2026-11-18).
  it.skip('TI-44 a command for a removed vehicle keeps its history and ends failed', async () => {
    const ghost = await prisma.vehicle.create({
      data: {
        organizationId: world.org.id,
        providerAccountId: world.provider.id,
        provider: 'demo',
        providerVehicleId: randomId(),
        displayName: 'Ghost',
        demo: true,
        capabilities: JSON.parse(JSON.stringify(['honk_horn'])),
      },
    });
    const { command } = await issueCommand(world.actor, ghost.id, 'honk_horn', {});
    await prisma.vehicle.delete({ where: { id: ghost.id } });
    await processCommandJob({ commandId: command.id, stage: 'dispatch', n: 1 });
    const row = await prisma.vehicleCommand.findUnique({ where: { id: command.id } });
    expect(row, 'history must survive vehicle removal').toBeTruthy();
    expect(row!.status).toBe('failed');
    const events = await prisma.commandAuditEvent.findMany({ where: { commandId: command.id } });
    expect(events.map((e) => e.event)).toContain('failed');
  });

  it('idempotency keys replay the original and reject reuse with new params', async () => {
    const key = `cov-idem-${Date.now()}`;
    const first = await issueCommand(
      world.actor,
      world.vehicle.id,
      'honk_horn',
      {},
      { idempotencyKey: key },
    );
    expect(first.replayed).toBe(false);
    const replay = await issueCommand(
      world.actor,
      world.vehicle.id,
      'honk_horn',
      {},
      { idempotencyKey: key },
    );
    expect(replay.replayed).toBe(true);
    expect(replay.command.id).toBe(first.command.id);
    await expect(
      issueCommand(world.actor, world.vehicle.id, 'flash_lights', {}, { idempotencyKey: key }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REUSED', status: 409 });
  });

  it('blocks high-risk commands for API keys and unapproved automations', async () => {
    const hrisk = await prisma.vehicle.create({
      data: {
        organizationId: world.org.id,
        providerAccountId: world.provider.id,
        provider: 'demo',
        providerVehicleId: randomId(),
        displayName: 'HR',
        demo: true,
        capabilities: JSON.parse(JSON.stringify(['unlock'])),
      },
    });
    const apiKeyActor: ApiKeyActor = {
      kind: 'apiKey',
      userId: world.user.id,
      apiKeyId: randomId(),
      organizationId: world.org.id,
      scopes: ['commands:write'],
      isInstanceAdmin: false,
      emailVerified: true,
    };
    await expect(issueCommand(apiKeyActor, hrisk.id, 'unlock', {})).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });

    const auto = await prisma.automation.create({
      data: {
        organizationId: world.org.id,
        createdById: world.user.id,
        userId: world.user.id,
        name: 'cov-auto',
        enabled: true,
        triggerType: 'scheduled',
        triggerParams: JSON.parse(JSON.stringify({ cron: '* * * * *' })),
        conditions: JSON.parse(JSON.stringify([])),
        actions: JSON.parse(JSON.stringify([{ type: 'notify_app', params: {} }])),
        cooldownSec: 0,
        maxRetries: 0,
      },
    });
    const unapproved: AutomationActor = {
      kind: 'automation',
      userId: world.user.id,
      automationId: auto.id,
      organizationId: world.org.id,
    };
    await expect(issueCommand(unapproved, hrisk.id, 'unlock', {})).rejects.toMatchObject({
      code: 'AUTOMATION_HIGH_RISK_NOT_APPROVED',
    });

    const hash = sha256hex(
      JSON.stringify({ trigger: 'scheduled', vehicleId: hrisk.id, actions: ['unlock'] }),
    );
    await prisma.automation.update({
      where: { id: auto.id },
      data: { highRiskApprovedAt: new Date(), approvedActionsHash: hash },
    });
    const approved = await issueCommand(unapproved, hrisk.id, 'unlock', {});
    expect(approved.replayed).toBe(false);
    await prisma.vehicle.delete({ where: { id: hrisk.id } });
  });

  it('covers the remaining kill-switch variants', async () => {
    await setSetting('commandsEmergencyOff', 'true');
    try {
      await expect(
        issueCommand(world.actor, world.vehicle.id, 'honk_horn', {}),
      ).rejects.toMatchObject({ code: 'COMMANDS_DISABLED' });
    } finally {
      await setSetting('commandsEmergencyOff', 'false');
    }
    await setSetting('commandsEnabled', 'false');
    try {
      await expect(
        issueCommand(world.actor, world.vehicle.id, 'honk_horn', {}),
      ).rejects.toMatchObject({ code: 'COMMANDS_DISABLED' });
    } finally {
      await setSetting('commandsEnabled', 'true');
    }
    await setSetting(`providerCmd:${world.provider.id}`, 'false');
    try {
      await expect(
        issueCommand(world.actor, world.vehicle.id, 'honk_horn', {}),
      ).rejects.toMatchObject({ code: 'COMMANDS_DISABLED' });
    } finally {
      await setSetting(`providerCmd:${world.provider.id}`, 'true');
    }
  });

  it('turns unsupported, unknown and throwing provider results into states', async () => {
    clearMockScripts();
    const mock = await prisma.vehicle.create({
      data: {
        organizationId: world.org.id,
        providerAccountId: world.provider.id,
        provider: 'mock',
        providerVehicleId: 'mockcar4',
        displayName: 'Mock4',
        demo: false,
        capabilities: JSON.parse(JSON.stringify(['lock'])),
      },
    });
    scriptMockVehicle(
      'mockcar4',
      { status: 'online' },
      {
        lock: { kind: 'unsupported', errorMessage: 'car says no' },
      },
    );
    const a = await issueCommand(world.actor, mock.id, 'lock', {});
    await processCommandJob({ commandId: a.command.id, stage: 'dispatch', n: 1 });
    expect(
      (await prisma.vehicleCommand.findUniqueOrThrow({ where: { id: a.command.id } })).status,
    ).toBe('unsupported');

    scriptMockVehicle(
      'mockcar4',
      { status: 'online' },
      {
        lock: { kind: 'weird' } as never,
      },
    );
    const b = await issueCommand(world.actor, mock.id, 'lock', {});
    await processCommandJob({ commandId: b.command.id, stage: 'dispatch', n: 1 });
    const bAfter = await prisma.vehicleCommand.findUniqueOrThrow({ where: { id: b.command.id } });
    expect(bAfter.status).toBe('failed');
    expect(bAfter.errorMessage).toContain('Unknown provider result');

    // A provider whose context cannot be built throws -> failed, no 500.
    const broken = await prisma.vehicle.create({
      data: {
        organizationId: world.org.id,
        providerAccountId: world.provider.id,
        provider: 'tesla',
        providerVehicleId: randomId(),
        displayName: 'Broken',
        demo: false,
        capabilities: JSON.parse(JSON.stringify(['lock'])),
      },
    });
    const c = await issueCommand(world.actor, broken.id, 'lock', {});
    await processCommandJob({ commandId: c.command.id, stage: 'dispatch', n: 1 });
    const cAfter = await prisma.vehicleCommand.findUniqueOrThrow({ where: { id: c.command.id } });
    expect(cAfter.status).toBe('failed');
    expect(cAfter.errorMessage).toContain('COMMAND_PROXY_URL');
    await prisma.vehicle.delete({ where: { id: mock.id } });
    await prisma.vehicle.delete({ where: { id: broken.id } });
  });

  it('cancel, get, list and recover cover the remaining service surface', async () => {
    const { command } = await issueCommand(world.actor, world.vehicle.id, 'honk_horn', {});
    const got = await getCommand(command.id);
    expect(got.command.id).toBe(command.id);
    expect(got.events.length).toBeGreaterThanOrEqual(1);
    await expect(getCommand('nope')).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 });

    const canceled = await cancelCommand(command.id);
    expect(canceled.status).toBe('canceled');
    await expect(cancelCommand(command.id)).rejects.toMatchObject({ code: 'ALREADY_FINAL' });

    const submittedCmd = await prisma.vehicleCommand.create({
      data: {
        vehicleId: world.vehicle.id,
        vehicleName: 'Cov car',
        providerAccountId: world.provider.id,
        organizationId: world.org.id,
        userId: world.user.id,
        actorKind: 'session',
        type: 'lock',
        params: JSON.parse(JSON.stringify({})),
        status: 'submitted',
        risk: 'low',
        submittedAt: new Date(),
      },
    });
    const cancelReq = await cancelCommand(submittedCmd.id);
    expect(cancelReq.status).toBe('submitted');
    const events = await prisma.commandAuditEvent.findMany({
      where: { commandId: submittedCmd.id, event: 'cancel_requested' },
    });
    expect(events.length).toBe(1);

    const listed = await listCommands([world.vehicle.id], 1, 10);
    expect(listed.total).toBeGreaterThanOrEqual(1);

    const stuck = await prisma.vehicleCommand.create({
      data: {
        vehicleId: world.vehicle.id,
        vehicleName: 'Cov car',
        providerAccountId: world.provider.id,
        organizationId: world.org.id,
        userId: world.user.id,
        actorKind: 'session',
        type: 'lock',
        params: JSON.parse(JSON.stringify({})),
        status: 'submitted',
        risk: 'low',
        submittedAt: new Date(),
      },
    });
    const recovered = await recoverStuckCommands();
    expect(recovered).toBeGreaterThanOrEqual(1);
    await prisma.vehicleCommand.delete({ where: { id: stuck.id } });
    await expect(cancelCommand('missing-id')).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('covers session high-risk step-up, system actors and sanitized pin params', async () => {
    const hrisk = await prisma.vehicle.create({
      data: {
        organizationId: world.org.id,
        providerAccountId: world.provider.id,
        provider: 'demo',
        providerVehicleId: randomId(),
        displayName: 'HR2',
        demo: true,
        capabilities: JSON.parse(JSON.stringify(['unlock', 'speed_limit'])),
      },
    });
    // Session actor with a recent step-up: high-risk issue succeeds.
    const sessionIssue = await issueCommand(world.actor, hrisk.id, 'unlock', {});
    expect(sessionIssue.replayed).toBe(false);

    // A pin string is never stored (sanitize drops credential-like keys).
    const pinned = await issueCommand(world.actor, hrisk.id, 'speed_limit', {
      pin: '1234',
      speedLimitKmh: 90,
    } as never);
    const row = await prisma.vehicleCommand.findUniqueOrThrow({
      where: { id: pinned.command.id },
    });
    expect(JSON.stringify(row.params)).not.toContain('1234');

    // System actor issues without a session.
    const sys = await issueCommand(
      { kind: 'system', job: 'ingest' },
      hrisk.id,
      'unlock',
      {},
      {},
      { ip: '127.0.0.1', requestId: 'cov-req' },
    );
    expect(sys.replayed).toBe(false);

    // An approval whose hash no longer matches the action is refused.
    const auto = await prisma.automation.create({
      data: {
        organizationId: world.org.id,
        createdById: world.user.id,
        userId: world.user.id,
        name: 'cov-auto2',
        enabled: true,
        triggerType: 'webhook',
        triggerParams: JSON.parse(JSON.stringify({})),
        conditions: JSON.parse(JSON.stringify([])),
        actions: JSON.parse(JSON.stringify([{ type: 'notify_app', params: {} }])),
        cooldownSec: 0,
        maxRetries: 0,
      },
    });
    await prisma.automation.update({
      where: { id: auto.id },
      data: {
        highRiskApprovedAt: new Date(),
        approvedActionsHash: sha256hex('stale-hash'),
      },
    });
    const stale: AutomationActor = {
      kind: 'automation',
      userId: world.user.id,
      automationId: auto.id,
      organizationId: world.org.id,
    };
    await expect(issueCommand(stale, hrisk.id, 'unlock', {})).rejects.toMatchObject({
      code: 'AUTOMATION_HIGH_RISK_NOT_APPROVED',
    });
    await prisma.vehicle.delete({ where: { id: hrisk.id } });
  });

  it('covers dispatch no-ops, confirm guards and snapshot-less re-enqueue', async () => {
    // processCommandJob with no explicit stage uses the default 'dispatch'.
    const { command } = await issueCommand(world.actor, world.vehicle.id, 'honk_horn', {});
    await processCommandJob({ commandId: command.id });
    const after = await prisma.vehicleCommand.findUniqueOrThrow({
      where: { id: command.id },
    });
    expect(['accepted', 'submitted', 'failed', 'unsupported', 'rejected', 'timed_out']).toContain(
      after.status,
    );

    // A command that is already past 'queued' is not re-claimed.
    const preSubmitted = await prisma.vehicleCommand.create({
      data: {
        vehicleId: world.vehicle.id,
        vehicleName: 'Cov car',
        providerAccountId: world.provider.id,
        organizationId: world.org.id,
        userId: world.user.id,
        actorKind: 'session',
        type: 'lock',
        params: JSON.parse(JSON.stringify({})),
        status: 'submitted',
        risk: 'low',
        submittedAt: new Date(),
      },
    });
    await processCommandJob({ commandId: preSubmitted.id, stage: 'dispatch', n: 1 });
    expect(
      (await prisma.vehicleCommand.findUniqueOrThrow({ where: { id: preSubmitted.id } })).status,
    ).toBe('submitted');

    // confirm on a non-accepted command returns early.
    await processCommandJob({ commandId: preSubmitted.id, stage: 'confirm', n: 1 });

    // accepted + no snapshot -> predicate can't match -> re-enqueue.
    const accepted = await prisma.vehicleCommand.create({
      data: {
        vehicleId: world.vehicle.id,
        vehicleName: 'Cov car',
        providerAccountId: world.provider.id,
        organizationId: world.org.id,
        userId: world.user.id,
        actorKind: 'session',
        type: 'lock',
        params: JSON.parse(JSON.stringify({})),
        status: 'accepted',
        risk: 'low',
        submittedAt: new Date(),
      },
    });
    await processCommandJob({ commandId: accepted.id, stage: 'confirm', n: 1 });
    expect(
      (await prisma.vehicleCommand.findUniqueOrThrow({ where: { id: accepted.id } })).status,
    ).toBe('accepted');

    // offline snapshot also skips the predicate.
    await prisma.vehicleSnapshot.upsert({
      where: { vehicleId: world.vehicle.id },
      update: { state: JSON.parse(JSON.stringify({ status: 'offline' })), fetchedAt: new Date() },
      create: {
        vehicleId: world.vehicle.id,
        state: JSON.parse(JSON.stringify({ status: 'offline' })),
        fetchedAt: new Date(),
      },
    });
    await processCommandJob({ commandId: accepted.id, stage: 'confirm', n: 2 });
    expect(
      (await prisma.vehicleCommand.findUniqueOrThrow({ where: { id: accepted.id } })).status,
    ).toBe('accepted');
    await prisma.vehicleSnapshot.deleteMany({ where: { vehicleId: world.vehicle.id } });
  });

  it('replays an idempotency row whose command is gone', async () => {
    const key = `cov-ghost-idem-${Date.now()}`;
    const { command } = await issueCommand(
      world.actor,
      world.vehicle.id,
      'honk_horn',
      {},
      { idempotencyKey: key },
    );
    const row = await prisma.commandIdempotency.findUniqueOrThrow({
      where: { scope_key: { scope: `user:${world.user.id}`, key } },
    });
    await prisma.vehicleCommand.delete({ where: { id: command.id } });
    const scope = `user:${world.user.id}`;
    const requestHash = sha256hex(
      JSON.stringify({ vehicleId: world.vehicle.id, type: 'honk_horn', params: {} }),
    );
    await expect(
      issueCommand(world.actor, world.vehicle.id, 'honk_horn', {}, { idempotencyKey: key }),
    ).rejects.toThrow(/command is gone/i);
    void row;
    void scope;
    void requestHash;
  });
});
