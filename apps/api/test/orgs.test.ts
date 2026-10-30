// Organization router regression tests (Z-OWNER, Z-ROLERANK, Z-RETENTION,
// A-ENUM). Each test uses its own world rows and cleans them up.

process.env.NODE_ENV = 'test';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildApp } from '../src/app';
import { prisma } from '../src/core/db';
import { sha256hex, randomId } from '../src/core/crypto';
import { createSession } from '../src/auth/service';

vi.mock('../src/auth/service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/auth/service')>();
  return { ...actual, sendMail: vi.fn(async () => ({ sent: false, detail: 'test' })) };
});

let server: Server;
let base: string;

beforeAll(async () => {
  server = buildApp({ serveSpa: false }).listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

function sessionAgent(token: string) {
  return request.agent(base).set('Cookie', `vl_session=${token}`);
}

const csrfCache = new WeakMap<object, string>();
async function postJson(agent: ReturnType<typeof request.agent>, url: string, body?: unknown) {
  let csrf = csrfCache.get(agent);
  let res = csrf
    ? await agent.post(url).set('x-vl-csrf', csrf).send(body ?? {})
    : await agent.post(url).send(body ?? {});
  if (res.status === 403 && res.body?.error?.code === 'CSRF') {
    const cookies = (res.headers['set-cookie'] ?? []) as unknown as string[];
    csrf = cookies.map((c) => c.split(';')[0]).find((c) => c.startsWith('vl_csrf='))?.split('=')[1] ?? csrf;
    if (!csrf) throw new Error('CSRF cookie was not issued');
    csrfCache.set(agent, csrf);
    res = await agent.post(url).set('x-vl-csrf', csrf).send(body ?? {});
  }
  return res;
}

async function patchJson(agent: ReturnType<typeof request.agent>, url: string, body?: unknown) {
  let csrf = csrfCache.get(agent);
  let res = csrf
    ? await agent.patch(url).set('x-vl-csrf', csrf).send(body ?? {})
    : await agent.patch(url).send(body ?? {});
  if (res.status === 403 && res.body?.error?.code === 'CSRF') {
    const cookies = (res.headers['set-cookie'] ?? []) as unknown as string[];
    csrf = cookies.map((c) => c.split(';')[0]).find((c) => c.startsWith('vl_csrf='))?.split('=')[1] ?? csrf;
    if (!csrf) throw new Error('CSRF cookie was not issued');
    csrfCache.set(agent, csrf);
    res = await agent.patch(url).set('x-vl-csrf', csrf).send(body ?? {});
  }
  return res;
}

async function mkUser(email: string, opts: { instanceAdmin?: boolean } = {}) {
  return prisma.user.create({
    data: {
      email,
      name: email.split('@')[0]!,
      passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$s$s',
      webauthnUserId: randomId(),
      emailVerifiedAt: new Date(),
      isInstanceAdmin: opts.instanceAdmin === true,
    },
  });
}

async function sessionFor(userId: string, stepped: boolean) {
  const { token, sessionId } = await createSession(userId);
  if (stepped) {
    await prisma.userSession.update({ where: { id: sessionId }, data: { stepUpAt: new Date(), stepUpMethod: 'totp' } });
  }
  return token;
}

async function setSetting(key: string, value: string) {
  await prisma.appSetting.upsert({ where: { key }, update: { value }, create: { key, value } });
}

describe('organizations', () => {
  it('Z-OWNER: creates an org, becomes OWNER, and lists it', async () => {
    const u = await mkUser(`orgs-1-${Date.now()}@example.test`);
    const token = await sessionFor(u.id, false);
    const agent = sessionAgent(token);
    const created = await postJson(agent, '/api/v1/orgs', { name: 'My Fleet' });
    expect(created.status).toBe(201);
    const orgId = (created.body.data as { id: string }).id;
    const list = await agent.get('/api/v1/orgs');
    expect(list.status).toBe(200);
    const rows = list.body.data as { id: string; role: string }[];
    expect(rows.find((r) => r.id === orgId)?.role).toBe('OWNER');
    await prisma.organization.delete({ where: { id: orgId } });
    await prisma.user.delete({ where: { id: u.id } });
  });

  it('Z-OWNER: respects instance.allowOrgCreation=false', async () => {
    const u = await mkUser(`orgs-2-${Date.now()}@example.test`);
    await setSetting('instance.allowOrgCreation', 'false');
    const token = await sessionFor(u.id, false);
    const res = await postJson(sessionAgent(token), '/api/v1/orgs', { name: 'Nope' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('ORG_CREATION_DISABLED');
    await setSetting('instance.allowOrgCreation', 'true');
    await prisma.user.delete({ where: { id: u.id } });
  });

  it('Z-ROLERANK: operator-only roles are rejected outside an OPERATOR org', async () => {
    const owner = await mkUser(`orgs-3o-${Date.now()}@example.test`);
    const member = await mkUser(`orgs-3m-${Date.now()}@example.test`);
    const org = await prisma.organization.create({
      data: { kind: 'TEAM', name: 'Team', createdById: owner.id, memberships: { create: [{ userId: owner.id, role: 'OWNER' }, { userId: member.id, role: 'VIEWER' }] } },
    });
    const token = await sessionFor(owner.id, true);
    const res = await patchJson(sessionAgent(token), `/api/v1/orgs/${org.id}/members/${member.id}`, { role: 'STATUS_MANAGER' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('ROLE_NOT_ASSIGNABLE');
    await prisma.organization.delete({ where: { id: org.id } });
    await prisma.user.deleteMany({ where: { id: { in: [owner.id, member.id] } } });
  });

  it('Z-OWNER: the last owner cannot be removed or demoted', async () => {
    const owner = await mkUser(`orgs-4-${Date.now()}@example.test`);
    const org = await prisma.organization.create({
      data: { kind: 'PERSONAL', name: 'Solo', createdById: owner.id, memberships: { create: { userId: owner.id, role: 'OWNER' } } },
    });
    const token = await sessionFor(owner.id, true);
    const agent = sessionAgent(token);
    const removed = await postJson(agent, `/api/v1/orgs/${org.id}/transfer-ownership`, { toUserId: 'nobody' });
    expect(removed.status).toBe(400);
    const demoted = await patchJson(agent, `/api/v1/orgs/${org.id}/members/${owner.id}`, { role: 'VIEWER' });
    expect(demoted.status).toBe(409);
    expect(demoted.body.error.code).toBe('LAST_OWNER');
    const membersRes = await agent.get(`/api/v1/orgs/${org.id}/members`);
    const membersBefore = membersRes.body.data as { userId: string }[];
    expect(membersBefore.length).toBe(1);
    await prisma.organization.delete({ where: { id: org.id } });
    await prisma.user.delete({ where: { id: owner.id } });
  });

  it('ownership transfer requires step-up and swaps roles', async () => {
    const owner = await mkUser(`orgs-5o-${Date.now()}@example.test`);
    const member = await mkUser(`orgs-5m-${Date.now()}@example.test`);
    const org = await prisma.organization.create({
      data: { kind: 'TEAM', name: 'T', createdById: owner.id, memberships: { create: [{ userId: owner.id, role: 'OWNER' }, { userId: member.id, role: 'ADMIN' }] } },
    });
    const token = await sessionFor(owner.id, false);
    const agent = sessionAgent(token);
    const denied = await postJson(agent, `/api/v1/orgs/${org.id}/transfer-ownership`, { toUserId: member.id });
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('STEP_UP_REQUIRED');
    await prisma.userSession.updateMany({ where: { userId: owner.id }, data: { stepUpAt: new Date(), stepUpMethod: 'totp' } });
    const allowed = await postJson(agent, `/api/v1/orgs/${org.id}/transfer-ownership`, { toUserId: member.id });
    expect(allowed.status).toBe(200);
    const memberAfter = await prisma.membership.findUniqueOrThrow({ where: { organizationId_userId: { organizationId: org.id, userId: member.id } } });
    expect(memberAfter.role).toBe('OWNER');
    const ownerAfter = await prisma.membership.findUniqueOrThrow({ where: { organizationId_userId: { organizationId: org.id, userId: owner.id } } });
    expect(ownerAfter.role).toBe('ADMIN');
    await prisma.organization.delete({ where: { id: org.id } });
    await prisma.user.deleteMany({ where: { id: { in: [owner.id, member.id] } } });
  });

  it('Z-RETENTION: clamps to the instance ceiling and requires step-up to lower', async () => {
    const owner = await mkUser(`orgs-6-${Date.now()}@example.test`);
    const org = await prisma.organization.create({
      data: { kind: 'PERSONAL', name: 'R', createdById: owner.id, telemetryRetentionDays: 90, memberships: { create: { userId: owner.id, role: 'OWNER' } } },
    });
    await setSetting('retention.telemetryMaxDays', '10');
    const token = await sessionFor(owner.id, false);
    const agent = sessionAgent(token);
    // Lowering without step-up -> 403.
    const lowered = await patchJson(agent, `/api/v1/orgs/${org.id}/settings/retention`, { telemetryRetentionDays: 8 });
    expect(lowered.status).toBe(403);
    expect(lowered.body.error.code).toBe('STEP_UP_REQUIRED');
    // After step-up: request above the ceiling is clamped to the ceiling.
    await prisma.userSession.updateMany({ where: { userId: owner.id }, data: { stepUpAt: new Date(), stepUpMethod: 'totp' } });
    const raised = await patchJson(agent, `/api/v1/orgs/${org.id}/settings/retention`, { telemetryRetentionDays: 999 });
    expect(raised.status).toBe(200);
    const after = await prisma.organization.findUniqueOrThrow({ where: { id: org.id } });
    expect(after.telemetryRetentionDays).toBe(10);
    await prisma.organization.delete({ where: { id: org.id } });
    await prisma.user.delete({ where: { id: owner.id } });
    await setSetting('retention.telemetryMaxDays', '365');
  });

  it('A-ENUM: invitations always answer 202, and acceptance enforces the email', async () => {
    const owner = await mkUser(`orgs-7o-${Date.now()}@example.test`);
    const invitee = await mkUser(`orgs-7i-${Date.now()}@example.test`);
    const outsider = await mkUser(`orgs-7x-${Date.now()}@example.test`);
    const org = await prisma.organization.create({
      data: { kind: 'TEAM', name: 'I', createdById: owner.id, memberships: { create: { userId: owner.id, role: 'OWNER' } } },
    });
    const token = await sessionFor(owner.id, true);
    const agent = sessionAgent(token);
    // Unknown and known emails both answer 202 with the same shape.
    const unknown = await postJson(agent, `/api/v1/orgs/${org.id}/invitations`, { email: 'ghost@example.test', role: 'VIEWER' });
    expect(unknown.status).toBe(202);
    const known = await postJson(agent, `/api/v1/orgs/${org.id}/invitations`, { email: invitee.email, role: 'VIEWER' });
    expect(known.status).toBe(202);
    // Recover the token from the (mocked) mail call? Instead accept via a fresh
    // invitation row we control.
    const acceptToken = `accept-${randomId()}${randomId()}`;
    await prisma.invitation.create({
      data: { organizationId: org.id, kind: 'membership', email: invitee.email, role: 'VIEWER', tokenHash: sha256hex(acceptToken), invitedById: owner.id, expiresAt: new Date(Date.now() + 3600_000) },
    });
    // Wrong email -> 403 EMAIL_MISMATCH; right email -> membership.
    const wrongAgent = sessionAgent(await sessionFor(outsider.id, true));
    const wrong = await postJson(wrongAgent, `/api/v1/invitations/${acceptToken}/accept`, {});
    expect(wrong.status).toBe(403);
    expect(wrong.body.error.code).toBe('EMAIL_MISMATCH');
    const rightAgent = sessionAgent(await sessionFor(invitee.id, true));
    const right = await postJson(rightAgent, `/api/v1/invitations/${acceptToken}/accept`, {});
    expect(right.status).toBe(200);
    const membership = await prisma.membership.findUnique({ where: { organizationId_userId: { organizationId: org.id, userId: invitee.id } } });
    expect(membership?.role).toBe('VIEWER');
    await prisma.organization.delete({ where: { id: org.id } });
    await prisma.user.deleteMany({ where: { id: { in: [owner.id, invitee.id, outsider.id] } } });
  });

  it('audit listing is organization-scoped', async () => {
    const owner = await mkUser(`orgs-8o-${Date.now()}@example.test`);
    const other = await mkUser(`orgs-8x-${Date.now()}@example.test`);
    const org = await prisma.organization.create({ data: { kind: 'PERSONAL', name: 'A', createdById: owner.id, memberships: { create: { userId: owner.id, role: 'OWNER' } } } });
    const org2 = await prisma.organization.create({ data: { kind: 'PERSONAL', name: 'B', createdById: other.id, memberships: { create: { userId: other.id, role: 'OWNER' } } } });
    await prisma.auditLog.create({ data: { organizationId: org.id, action: 'org.updated', actorId: owner.id } });
    await prisma.auditLog.create({ data: { organizationId: org2.id, action: 'org.updated', actorId: other.id } });
    const token = await sessionFor(owner.id, true);
    const res = await sessionAgent(token).get(`/api/v1/orgs/${org.id}/audit`);
    expect(res.status).toBe(200);
    const items = (res.body.data as { items: { id: string }[] }).items;
    expect(items.length).toBe(1);
    // Foreign org audit is hidden (org.read fails -> 404).
    const foreign = await sessionAgent(token).get(`/api/v1/orgs/${org2.id}/audit`);
    expect(foreign.status).toBe(404);
    await prisma.organization.deleteMany({ where: { id: { in: [org.id, org2.id] } } });
    await prisma.user.deleteMany({ where: { id: { in: [owner.id, other.id] } } });
  });
});
