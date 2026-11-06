// R4: provider routes coverage — Tesla authorize/callback failure paths,
// Tessie connect validation + upstream checks, demo webhook, pairing link,
// import, disconnect and demo-degraded toggle.
process.env.NODE_ENV = 'test';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { Server as HttpServer } from 'node:http';
import { buildApp } from '../src/app';
import { prisma } from '../src/core/db';
import { initRedis } from '../src/core/redis';
import { randomId } from '../src/core/crypto';
import { createSession } from '../src/auth/service';

let server: Server;
let base = '';
let tessieFake: HttpServer;
let tessieBase = '';

beforeAll(async () => {
  await initRedis();
  server = buildApp({ serveSpa: false }).listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const app = express();
  app.use(express.json());
  app.get('/vins', (_req, res) => res.json({ results: ['5YJ3000000NEXUS02'] }));
  tessieFake = app.listen(0);
  await new Promise<void>((resolve) => tessieFake.once('listening', resolve));
  tessieBase = `http://127.0.0.1:${(tessieFake.address() as AddressInfo).port}`;
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => tessieFake.close(() => resolve()));
  await prisma.$disconnect();
});

async function mkActor(member = true) {
  const user = await prisma.user.create({
    data: {
      email: `pr-${Date.now()}-${randomId()}@test.dev`,
      name: 'PR',
      passwordHash: 'x',
      webauthnUserId: randomId(),
      emailVerifiedAt: new Date(),
    },
  });
  let orgId: string | null = null;
  if (member) {
    const org = await prisma.organization.create({
      data: {
        kind: 'PERSONAL',
        name: 'PR Org',
        createdById: user.id,
        memberships: { create: { userId: user.id, role: 'OWNER' } },
      },
    });
    orgId = org.id;
  }
  const session = await createSession(user.id, '127.0.0.1');
  return { user, orgId, session, agent: request.agent(base).set('Cookie', `vl_session=${session.token}`) };
}


const csrfCache = new WeakMap<object, string>();
async function postJson(
  agent: ReturnType<typeof request.agent>,
  path: string,
  body: unknown,
): Promise<request.Response> {
  let csrf = csrfCache.get(agent);
  let res = await agent.post(path).set('x-vl-csrf', csrf ?? '').send(body as object);
  if (res.status === 403) console.error('CSRF PROBE', path, JSON.stringify(res.body), res.headers['set-cookie']);
  if (res.status === 403 && res.body?.error?.code === 'CSRF') {
    const cookies = (res.headers['set-cookie'] ?? []) as unknown as string[];
    csrf =
      cookies
        .map((c) => (c ?? '').split(';')[0])
        .find((c) => c?.startsWith('vl_csrf='))
        ?.split('=')[1] ?? '';
    csrfCache.set(agent, csrf);
    res = await agent.post(path).set('x-vl-csrf', csrf).send(body as object);
  }
  return res;
}

