// Regression tests for the webhook stack (guide 03):
// N-WHSIGN (Standard Webhooks signing), Z-INBOUNDWH (inbound hooks with
// dedupe), N-CHANSECRETS (channel URLs sealed at rest), G-08 (raw URLs never
// returned), Z-TESLASTATE (single-use session-bound OAuth state), Z-DEMOSCOPE
// (per-org demo degradation) and N-CSV (formula-injection neutralization).

process.env.NODE_ENV = 'test';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildApp } from '../src/app';
import { prisma } from '../src/core/db';
import { initRedis } from '../src/core/redis';
import { randomId, sha256hex, sealJson } from '../src/core/crypto';
import { createSession } from '../src/auth/service';
import { csv } from '../src/core/util';
import {
  generateWebhookSecret,
  outgoingHeaders,
  signV1,
  verifyIncoming,
} from '../src/webhooks/standardWebhooks';

let server: Server;
let base: string;

beforeAll(async () => {
  await initRedis(); // notify() enqueues outbox jobs (N-DROPPED)
  server = buildApp({ serveSpa: false }).listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 30_000);

afterAll(async () => {
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
        .map((c) => c.split(';')[0])
        .find((c) => c.startsWith('vl_csrf='))
        ?.split('=')[1] ?? '';
    if (!csrf) throw new Error('CSRF cookie was not issued');
    csrfCache.set(agent, csrf);
    res = await fn(csrf);
  }
  return res;
}

async function mkUser(email: string) {
  return prisma.user.create({
    data: {
      email,
      name: email.split('@')[0]!,
      passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$s$s',
      webauthnUserId: randomId(),
      emailVerifiedAt: new Date(),
    },
  });
}

async function mkOrgWithOwner(email: string) {
  const user = await mkUser(email);
  const org = await prisma.organization.create({
    data: {
      kind: 'TEAM',
      name: `W-${email.split('@')[0]}`,
      createdById: user.id,
      memberships: { create: { userId: user.id, role: 'OWNER' } },
    },
  });
  return { user, org };
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

describe('Standard Webhooks (N-WHSIGN)', () => {
  it('signs and verifies a payload, and rejects wrong/tampered inputs', () => {
    const secret = generateWebhookSecret();
    expect(secret.startsWith('whsec_')).toBe(true);
    const body = JSON.stringify({ a: 1 });
    const headers = outgoingHeaders([secret], 'msg_test1', body);
    const v = verifyIncoming([secret], headers, Buffer.from(body));
    expect(v).toMatchObject({ ok: true, msgId: 'msg_test1' });

    expect(verifyIncoming(['whsec_other'], headers, Buffer.from(body))).toMatchObject({
      ok: false,
      reason: 'bad_signature',
    });
    expect(verifyIncoming([secret], {}, Buffer.from(body))).toMatchObject({
      ok: false,
      reason: 'missing_headers',
    });

    const old = new Date(Date.now() - 900_000).getTime() / 1000;
    const stale = {
      'webhook-id': 'msg_stale',
      'webhook-timestamp': String(Math.floor(old)),
      'webhook-signature': signV1(secret, 'msg_stale', Math.floor(old), body),
    };
    expect(verifyIncoming([secret], stale, Buffer.from(body))).toMatchObject({
      ok: false,
      reason: 'stale',
    });

    const tampered = {
      ...headers,
      'webhook-signature': `${headers['webhook-signature']!.slice(0, 8)}bad`,
    };
    expect(verifyIncoming([secret], tampered, Buffer.from(body))).toMatchObject({
      ok: false,
      reason: 'bad_signature',
    });
  });
});

describe('webhook endpoint lifecycle (N-WHSIGN, G-08)', () => {
  it('stores only the sealed secret, returns the secret once, masks the URL', async () => {
    const { user } = await mkOrgWithOwner(`wh-1-${Date.now()}@example.test`);
    const { token } = await sessionFor(user.id);
    const agent = agentFor(token);
    const rawUrl = 'https://example.com/hook?token=supersecret123';
    const res = await withCsrf(agent, (csrf) =>
      agent
        .post('/api/v1/notifications/webhooks')
        .set('x-vl-csrf', csrf)
        .send({ name: 'ci', url: rawUrl, events: ['telemetry.received'] }),
    );
    expect(res.status).toBe(201);
    const secret = res.body.data.secret as string;
    expect(secret.startsWith('whsec_')).toBe(true);
    // Secret shown exactly once: creation.
    expect(JSON.stringify(res.body).split(secret).length - 1).toBe(1);

    const row = await prisma.webhookEndpoint.findFirstOrThrow({ where: { userId: user.id } });
    expect(row.secretSealed).not.toBe('');
    expect(JSON.stringify(row)).not.toContain(secret);
    expect(row.displayHint).toBe('https://example.com/…');
    expect(JSON.parse(JSON.stringify(row.events))).toEqual(['telemetry.received']);

    // G-08: listing never returns the raw URL.
    const list = await agent.get('/api/v1/notifications/webhooks');
    expect(list.status).toBe(200);
    expect(list.text).not.toContain('supersecret123');
    expect(list.body.data[0].displayHint).toBe('https://example.com/…');

    await prisma.webhookEndpoint.deleteMany({ where: { userId: user.id } });
    await prisma.organization.delete({
      where: {
        id: (await prisma.membership.findFirstOrThrow({ where: { userId: user.id } }))
          .organizationId,
      },
    });
    await prisma.user.delete({ where: { id: user.id } });
  });

  it('rotate-secret keeps the previous secret for 24h and requires step-up', async () => {
    const { user } = await mkOrgWithOwner(`wh-2-${Date.now()}@example.test`);
    const { token } = await sessionFor(user.id, true);
    const agent = agentFor(token);
    let res = await withCsrf(agent, (csrf) =>
      agent
        .post('/api/v1/notifications/webhooks')
        .set('x-vl-csrf', csrf)
        .send({ name: 'rot', url: 'https://example.com/r' }),
    );
    const id = res.body.data.id as string;
    const first = res.body.data.secret as string;

    const row0 = await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id } });
    res = await withCsrf(agent, (csrf) =>
      agent
        .post(`/api/v1/notifications/webhooks/${id}/rotate-secret`)
        .set('x-vl-csrf', csrf)
        .send({}),
    );
    expect(res.status).toBe(200);
    const second = res.body.data.secret as string;
    expect(second).not.toBe(first);
    const row = await prisma.webhookEndpoint.findUniqueOrThrow({ where: { id } });
    expect(row.previousSecretSealed).toBe(row0.secretSealed);
    const until = row.previousUntil!;
    const delta = until.getTime() - Date.now();
    expect(delta).toBeGreaterThan(23 * 3600_000);
    expect(delta).toBeLessThan(25 * 3600_000);

    await prisma.webhookEndpoint.deleteMany({ where: { userId: user.id } });
    await prisma.organization.delete({
      where: {
        id: (await prisma.membership.findFirstOrThrow({ where: { userId: user.id } }))
          .organizationId,
      },
    });
    await prisma.user.delete({ where: { id: user.id } });
  });
});

