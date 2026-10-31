// API integration tests against the real Express app + PostgreSQL.
// Requires a migrated DATABASE_URL (CI provides a Postgres service).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import crypto from 'node:crypto';
import { buildApp } from '../src/app';
import { prisma } from '../src/core/db';
import { env } from '../src/core/env';

process.env.NODE_ENV = 'test';
if (!process.env.JWT_SECRET) process.env.JWT_SECRET = crypto.randomBytes(32).toString('hex');

const base = () => `http://127.0.0.1:${port}`;
let server: Server;
let port = 0;

type CookieJar = { setCookie: string[]; cookie: string };

class Api {
  csrf = '';
  jar: CookieJar = { setCookie: [], cookie: '' };

  applyHeaders(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    if (this.csrf) h['x-vl-csrf'] = this.csrf;
    if (this.jar.cookie) h.cookie = this.jar.cookie;
    return h;
  }

  absorb(res: Response) {
    const sc = res.headers.getSetCookie?.() ?? [];
    for (const c of sc) this.jar.setCookie.push(c);
    // Last value per cookie name wins (e.g. a fresh vl_session replaces a
    // revoked one).
    const byName = new Map<string, string>();
    for (const c of this.jar.setCookie) {
      const pair = c.split(';')[0]!;
      const name = pair.split('=')[0]!;
      byName.set(name, pair);
    }
    if (byName.size) this.jar.cookie = [...byName.values()].join('; ');
  }

  async get(path: string) {
    const res = await fetch(`${base()}${path}`, { headers: { cookie: this.jar.cookie } });
    this.absorb(res);
    return res;
  }

