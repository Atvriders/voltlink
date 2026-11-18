// round2-r20-firstrun.test.ts — R2-20: the REAL first-run flow over HTTP on an
// unseeded database: setup-status -> register refused without the setup token
// -> register with the setup token creates an instance admin who owns the
// operator org -> invite / open / closed registration modes over HTTP.
// Mutants: M20a (register in setup mode always 403) and M20b (first admin not
// isInstanceAdmin) must both fail this suite.
const envs = vi.hoisted(() => {
  process.env.NODE_ENV = 'test';
  process.env.SMTP_URL = 'smtp://fake.invalid:1025';
  process.env.VL_SETUP_TOKEN = 'r20-setup-token-0123456789abcdef01234567';
});
void envs;

vi.mock('nodemailer', () => ({
  default: {
    createTransport: () => ({
      sendMail: () => Promise.resolve({ messageId: 'mock' }),
    }),
  },
  createTransport: () => ({
    sendMail: () => Promise.resolve({ messageId: 'mock' }),
  }),
}));

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { buildApp } from '../src/app';
import { initRedis } from '../src/core/redis';
import { prisma } from '../src/core/db';
import { sha256hex } from '../src/core/crypto';
import { setRegistrationMode } from '../src/auth/service';

let server: Server;
let base = '';
let adminEmail = '';
const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

async function csrfAndPost(path: string, body: unknown) {
  const c0 = await fetch(`${base}/api/v1/auth/csrf`);
  const setCookies = c0.headers.getSetCookie?.() ?? [];
  const token = setCookies.join(';').match(/vl_csrf=([^;]+)/)?.[1] ?? '';
  const cookie = setCookies.find((x) => x.startsWith('vl_csrf='))?.split(';')[0] ?? '';
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-vl-csrf': token, cookie },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  await initRedis();
  const app = await buildApp();
  server = await new Promise<Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // Unseed: no markers, no users — the template's test-bootstrap rows go away.
  await prisma.appSetting.deleteMany({
    where: { key: { in: ['instance.bootstrappedAt', 'instance.operatorOrgId'] } },
  });
  await prisma.user.deleteMany({ where: { email: 'test-bootstrap@voltlink.test' } });
  adminEmail = `r20-admin-${uniq()}@test.dev`;
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe('R2-20 first-run setup over HTTP on an unseeded database', () => {
  it('setup-status reports needsSetup before any registration', async () => {
    const res = await fetch(`${base}/api/v1/auth/setup-status`);
    const body = (await res.json()) as { data: { needsSetup: boolean } };
    expect(res.status).toBe(200);
    expect(body.data.needsSetup).toBe(true);
  });

  it('register WITHOUT the setup token is refused in setup mode (M20a)', async () => {
    const res = await csrfAndPost('/api/v1/auth/register', {
      email: `r20-x-${uniq()}@test.dev`,
      name: 'No Token',
      password: 'r20-password-123',
    });
    const bodyText = await res.text();
    expect(res.status, bodyText).toBe(403);
    expect(bodyText).toContain('SETUP_REQUIRED');
  });

  it('register WITH the setup token creates the instance admin owning the operator org (M20b)', async () => {
    const res = await csrfAndPost('/api/v1/auth/register', {
      email: adminEmail,
      name: 'R20 Admin',
      password: 'r20-password-123',
      setupToken: process.env.VL_SETUP_TOKEN,
    });
    const bodyText = await res.text();
    expect(res.status, bodyText).toBe(201);
    const body = JSON.parse(bodyText) as {
      data?: { user?: { id: string; isInstanceAdmin?: boolean } };
    };
    expect(body.data?.user?.id).toBeTruthy();
    const created = await prisma.user.findUniqueOrThrow({
      where: { id: body.data!.user!.id },
    });
    expect(created.isInstanceAdmin, 'first admin must be instance admin (M20b)').toBe(true);
    const operator = await prisma.appSetting.findUniqueOrThrow({
      where: { key: 'instance.operatorOrgId' },
    });
    const membership = await prisma.membership.findFirstOrThrow({
      where: { userId: body.data!.user!.id, organizationId: operator.value },
    });
    expect(membership.role).toBe('OWNER');
  });

  it('invite mode: a valid invitation token is required over HTTP', async () => {
    await setRegistrationMode('invite');
    const noToken = await csrfAndPost('/api/v1/auth/register', {
      email: `r20-i-${uniq()}@test.dev`,
      name: 'Invitee',
      password: 'r20-password-123',
    });
    expect(noToken.status).toBe(403);
    expect(await noToken.text()).toContain('INVITE_REQUIRED');

    const email = `r20-i-${uniq()}@test.dev`;
    const token = `inv-${uniq()}`;
    const admin = await prisma.user.findUniqueOrThrow({ where: { email: adminEmail } });
    const org = await prisma.organization.findFirstOrThrow({
      where: { memberships: { some: { userId: admin.id, role: 'OWNER' } } },
    });
    await prisma.invitation.create({
      data: {
        email,
        tokenHash: sha256hex(token),
        kind: 'membership',
        organizationId: org.id,
        role: 'VIEWER',
        invitedById: admin.id,
        expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
      },
    });
    const withToken = await csrfAndPost('/api/v1/auth/register', {
      email,
      name: 'Invitee',
      password: 'r20-password-123',
      inviteToken: token,
    });
    const bodyText = await withToken.text();
    expect(withToken.status, bodyText).toBe(201);
  });

  it('open mode: registration answers check_email over HTTP', async () => {
    await setRegistrationMode('open');
    const res = await csrfAndPost('/api/v1/auth/register', {
      email: `r20-o-${uniq()}@test.dev`,
      name: 'Open User',
      password: 'r20-password-123',
    });
    const bodyText = await res.text();
    expect(res.status, bodyText).toBe(202);
  });

  it('closed mode: registration is refused over HTTP', async () => {
    await setRegistrationMode('closed');
    const res = await csrfAndPost('/api/v1/auth/register', {
      email: `r20-c-${uniq()}@test.dev`,
      name: 'Closed User',
      password: 'r20-password-123',
    });
    const bodyText = await res.text();
    expect(res.status, bodyText).toBe(403);
    expect(bodyText).toContain('REGISTRATION_CLOSED');
  });
});