describe('inbound webhooks (Z-INBOUNDWH)', () => {
  it('verifies signatures, dispatches once, and dedupes replays', async () => {
    const { user } = await mkOrgWithOwner(`wh-3-${Date.now()}@example.test`);
    const { token } = await sessionFor(user.id);
    const agent = agentFor(token);
    let res = await withCsrf(agent, (csrf) =>
      agent
        .post('/api/v1/automations')
        .set('x-vl-csrf', csrf)
        .send({
          name: 'inbound',
          enabled: true,
          trigger: { type: 'webhook', params: {} },
          conditions: [],
          actions: [{ type: 'notify_app', params: { message: 'inbound fired' } }],
          cooldownSec: 60,
          maxRetries: 0,
        }),
    );
    expect(res.status).toBe(201);
    const automationId = res.body.data.id as string;

    res = await withCsrf(agent, (csrf) =>
      agent
        .post(`/api/v1/automations/${automationId}/inbound-webhook`)
        .set('x-vl-csrf', csrf)
        .send({}),
    );
    expect(res.status).toBe(201);
    const { url, secret, publicId } = res.body.data as {
      url: string;
      secret: string;
      publicId: string;
    };
    expect(url).toContain('/api/v1/hooks/automations/');
    expect(url.endsWith(publicId)).toBe(true);

    const hookRow = await prisma.inboundWebhook.findUniqueOrThrow({ where: { publicId } });
    expect(JSON.stringify(hookRow)).not.toContain(secret);

    const body = JSON.stringify({ hello: 'world' });
    const msgId = 'msg_inbound_1';
    const headers = outgoingHeaders([secret], msgId, body);
    const path = new URL(url).pathname;
    const delivered = await request(base).post(path).set(headers).send(body);
    expect(delivered.status).toBe(200);
    expect(delivered.body.data.ok).toBe(true);
    const receipt = await prisma.inboundWebhookReceipt.findUnique({
      where: { hookId_messageId: { hookId: hookRow.id, messageId: msgId } },
    });
    expect(receipt).not.toBeNull();

    // Replay with the same message id -> acknowledged, marked replayed, no dup dispatch.
    const replay = await request(base).post(path).set(headers).send(body);
    expect(replay.status).toBe(200);
    expect(replay.body.data.replayed).toBe(true);

    // Wrong signature -> 401 SIGNATURE.
    const bad = {
      ...headers,
      'webhook-signature': `${headers['webhook-signature']!.slice(0, 10)}tampered`,
    };
    const badRes = await request(base).post(path).set(bad).send(body);
    expect(badRes.status).toBe(401);
    expect(badRes.body.error.code).toBe('SIGNATURE');

    const missing = await request(base).post(path).send(body);
    expect(missing.status).toBe(401);
    expect(missing.body.error.code).toBe('SIGNATURE');

    const unknown = await request(base)
      .post('/api/v1/hooks/automations/nope_does_not_exist')
      .send(body);
    expect(unknown.status).toBe(404);

    await prisma.automation.delete({ where: { id: automationId } });
    await prisma.organization.delete({
      where: {
        id: (await prisma.membership.findFirstOrThrow({ where: { userId: user.id } }))
          .organizationId,
      },
    });
    await prisma.user.delete({ where: { id: user.id } });
  });
});

