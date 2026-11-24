// Round 2 headline defect tests (ROUND2_PLAN.md R0). Each test name carries
// its issue ID and reproduces the verifier's evidence on the pre-fix code;
// red logs are kept under the round-2 evidence directory in the handoff
// folder (a machine-local path that must never appear in the repo).
//
// - R2-01: a fresh install with no VL_SETUP_TOKEN must get a generated,
//   persisted setup token (currently: no token exists anywhere).
// - P-SLEEP: planNextPoll must schedule minutes away, not ~100-300 ms.
// - R2-12: enqueue() with attempts omitted must keep QUEUE_DEFAULTS retries.
// - Z-INCIDENTPUB: a self-registered user's create_incident automation must
//   never appear in the anonymous public status bundle.
// - R2-49: VL_QUEUE_PREFIX must change the BullMQ key prefix.

process.env.NODE_ENV = 'test';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildApp } from '../src/app';
import { prisma } from '../src/core/db';
import { initRedis, producerConnection, workerConnection } from '../src/core/redis';
import { enqueue, queue, PREFIX } from '../src/jobs/queues';
import { planNextPoll } from '../src/telemetry/teslaPollPlanner';
import { runAutomation } from '../src/automations/engine';

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

describe('round2 headline defects', () => {
  it('P-SLEEP: planNextPoll schedules in seconds, not milliseconds', () => {
    const now = 1_700_000_000_000;
    const cases: Array<{
      branch: string;
      sec: number;
      input: Parameters<typeof planNextPoll>[0];
    }> = [
      {
        branch: 'asleep',
        sec: 120,
        input: {
          connectivity: 'asleep',
          activity: null,
          lastVehicleDataAt: null,
          lastActivityAt: null,
          pendingCommandUntil: null,
          userActiveUntil: null,
          suspendedUntil: null,
          backoffUntil: null,
          now,
        },
      },
      {
        branch: 'offline',
        sec: 300,
        input: {
          connectivity: 'offline',
          activity: null,
          lastVehicleDataAt: null,
          lastActivityAt: null,
          pendingCommandUntil: null,
          userActiveUntil: null,
          suspendedUntil: null,
          backoffUntil: null,
          now,
        },
      },
      {
        branch: 'unknown',
        sec: 300,
        input: {
          connectivity: 'unknown',
          activity: null,
          lastVehicleDataAt: null,
          lastActivityAt: null,
          pendingCommandUntil: null,
          userActiveUntil: null,
          suspendedUntil: null,
          backoffUntil: null,
          now,
        },
      },
      {
        branch: 'pending_command',
        sec: 15,
        input: {
          connectivity: 'online',
          activity: null,
          lastVehicleDataAt: null,
          lastActivityAt: null,
          pendingCommandUntil: now + 60_000,
          userActiveUntil: null,
          suspendedUntil: null,
          backoffUntil: null,
          now,
        },
      },
      {
        branch: 'sleeping_window',
        sec: 60,
        input: {
          connectivity: 'online',
          activity: {},
          lastVehicleDataAt: null,
          lastActivityAt: now - 16 * 60_000,
          pendingCommandUntil: null,
          userActiveUntil: null,
          suspendedUntil: null,
          backoffUntil: null,
          now,
        },
      },
      {
        branch: 'viewing',
        sec: 60,
        input: {
          connectivity: 'online',
          activity: {},
          lastVehicleDataAt: null,
          lastActivityAt: now - 1_000,
          pendingCommandUntil: null,
          userActiveUntil: now + 60_000,
          suspendedUntil: null,
          backoffUntil: null,
          now,
        },
      },
      {
        branch: 'idle',
        sec: 300,
        input: {
          connectivity: 'online',
          activity: {},
          lastVehicleDataAt: null,
          lastActivityAt: now - 1_000,
          pendingCommandUntil: null,
          userActiveUntil: null,
          suspendedUntil: null,
          backoffUntil: null,
          now,
        },
      },
      {
        branch: 'driving',
        sec: 60,
        input: {
          connectivity: 'online',
          activity: { shift_state: 'D' },
          lastVehicleDataAt: null,
          lastActivityAt: now - 1_000,
          pendingCommandUntil: null,
          userActiveUntil: null,
          suspendedUntil: null,
          backoffUntil: null,
          now,
        },
      },
      {
        branch: 'charging',
        sec: 180,
        input: {
          connectivity: 'online',
          activity: { chargingState: 'Charging' },
          lastVehicleDataAt: null,
          lastActivityAt: now - 1_000,
          pendingCommandUntil: null,
          userActiveUntil: null,
          suspendedUntil: null,
          backoffUntil: null,
          now,
        },
      },
      {
        branch: 'sentry',
        sec: 1800,
        input: {
          connectivity: 'online',
          activity: { sentryMode: true },
          lastVehicleDataAt: null,
          lastActivityAt: now - 1_000,
          pendingCommandUntil: null,
          userActiveUntil: null,
          suspendedUntil: null,
          backoffUntil: null,
          now,
        },
      },
    ];
    for (const c of cases) {
      const plan = planNextPoll(c.input);
      // Jitter is +/-10%, so a seconds-based schedule lands at >= 0.9*sec*1000ms.
      expect(
        plan.nextAt - now,
        `${c.branch}: next poll must be >= ${c.sec} s away (${c.sec * 900} ms min), got ${plan.nextAt - now} ms`,
      ).toBeGreaterThanOrEqual(c.sec * 900);
    }
  });

  it('R2-12: enqueue() with attempts omitted retries per QUEUE_DEFAULTS', async () => {
    const { Worker } = await import('bullmq');
    const worker = new Worker(
      'demo',
      async () => {
        throw new Error('boom');
      },
      { connection: workerConnection(), prefix: PREFIX, concurrency: 1 },
    );
    const jobId = await enqueue('demo', { probe: Date.now() });
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('job never failed')), 45_000);
      worker.on('failed', (job) => {
        // The job finally fails after every retry is exhausted.
        if (job?.id === jobId && job.attemptsMade >= (job.opts.attempts ?? 1)) {
          clearTimeout(t);
          resolve();
        }
      });
    });
    const job = await queue('demo').getJob(jobId);
    // QUEUE_DEFAULTS.demo: attempts 3. The verifier saw attemptsMade=1 with
    // attempts=undefined because enqueue() passed the undefined through.
    expect(job?.opts.attempts, 'job attempts must come from QUEUE_DEFAULTS').toBe(3);
    expect(job?.attemptsMade, 'a failing job must actually be retried').toBeGreaterThanOrEqual(2);
    await worker.close();
  }, 60_000);

  it('Z-INCIDENTPUB: a self-registered user cannot publish a public incident', async () => {
    const title = `self-registered-${Date.now()}`;
    const user = await prisma.user.create({
      data: {
        email: `pub-${Date.now()}@example.test`,
        name: 'Self-registered',
        passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$s$s',
        isInstanceAdmin: false,
        emailVerifiedAt: new Date(),
        webauthnUserId: `pub-${Date.now()}`,
      },
    });
    const org = await prisma.organization.create({
      data: {
        kind: 'PERSONAL',
        name: 'Pub test org',
        createdById: user.id,
        memberships: { create: { userId: user.id, role: 'OWNER' } },
      },
    });
    const automation = await prisma.automation.create({
      data: {
        organizationId: org.id,
        createdById: user.id,
        userId: user.id,
        name: 'public incident by self-registered user',
        triggerType: 'scheduled',
        triggerParams: JSON.parse('{}'),
        conditions: JSON.parse('[]'),
        actions: JSON.parse(
          JSON.stringify([
            { type: 'create_incident', params: { title, severity: 'major', public: true } },
          ]),
        ),
        cooldownSec: 0,
        maxRetries: 0,
        enabled: true,
      },
    });
    const run = await runAutomation(automation.id, {
      type: 'scheduled',
      userId: user.id,
      data: {},
    });
    expect(['ok', 'success'].includes(run.result), `automation ran (got ${run.result})`).toBe(true);
    const res = await request(base).get('/api/v1/status');
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(title);
  }, 30_000);

  it('R2-01: a fresh install without VL_SETUP_TOKEN gets a generated setup token', async () => {
    delete process.env.VL_SETUP_TOKEN;
    // Isolate the precondition: a previous run's row must not leak into this
    // fresh install.
    await prisma.appSetting.deleteMany({ where: { key: 'instance.setupTokenHash' } });
    const mod = await import('../src/auth/setup-token');
    const token = await mod.ensureSetupToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{24,}$/);
    // The plaintext is shown once and never re-revealed.
    const again = await mod.ensureSetupToken();
    expect(again).toBeNull();
    // Only the hash is persisted.
    const row = await prisma.appSetting.findUniqueOrThrow({
      where: { key: 'instance.setupTokenHash' },
    });
    expect(row.value).toMatch(/^[a-f0-9]{64}$/);
  }, 30_000);

  it('R2-49: VL_QUEUE_PREFIX changes the BullMQ key prefix', async () => {
    const expected = process.env.VL_QUEUE_PREFIX;
    expect(expected, 'this test must run with VL_QUEUE_PREFIX set').toBeTruthy();
    expect(PREFIX, 'PREFIX must come from VL_QUEUE_PREFIX').toBe(expected);
    const redis = producerConnection();
    await enqueue('demo', { probe: Date.now() });
    const prefixed = await redis.keys(`${expected}:demo:*`);
    expect(prefixed.length, `expected keys under ${expected}:demo:*`).toBeGreaterThan(0);
  }, 30_000);
});
