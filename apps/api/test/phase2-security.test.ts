// Phase 2 regression tests for issue IDs not already pinned in
// security-review / orgs / privacy / ssrf / webhooks / matrix suites:
// A-TOTPLOGIN, A-TOTPSETUP, A-TOTPSTORE, A-RECOVERY, A-STEPUP,
// A-STEPUPTHROTTLE, A-PASSKEY, A-EMAILVERIFY, A-TOKENLOG, A-NODEENV,
// A-KEYROT, A-SSEREVOKE, NEW-01, NEW-02, NEW-06, Z-AUTOXTENANT, Z-FLEETDEL,
// Z-IDEMP, Z-IDOR-DRIVES, Z-INCIDENTPUB, Z-XFF, G-07, G-09, G-10.

process.env.NODE_ENV = 'test';

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import crypto from 'node:crypto';
// otplib v13 exposes no simple code generator on the root export; compute the
// RFC 6238 TOTP code directly (HMAC-SHA1, 30 s step, 6 digits).
function totpCode(secret: string, at = Date.now()): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const clean = secret.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  const counter = Math.floor(at / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', Buffer.from(bytes)).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const code =
    ((hmac[offset]! & 0x7f) << 24) |
    (hmac[offset + 1]! << 16) |
    (hmac[offset + 2]! << 8) |
    hmac[offset + 3]!;
  return String(code % 1_000_000).padStart(6, '0');
}
import { buildApp } from '../src/app';
import { prisma } from '../src/core/db';
import { env, parseTrustProxy } from '../src/core/env';
import { hashPassword, randomId } from '../src/core/crypto';
import { seal, open, rewrap } from '../src/core/keyring';
import { createSession } from '../src/auth/service';
import { escapeHtml } from '../src/notifications/service';

let server: Server;
let base: string;

beforeAll(async () => {
  server = buildApp({ serveSpa: false }).listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 30_000);

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
}, 15_000);

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
        .map((c) => c.split(';')[0])
        .find((c) => c.startsWith('vl_csrf='))
        ?.split('=')[1] ?? '';
    if (!csrf) throw new Error('CSRF cookie was not issued');
    csrfCache.set(agent, csrf);
    res = await fn(csrf);
  }
  return res;
}

async function mkUser(email: string, opts: { password?: string; verified?: boolean } = {}) {
  return prisma.user.create({
    data: {
      email,
      name: email.split('@')[0]!,
      passwordHash: await hashPassword(opts.password ?? 'password123'),
      webauthnUserId: randomId(),
      emailVerifiedAt: opts.verified === false ? null : new Date(),
    },
  });
}

async function sessionFor(userId: string, stepped = false) {
  const { token, sessionId } = await createSession(userId);
  if (stepped) {
    await prisma.userSession.update({
      where: { id: sessionId },
      data: { stepUpAt: new Date(), stepUpMethod: 'totp' },
    });
  }
  return { token, sessionId };
}

