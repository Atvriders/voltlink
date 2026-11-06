// R2-57: concurrent POSTs with one idempotency key never leave orphan
// 'queued' rows; the losing requests roll back.
// R2-56: the confirm-stage timeout measures from submittedAt, so an accepted
// command that never confirms is swept to timed_out after the window.

process.env.NODE_ENV = 'test';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildApp } from '../src/app';
import { prisma } from '../src/core/db';
import { initRedis } from '../src/core/redis';
import { randomId } from '../src/core/crypto';
import { createSession } from '../src/auth/service';
import { processCommandJob } from '../src/commands/service';

let server: Server;
let base: string;

beforeAll(async () => {
  await initRedis();
  server = buildApp({ serveSpa: false }).listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

async function world() {
  const owner = await prisma.user.create({
    data: {
      email: `r257.${Date.now()}@test.dev`,
      name: 'r257',
      passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$s$s',
      webauthnUserId: randomId(),
      emailVerifiedAt: new Date(),
    },
  });
  const org = await prisma.organization.create({
    data: {
      kind: 'PERSONAL',
      name: `R257-${Date.now()}`,
      createdById: owner.id,
      memberships: { create: { userId: owner.id, role: 'OWNER' } },
    },
  });
  const provider = await prisma.providerAccount.create({
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
      providerAccountId: provider.id,
      provider: 'demo',
      providerVehicleId: randomId(),
      displayName: 'R257 car',
      demo: true,
      capabilities: JSON.parse(JSON.stringify(['honk_horn', 'wake'])),
    },
  });
  const { token } = await createSession(owner.id);
  return { owner, org, provider, vehicle, token };
}

const csrfCache = new WeakMap<object, string>();
function agentFor(token: string) {
  return request.agent(base).set('Cookie', `vl_session=${token}`);
}
async function withCsrf(
  agent: ReturnType<typeof request.agent>,
  fn: (csrf: string) => Promise<request.Response>,
) {
  let csrf = csrfCache.get(agent);
  let res = await fn(csrf ?? '');
  if (res.status === 403 && res.body?.error?.code === 'CSRF') {
    const cookies = (res.headers['set-cookie'] ?? []) as unknown as string[];
    csrf =
      cookies
        .map((c) => (c ?? '').split(';')[0])
        .find((c) => c?.startsWith('vl_csrf='))
        ?.split('=')[1] ?? '';
    if (!csrf) throw new Error('CSRF cookie was not issued');
    csrfCache.set(agent, csrf);
    res = await fn(csrf);
  }
  return res;
}

describe('R2-57 idempotency race', () => {
  it('concurrent posts with one key yield one command row', async () => {
    const w = await world();
    const agent = agentFor(w.token);
    const key = `race-${Date.now()}`;

    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        withCsrf(agent, (csrf) =>
          agent.post('/api/v1/commands').set('x-vl-csrf', csrf).send({
            vehicleId: w.vehicle.id,
            type: 'honk_horn',
            params: {},
            idempotencyKey: key,
          }),
        ),
      ),
    );
    for (const r of results)
      expect([200, 201], `body=${JSON.stringify(r.body)}`).toContain(r.status);

    const ids = results.map((r) => r.body?.data?.id as string);
    expect(new Set(ids).size).toBe(1);

    const rows = await prisma.vehicleCommand.count({
      where: { idempotencyKey: key },
    });
    expect(rows).toBe(1);

    await prisma.organization.delete({ where: { id: w.org.id } });
    await prisma.user.delete({ where: { id: w.owner.id } });
  });
});

describe('R2-56 confirm timeout', () => {
  it('accepted commands past the window are swept to timed_out', async () => {
    const w = await world();
    const command = await prisma.vehicleCommand.create({
      data: {
        vehicleId: w.vehicle.id,
        vehicleName: w.vehicle.displayName,
        providerAccountId: w.provider.id,
        organizationId: w.org.id,
        userId: w.owner.id,
        actorKind: 'session',
        type: 'honk_horn',
        params: JSON.parse(JSON.stringify({})),
        status: 'accepted',
        risk: 'low',
        submittedAt: new Date(Date.now() - 120_000),
      },
    });

    await processCommandJob({ commandId: command.id, stage: 'confirm', n: 1 });

    const after = await prisma.vehicleCommand.findUniqueOrThrow({
      where: { id: command.id },
    });
    expect(after.status).toBe('timed_out');
    expect(after.confirmation).toBe('timeout');

    await prisma.organization.delete({ where: { id: w.org.id } });
    await prisma.user.delete({ where: { id: w.owner.id } });
  });
});