describe('channel secrets (N-CHANSECRETS, G-08)', () => {
  it('seals channel URLs, migrates legacy settings, and masks on read', async () => {
    const { user } = await mkOrgWithOwner(`wh-4-${Date.now()}@example.test`);
    const { token } = await sessionFor(user.id);
    const agent = agentFor(token);
    const raw = 'https://example.com/ntfy/room?token=chansupersecret';

    const put = await withCsrf(agent, (csrf) =>
      agent.put('/api/v1/notifications/channel-urls').set('x-vl-csrf', csrf).send({ ntfyUrl: raw }),
    );
    expect(put.status).toBe(200);

    const channel = await prisma.notificationChannel.findFirstOrThrow({
      where: { userId: user.id, kind: 'ntfy' },
    });
    expect(channel.configCiphertext).not.toBe('');
    expect(JSON.stringify(channel)).not.toContain('chansupersecret');
    const legacy = await prisma.appSetting.findUnique({
      where: { key: `user:${user.id}:ntfyUrl` },
    });
    expect(legacy).toBeNull();

    // G-08: preferences return only the masked form.
    const prefs = await agent.get('/api/v1/notifications/preferences');
    expect(prefs.status).toBe(200);
    expect(prefs.body.data.channelUrls.ntfyUrl).toBe('https://example.com/…');
    expect(prefs.text).not.toContain('chansupersecret');

    // Legacy AppSetting values are lazily migrated on read.
    await prisma.appSetting.create({
      data: {
        key: `user:${user.id}:gotifyUrl`,
        value: 'https://example.com/gotify?token=legacysecret',
      },
    });
    await agent.get('/api/v1/notifications/preferences');
    const migrated = await prisma.notificationChannel.findFirst({
      where: { userId: user.id, kind: 'gotify' },
    });
    expect(migrated).not.toBeNull();
    expect(JSON.stringify(migrated)).not.toContain('legacysecret');
    expect(
      await prisma.appSetting.findUnique({ where: { key: `user:${user.id}:gotifyUrl` } }),
    ).toBeNull();

    await prisma.notificationChannel.deleteMany({ where: { userId: user.id } });
    await prisma.organization.delete({
      where: {
        id: (await prisma.membership.findFirstOrThrow({ where: { userId: user.id } }))
          .organizationId,
      },
    });
    await prisma.user.delete({ where: { id: user.id } });
  });
});