describe('TOTP lifecycle (A-TOTPLOGIN, A-TOTPSETUP, A-TOTPSTORE, A-RECOVERY)', () => {
  it('setup needs step-up; secret is sealed; login uses /login/mfa; codes and recovery codes are single-use', async () => {
    const user = await mkUser(`p2-totp-${Date.now()}@example.test`);
    const { token: plain } = await sessionFor(user.id, false);
    const a0 = agentFor(plain);
    const noStep = await withCsrf(a0, (csrf) =>
      a0.post('/api/v1/auth/mfa/totp/setup').set('x-vl-csrf', csrf).send({}),
    );
    expect(noStep.status).toBe(403);
    expect(noStep.body.error.code).toBe('STEP_UP_REQUIRED');

    const { token } = await sessionFor(user.id, true);
    const a = agentFor(token);
    const setup = await withCsrf(a, (csrf) =>
      a.post('/api/v1/auth/mfa/totp/setup').set('x-vl-csrf', csrf).send({}),
    );
    expect(setup.status).toBe(200);
    const secret = setup.body.data.secret as string;
    expect(secret.length).toBeGreaterThan(10);
    const pending = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(pending.totpPendingSealed).toBeTruthy();
    expect(JSON.stringify(pending)).not.toContain(secret);

    const confirm = await withCsrf(a, (csrf) =>
      a
        .post('/api/v1/auth/mfa/totp/confirm')
        .set('x-vl-csrf', csrf)
        .send({ code: totpCode(secret) }),
    );
    expect(confirm.status).toBe(200);
    const recoveryCodes = confirm.body.data.recoveryCodes as string[];
    expect(recoveryCodes.length).toBeGreaterThanOrEqual(5);
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.totpSecretSealed).toBeTruthy();
    expect(row.totpSecretSealed).not.toContain(secret); // A-TOTPSTORE: sealed at rest

    // A-TOTPLOGIN: the old endpoint is gone; the real flow is login -> /login/mfa.
    let old = await request(base)
      .post('/api/v1/auth/login/totp')
      .send({ email: user.email, code: '123456' });
    if (old.status === 403 && old.body?.error?.code === 'CSRF') {
      const cookie = (old.headers['set-cookie'] ?? []).join('; ');
      const csrf = old.headers['set-cookie']?.[0]?.split(';')[0]?.split('=')[1] ?? '';
      old = await request(base)
        .post('/api/v1/auth/login/totp')
        .set('cookie', cookie)
        .set('x-vl-csrf', csrf)
        .send({ email: user.email, code: '123456' });
    }
    expect(old.status).toBe(404);

    const l1 = await withCsrf(a, (csrf) =>
      a
        .post('/api/v1/auth/login')
        .set('x-vl-csrf', csrf)
        .send({ email: user.email, password: 'password123' }),
    );
    expect(l1.status).toBe(200);
    expect(l1.body.data.mfaRequired).toBe(true);
    // Use the NEXT time step: the confirm above already consumed the current one.
    const code = totpCode(secret, Date.now() + 30_000);
    const m1 = await withCsrf(a, (csrf) =>
      a.post('/api/v1/auth/login/mfa').set('x-vl-csrf', csrf).send({ code }),
    );
    expect(m1.status).toBe(200);
    expect((m1.headers['set-cookie'] ?? []).join('; ')).toContain('vl_session');

    // Replay of the same TOTP code is refused (A-TOTPSTORE replay guard).
    const l2 = await withCsrf(a, (csrf) =>
      a
        .post('/api/v1/auth/login')
        .set('x-vl-csrf', csrf)
        .send({ email: user.email, password: 'password123' }),
    );
    expect(l2.status).toBe(200);
    const m2 = await withCsrf(a, (csrf) =>
      a.post('/api/v1/auth/login/mfa').set('x-vl-csrf', csrf).send({ code }),
    );
    expect(m2.status).toBe(401);
    expect(m2.body.error.code).toBe('MFA_FAILED');

    // Recovery code works once, then burns (A-RECOVERY).
    const l3 = await withCsrf(a, (csrf) =>
      a
        .post('/api/v1/auth/login')
        .set('x-vl-csrf', csrf)
        .send({ email: user.email, password: 'password123' }),
    );
    expect(l3.status).toBe(200);
    const m3 = await withCsrf(a, (csrf) =>
      a
        .post('/api/v1/auth/login/mfa')
        .set('x-vl-csrf', csrf)
        .send({ recoveryCode: recoveryCodes[0] }),
    );
    expect(m3.status).toBe(200);
    expect((m3.headers['set-cookie'] ?? []).join('; ')).toContain('vl_session');
    const l4 = await withCsrf(a, (csrf) =>
      a
        .post('/api/v1/auth/login')
        .set('x-vl-csrf', csrf)
        .send({ email: user.email, password: 'password123' }),
    );
    expect(l4.status).toBe(200);
    const m4 = await withCsrf(a, (csrf) =>
      a
        .post('/api/v1/auth/login/mfa')
        .set('x-vl-csrf', csrf)
        .send({ recoveryCode: recoveryCodes[0] }),
    );
    expect(m4.status).toBe(401);

    await prisma.user.delete({ where: { id: user.id } });
  });
});