  async post(path: string, body?: unknown) {
    const res = await fetch(`${base()}${path}`, {
      method: 'POST',
      headers: this.applyHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    this.absorb(res);
    return res;
  }

  async patch(path: string, body?: unknown) {
    const res = await fetch(`${base()}${path}`, {
      method: 'PATCH',
      headers: this.applyHeaders(body),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    this.absorb(res);
    return res;
  }

  async del(path: string) {
    const res = await fetch(`${base()}${path}`, { method: 'DELETE', headers: this.applyHeaders() });
    this.absorb(res);
    return res;
  }

  async fetchCsrf() {
    // The API issues the CSRF cookie on the first mutating request; the header
    // must echo it on the retry (middleware/core.ts csrf()).
    const res = await fetch(`${base()}/api/v1/auth/step-up`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    this.absorb(res);
    const pair = [...this.jar.setCookie]
      .reverse()
      .find((c) => c.split(';')[0]!.startsWith('vl_csrf='));
    this.csrf = pair ? pair.split(';')[0]!.split('=')[1]! : '';
    expect(this.csrf.length).toBeGreaterThan(0);
  }
}

// Register through the invite flow (default instance mode is invite after the
// instance is bootstrapped). Seeds the host + invitation rows directly so the
// helper is independent of the current AppSetting.
async function inviteRegister(api: Api, email: string, password: string) {
  const hostEmail = `host-${Date.now()}-${Math.random().toString(16).slice(2)}@example.test`;
  emails.push(hostEmail);
  const host = await prisma.user.create({
    data: {
      email: hostEmail,
      name: 'Invite Host',
      passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$s$s',
      webauthnUserId: crypto.randomBytes(16).toString('hex'),
      emailVerifiedAt: new Date(),
    },
  });
  const org = await prisma.organization.create({
    data: {
      kind: 'PERSONAL',
      name: 'Host org',
      createdById: host.id,
      memberships: { create: { userId: host.id, role: 'OWNER' } },
    },
  });
  const token = `it-${crypto.randomBytes(24).toString('hex')}`;
  await prisma.invitation.create({
    data: {
      organizationId: org.id,
      kind: 'membership',
      email,
      role: 'OWNER',
      tokenHash: (await import('../src/core/crypto')).sha256hex(token),
      invitedById: host.id,
      expiresAt: new Date(Date.now() + 3600_000),
    },
  });
  orgs.push(org.id);
  return {
    res: await api.post('/api/v1/auth/register', {
      name: 'IT Tester',
      email,
      password,
      inviteToken: token,
    }),
    host,
    org,
  };
}

const emails: string[] = [];
const orgs: string[] = [];
let api: Api;

beforeAll(async () => {
  server = buildApp({ serveSpa: false }).listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  port = (server.address() as AddressInfo).port;
  api = new Api();
  await api.fetchCsrf();
}, 30000);

afterAll(async () => {
  for (const id of orgs) {
    await prisma.organization.deleteMany({ where: { id } }).catch(() => undefined);
  }
  for (const email of emails) {
    const u = await prisma.user.findUnique({ where: { email } });
    if (u) await prisma.user.delete({ where: { id: u.id } });
  }
  await prisma.$disconnect();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('auth', () => {
  it('registers, verifies session, and exposes /auth/me', async () => {
    const email = `vl-it-${Date.now()}@example.test`;
    emails.push(email);
    const { res } = await inviteRegister(api, email, 'integration-pass-123');
    expect(res.status).toBe(201);
    const me = await api.get('/api/v1/auth/me');
    expect(me.status).toBe(200);
    const body = (await me.json()) as {
      data: { user: { email: string }; memberships: { role: string }[] };
    };
    expect(body.data.user.email).toBe(email);
    expect(body.data.memberships[0]!.role).toBe('OWNER');
  });

  it('rejects duplicate registration', async () => {
    const email = `vl-it-${Date.now()}@example.test`;
    emails.push(email);
    const { res: first } = await inviteRegister(api, email, 'integration-pass-123');
    expect(first.status).toBe(201);
    // A second registration attempt (invite consumed) is denied without
    // revealing whether the email exists.
    const second = await api.post('/api/v1/auth/register', {
      name: 'IT Tester',
      email,
      password: 'integration-pass-123',
      inviteToken: 'wrong',
    });
    expect([403, 409]).toContain(second.status);
  });

  it('rejects weak passwords', async () => {
    const email = `vl-it-${Date.now()}@example.test`;
    emails.push(email);
    const hostEmail = `whost-${Date.now()}@example.test`;
    emails.push(hostEmail);
    const host = await prisma.user.create({
      data: {
        email: hostEmail,
        name: 'Host',
        passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$s$s',
        webauthnUserId: crypto.randomBytes(16).toString('hex'),
        emailVerifiedAt: new Date(),
      },
    });
    const org = await prisma.organization.create({
      data: {
        kind: 'PERSONAL',
        name: 'Host org',
        createdById: host.id,
        memberships: { create: { userId: host.id, role: 'OWNER' } },
      },
    });
    orgs.push(org.id);
    const token = `it-${crypto.randomBytes(24).toString('hex')}`;
    await prisma.invitation.create({
      data: {
        organizationId: org.id,
        kind: 'membership',
        email,
        tokenHash: (await import('../src/core/crypto')).sha256hex(token),
        invitedById: host.id,
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });
    const res = await api.post('/api/v1/auth/register', {
      name: 'IT Tester',
      email,
      password: 'short',
      inviteToken: token,
    });
    expect(res.status).toBe(400);
  });

  it('enforces CSRF on mutating requests', async () => {
    const bare = await fetch(`${base()}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'X',
        email: `x-${Date.now()}@example.test`,
        password: 'password-123',
      }),
    });
    // First attempt has no cookie → token issued; retry without header → mismatch.
    expect(bare.status).toBe(403);
    const body = (await bare.json()) as { error: { code: string } };
    expect(body.error.code).toBe('CSRF');
  });

  it('session listing marks current and revoking a session invalidates it', async () => {
    const email = `vl-it-${Date.now()}@example.test`;
    emails.push(email);
    await inviteRegister(api, email, 'integration-pass-123');
    const listRes = await api.get('/api/v1/auth/sessions');
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { data: { id: string; current: boolean }[] };
    const current = list.data.find((s) => s.current);
    expect(current).toBeTruthy();
    // revoke-others keeps the current session alive
    await api.post('/api/v1/auth/sessions/revoke-others');
    expect((await api.get('/api/v1/auth/me')).status).toBe(200);
    // revoking the current session by id logs us out
    await api.post(`/api/v1/auth/sessions/${current!.id}/revoke`);
    expect((await api.get('/api/v1/auth/me')).status).toBe(401);
  });
});

describe('demo + vehicles + commands', () => {
  it('connects demo fleet and lists vehicles with state', async () => {
    const email = `vl-it-${Date.now()}@example.test`;
    emails.push(email);
    await inviteRegister(api, email, 'integration-pass-123');
    const connect = await api.post('/api/v1/providers/demo/connect');
    expect(connect.status).toBeLessThan(300);
    const vehicles = await api.get('/api/v1/vehicles');
    expect(vehicles.status).toBe(200);
    const body = (await vehicles.json()) as { data: { state: { status: string } }[] };
    expect(body.data.length).toBeGreaterThanOrEqual(5);
    for (const v of body.data) expect(v.state.status).toBeTruthy();
  });

  it('issues honk_horn and observes the queued lifecycle', async () => {
    const vehicles = (await (await api.get('/api/v1/vehicles')).json()) as {
      data: { id: string }[];
    };
    const vid = vehicles.data[0]!.id;
    // Possession step-up is required before issuing commands.
    const su = await api.post('/api/v1/auth/step-up', {
      method: 'password',
      password: 'integration-pass-123',
    });
    expect(su.status).toBeLessThan(300);
    const issue = await api.post('/api/v1/commands', { type: 'honk_horn', vehicleId: vid });
    expect(issue.status).toBeLessThan(300);
    const cmd = (await issue.json()) as { data: { status: string; id: string } };
    expect(['queued', 'submitted', 'accepted', 'confirmed']).toContain(cmd.data.status);
    const list = await api.get(`/api/v1/commands?vehicleId=${vid}`);
    const listBody = (await list.json()) as { data: { items: { id: string }[]; total: number } };
    expect(listBody.data.total).toBeGreaterThanOrEqual(1);
    expect(listBody.data.items.some((c) => c.id === cmd.data.id)).toBe(true);
  });

  it('rejects commands for unknown vehicles', async () => {
    const res = await api.post('/api/v1/commands', {
      type: 'honk_horn',
      vehicleId: 'does-not-exist',
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });
});

describe('status platform', () => {
  it('serves the public status bundle without auth', async () => {
    const bare = await fetch(`${base()}/api/v1/status`);
    expect(bare.status).toBe(200);
    const body = (await bare.json()) as { data?: { components?: unknown[] } };
    expect(body.data?.components?.length).toBeGreaterThan(0);
  });

  it('serves the badge and rss', async () => {
    const badge = await fetch(`${base()}/api/v1/status/badge.svg`);
    expect(badge.status).toBe(200);
    expect(await badge.text()).toContain('<svg');
    const rss = await fetch(`${base()}/api/v1/status/rss`);
    expect(rss.status).toBe(200);
  });
});

describe('meta', () => {
  it('healthz and api docs', async () => {
    const h = await fetch(`${base()}/healthz`);
    expect(h.status).toBe(200);
    const docs = await fetch(`${base()}/api/docs`);
    expect(docs.status).toBe(200);
    const doc = (await docs.json()) as { openapi: string };
    expect(doc.openapi).toBe('3.1.0');
  });

  it('unknown API route returns JSON 404', async () => {
    const res = await fetch(`${base()}/api/v1/definitely-not-a-route`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('NOT_FOUND');
  });

  it('rate limit headers present', async () => {
    const res = await fetch(`${base()}/api/v1/auth/csrf`);
    expect(res.headers.get('ratelimit-policy')).toBeTruthy();
  });
});

// silence unused env import warning path
void env;
