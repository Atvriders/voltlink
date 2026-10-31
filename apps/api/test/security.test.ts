// Security behaviour: auth enforcement, brute-force lockout, authorization.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import crypto from 'node:crypto';
import { buildApp } from '../src/app';
import { prisma } from '../src/core/db';

process.env.NODE_ENV = 'test';
if (!process.env.JWT_SECRET) process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');

let server: Server;
let port = 0;
const base = () => `http://127.0.0.1:${port}`;

beforeAll(async () => {
  server = buildApp({ serveSpa: false }).listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  port = (server.address() as AddressInfo).port;
}, 30000);

afterAll(async () => {
  await prisma.$disconnect();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('authentication enforcement', () => {
  const protectedPaths = [
    '/api/v1/vehicles',
    '/api/v1/commands',
    '/api/v1/drives',
    '/api/v1/charging/sessions',
    '/api/v1/automations',
    '/api/v1/notifications',
    '/api/v1/fleet/overview',
    '/api/v1/admin/health',
    '/api/v1/users/settings',
    '/api/v1/users/favorites',
  ];

  for (const p of protectedPaths) {
    it(`401s without a session: ${p}`, async () => {
      const res = await fetch(`${base()}${p}`);
      expect(res.status).toBe(401);
    });
  }

  it('realtime SSE requires auth', async () => {
    const res = await fetch(`${base()}/api/v1/realtime`);
    expect(res.status).toBe(401);
  });

  it('public status stays public', async () => {
    const res = await fetch(`${base()}/api/v1/status`);
    expect(res.status).toBe(200);
  });

  it('healthz/readyz stay public', async () => {
    expect((await fetch(`${base()}/healthz`)).status).toBe(200);
  });
});

describe('brute-force protection', () => {
  it('locks out repeated failed logins', async () => {
    const email = `vl-sec-${Date.now()}@example.test`;
    await prisma.user.create({
      data: {
        email,
        name: 'Sec Tester',
        passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$s$s',
        webauthnUserId: crypto.randomBytes(16).toString('hex'),
        emailVerifiedAt: new Date(),
      },
    });

    // The API issues the CSRF cookie on the first mutating request; the header
    // must echo it on the retry (middleware/core.ts csrf()).
    const first = await fetch(`${base()}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'wrong-password' }),
    });
    expect(first.status).toBe(403);
    const csrfCookie = first.headers.getSetCookie()[0]!.split(';')[0]!;
    const csrfToken = csrfCookie.split('=')[1]!;

    // Hammer the login endpoint with wrong passwords.
    let last = 0;
    for (let i = 0; i < 12; i++) {
      const res = await fetch(`${base()}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: csrfCookie, 'x-vl-csrf': csrfToken },
        body: JSON.stringify({ email, password: 'wrong-password' }),
      });
      last = res.status;
      if (last === 429) break;
    }
    expect(last).toBe(429);

    await prisma.user.delete({ where: { email } });
  });
});