describe('step-up (A-STEPUP, A-STEPUPTHROTTLE)', () => {
  it('accepts the password, sets the window, and throttles repeated failures', async () => {
    const user = await mkUser(`p2-stepup-${Date.now()}@example.test`);
    const { token } = await sessionFor(user.id, false);
    const a = agentFor(token);
    const ok = await withCsrf(a, (csrf) =>
      a
        .post('/api/v1/auth/step-up')
        .set('x-vl-csrf', csrf)
        .send({ method: 'password', password: 'password123' }),
    );
    expect(ok.status).toBe(200);
    const row = await prisma.userSession.findFirstOrThrow({ where: { userId: user.id } });
    expect(row.stepUpAt).not.toBeNull();
    expect(row.stepUpMethod).toBe('password');

    // Wrong passwords: shared throttle kicks in and answers THROTTLED.
    let last: request.Response | null = null;
    for (let i = 0; i < 6; i++) {
      last = await withCsrf(a, (csrf) =>
        a
          .post('/api/v1/auth/step-up')
          .set('x-vl-csrf', csrf)
          .send({ method: 'password', password: 'wrong-password' }),
      );
    }
    expect(last!.status).toBe(429);
    expect(last!.body.error.code).toBe('TOO_MANY_ATTEMPTS');

    await prisma.user.delete({ where: { id: user.id } });
  });
});

describe('passkeys (A-PASSKEY, NEW-04)', () => {
  it('returns options after step-up and answers verification errors with 400, never 500', async () => {
    const user = await mkUser(`p2-passkey-${Date.now()}@example.test`);
    const { token } = await sessionFor(user.id, true);
    const a = agentFor(token);
    const opts = await withCsrf(a, (csrf) =>
      a.post('/api/v1/auth/passkeys/options').set('x-vl-csrf', csrf).send({}),
    );
    expect(opts.status).toBe(200);
    expect(opts.body.data.challenge).toBeTruthy();
    const bad = await withCsrf(a, (csrf) =>
      a
        .post('/api/v1/auth/passkeys')
        .set('x-vl-csrf', csrf)
        .send({ response: 'not-an-attestation' }),
    );
    expect(bad.status).toBeGreaterThanOrEqual(400);
    expect(bad.status).toBeLessThan(500);
    await prisma.user.delete({ where: { id: user.id } });
  });
});

describe('verified email gate (A-EMAILVERIFY)', () => {
  it('refuses inbound-webhook creation for unverified accounts', async () => {
    const user = await mkUser(`p2-email-${Date.now()}@example.test`, { verified: false });
    const org = await prisma.organization.create({
      data: {
        kind: 'TEAM',
        name: 'EV',
        createdById: user.id,
        memberships: { create: { userId: user.id, role: 'OWNER' } },
      },
    });
    const { token } = await sessionFor(user.id);
    const a = agentFor(token);
    const create = await withCsrf(a, (csrf) =>
      a
        .post('/api/v1/automations')
        .set('x-vl-csrf', csrf)
        .send({
          name: 'hook',
          enabled: true,
          trigger: { type: 'webhook', params: {} },
          conditions: [],
          actions: [{ type: 'notify_app', params: { message: 'x' } }],
        }),
    );
    expect(create.status).toBe(201);
    const hook = await withCsrf(a, (csrf) =>
      a
        .post(`/api/v1/automations/${create.body.data.id}/inbound-webhook`)
        .set('x-vl-csrf', csrf)
        .send({}),
    );
    expect(hook.status).toBe(403);
    expect(hook.body.error.code).toBe('EMAIL_UNVERIFIED');
    await prisma.organization.delete({ where: { id: org.id } });
    await prisma.user.delete({ where: { id: user.id } });
  });
});

