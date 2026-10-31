// Security-review regression tests for the four Phase 2 holes found in the
// uncommitted code. Each test fails on the previous code and passes now.
//
//   SEC-REVIEW-1  passkey step-up bound to user + session (403 for a foreign passkey)
//   SEC-REVIEW-2  invite registration requires the secret token
//   SEC-REVIEW-3  API-key / automation vehicle lists follow the owner's permissions
//   SEC-REVIEW-4  POST /passkeys/:id/delete requires possession step-up

process.env.NODE_ENV = 'test';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildApp } from '../src/app';
import { prisma } from '../src/core/db';
import { sha256hex, randomId } from '../src/core/crypto';
import { createSession } from '../src/auth/service';

// Mock only the cryptographic assertion verification so tests do not need a
// real authenticator signature; the binding checks under test run before it.
vi.mock('@simplewebauthn/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@simplewebauthn/server')>();
  return {
    ...actual,
    verifyAuthenticationResponse: vi.fn(async () => ({
      verified: true,
      authenticationInfo: { newCounter: 5, credentialBackedUp: false },
    })),
  };
});

let server: Server;
let base: string;

beforeAll(async () => {
  server = buildApp({ serveSpa: false }).listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

async function createAccount(email: string, name: string) {
  const user = await prisma.user.create({
    data: {
      email,
      name,
      passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$s$s',
      webauthnUserId: randomId(),
    },
  });
  const org = await prisma.organization.create({
    data: {
      kind: 'PERSONAL',
      name: `${name} org`,
      createdById: user.id,
      memberships: { create: { userId: user.id, role: 'OWNER' } },
    },
  });
  return { user, org };
}

function sessionAgent(token: string) {
  return request.agent(base).set('Cookie', `vl_session=${token}`);
}

// The API issues a CSRF cookie on the first mutating request and expects a
// matching x-vl-csrf header on the retry (middleware/core.ts csrf()).
const csrfTokens = new WeakMap<object, string>();
async function postJson(agent: ReturnType<typeof request.agent>, url: string, body?: unknown) {
  let csrf = csrfTokens.get(agent);
  let res = csrf
    ? await agent
        .post(url)
        .set('x-vl-csrf', csrf)
        .send(body ?? {})
    : await agent.post(url).send(body ?? {});
  if (res.status === 403 && res.body?.error?.code === 'CSRF') {
    const cookies = (res.headers['set-cookie'] ?? []) as unknown as string[];
    csrf =
      cookies
        .map((c) => c.split(';')[0])
        .find((c) => c.startsWith('vl_csrf='))
        ?.split('=')[1] ?? csrf;
    if (!csrf) throw new Error('CSRF cookie was not issued');
    csrfTokens.set(agent, csrf);
    res = await agent
      .post(url)
      .set('x-vl-csrf', csrf)
      .send(body ?? {});
  }
  return res;
}

describe('SEC-REVIEW-1: passkey step-up is bound to the user and session', () => {
  it('rejects another account passkey with 403 and records a throttle failure', async () => {
    const a = await createAccount(`sr1-a-${Date.now()}@example.test`, 'A');
    const b = await createAccount(`sr1-b-${Date.now()}@example.test`, 'B');
    const foreign = await prisma.passkeyCredential.create({
      data: {
        userId: b.user.id,
        credentialId: randomId(),
        publicKey: Buffer.alloc(65).toString('base64'),
        counter: 0n,
        transports: [],
        name: 'B key',
      },
    });
    const { token } = await createSession(a.user.id);
    const agent = sessionAgent(token);
    const options = await agent.get('/api/v1/auth/step-up/passkey/options');
    expect(options.status).toBe(200);
    const res = await postJson(agent, '/api/v1/auth/step-up', {
      method: 'passkey',
      response: {
        id: foreign.credentialId,
        rawId: '',
        type: 'public-key',
        response: { clientDataJSON: '', authenticatorData: '', signature: '', userHandle: null },
      },
    });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PASSKEY_MISMATCH');
    const throttle = await prisma.authThrottle.findUnique({ where: { key: `user:${a.user.id}` } });
    expect(throttle?.failures ?? 0).toBeGreaterThanOrEqual(1);
    await prisma.user.delete({ where: { id: a.user.id } });
    await prisma.user.delete({ where: { id: b.user.id } });
  });

  it('accepts the account own passkey with 200', async () => {
    const a = await createAccount(`sr1-c-${Date.now()}@example.test`, 'A');
    const own = await prisma.passkeyCredential.create({
      data: {
        userId: a.user.id,
        credentialId: randomId(),
        publicKey: Buffer.alloc(65).toString('base64'),
        counter: 0n,
        transports: [],
        name: 'A key',
      },
    });
    const { token } = await createSession(a.user.id);
    const agent = sessionAgent(token);
    const options = await agent.get('/api/v1/auth/step-up/passkey/options');
    expect(options.status).toBe(200);
    const res = await postJson(agent, '/api/v1/auth/step-up', {
      method: 'passkey',
      response: {
        id: own.credentialId,
        rawId: '',
        type: 'public-key',
        response: { clientDataJSON: '', authenticatorData: '', signature: '', userHandle: null },
      },
    });
    expect(res.status).toBe(200);
    const { sid } = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64').toString()) as {
      sid: string;
    };
    const row = await prisma.userSession.findUniqueOrThrow({ where: { id: sid } });
    expect(row.stepUpMethod).toBe('passkey');
    await prisma.user.delete({ where: { id: a.user.id } });
  });
});

describe('SEC-REVIEW-2: invite registration requires the secret token', () => {
  async function seedInviteMode() {
    const host = await createAccount(`sr2-host-${Date.now()}@example.test`, 'Host');
    await prisma.appSetting.upsert({
      where: { key: 'instance.bootstrappedAt' },
      update: { value: new Date().toISOString() },
      create: { key: 'instance.bootstrappedAt', value: new Date().toISOString() },
    });
    await prisma.appSetting.upsert({
      where: { key: 'instance.registrationMode' },
      update: { value: 'invite' },
      create: { key: 'instance.registrationMode', value: 'invite' },
    });
    const token = `invite-${randomId()}${randomId()}`;
    const invitation = await prisma.invitation.create({
      data: {
        organizationId: host.org.id,
        kind: 'membership',
        email: `sr2-invitee-${Date.now()}@example.test`,
        tokenHash: sha256hex(token),
        invitedById: host.user.id,
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });
    return { host, token, invitation };
  }

  it('rejects without a token and with a wrong token; accepts the right token', async () => {
    const { host, token, invitation } = await seedInviteMode();
    const email = invitation.email;
    const payload = { email, name: 'Invitee', password: 'invite-password-123' };

    const noToken = await postJson(request.agent(base), '/api/v1/auth/register', payload);
    expect(noToken.status).toBe(403);
    expect(noToken.body.error.code).toBe('INVITE_REQUIRED');

    const wrongToken = await postJson(request.agent(base), '/api/v1/auth/register', {
      ...payload,
      inviteToken: 'wrong-token',
    });
    expect(wrongToken.status).toBe(403);
    expect(wrongToken.body.error.code).toBe('INVITE_REQUIRED');

    const rightToken = await postJson(request.agent(base), '/api/v1/auth/register', {
      ...payload,
      inviteToken: token,
    });
    expect(rightToken.status).toBe(201);
    const created = await prisma.user.findUnique({
      where: { email },
      include: { memberships: true },
    });
    expect(created).not.toBeNull();
    expect(created!.emailVerifiedAt).not.toBeNull();
    expect(created!.memberships).toHaveLength(1);
    expect(created!.memberships[0]!.organizationId).toBe(host.org.id);
    const after = await prisma.invitation.findUnique({ where: { id: invitation.id } });
    expect(after!.acceptedAt).not.toBeNull();

    await prisma.user.delete({ where: { id: created!.id } });
    await prisma.user.delete({ where: { id: host.user.id } });
  });
});

describe('SEC-REVIEW-3: API-key vehicle lists follow the owner permissions', () => {
  it('a DRIVER key with one grant lists only the granted vehicle', async () => {
    const owner = await createAccount(`sr3-owner-${Date.now()}@example.test`, 'Owner');
    const driver = await createAccount(`sr3-driver-${Date.now()}@example.test`, 'Driver');
    const org = await prisma.organization.create({
      data: {
        kind: 'TEAM',
        name: 'Team org',
        createdById: owner.user.id,
        memberships: {
          create: [
            { userId: owner.user.id, role: 'OWNER' },
            { userId: driver.user.id, role: 'DRIVER', vehicleScope: 'GRANTED' },
          ],
        },
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
    const mk = (i: number) =>
      prisma.vehicle.create({
        data: {
          organizationId: org.id,
          providerAccountId: provider.id,
          provider: 'demo',
          providerVehicleId: `v${i}`,
          displayName: `Car ${i}`,
          demo: true,
        },
      });
    const [v1, v2, v3] = await Promise.all([mk(1), mk(2), mk(3)]);
    await prisma.vehicleGrant.create({
      data: {
        vehicleId: v1.id,
        userId: driver.user.id,
        level: 'DRIVER',
        grantedById: owner.user.id,
      },
    });
    const r1 = randomId();
    const r2 = randomId();
    const r3 = randomId();
    const r4 = randomId();
    const token = `vlk_${r1.slice(0, 12)}_${r2}${r3}${r4.slice(0, 16)}`;
    await prisma.apiKey.create({
      data: {
        userId: driver.user.id,
        organizationId: org.id,
        name: 'driver key',
        keyHash: sha256hex(token),
        prefix: token.slice(0, 16),
        scopes: ['vehicles:read'],
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    const res = await request(base).get('/api/v1/vehicles').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    const items = res.body.data as { id: string }[];
    const ids = items.map((v) => v.id);
    expect(ids).toContain(v1.id);
    expect(ids).not.toContain(v2.id);
    expect(ids).not.toContain(v3.id);

    // Cleanup cascades through the organization.
    await prisma.organization.delete({ where: { id: org.id } });
    await prisma.user.delete({ where: { id: driver.user.id } });
    await prisma.user.delete({ where: { id: owner.user.id } });
  });
});

describe('SEC-REVIEW-4: POST /passkeys/:id/delete requires possession step-up', () => {
  it('returns 403 STEP_UP_REQUIRED without step-up and succeeds after', async () => {
    const a = await createAccount(`sr4-${Date.now()}@example.test`, 'A');
    const key = await prisma.passkeyCredential.create({
      data: {
        userId: a.user.id,
        credentialId: randomId(),
        publicKey: Buffer.alloc(65).toString('base64'),
        counter: 0n,
        transports: [],
        name: 'A key',
      },
    });
    const { token, sessionId } = await createSession(a.user.id);
    const agent = sessionAgent(token);

    const denied = await postJson(agent, `/api/v1/auth/passkeys/${key.id}/delete`);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('STEP_UP_REQUIRED');
    expect(denied.body.error.details.methods).toEqual(['totp', 'recovery_code', 'passkey']);

    await prisma.userSession.update({
      where: { id: sessionId },
      data: { stepUpAt: new Date(), stepUpMethod: 'passkey' },
    });
    const allowed = await postJson(agent, `/api/v1/auth/passkeys/${key.id}/delete`);
    expect(allowed.status).toBe(200);
    expect(await prisma.passkeyCredential.count({ where: { id: key.id } })).toBe(0);

    await prisma.user.delete({ where: { id: a.user.id } });
  });
});
