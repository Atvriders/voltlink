// R5: N-PUSH — push subscriptions accept only well-known https push services;
// a plain localhost http endpoint is rejected with INVALID_ENDPOINT.
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
import { isKnownPushEndpoint } from '../src/notifications/push';

let server: Server;
let base = '';

const p256dh = Buffer.concat([Buffer.from([0x04]), Buffer.alloc(64, 7)]).toString('base64url');
const auth = Buffer.alloc(16, 9).toString('base64url');

// The SPA double-submit pattern: first attempt may 403 and hand back the
// vl_csrf cookie; retry with it in cookie + header.
async function putJson(
  agent: ReturnType<typeof request.agent>,
  sessionToken: string,
  path: string,
  body: unknown,
) {
  let res = await agent.put(path).send(body as object);
  if (res.status === 403 && res.body?.error?.code === 'CSRF') {
    const cookies = (res.headers['set-cookie'] ?? []) as unknown as string[];
    const csrf = cookies
      .map((c) => (c ?? '').split(';')[0])
      .find((c) => c?.startsWith('vl_csrf='))
      ?.split('=')[1];
    expect(csrf).toBeTruthy();
    res = await agent
      .put(path)
      .set('Cookie', `vl_session=${sessionToken}; vl_csrf=${csrf ?? ''}`)
      .set('x-vl-csrf', String(csrf))
      .send(body as object);
  }
  return res;
}

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

describe('push subscription endpoint allow-list (N-PUSH)', () => {
  it('the allow-list guard rejects localhost http endpoints', () => {
    expect(isKnownPushEndpoint('http://127.0.0.1:5433/')).toBe(false);
    expect(isKnownPushEndpoint('https://fcm.googleapis.com/fcm/send/abc')).toBe(true);
    expect(isKnownPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x')).toBe(true);
    expect(isKnownPushEndpoint('https://evil.example/collect')).toBe(false);
  });
  it('rejects a non-https localhost endpoint', async () => {
    const user = await prisma.user.create({
      data: {
        email: `push-${Date.now()}-${randomId()}@test.dev`,
        name: 'Push',
        passwordHash: 'x',
        webauthnUserId: randomId(),
      },
    });
    const session = await createSession(user.id, '127.0.0.1');
    const agent = request.agent(base).set('Cookie', `vl_session=${session.token}`);
    const res = await putJson(agent, session.token, '/api/v1/notifications/push/subscriptions', {
      endpoint: 'http://127.0.0.1:5433/',
      keys: { p256dh, auth },
    });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INVALID_ENDPOINT');
  });

  it('accepts the exact body the SPA enable() sends (TI-10)', async () => {
    const user = await prisma.user.create({
      data: {
        email: `push2-${Date.now()}-${randomId()}@test.dev`,
        name: 'Push2',
        passwordHash: 'x',
        webauthnUserId: randomId(),
      },
    });
    const session = await createSession(user.id, '127.0.0.1');
    const agent = request.agent(base).set('Cookie', `vl_session=${session.token}`);
    const res = await putJson(agent, session.token, '/api/v1/notifications/push/subscriptions', {
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
      keys: { p256dh, auth },
    });
    expect(res.status).toBe(200);
    expect(res.body.data.ok).toBe(true);
  });
});