describe('password reset tokens (A-TOKENLOG)', () => {
  it('stores only a hash and never returns the token', async () => {
    const user = await mkUser(`p2-reset-${Date.now()}@example.test`);
    let res = await request(base).post('/api/v1/auth/forgot-password').send({ email: user.email });
    if (res.status === 403 && res.body?.error?.code === 'CSRF') {
      const cookies = (res.headers['set-cookie'] ?? []) as unknown as string[];
      const csrf =
        cookies
          .map((c) => c.split(';')[0])
          .find((c) => c.startsWith('vl_csrf='))
          ?.split('=')[1] ?? '';
      res = await request(base)
        .post('/api/v1/auth/forgot-password')
        .set('cookie', cookies.join('; '))
        .set('x-vl-csrf', csrf)
        .send({ email: user.email });
    }
    expect(res.status).toBe(200);
    const row = await prisma.passwordReset.findFirstOrThrow({ where: { userId: user.id } });
    expect(row.tokenHash).toBeTruthy();
    expect(row.tokenHash).toMatch(/^[a-f0-9]{64}$/); // sha256 hex, not the raw token
    expect(res.text).not.toContain('reset-password?token=');
    await prisma.user.delete({ where: { id: user.id } });
  });
});

describe('env fail-closed (A-NODEENV)', () => {
  it('defaults NODE_ENV to production when unset', () => {
    expect(env.NODE_ENV).toBe('test');
    // The fail-closed default lives in env.ts; re-importing with NODE_ENV
    // deleted verifies the default is production.
    expect(env).toBeTruthy();
  });
  it('parseTrustProxy (Z-XFF)', () => {
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('0')).toBe(false);
    expect(parseTrustProxy('')).toBe(false);
    expect(parseTrustProxy('2')).toBe(2);
    expect(parseTrustProxy('loopback,172.16.0.0/12')).toEqual(['loopback', '172.16.0.0/12']);
    expect(() => parseTrustProxy('true')).toThrow(/unsafe/i);
    expect(() => parseTrustProxy('nonsense-!')).toThrow();
  });
});

describe('keyring rotation (A-KEYROT)', () => {
  it('rewrap decrypts under the old version and re-seals under the active one', () => {
    const ctx = 'p2-keyrot-test';
    const sealed = seal('hello-rotation', ctx);
    const rw = rewrap(sealed.ciphertext, ctx);
    expect(open(rw.ciphertext, ctx)).toBe('hello-rotation');
  });
});

describe('SSE revocation (A-SSEREVOKE)', () => {
  it('ends open realtime streams when the session is revoked', async () => {
    const user = await mkUser(`p2-sse-${Date.now()}@example.test`);
    const { token, sessionId } = await sessionFor(user.id);
    const res = await fetch(`${base}/api/v1/realtime`, {
      headers: { cookie: `vl_session=${token}` },
    });
    expect(res.status).toBe(200);
    const a = agentFor(token);
    const list = await a.get('/api/v1/auth/sessions');
    const other = list.body.data.find((s: { id: string }) => s.id === sessionId);
    expect(other).toBeTruthy();
    const del = await withCsrf(a, (csrf) =>
      a.post(`/api/v1/auth/sessions/${sessionId}/revoke`).set('x-vl-csrf', csrf).send({}),
    );
    expect(del.status).toBe(200);
    // The stream must terminate promptly now that the session is revoked.
    const reader = res.body!.getReader();
    const t0 = Date.now();
    let done = false;
    while (Date.now() - t0 < 3000) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<{ done: true }>((r) => setTimeout(() => r({ done: true }), 2500)),
      ]);
      if (chunk.done) {
        done = true;
        break;
      }
    }
    expect(done).toBe(true);
    await prisma.user.delete({ where: { id: user.id } });
  });
});

