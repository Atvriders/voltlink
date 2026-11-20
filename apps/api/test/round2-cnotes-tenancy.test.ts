// round2-cnotes-tenancy.test.ts — C-NOTESTS / TI-08 / TI-15 / TI-42:
// the mutants that still survived the full api-int suite:
//   M1c: an open registrant also becomes OWNER of the operator org
//   M2b: anonymous {email, code} at /login/mfa signs the user in (no ceremony)
//   M3b: another org's drives leak into a user's drive list
// nodemailer is mocked (TI-14 pattern) so no live SMTP sink is needed.
const envs = vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.SMTP_URL = 'smtp://fake.invalid:1025';
  process.env.VL_SETUP_TOKEN = 'cnotes-setup-token-0123456789abcdef01234567';
});
void envs;

const mailer = vi.hoisted(() => ({ sends: [] as unknown[], sendMail: vi.fn() }));
vi.mock('nodemailer', () => {
  const createTransport = () => ({
    sendMail: (...args: unknown[]) => {
      mailer.sends.push(args);
      return Promise.resolve({ messageId: 'mock' });
    },
  });
  return { default: { createTransport }, createTransport };
});

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { buildApp } from '../src/app';
import { initRedis } from '../src/core/redis';
import { prisma } from '../src/core/db';
import { randomId, sha256hex } from '../src/core/crypto';
import {
  bootstrapInstanceAdmin,
  registerUser,
  setRegistrationMode,
  createSession,
  createMfaCeremony,
  totpSetup,
  totpConfirm,
} from '../src/auth/service';
import { CEREMONY_COOKIE } from '../src/auth/ceremony';
import { TOTP, NobleCryptoPlugin, ScureBase32Plugin } from 'otplib';

let server: Server;
let base = '';
let adminEmail = '';
const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

beforeAll(async () => {
  await initRedis();
  const app = await buildApp();
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // The shared template seeds a bootstrapped marker; clear it so the real
  // first-run path runs (same pattern as round2-auth-service).
  await prisma.appSetting.deleteMany({
    where: { key: { in: ['instance.bootstrappedAt', 'instance.operatorOrgId'] } },
  });
  // Bootstrap the instance admin: this creates the OPERATOR org (M1c target).
  adminEmail = `cnotes-admin-${uniq()}@test.dev`;
  await bootstrapInstanceAdmin({
    email: adminEmail,
    name: 'CN Admin',
    password: 'cnotes-admin-pass-123',
    setupToken: process.env.VL_SETUP_TOKEN!,
  });
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const { prisma: p } = await import('../src/core/db');
  await p.$disconnect();
});

describe('C-NOTESTS M1c: open registrant stays out of the operator org', () => {
  it('a fresh open registration owns ONLY its own personal org', async () => {
    await setRegistrationMode('open');
    const email = `cnotes-open-${uniq()}@test.dev`;
    const res = await registerUser({
      email,
      name: 'Open Registrant',
      password: 'cnotes-open-pass-123',
    });
    expect(res.kind).toBe('check_email');
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const operatorOrgId = (
      await prisma.appSetting.findUniqueOrThrow({
        where: { key: 'instance.operatorOrgId' },
      })
    ).value;
    const memberships = await prisma.membership.findMany({ where: { userId: user.id } });
    // M1c adds an OWNER membership in the operator org: exactly one membership
    // in a PERSONAL org (never the operator org) is the spec.
    expect(memberships).toHaveLength(1);
    expect(memberships[0]!.organizationId).not.toBe(operatorOrgId);
    const org = await prisma.organization.findUniqueOrThrow({
      where: { id: memberships[0]!.organizationId },
    });
    expect(org.kind).toBe('PERSONAL');
    expect(org.createdById).toBe(user.id);
  });
});

