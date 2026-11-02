// test/phase10-incidents-status.test.ts — status platform and incident
// lifecycle (guide 08 §7: integration/{status,incidents}.test.ts minimums).
// Public bundle must never leak private data; incidents are operator-only;
// component state survives the next check.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildApp } from '../src/app';
import { prisma } from '../src/core/db';
import { createSession } from '../src/auth/service';
import { ensureComponents } from '../src/status/service';

let server: Server;
let base: string;

const pw = '$argon2id$v=19$m=19456,t=2,p=1$s$s';

async function mkUser(email: string, isInstanceAdmin = false) {
  return prisma.user.create({
    data: {
      email,
      name: email.split('@')[0]!,
      passwordHash: pw,
      isInstanceAdmin,
      emailVerifiedAt: new Date(),
      webauthnUserId: `${email}-wn`,
    },
  });
}

beforeAll(async () => {
  await ensureComponents();
  const app = buildApp();
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

describe('status platform', () => {
  it('public bundle never contains private data', async () => {
    const res = await request(base).get('/api/v1/status');
    expect(res.status).toBe(200);
    const text = JSON.stringify(res.body);
    expect(text).not.toMatch(/password|tokenHash|sealed|secret/i);
  });

  it('incidents are operator-only and carry their creator', async () => {
    const admin = await mkUser(`op-${Date.now()}@example.test`, true);
    const outsider = await mkUser(`out-${Date.now()}@example.test`);
    const adminSession = await createSession(admin.id);
    const outsiderSession = await createSession(outsider.id);
    const postWithCsrf = async (sessionToken: string, url: string, body: unknown) => {
      // First attempt: no CSRF cookie yet → 403 issues one; retry with it.
      let res = await request(base).post(url).set('Cookie', `vl_session=${sessionToken}`).send(body);
      if (res.status === 403 && res.body?.error?.code === 'CSRF') {
        const setCookies = (res.headers['set-cookie'] ?? []) as unknown as string[];
        const csrf =
          setCookies
            .map((c) => c.split(';')[0])
            .find((c) => c.startsWith('vl_csrf='))
            ?.split('=')[1] ?? '';
        expect(csrf).toBeTruthy();
        res = await request(base)
          .post(url)
          .set('Cookie', `vl_session=${sessionToken}; vl_csrf=${csrf}`)
          .set('x-vl-csrf', csrf)
          .send(body);
      }
      return res;
    };

    const created = await postWithCsrf(adminSession.token, '/api/v1/status/incidents', {
      title: 'Phase10 incident',
      severity: 'major',
      message: 'created by test',
    });
    expect(created.status).toBe(201);
    const id = (created.body as { data: { id: string } }).data.id;

    const denied = await postWithCsrf(outsiderSession.token, '/api/v1/status/incidents', {
      title: 'Nope',
      severity: 'minor',
    });
    expect([401, 403, 404]).toContain(denied.status);

    const row = await prisma.incident.findUniqueOrThrow({ where: { id } });
    expect(row.createdById).toBe(admin.id);
    expect(row.public).toBe(true);

    // Resolve through an update and check the phase state persists.
    const resolve = await postWithCsrf(
      adminSession.token,
      `/api/v1/status/incidents/${id}/updates`,
      { phase: 'resolved', message: 'all clear' },
    );
    expect([200, 201]).toContain(resolve.status);
    const after = await prisma.incident.findUniqueOrThrow({ where: { id } });
    expect(after.status).toBe('resolved');
    const phases = after.phases as Record<string, unknown>;
    expect(phases.resolved).not.toBeNull();

    await prisma.incident.deleteMany({ where: { id } });
  });

  it('component state survives the next check run', async () => {
    const before = await prisma.statusComponent.findFirst({ where: { key: 'web' } });
    const { runStatusChecks } = await import('../src/status/service');
    await runStatusChecks();
    const after = await prisma.statusComponent.findFirstOrThrow({ where: { key: 'web' } });
    expect(before).not.toBeNull();
    expect(['operational', 'major_outage', 'maintenance']).toContain(after.status);
  });
});
