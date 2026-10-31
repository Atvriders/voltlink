// Outbound SSRF tests (N-SSRF, guide 03 §2): the classification table, the
// connect-time policy inside safeFetch, redirects never followed, the owner
// allowlist and the save-time preflight on webhook URLs.

process.env.NODE_ENV = 'test';

import http from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { buildApp } from '../src/app';
import { prisma } from '../src/core/db';
import { randomId } from '../src/core/crypto';
import { createSession } from '../src/auth/service';
import { classify, parseAllowlist, OutboundBlockedError } from '../src/net/outboundPolicy';
import { safeFetch, preflightUrl, failureKindOf } from '../src/net/safeFetch';
import { buildOutboundPolicy, resetOutboundPolicy, getOutboundPolicy } from '../src/net/policy';

let appServer: Server;
let base: string;

beforeAll(async () => {
  appServer = buildApp({ serveSpa: false }).listen(0);
  await new Promise<void>((resolve) => appServer.once('listening', resolve));
  base = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}`;
  await buildOutboundPolicy();
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolve) => appServer.close(() => resolve()));
  await prisma.$disconnect();
});

describe('classification table', () => {
  it('classifies special-purpose addresses', () => {
    expect(classify('127.0.0.1')).toBe('loopback');
    expect(classify('10.1.2.3')).toBe('private');
    expect(classify('192.168.1.1')).toBe('private');
    expect(classify('169.254.169.254')).toBe('link_local');
    expect(classify('100.64.0.1')).toBe('cgnat');
    expect(classify('224.0.0.1')).toBe('multicast');
    expect(classify('0.0.0.0')).toBe('unspecified');
    expect(classify('192.0.2.1')).toBe('documentation');
    expect(classify('203.0.113.9')).toBe('documentation');
    expect(classify('198.18.0.1')).toBe('benchmark');
    expect(classify('64:ff9b::a00:1')).toBe('private'); // NAT64 carrying 10.0.0.1
    expect(classify('::ffff:10.0.0.1')).toBe('private'); // IPv4-mapped
    expect(classify('::1')).toBe('loopback');
    expect(classify('fc00::1')).toBe('ula');
    expect(classify('fe80::1')).toBe('link_local');
    expect(classify('8.8.8.8')).toBe('public');
    expect(classify('1.1.1.1')).toBe('public');
  });

  it('rejects invalid allowlist entries', () => {
    expect(() => parseAllowlist('10.0.0.0/7')).toThrow(/too broad/);
    expect(() => parseAllowlist('127.0.0.1/32')).toThrow(/must name a port/);
    expect(() => parseAllowlist('192.0.2.0/24')).toThrow(/can never be allowed/);
    expect(() => parseAllowlist('nonsense')).toThrow(/cannot parse/);
  });
});

describe('safeFetch', () => {
  it('blocks loopback without an owner allowlist entry', async () => {
    const server = http.createServer((_req, res) => res.end('ok'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      await expect(safeFetch(getOutboundPolicy(), `http://127.0.0.1:${port}/`, { method: 'POST' })).rejects.toMatchObject({ code: 'VL_OUTBOUND_BLOCKED' });
    } finally {
      server.close();
    }
  });

  it('allows an owner-allowlisted loopback target and never follows redirects', async () => {
    const server = http.createServer((req, res) => {
      if (req.url === '/r') {
        res.statusCode = 302;
        res.setHeader('location', '/landed');
        res.end();
      } else {
        res.end('landed');
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const old = process.env.VL_OUTBOUND_ALLOW;
    process.env.VL_OUTBOUND_ALLOW = `127.0.0.1/32:${port}`;
    resetOutboundPolicy();
    await buildOutboundPolicy();
    try {
      const ok = await safeFetch(getOutboundPolicy(), `http://127.0.0.1:${port}/`, { method: 'POST', body: 'x' });
      expect(ok.status).toBe(200);
      expect(ok.bodyText).toBe('landed');
      const redir = await safeFetch(getOutboundPolicy(), `http://127.0.0.1:${port}/r`, { method: 'POST' });
      expect(redir.status).toBe(302); // never followed
      expect(failureKindOf(new OutboundBlockedError('loopback', 'x'))).toBe('blocked_by_policy');
    } finally {
      server.close();
      if (old === undefined) delete process.env.VL_OUTBOUND_ALLOW;
      else process.env.VL_OUTBOUND_ALLOW = old;
      resetOutboundPolicy();
      await buildOutboundPolicy();
    }
  });

  it('always denies VoltLink infrastructure even when allowlisted', async () => {
    const server = http.createServer((_req, res) => res.end('ok'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const old = process.env.VL_OUTBOUND_ALLOW;
    process.env.VL_OUTBOUND_ALLOW = `127.0.0.1/32:${port}`;
    resetOutboundPolicy();
    await buildOutboundPolicy();
    try {
      const policy = { ...getOutboundPolicy(), infrastructure: new Set([`127.0.0.1:${port}`]) };
      await expect(safeFetch(policy, `http://127.0.0.1:${port}/`, {})).rejects.toMatchObject({ reason: 'infrastructure' });
      await expect(preflightUrl(policy, `http://127.0.0.1:${port}/`)).rejects.toMatchObject({ reason: 'infrastructure' });
    } finally {
      server.close();
      if (old === undefined) delete process.env.VL_OUTBOUND_ALLOW;
      else process.env.VL_OUTBOUND_ALLOW = old;
      resetOutboundPolicy();
      await buildOutboundPolicy();
    }
  });

  it('rejects non-http schemes and URL credentials', async () => {
    await expect(safeFetch(getOutboundPolicy(), 'file:///etc/passwd')).rejects.toMatchObject({ reason: 'scheme' });
    await expect(safeFetch(getOutboundPolicy(), 'ftp://example.com/x')).rejects.toMatchObject({ reason: 'scheme' });
    await expect(preflightUrl(getOutboundPolicy(), 'https://user:pass@example.com/')).rejects.toMatchObject({ reason: 'host' });
  });
});

describe('save-time preflight on webhook URLs', () => {
  it('returns 422 URL_BLOCKED for a loopback webhook URL', async () => {
    const user = await prisma.user.create({
      data: { email: `ssrf-${Date.now()}@example.test`, name: 'S', passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$s$s', webauthnUserId: randomId(), emailVerifiedAt: new Date() },
    });
    const { token } = await createSession(user.id);
    const agent = request.agent(base).set('Cookie', `vl_session=${token}`);
    let res = await agent.post('/api/v1/notifications/webhooks').send({ name: 'x', url: 'https://10.0.0.1:8443/hook' });
    if (res.status === 403 && res.body?.error?.code === 'CSRF') {
      const cookies = (res.headers['set-cookie'] ?? []) as unknown as string[];
      const csrfPair = cookies.map((c) => c.split(';')[0]).find((c) => c.startsWith('vl_csrf='));
      const csrf = csrfPair ? csrfPair.split('=')[1]! : '';
      res = await agent.post('/api/v1/notifications/webhooks').set('x-vl-csrf', csrf).send({ name: 'x', url: 'https://10.0.0.1:8443/hook' });
    }
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('URL_BLOCKED');
    await prisma.user.delete({ where: { id: user.id } });
  });
});