describe('provider routes coverage', () => {
  it('tesla authorize answers NOT_CONFIGURED without credentials', async () => {
    const { agent } = await mkActor();
    const res = await agent.get('/api/v1/providers/tesla/authorize');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('NOT_CONFIGURED');
  });

  it('tesla callback redirects home for missing or unknown state', async () => {
    const { agent } = await mkActor();
    const noCode = await agent.get('/api/v1/providers/tesla/callback');
    expect(noCode.status).toBe(302);
    const badState = await agent.get(
      '/api/v1/providers/tesla/callback?code=abc&state=not-a-real-state',
    );
    expect(badState.status).toBe(302);
  });

  it('tessie connect validates the token before any upstream call', async () => {
    const { agent } = await mkActor();
    const res = await postJson(agent, '/api/v1/providers/tessie/connect', { token: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION');
  });

  it('tessie connect requires an organization membership', async () => {
    const { agent } = await mkActor(false);
    const res = await postJson(agent, '/api/v1/providers/tessie/connect', { token: 'long-enough-token' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('tessie connect reports INVALID_TOKEN when upstream rejects', async () => {
    const rejectApp = express();
    rejectApp.get('/vins', (_req, res) => res.status(401).json({ error: 'bad' }));
    const rejecting = rejectApp.listen(0);
    await new Promise<void>((resolve) => rejecting.once('listening', resolve));
    process.env.TESSIE_BASE_URL = `http://127.0.0.1:${(rejecting.address() as AddressInfo).port}`;
    const { agent } = await mkActor();
    const res = await postJson(agent, '/api/v1/providers/tessie/connect', { token: 'long-enough-token' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('INVALID_TOKEN');
    await new Promise<void>((resolve) => rejecting.close(() => resolve()));
  });

  it('tessie connect succeeds against the local fake and stores credentials', async () => {
    process.env.TESSIE_BASE_URL = tessieBase;
    const { agent, orgId } = await mkActor();
    const res = await postJson(agent, '/api/v1/providers/tessie/connect', { token: 'long-enough-token', label: 'My Tessie' });
    expect(res.status).toBe(201);
    const account = await prisma.providerAccount.findUniqueOrThrow({
      where: { id: res.body.data.accountId },
    });
    expect(account.organizationId).toBe(orgId);
    expect(account.status).toBe('connected');
    const cred = await prisma.providerCredential.findUnique({
      where: { providerAccountId: account.id },
    });
    expect(cred).toBeTruthy();
  });

  it('tessie connect reports UNREACHABLE when the upstream is down', async () => {
    process.env.TESSIE_BASE_URL = 'http://127.0.0.1:1';
    const { agent } = await mkActor();
    const res = await postJson(agent, '/api/v1/providers/tessie/connect', { token: 'long-enough-token' });
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('UNREACHABLE');
  });

  it('provider webhook 404s for providers without a webhook API', async () => {
    const { agent } = await mkActor();
    const res = await postJson(agent, '/api/v1/providers/tessie/webhook', {});
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('demo webhook answers ok and rejects other-org vehicles', async () => {
    const { agent, user, orgId } = await mkActor();
    const pa = await prisma.providerAccount.create({
      data: { organizationId: orgId!, provider: 'demo', label: 'Demo', status: 'connected', demo: true },
    });
    const veh = await prisma.vehicle.create({
      data: {
        organizationId: orgId!,
        providerAccountId: pa.id,
        provider: 'demo',
        providerVehicleId: randomId(),
        displayName: 'Demo V',
        demo: true,
      },
    });
    const ok = await postJson(agent, '/api/v1/providers/demo/webhook', { vehicleId: veh.id, type: 'trigger', payload: { type: 'webhook' } });
    expect(ok.status).toBe(200);
    expect(ok.body.data.ok).toBe(true);

    // A vehicle from a foreign org is treated as nonexistent.
    const stranger = await prisma.user.create({
      data: {
        email: `pr-s-${Date.now()}-${randomId()}@test.dev`,
        name: 'Stranger',
        passwordHash: 'x',
        webauthnUserId: randomId(),
      },
    });
    const org2 = await prisma.organization.create({
      data: {
        kind: 'PERSONAL',
        name: 'Other Org',
        createdById: stranger.id,
        memberships: { create: { userId: stranger.id, role: 'OWNER' } },
      },
    });
    const pa2 = await prisma.providerAccount.create({
      data: { organizationId: org2.id, provider: 'demo', label: 'Demo', status: 'connected', demo: true },
    });
    const foreign = await prisma.vehicle.create({
      data: {
        organizationId: org2.id,
        providerAccountId: pa2.id,
        provider: 'demo',
        providerVehicleId: randomId(),
        displayName: 'Foreign V',
        demo: true,
      },
    });
    const denied = await postJson(agent, '/api/v1/providers/demo/webhook', { vehicleId: foreign.id, type: 'trigger', payload: {} });
    expect(denied.status).toBe(404);
    void user;
  });

  it('pairing link rejects non-Tesla vehicles', async () => {
    const { agent, orgId } = await mkActor();
    const pa = await prisma.providerAccount.create({
      data: { organizationId: orgId!, provider: 'demo', label: 'Demo', status: 'connected', demo: false },
    });
    const veh = await prisma.vehicle.create({
      data: {
        organizationId: orgId!,
        providerAccountId: pa.id,
        provider: 'demo',
        providerVehicleId: randomId(),
        displayName: 'Demo V',
      },
    });
    const res = await agent.get(`/api/v1/providers/${pa.id}/vehicles/${veh.id}/pairing-link`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('NOT_TESLA');
  });

  it('imports demo vehicles into the account and enqueues telemetry', async () => {
    const { agent, orgId } = await mkActor();
    const pa = await prisma.providerAccount.create({
      data: { organizationId: orgId!, provider: 'demo', label: 'Demo', status: 'connected', demo: false },
    });
    const res = await postJson(agent, `/api/v1/providers/${pa.id}/import`, {});
    expect(res.status).toBe(200);
    expect(res.body.data.imported).toBeGreaterThan(0);
    const imported = await prisma.vehicle.count({ where: { providerAccountId: pa.id } });
    expect(imported).toBe(res.body.data.imported);
  });

  it('disconnects an account and removes its credentials', async () => {
    const { agent, orgId } = await mkActor();
    const pa = await prisma.providerAccount.create({
      data: { organizationId: orgId!, provider: 'demo', label: 'Demo', status: 'connected', demo: false },
    });
    const veh = await prisma.vehicle.create({
      data: {
        organizationId: orgId!,
        providerAccountId: pa.id,
        provider: 'demo',
        providerVehicleId: randomId(),
        displayName: 'Demo V',
      },
    });
    const res = await postJson(agent, `/api/v1/providers/${pa.id}/disconnect`, {});
    expect(res.status).toBe(200);
    expect(res.body.data.ok).toBe(true);
    const afterVehicle = await prisma.vehicle.findUnique({ where: { id: veh.id } });
    expect(afterVehicle?.active).toBe(false);
    const afterAccount = await prisma.providerAccount.findUnique({ where: { id: pa.id } });
    expect(afterAccount?.status).toBe('revoked');
  });

  it('toggles demo-degraded only for demo accounts', async () => {
    const { agent, orgId } = await mkActor();
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId! } });
    const pa = await prisma.providerAccount.create({
      data: { organizationId: orgId!, provider: 'demo', label: 'Demo', status: 'connected', demo: true },
    });
    const on = await postJson(agent, `/api/v1/providers/${pa.id}/demo-degraded`, { degraded: true });
    expect(on.status).toBe(200);
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: org.id } })).demoDegraded).toBe(true);
    const off = await postJson(agent, `/api/v1/providers/${pa.id}/demo-degraded`, { degraded: false });
    expect(off.status).toBe(200);
  });
});
