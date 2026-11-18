// N-SUBS double opt-in: the subscribe endpoint never returns the confirmation
// token (it is emailed), and private incident updates never reach subscribers.

process.env.NODE_ENV = 'test';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildApp } from '../src/app';
import { prisma } from '../src/core/db';
import { initRedis } from '../src/core/redis';
import { randomId } from '../src/core/crypto';
import { createSession } from '../src/auth/service';

let server: Server;
let base: string;
let sendMailSpy: ReturnType<typeof vi.spyOn>;

beforeAll(async () => {
  await initRedis();
  server = buildApp({ serveSpa: false }).listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const ns = await import('../src/auth/service');
  sendMailSpy = vi.spyOn(ns, 'sendMail').mockResolvedValue({ ok: true, id: 'm1' } as never);
}, 30_000);

afterAll(async () => {
  sendMailSpy.mockRestore();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

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

async function operatorSession() {
  const user = await prisma.user.create({
    data: {
      email: `subsop.${Date.now()}@test.dev`,
      name: 'subsop',
      passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$s$s',
      webauthnUserId: randomId(),
      emailVerifiedAt: new Date(),
    },
  });
  const org = await prisma.organization.create({
    data: {
      kind: 'OPERATOR',
      name: `SUBOP-${Date.now()}`,
      memberships: { create: { userId: user.id, role: 'OWNER' } },
    },
  });
  await prisma.appSetting.upsert({
    where: { key: 'instance.operatorOrgId' },
    update: { value: org.id },
    create: { key: 'instance.operatorOrgId', value: org.id },
  });
  const { token } = await createSession(user.id);
  return { user, org, token };
}

describe('N-SUBS double opt-in', () => {
  it('subscribe never returns the confirmation token to the requester', async () => {
    sendMailSpy.mockClear();
    // Public POSTs still require the double-submit CSRF token.
    const agent = request.agent(base);
    const csrfRes = await agent.get('/api/v1/auth/csrf');
    const csrf = csrfRes.body.data.token as string;
    const subEmail = `subs.${Date.now()}@test.dev`;
    const res = await agent
      .post('/api/v1/status/subscribe')
      .set('Cookie', `vl_csrf=${csrf}`)
      .set('x-vl-csrf', csrf)
      .send({ email: subEmail });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('unsubscribeUrl');
    expect(JSON.stringify(res.body)).not.toContain('token');
    // The mail goes out with the confirmation link.
    const sent = sendMailSpy.mock.calls.find((c: unknown[]) =>
      String((c[0] as { subject?: string } | undefined)?.subject).includes('Confirm'),
    );
    expect(sent).toBeTruthy();
    // TI-30: the link must carry THIS subscription's token — a link that
    // ends at '/confirm/' (broken token) used to pass the substring check.
    const sub = await prisma.statusSubscription.findUniqueOrThrow({
      where: { email: subEmail },
    });
    const text = String((sent?.[0] as { text?: string } | undefined)?.text ?? '');
    expect(text).toContain(`/status/subscriptions/confirm/${sub.token}`);
  });

  it('private incident updates are not emailed; public ones are', async () => {
    const op = await operatorSession();
    const agent = agentFor(op.token);

    // A confirmed subscriber so delivery attempts are observable.
    await prisma.statusSubscription.create({
      data: {
        email: `conf.${Date.now()}@test.dev`,
        token: randomId(),
        confirmed: true,
      },
    });

    const privateRes = await withCsrf(agent, (csrf) =>
      agent.post('/api/v1/status/incidents').set('x-vl-csrf', csrf).send({
        title: 'nsubs private',
        severity: 'minor',
        message: 'x',
        components: [],
        public: false,
      }),
    );
    expect(privateRes.status).toBe(201);
    const privateId = privateRes.body.data.id as string;

    sendMailSpy.mockClear();
    const upd = await withCsrf(agent, (csrf) =>
      agent
        .post(`/api/v1/status/incidents/${privateId}/updates`)
        .set('x-vl-csrf', csrf)
        .send({ phase: 'identified', message: 'private detail' }),
    );
    expect(upd.status).toBe(201);
    // Give any fire-and-forget notification a chance to (wrongly) fire.
    await new Promise((r) => setTimeout(r, 250));
    expect(sendMailSpy).not.toHaveBeenCalled();

    // A public incident update does notify.
    const publicRes = await withCsrf(agent, (csrf) =>
      agent.post('/api/v1/status/incidents').set('x-vl-csrf', csrf).send({
        title: 'nsubs public',
        severity: 'minor',
        message: 'x',
        components: [],
        public: true,
      }),
    );
    expect(publicRes.status).toBe(201);
    const publicId = publicRes.body.data.id as string;
    sendMailSpy.mockClear();
    const pubUpd = await withCsrf(agent, (csrf) =>
      agent
        .post(`/api/v1/status/incidents/${publicId}/updates`)
        .set('x-vl-csrf', csrf)
        .send({ phase: 'identified', message: 'public detail' }),
    );
    expect(pubUpd.status).toBe(201);
    for (let i = 0; i < 20 && sendMailSpy.mock.calls.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(sendMailSpy).toHaveBeenCalled();

    await prisma.incident.deleteMany({
      where: { id: { in: [privateId, publicId] } },
    });
    await prisma.organization.delete({ where: { id: op.org.id } });
    await prisma.user.delete({ where: { id: op.user.id } });
  });
});
