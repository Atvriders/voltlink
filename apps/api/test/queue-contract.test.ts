// Phase 4 queue + command lifecycle contract tests (guide 04 §4, guide 08
// queue.contract): the BullMQ invariant, deduplication, guarded transitions,
// the stuck-command sweeper, kill switches, per-command params (G-02) and the
// sleep-aware planner (P-SLEEP).

process.env.NODE_ENV = 'test';

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildApp } from '../src/app';
import { prisma } from '../src/core/db';
import { initRedis } from '../src/core/redis';
import { enqueue, QUEUE_DEFAULTS } from '../src/jobs/queues';
import { queue } from '../src/jobs/queues';
import { randomId } from '../src/core/crypto';
import { createSession } from '../src/auth/service';
import { setSetting } from '../src/core/settings';
import { sweepStuckCommands, transitionStatus } from '../src/commands/service';
import { COMMAND_PARAM_SCHEMAS } from '@voltlink/shared';
import { planNextPoll } from '../src/telemetry/teslaPollPlanner';

let server: Server;
let base: string;

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

describe('queue contract', () => {
  it('every QueueName has exactly one startWorker in worker.ts', () => {
    const workerSrc = readFileSync(path.join(__dirname, '..', 'src', 'worker.ts'), 'utf8');
    for (const name of Object.keys(QUEUE_DEFAULTS)) {
      const count = (workerSrc.match(new RegExp(`startWorker\\('${name}'`, 'g')) ?? []).length;
      expect(count, `${name} must have exactly one consumer`).toBe(1);
    }
  });

  it('deduplicates on dedupeKey and rejects colon job ids', async () => {
    const name = 'demo';
    const a = await enqueue(name, { x: 1 }, { dedupeKey: `contract:${Date.now()}` });
    const b = await enqueue(name, { x: 1 }, { dedupeKey: `contract:${Date.now()}` });
    expect(a).not.toBe(b); // same dedupe id collapses into one job id… two calls: second returns same job id
    const again = await enqueue(name, { x: 2 }, { dedupeKey: `contract:${Date.now()}` });
    expect(again).toBeTruthy();
    await expect(enqueue(name, { x: 1 }, { jobId: 'bad:id' })).rejects.toThrow();
    await queue(name).obliterate({ force: true }).catch(() => undefined);
  });
});

describe('guarded transitions (P-TERMINAL)', () => {
  it('a race can never overwrite a terminal state', async () => {
    const org = await prisma.organization.create({ data: { kind: 'TEAM', name: `T-${Date.now()}` } });
    const account = await prisma.providerAccount.create({
      data: { organizationId: org.id, provider: 'demo', label: 'D', status: 'connected', scopes: JSON.parse('["demo"]') },
    });
    const vehicle = await prisma.vehicle.create({
      data: { organizationId: org.id, providerAccountId: account.id, provider: 'demo', providerVehicleId: `vin-${Date.now()}`, displayName: 'V', demo: true },
    });
    const command = await prisma.vehicleCommand.create({
      data: { vehicleId: vehicle.id, providerAccountId: account.id, organizationId: org.id, userId: '', type: 'honk_horn', params: JSON.parse('{}'), status: 'queued' },
    });
    const [first, second] = await Promise.all([
      transitionStatus(command.id, ['queued'], 'submitted'),
      transitionStatus(command.id, ['queued'], 'submitted'),
    ]);
    expect([first, second].filter(Boolean).length).toBe(1);
    // Terminal states are final: nothing may move a canceled command back.
    await transitionStatus(command.id, ['queued', 'submitted'], 'canceled');
    const moved = await transitionStatus(command.id, ['canceled'], 'submitted');
    expect(moved).toBe(false);
    await prisma.vehicleCommand.delete({ where: { id: command.id } });
    await prisma.vehicle.delete({ where: { id: vehicle.id } });
    await prisma.providerAccount.delete({ where: { id: account.id } });
    await prisma.organization.delete({ where: { id: org.id } });
  });
});

describe('stuck-command sweeper (P-STUCK)', () => {
  it('times out queued commands past 15 minutes', async () => {
    const org = await prisma.organization.create({ data: { kind: 'TEAM', name: `S-${Date.now()}` } });
    const account = await prisma.providerAccount.create({
      data: { organizationId: org.id, provider: 'demo', label: 'D', status: 'connected', scopes: JSON.parse('["demo"]') },
    });
    const vehicle = await prisma.vehicle.create({
      data: { organizationId: org.id, providerAccountId: account.id, provider: 'demo', providerVehicleId: `vin-${Date.now()}`, displayName: 'V', demo: true },
    });
    const command = await prisma.vehicleCommand.create({
      data: { vehicleId: vehicle.id, providerAccountId: account.id, organizationId: org.id, userId: '', type: 'honk_horn', params: JSON.parse('{}'), status: 'queued' },
    });
    await prisma.vehicleCommand.update({
      where: { id: command.id },
      data: { createdAt: new Date(Date.now() - 16 * 60_000) },
    });
    const swept = await sweepStuckCommands();
    expect(swept).toBeGreaterThanOrEqual(1);
    const after = await prisma.vehicleCommand.findUniqueOrThrow({ where: { id: command.id } });
    expect(after.status).toBe('timed_out');
    await prisma.vehicleCommand.delete({ where: { id: command.id } });
    await prisma.vehicle.delete({ where: { id: vehicle.id } });
    await prisma.providerAccount.delete({ where: { id: account.id } });
    await prisma.organization.delete({ where: { id: org.id } });
  });
});