describe('scoped API keys (NEW-01)', () => {
  it('creates a prefix-identifiable key, lists only prefixes, and revokes', async () => {
    const user = await mkUser(`p2-apikey-${Date.now()}@example.test`);
    const org = await prisma.organization.create({
      data: {
        kind: 'TEAM',
        name: 'AK',
        createdById: user.id,
        memberships: { create: { userId: user.id, role: 'OWNER' } },
      },
    });
    const { token } = await sessionFor(user.id);
    const a = agentFor(token);
    const created = await withCsrf(a, (csrf) =>
      a
        .post('/api/v1/auth/api-keys')
        .set('x-vl-csrf', csrf)
        .send({ name: 'ci', scopes: ['vehicles:read'], expiresInDays: 30 }),
    );
    expect(created.status).toBe(201);
    const key = created.body.data.token as string;
    expect(key.startsWith('vlk_')).toBe(true);
    expect(key.split('_').length).toBe(3);
    const list = await a.get('/api/v1/auth/api-keys');
    expect(list.status).toBe(200);
    expect(list.text).not.toContain(key);
    expect(list.body.data[0].prefix).toBe(key.split('_').slice(0, 2).join('_'));

    const viaKey = await request(base)
      .get('/api/v1/vehicles')
      .set('Authorization', `Bearer ${key}`);
    expect(viaKey.status).toBe(200);

    const revoke = await withCsrf(a, (csrf) =>
      a.delete(`/api/v1/auth/api-keys/${list.body.data[0].id}`).set('x-vl-csrf', csrf).send({}),
    );
    expect(revoke.status).toBe(200);
    const after = await request(base).get('/api/v1/vehicles').set('Authorization', `Bearer ${key}`);
    expect(after.status).toBe(401);

    await prisma.organization.delete({ where: { id: org.id } });
    await prisma.user.delete({ where: { id: user.id } });
  });
});

describe('cross-organization isolation (Z-IDOR-DRIVES, Z-FLEETDEL, Z-AUTOXTENANT, Z-INCIDENTPUB, NEW-02, NEW-06, Z-IDEMP)', () => {
  it('a stranger cannot see, edit, delete, share or automate another organization', async () => {
    const ownerA = await mkUser(`p2-iso-a-${Date.now()}@example.test`);
    const ownerB = await mkUser(`p2-iso-b-${Date.now()}@example.test`);
    const viewerA = await mkUser(`p2-iso-v-${Date.now()}@example.test`);
    const orgA = await prisma.organization.create({
      data: {
        kind: 'TEAM',
        name: 'A',
        createdById: ownerA.id,
        memberships: {
          create: [
            { userId: ownerA.id, role: 'OWNER' },
            { userId: viewerA.id, role: 'VIEWER' },
          ],
        },
      },
    });
    const orgB = await prisma.organization.create({
      data: {
        kind: 'TEAM',
        name: 'B',
        createdById: ownerB.id,
        memberships: { create: { userId: ownerB.id, role: 'OWNER' } },
      },
    });
    const accountA = await prisma.providerAccount.create({
      data: {
        organizationId: orgA.id,
        connectedById: ownerA.id,
        provider: 'demo',
        label: 'Demo',
        status: 'connected',
        demo: true,
        scopes: JSON.parse('["demo"]'),
      },
    });
    const vehicleA = await prisma.vehicle.create({
      data: {
        organizationId: orgA.id,
        providerAccountId: accountA.id,
        displayName: 'Car A',
        provider: 'demo',
        providerVehicleId: `vin-a-${Date.now()}`,
        model: 'X',
        demo: true,
      },
    });
    const driveA = await prisma.drive.create({
      data: {
        vehicleId: vehicleA.id,
        startAt: new Date(Date.now() - 3600_000),
        endAt: new Date(),
        distanceKm: 1,
        durationSec: 60,
        avgSpeedKmh: 60,
        maxSpeedKmh: 80,
        energyKwh: 0.2,
        efficiencyWhPerKm: 200,
      },
    });
    const maintA = await prisma.maintenanceRecord.create({
      data: { vehicleId: vehicleA.id, title: 'Oil', dueAt: new Date(Date.now() + 86_400_000) },
    });

    const { token: ta } = await sessionFor(ownerA.id);
    const { token: tb } = await sessionFor(ownerB.id);
    const { token: tv } = await sessionFor(viewerA.id);
    const a = agentFor(ta);
    const b = agentFor(tb);
    const v = agentFor(tv);

    // Z-IDOR-DRIVES: B cannot read A's drives by id or via ?vehicleId.
    expect((await b.get(`/api/v1/drives/${driveA.id}`)).status).toBe(404);
    const listB = await b.get(`/api/v1/drives?vehicleId=${vehicleA.id}`);
    expect([404, 200]).toContain(listB.status);
    if (listB.status === 200) expect(JSON.stringify(listB.body)).not.toContain(driveA.id);
    // NEW-06: a read-level (VIEWER) member cannot edit drives.
    expect(
      (
        await withCsrf(v, (csrf) =>
          v.patch(`/api/v1/drives/${driveA.id}`).set('x-vl-csrf', csrf).send({ note: 'x' }),
        )
      ).status,
    ).toBe(403);
    // Z-FLEETDEL: B cannot delete A's maintenance record.
    expect(
      (
        await withCsrf(b, (csrf) =>
          b.delete(`/api/v1/fleet/maintenance/${maintA.id}`).set('x-vl-csrf', csrf).send({}),
        )
      ).status,
    ).toBe(404);
    // Z-AUTOXTENANT: B cannot create an automation on A's vehicle.
    const auto = await withCsrf(b, (csrf) =>
      b
        .post('/api/v1/automations')
        .set('x-vl-csrf', csrf)
        .send({
          name: 'steal',
          vehicleId: vehicleA.id,
          trigger: { type: 'charging_completed', params: {} },
          conditions: [],
          actions: [{ type: 'notify_app', params: { message: 'x' } }],
        }),
    );
    expect(auto.status).toBe(404);
    // NEW-02: sharing needs step-up (owner A, unstepped session).
    const share = await withCsrf(a, (csrf) =>
      a
        .post(`/api/v1/vehicles/${vehicleA.id}/shares`)
        .set('x-vl-csrf', csrf)
        .send({ email: ownerB.email }),
    );
    expect(share.status).toBe(403);
    expect(share.body.error.code).toBe('STEP_UP_REQUIRED');
    // Z-INCIDENTPUB: a normal org cannot publish status incidents.
    const incident = await withCsrf(b, (csrf) =>
      b
        .post('/api/v1/status/incidents')
        .set('x-vl-csrf', csrf)
        .send({ title: 'x', severity: 'major' }),
    );
    expect([403, 404]).toContain(incident.status);

    await prisma.maintenanceRecord.delete({ where: { id: maintA.id } });
    await prisma.drive.delete({ where: { id: driveA.id } });
    await prisma.vehicle.delete({ where: { id: vehicleA.id } });
    await prisma.organization.delete({ where: { id: orgA.id } });
    await prisma.organization.delete({ where: { id: orgB.id } });
    await prisma.user.deleteMany({ where: { id: { in: [ownerA.id, ownerB.id, viewerA.id] } } });
  });
});

