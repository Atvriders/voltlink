// R2-55: remote lockout — failures from one client IP must not lock the
// account for another IP, and remote failures never lock the account.
// R2-53: the CSRF double-submit cookie is Secure on https deployments.
//
// Recipe note: run this file with TRUST_PROXY=127.0.0.1 exported so the app
// honours X-Forwarded-For, and PUBLIC_URL=https://... for the R2-53 test.

process.env.NODE_ENV = 'test';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildApp } from '../src/app';
import { prisma } from '../src/core/db';
import { initRedis } from '../src/core/redis';
import { randomId, hashPassword } from '../src/core/crypto';

let server: Server;
let base: string;

beforeAll(async () => {
  // Both env knobs are read live by the app, so they can be tuned here
  // without special run recipes.
  process.env.TRUST_PROXY = '127.0.0.1'; // req.ip follows X-Forwarded-For
  process.env.PUBLIC_URL = 'https://cars.example.org';
  await initRedis();
  server = buildApp({ serveSpa: false }).listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

// Login posts need a CSRF token like the SPA sends.
let csrf: string | null = null;
async function loginPost(ip: string, email: string, password: string) {
  const agent = request.agent(base);
  if (csrf) agent.set('Cookie', `vl_csrf=${csrf}`);
  const headers: Record<string, string> = {
    'X-Forwarded-For': ip,
    ...(csrf ? { 'x-vl-csrf': csrf } : {}),
  };
  let res = await agent.post('/api/v1/auth/login').set(headers).send({ email, password });
  if (res.status === 403 && res.body?.error?.code === 'CSRF') {
    const cookies = (res.headers['set-cookie'] ?? []) as unknown as string[];
    csrf =
      cookies
        .map((c) => (c ?? '').split(';')[0])
        .find((c) => c?.startsWith('vl_csrf='))
        ?.split('=')[1] ?? '';
    expect(csrf).toBeTruthy();
    res = await agent
      .post('/api/v1/auth/login')
      .set('Cookie', `vl_csrf=${csrf}`)
      .set('X-Forwarded-For', ip)
      .set('x-vl-csrf', csrf)
      .send({ email, password });
  }
  return res;
}

describe('R2-55 remote lockout', { tags: ['rate-limit'] }, () => {
  it('failures from one IP never lock the account for another IP', async () => {
    const email = `r255.${Date.now()}@example.invalid`;
    const user = await prisma.user.create({
      data: {
        email,
        name: 'r255',
        passwordHash: await hashPassword('correct-horse-battery'),
        webauthnUserId: randomId(),
        emailVerifiedAt: new Date(),
      },
    });

    // Attacker: six wrong passwords from six different IPs. A shared
    // per-account counter would lock by attempt five; per-IP counters must not.
    for (let i = 0; i < 6; i++) {
      const res = await loginPost(`10.7.0.${i + 1}`, email, 'wrong-password');
      expect([401, 403]).toContain(res.status);
    }

    // The victim's own IP is unaffected: correct password succeeds.
    const ok = await loginPost('10.9.9.9', email, 'correct-horse-battery');
    expect(ok.status).toBe(200);
    const cookies = (ok.headers['set-cookie'] ?? []) as unknown as string[];
    expect(cookies.some((c) => c?.startsWith('vl_session='))).toBe(true);

    // A single IP that fails repeatedly is still locked, for that IP only.
    for (let i = 0; i < 6; i++) {
      await loginPost('10.7.0.9', email, 'wrong-password');
    }
    const attacker = await loginPost('10.7.0.9', email, 'correct-horse-battery');
    expect(attacker.status).toBe(429);

    await prisma.user.delete({ where: { id: user.id } });
  });
});

describe('R2-53 CSRF cookie security', () => {
  it('marks the double-submit cookie Secure on an https PUBLIC_URL', async () => {
    const res = await request(base).get('/api/v1/auth/csrf');
    expect(res.status).toBe(200);
    const cookies = (res.headers['set-cookie'] ?? []) as unknown as string[];
    const csrfCookie = cookies.find((c) => c?.startsWith('vl_csrf='));
    expect(csrfCookie).toBeTruthy();
    expect(csrfCookie).toContain('Secure');
  });
});