describe('Z-TESLASTATE (single-use session-bound OAuth state)', () => {
  it('rejects a foreign session, an expired state, and consumes the state once', async () => {
    const { user, org } = await mkOrgWithOwner(`wh-5-${Date.now()}@example.test`);
    const { token, sessionId } = await sessionFor(user.id);
    const agent = agentFor(token);

    const makeState = (key: string, sid: string, expiresAt: Date) =>
      prisma.oAuthState.create({
        data: {
          stateHash: sha256hex(key),
          provider: 'tesla',
          userId: user.id,
          sessionId: sid,
          organizationId: org.id,
          verifierSealed: sealJson({ verifier: 'v' }).ciphertext,
          expiresAt,
        },
      });

    // Foreign session (same user, different session): no account, state kept.
    await makeState('st_foreign', 'someone-elses-session', new Date(Date.now() + 300_000));
    const foreign = await agent.get('/api/v1/providers/tesla/callback?code=x&state=st_foreign');
    expect(foreign.status).toBe(302);
    expect(foreign.headers.location).toContain('tesla_error=invalid_state');
    expect(
      await prisma.providerAccount.count({ where: { connectedById: user.id, provider: 'tesla' } }),
    ).toBe(0);
    expect(
      await prisma.oAuthState.findUnique({ where: { stateHash: sha256hex('st_foreign') } }),
    ).not.toBeNull();

    // Expired state: rejected, no account.
    await makeState('st_expired', sessionId, new Date(Date.now() - 1000));
    const expired = await agent.get('/api/v1/providers/tesla/callback?code=x&state=st_expired');
    expect(expired.status).toBe(302);
    expect(expired.headers.location).toContain('tesla_error=invalid_state');

    // Valid state, empty code: rejected early, state kept.
    await makeState('st_nocode', sessionId, new Date(Date.now() + 300_000));
    const nocode = await agent.get('/api/v1/providers/tesla/callback?code=&state=st_nocode');
    expect(nocode.status).toBe(302);
    expect(nocode.headers.location).toContain('tesla_error=invalid_state');

    // Valid state + code: consumed exactly once (single-use), then the token
    // exchange fails (no Tesla credentials in the test env) -> exchange_failed.
    await makeState('st_once', sessionId, new Date(Date.now() + 300_000));
    const once = await agent.get('/api/v1/providers/tesla/callback?code=x&state=st_once');
    expect(once.status).toBe(302);
    expect(once.headers.location).toContain('tesla_error=exchange_failed');
    expect(
      await prisma.oAuthState.findUnique({ where: { stateHash: sha256hex('st_once') } }),
    ).toBeNull();
    expect(
      await prisma.providerAccount.count({ where: { connectedById: user.id, provider: 'tesla' } }),
    ).toBe(0);

    // Replay of the consumed state: invalid, no account.
    const replay = await agent.get('/api/v1/providers/tesla/callback?code=x&state=st_once');
    expect(replay.status).toBe(302);
    expect(replay.headers.location).toContain('tesla_error=invalid_state');

    await prisma.oAuthState.deleteMany({ where: { userId: user.id } });
    await prisma.organization.delete({ where: { id: org.id } });
    await prisma.user.delete({ where: { id: user.id } });
  });
});

describe('Z-DEMOSCOPE (per-org demo degradation)', () => {
  it('degrades only the demo account organization, never the process', async () => {
    const a = await mkOrgWithOwner(`wh-6a-${Date.now()}@example.test`);
    const b = await mkOrgWithOwner(`wh-6b-${Date.now()}@example.test`);
    const { token: ta } = await sessionFor(a.user.id);
    const { token: tb } = await sessionFor(b.user.id);
    const agentA = agentFor(ta);
    const agentB = agentFor(tb);

    const connect = await withCsrf(agentA, (csrf) =>
      agentA.post('/api/v1/providers/demo/connect').set('x-vl-csrf', csrf).send({}),
    );
    expect(connect.status).toBe(200);
    const accountId = connect.body.data.accountId as string;

    const toggle = await withCsrf(agentA, (csrf) =>
      agentA
        .post(`/api/v1/providers/${accountId}/demo-degraded`)
        .set('x-vl-csrf', csrf)
        .send({ degraded: true }),
    );
    expect(toggle.status).toBe(200);
    expect(toggle.body.data.degraded).toBe(true);

    // Org A sees the demo provider degraded; org B does not.
    const readA = await agentA.get('/api/v1/providers/readiness');
    const demoA = readA.body.data.find((p: { provider: string }) => p.provider === 'demo');
    expect(demoA.ok).toBe(false);
    const readB = await agentB.get('/api/v1/providers/readiness');
    const demoB = readB.body.data.find((p: { provider: string }) => p.provider === 'demo');
    expect(demoB.ok).toBe(true);

    // Non-demo accounts are out of scope.
    const bogus = await withCsrf(agentA, (csrf) =>
      agentA
        .post('/api/v1/providers/not-an-account/demo-degraded')
        .set('x-vl-csrf', csrf)
        .send({ degraded: true }),
    );
    expect(bogus.status).toBe(404);

    await prisma.providerAccount.deleteMany({ where: { organizationId: a.org.id } });
    await prisma.organization.delete({ where: { id: a.org.id } });
    await prisma.user.delete({ where: { id: a.user.id } });
    await prisma.organization.delete({ where: { id: b.org.id } });
    await prisma.user.delete({ where: { id: b.user.id } });
  });
});

describe('N-CSV (formula injection neutralization)', () => {
  it('prefixes formula-leading cells with a quote', () => {
    expect(csv([['=cmd', 'plain', '-2+3', '@ref', '+x']])).toBe(`'=cmd,plain,'-2+3,'@ref,'+x`);
    expect(csv([['a"b', 'c,d']])).toBe(`"a""b","c,d"`);
    expect(csv([['ok']])).toBe('ok');
  });
});
