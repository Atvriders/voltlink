// R5: fleet assignments are end-dated and editable (N-ASSIGN).
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

let server: Server;
let base = '';

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

const csrfCache = new WeakMap<object, string>();
async function postJson(agent: ReturnType<typeof request.agent>, path: string, body: unknown) {
  let csrf = csrfCache.get(agent);
  let res = await agent
    .post(path)
    .set('x-vl-csrf', csrf ?? '')
    .send(body as object);
  if (res.status === 403 && res.body?.error?.code === 'CSRF') {
    const cookies = (res.headers['set-cookie'] ?? []) as unknown as string[];
    csrf =
      cookies
        .map((c) => (c ?? '').split(';')[0])
        .find((c) => c?.startsWith('vl_csrf='))
        ?.split('=')[1] ?? '';
    csrfCache.set(agent, csrf);
    res = await agent
      .post(path)
      .set('x-vl-csrf', csrf)
      .send(body as object);
  }
  return res;
}
async function patchJson(agent: ReturnType<typeof request.agent>, path: string, body: unknown) {
  let csrf = csrfCache.get(agent);
  let res = await agent
    .patch(path)
    .set('x-vl-csrf', csrf ?? '')
    .send(body as object);
  if (res.status === 403 && res.body?.error?.code === 'CSRF') {
    const cookies = (res.headers['set-cookie'] ?? []) as unknown as string[];
    csrf =
      cookies
        .map((c) => (c ?? '').split(';')[0])
        .find((c) => c?.startsWith('vl_csrf='))
        ?.split('=')[1] ?? '';
    csrfCache.set(agent, csrf);
    res = await agent
      .patch(path)
      .set('x-vl-csrf', csrf)
      .send(body as object);
  }
  return res;
}

describe('fleet assignments (N-ASSIGN)', () => {
  it('a new assignment ends the previous one and PATCH edits the record', async () => {
    const user = await prisma.user.create({
      data: {
        email: `fa-${Date.now()}-${randomId()}@example.invalid`,
        name: 'FA',
        passwordHash: 'x',
        webauthnUserId: randomId(),
      },
    });
    const org = await prisma.organization.create({
      data: {
        kind: 'TEAM',
        name: 'Fleet Org',
        createdById: user.id,
        memberships: { create: { userId: user.id, role: 'FLEET_MANAGER' } },
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
    const veh = await prisma.vehicle.create({
      data: {
        organizationId: org.id,
        providerAccountId: pa.id,
        provider: 'demo',
        providerVehicleId: randomId(),
        displayName: 'V',
        demo: true,
      },
    });
    const d1 = await prisma.driver.create({
      data: { organizationId: org.id, name: 'Dana', email: 'dana@example.invalid' },
    });
    const d2 = await prisma.driver.create({
      data: { organizationId: org.id, name: 'Sam', email: 'sam@example.invalid' },
    });
    const session = await createSession(user.id, '127.0.0.1');
    const agent = request.agent(base).set('Cookie', `vl_session=${session.token}`);

    const first = await postJson(agent, '/api/v1/fleet/assignments', {
      vehicleId: veh.id,
      driverId: d1.id,
    });
    expect(first.status).toBe(201);

    const second = await postJson(agent, '/api/v1/fleet/assignments', {
      vehicleId: veh.id,
      driverId: d2.id,
    });
    expect(second.status).toBe(201);

    const previous = await prisma.vehicleAssignment.findUniqueOrThrow({
      where: { id: first.body.data.id },
    });
    expect(previous.toAt).not.toBeNull();
    expect(previous.toAt!.getTime()).toBeLessThanOrEqual(Date.now());

    const fresh = await prisma.vehicleAssignment.findUniqueOrThrow({
      where: { id: second.body.data.id },
    });
    expect(fresh.toAt).toBeNull();

    // Editable: PATCH can end the active assignment and re-map cost centers.
    const patch = await patchJson(agent, `/api/v1/fleet/assignments/${fresh.id}`, {
      toAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    expect(patch.status).toBe(200);
    const patched = await prisma.vehicleAssignment.findUniqueOrThrow({
      where: { id: fresh.id },
    });
    expect(patched.toAt).not.toBeNull();
  });
});