describe('C-NOTESTS M2b: anonymous MFA completion cannot sign anyone in', () => {
  async function csrf(): Promise<{ header: string; cookie: string }> {
    const res = await fetch(`${base}/api/v1/auth/csrf`);
    const setCookies = res.headers.getSetCookie?.() ?? [];
    const token = setCookies.join(';').match(/vl_csrf=([^;]+)/)?.[1] ?? '';
    const cookie = setCookies.find((c) => c.startsWith('vl_csrf='))?.split(';')[0] ?? '';
    return { header: token, cookie };
  }

  it('anonymous {email, code} at /login/mfa is refused with no session cookie', async () => {
    const c = await csrf();
    const res = await fetch(`${base}/api/v1/auth/login/mfa`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-vl-csrf': c.header, cookie: c.cookie },
      body: JSON.stringify({ email: adminEmail, code: '123456' }),
    });
    const bodyText = await res.text();
    expect(res.status, bodyText).toBe(401);
    expect(res.headers.getSetCookie?.() ?? []).toEqual([]);
    expect(bodyText).not.toContain('vl_session');
  });

  it('anonymous {email, recoveryCode} at /login/mfa is refused', async () => {
    const c = await csrf();
    const res = await fetch(`${base}/api/v1/auth/login/mfa`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-vl-csrf': c.header, cookie: c.cookie },
      body: JSON.stringify({ email: adminEmail, recoveryCode: 'ABCD-EFGH-IJKL-MNOP' }),
    });
    const bodyText = await res.text();
    expect(res.status, bodyText).toBe(401);
    expect(res.headers.getSetCookie?.() ?? []).toEqual([]);
  });
});