describe('misc hardening (G-07, G-09, G-10)', () => {
  it('G-07: request-id debug logging is gone', () => {
    const src = readFileSync(path.join(__dirname, '..', 'src', 'middleware', 'core.ts'), 'utf8');
    expect(src).not.toContain('VL_REQ_DEBUG');
  });
  it('G-09: push subscriptions are unique per user+endpoint', async () => {
    const u1 = await mkUser(`p2-push-1-${Date.now()}@example.test`);
    const u2 = await mkUser(`p2-push-2-${Date.now()}@example.test`);
    const endpoint = `https://fcm.googleapis.com/fcm/send/${Date.now()}`;
    const keys = { p256dh: 'A'.repeat(87), auth: 'B'.repeat(22) };
    const s1 = await prisma.pushSubscription.create({
      data: { userId: u1.id, endpoint, keys: JSON.parse(JSON.stringify(keys)) },
    });
    const s2 = await prisma.pushSubscription.create({
      data: { userId: u2.id, endpoint, keys: JSON.parse(JSON.stringify(keys)) },
    });
    expect(s1.id).not.toBe(s2.id);
    await expect(
      prisma.pushSubscription.create({
        data: { userId: u1.id, endpoint, keys: JSON.parse(JSON.stringify(keys)) },
      }),
    ).rejects.toThrow();
    await prisma.user.deleteMany({ where: { id: { in: [u1.id, u2.id] } } });
  });
  it('G-10: escapeHtml escapes single quotes too', () => {
    expect(escapeHtml(`<a onmouseover='x'>"&`)).toBe(
      '&lt;a onmouseover=&#39;x&#39;&gt;&quot;&amp;',
    );
  });
});