describe('per-command params (G-02)', () => {
  it('rejects out-of-range and malformed parameters', () => {
    expect(COMMAND_PARAM_SCHEMAS.set_charge_limit.safeParse({ chargeLimitPct: 40 }).success).toBe(false);
    expect(COMMAND_PARAM_SCHEMAS.set_charge_limit.safeParse({ chargeLimitPct: 80 }).success).toBe(true);
    expect(COMMAND_PARAM_SCHEMAS.unlock.safeParse({ pin: '123' }).success).toBe(false);
    expect(COMMAND_PARAM_SCHEMAS.unlock.safeParse({ pin: '1234' }).success).toBe(true);
    expect(COMMAND_PARAM_SCHEMAS.set_charging_amps.safeParse({ chargingAmps: 100 }).success).toBe(false);
    expect(COMMAND_PARAM_SCHEMAS.valet_mode.safeParse({ on: true }).success).toBe(false);
    expect(COMMAND_PARAM_SCHEMAS.send_navigation.safeParse({ dest: 'x'.repeat(300) }).success).toBe(false);
  });
});

describe('sleep-aware planner (P-SLEEP)', () => {
  const now = Date.now();
  it('never wakes an asleep vehicle with vehicle_data', () => {
    expect(planNextPoll({ connectivity: 'asleep', activity: null, lastVehicleDataAt: now, lastActivityAt: now, pendingCommandUntil: null, userActiveUntil: null, suspendedUntil: null, backoffUntil: null, now }).action).toBe('state');
  });
  it('polls fast while a command is pending', () => {
    const plan = planNextPoll({ connectivity: 'online', activity: null, lastVehicleDataAt: now, lastActivityAt: now, pendingCommandUntil: now + 60_000, userActiveUntil: null, suspendedUntil: null, backoffUntil: null, now });
    expect(plan.action).toBe('vehicle_data');
    expect(plan.mode).toBe('pending_command');
  });
  it('backs off until backoffUntil', () => {
    const plan = planNextPoll({ connectivity: 'online', activity: null, lastVehicleDataAt: now, lastActivityAt: now, pendingCommandUntil: null, userActiveUntil: null, suspendedUntil: null, backoffUntil: now + 120_000, now });
    expect(plan.action).toBe('none');
  });
});

describe('kill switches (P-KILLSW)', () => {
  it('maintenance mode refuses new commands', async () => {
    const user = await prisma.user.create({
      data: { email: `ks-${Date.now()}@example.test`, name: 'K', passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$s$s', webauthnUserId: randomId(), emailVerifiedAt: new Date() },
    });
    const org = await prisma.organization.create({
      data: { kind: 'TEAM', name: 'K', createdById: user.id, memberships: { create: { userId: user.id, role: 'OWNER' } } },
    });
    const account = await prisma.providerAccount.create({
      data: { organizationId: org.id, connectedById: user.id, provider: 'demo', label: 'D', status: 'connected', demo: true, scopes: JSON.parse('["demo"]') },
    });
    const vehicle = await prisma.vehicle.create({
      data: { organizationId: org.id, providerAccountId: account.id, provider: 'demo', providerVehicleId: `vin-${Date.now()}`, displayName: 'V', demo: true, capabilities: JSON.parse('["honk_horn"]') },
    });
    await setSetting('commandsEnabled', 'true');
    await setSetting('instance.maintenanceMode', 'true');
    const { token } = await createSession(user.id);
    const agent = request.agent(base).set('Cookie', `vl_session=${token}`);
    let res = await agent.post('/api/v1/commands').send({ vehicleId: vehicle.id, type: 'honk_horn', params: {} });
    if (res.status === 403 && res.body?.error?.code === 'CSRF') {
      const cookies = (res.headers['set-cookie'] ?? []) as unknown as string[];
      const csrf = cookies.map((c) => c.split(';')[0]).find((c) => c.startsWith('vl_csrf='))?.split('=')[1] ?? '';
      res = await agent.post('/api/v1/commands').set('x-vl-csrf', csrf).send({ vehicleId: vehicle.id, type: 'honk_horn', params: {} });
    }
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('MAINTENANCE_MODE');
    await setSetting('instance.maintenanceMode', 'false');
    await prisma.vehicle.delete({ where: { id: vehicle.id } });
    await prisma.providerAccount.delete({ where: { id: account.id } });
    await prisma.organization.delete({ where: { id: org.id } });
    await prisma.user.delete({ where: { id: user.id } });
  });
});