describe("C-NOTESTS M3b: drive lists never leak another org's drives", () => {
  it("GET /drives returns only the session user's org drives", async () => {
    // Org A: the instance admin (already exists, operator org).
    const admin = await prisma.user.findFirstOrThrow({
      where: { email: { startsWith: 'cnotes-admin-' } },
    });
    const orgA = await prisma.membership.findFirstOrThrow({ where: { userId: admin.id } });
    // Org B: a second user with its own org and a drive.
    const userB = await prisma.user.create({
      data: {
        email: `cnotes-b-${uniq()}@test.dev`,
        name: 'Org B user',
        passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$s$s',
        webauthnUserId: randomId(),
        emailVerifiedAt: new Date(),
      },
    });
    const orgB = await prisma.organization.create({
      data: {
        kind: 'PERSONAL',
        name: `CNB-${uniq()}`,
        createdById: userB.id,
        memberships: { create: { userId: userB.id, role: 'OWNER' } },
      },
    });
    const mk = async (orgId: string, tag: string) => {
      const provider = await prisma.providerAccount.create({
        data: {
          organizationId: orgId,
          provider: 'mock',
          label: tag,
          status: 'connected',
          connectedById: admin.id,
          demo: false,
        },
      });
      const vehicle = await prisma.vehicle.create({
        data: {
          organizationId: orgId,
          providerAccountId: provider.id,
          provider: 'mock',
          providerVehicleId: `${tag}-${uniq()}`,
          displayName: tag,
          demo: false,
        },
      });
      const drive = await prisma.drive.create({
        data: {
          vehicleId: vehicle.id,
          startAt: new Date(),
          endAt: new Date(Date.now() + 1000),
          distanceKm: 1,
          durationSec: 60,
          avgSpeedKmh: 60,
          maxSpeedKmh: 60,
          energyKwh: 0.2,
          efficiencyWhPerKm: 200,
        },
      });
      return drive.id;
    };
    const driveA = await mk(orgA.organizationId, 'orgA');
    const driveB = await mk(orgB.id, 'orgB');
    const { token } = await createSession(admin.id, '127.0.0.1');
    const res = await fetch(`${base}/api/v1/drives`, {
      headers: { cookie: `vl_session=${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { items?: { id: string }[] } };
    const ids = (body.data.items ?? []).map((d) => d.id);
    expect(ids).toContain(driveA);
    expect(ids).not.toContain(driveB); // M3b leaks driveB here
  });
});

describe('R2-19 A-TOTPLOGIN: ceremony negatives (self-contained)', () => {
  const moduleTotp = new TOTP({ crypto: new NobleCryptoPlugin(), base32: new ScureBase32Plugin() });

  // Each ceremony test owns its users and enrolment: nothing depends on the
  // beforeAll admin or on test order (review #2 point 5 — the previous version
  // enrolled TOTP for the shared admin and broke with TOTP_ALREADY_ENABLED).
  async function mkUser(email: string): Promise<{ id: string; email: string }> {
    return prisma.user.create({
      data: {
        email,
        name: email.split('@')[0]!,
        passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$s$s',
        webauthnUserId: randomId(),
        emailVerifiedAt: new Date(),
      },
      select: { id: true, email: true },
    });
  }

  async function postMfa(cookieHeader: string, body: unknown): Promise<Response> {
    const res = await fetch(`${base}/api/v1/auth/csrf`);
    const setCookies = res.headers.getSetCookie?.() ?? [];
    const token = setCookies.join(';').match(/vl_csrf=([^;]+)/)?.[1] ?? '';
    const cookie = setCookies.find((x) => x.startsWith('vl_csrf='))?.split(';')[0] ?? '';
    return fetch(`${base}/api/v1/auth/login/mfa`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-vl-csrf': token,
        cookie: `${cookie}; ${cookieHeader}`,
      },
      body: JSON.stringify(body),
    });
  }

  async function makeCeremony(userId: string): Promise<string> {
    const cookies: Record<string, string> = {};
    await createMfaCeremony(
      { cookie: (name: string, value: string) => (cookies[name] = value) } as never,
      userId,
    );
    return cookies[CEREMONY_COOKIE] as string;
  }

  it('R2-19: a consumed ceremony cannot be replayed even with a correct code (M2c red answers 200 with Set-Cookie)', async () => {
    const user = await mkUser(`cnotes-r19-${uniq()}@test.dev`);
    const setup = await totpSetup(user.id);
    await totpConfirm(user.id, await moduleTotp.generate({ secret: setup.secret }));

    const handle = await makeCeremony(user.id);
    // Consume the ceremony out from under the replay (by its own handle hash).
    const row = await prisma.authChallenge.findFirstOrThrow({
      where: { handleHash: sha256hex(handle) },
    });
    await prisma.authChallenge.update({
      where: { id: row.id },
      data: { consumedAt: new Date() },
    });
    // Clear the replay marker so ONLY the consumedAt check refuses this
    // attempt: M2c (consumedAt ignored) then answers 200 with a Set-Cookie.
    await prisma.user.update({ where: { id: user.id }, data: { totpLastStep: null } });

    const res = await postMfa(`${CEREMONY_COOKIE}=${handle}`, {
      code: await moduleTotp.generate({ secret: setup.secret }),
    });
    const bodyText = await res.text();
    expect(res.status, bodyText).toBe(401);
    expect(bodyText).toContain('MFA_EXPIRED');
    expect(res.headers.getSetCookie?.() ?? []).toEqual([]);
    expect(await prisma.userSession.count({ where: { userId: user.id } })).toBe(0);
  });

  // R2-19 / TI-15, the spec negative (guide 05 §6.1): the ceremony is bound to
  // its owner by the code check — B, with its own session AND its own enrolled
  // TOTP, presents A's ceremony cookie with B's code: 401 MFA_FAILED, no
  // Set-Cookie, no new UserSession. (A's ceremony + A's own code signs A in
  // even under B's session — that is specified behaviour, not a defect; the
  // previous test asserted the opposite and was rewritten per review 1a.)
  it("R2-19: B's session + A's ceremony + B's code is refused", async () => {
    const userA = await mkUser(`cnotes-r19a-${uniq()}@test.dev`);
    const userB = await mkUser(`cnotes-r19b-${uniq()}@test.dev`);
    const setupA = await totpSetup(userA.id);
    await totpConfirm(userA.id, await moduleTotp.generate({ secret: setupA.secret }));
    const setupB = await totpSetup(userB.id);
    await totpConfirm(userB.id, await moduleTotp.generate({ secret: setupB.secret }));
    // The mutant that accepts B's code under B's session must not be blocked
    // by B's own replay marker.
    await prisma.user.update({ where: { id: userB.id }, data: { totpLastStep: null } });

    const { token: sessionB } = await createSession(userB.id, '127.0.0.1');
    const sessionsBefore = await prisma.userSession.count({ where: { userId: userB.id } });
    expect(sessionsBefore).toBe(1);

    const handle = await makeCeremony(userA.id);
    const res = await postMfa(`vl_session=${sessionB}; ${CEREMONY_COOKIE}=${handle}`, {
      code: await moduleTotp.generate({ secret: setupB.secret }),
    });
    const bodyText = await res.text();
    expect(res.status, bodyText).toBe(401);
    expect(bodyText).toContain('MFA_FAILED');
    expect(res.headers.getSetCookie?.() ?? []).toEqual([]);
    expect(await prisma.userSession.count({ where: { userId: userB.id } })).toBe(sessionsBefore);
  });
});
