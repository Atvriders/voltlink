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
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../src/app';
import { initRedis } from '../src/core/redis';
import { prisma } from '../src/core/db';
import { sha256hex } from '../src/core/crypto';
import { setRegistrationMode } from '../src/auth/service';

let server: Server;
let base = '';
let adminEmail = '';
// File-level boot children: every spawned web role is killed here, so a test
// timeout can never orphan a 100%-CPU tsx child (the 2026-11-24 check).
const bootChildren: ReturnType<typeof spawn>[] = [];
const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

function spawnBoot(repoRoot: string, freePort: number): ReturnType<typeof spawn> {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, PORT: String(freePort), HOST: '127.0.0.1' };
  childEnv.PUBLIC_URL = `http://127.0.0.1:${freePort}`;
  delete childEnv.VL_SETUP_TOKEN;
  const child = spawn(process.execPath, ['--import', 'tsx', 'apps/api/src/index.ts'], {
    cwd: repoRoot,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  bootChildren.push(child);
  console.log('[r20-boot] child pid', child.pid);
  // The run wrapper appends `ps -p <pid>` to every log from this file: the
  // pid is mirrored to VL_BOOT_PID_FILE so the wrapper can read it back.
  if (process.env.VL_BOOT_PID_FILE) {
    import('node:fs').then((fs) =>
      fs.appendFileSync(process.env.VL_BOOT_PID_FILE!, `${child.pid}\n`),
    );
  }
  return child;
}

async function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const a = srv.address() as AddressInfo;
      srv.close(() => resolve(a.port));
    });
  });
}

async function stopChild(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise<void>((r) => child.once('exit', () => r())),
    new Promise<void>((r) => setTimeout(r, 5000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

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
  // Kill every boot child this file spawned (SIGTERM, wait, then SIGKILL).
  // The shutdown handler of the child needs a moment to close the DB.
  for (const child of bootChildren) {
    console.log('[r20-boot] stopping child pid', child.pid);
    await stopChild(child);
  }
  // Leave a bootstrapped instance behind so later test files see the suite's
  // usual state (admin + operator org + bootstrapped marker). The in-process
  // server is still up here, so the restore can go through the real routes.
  const admin = await prisma.user.findFirst({ where: { isInstanceAdmin: true } });
  if (!admin) {
    const res = await csrfAndPost('/api/v1/auth/register', {
      email: adminEmail,
      name: 'R20 Admin',
      password: 'r20-password-123',
      setupToken: process.env.VL_SETUP_TOKEN,
    });
    if (res.status !== 201) {
      await prisma.user.create({
        data: {
          email: adminEmail,
          name: 'R20 Admin',
          passwordHash: sha256hex(`r20-password-123:${uniq()}`),
          isInstanceAdmin: true,
          emailVerifiedAt: new Date(),
        },
      });
    }
  }
  await prisma.appSetting.upsert({
    where: { key: 'instance.bootstrappedAt' },
    update: {},
    create: {
      key: 'instance.bootstrappedAt',
      value: new Date().toISOString(),
      updatedAt: new Date(),
    },
  });
  await prisma.appSetting.deleteMany({ where: { key: 'instance.setupTokenHash' } });
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

  it('TI-53: after bootstrap the setup token no longer registers anyone', async () => {
    const res = await csrfAndPost('/api/v1/auth/register', {
      email: `r20-post-${uniq()}@test.dev`,
      name: 'Second Admin',
      password: 'r20-password-123',
      setupToken: process.env.VL_SETUP_TOKEN,
    });
    const bodyText = await res.text();
    expect(res.status, bodyText).toBe(403);
    expect(bodyText).not.toContain('SETUP_REQUIRED');
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
    const email = `r20-o-${uniq()}@test.dev`;
    const res = await csrfAndPost('/api/v1/auth/register', {
      email,
      name: 'Open User',
      password: 'r20-password-123',
    });
    const bodyText = await res.text();
    expect(res.status, bodyText).toBe(202);
    // R2-20 open-registrant clause over HTTP (same tenancy rule as C-NOTESTS
    // M1c): the open registrant gets ONLY its own PERSONAL org — never the
    // operator org.
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const operatorOrgId = (
      await prisma.appSetting.findUniqueOrThrow({ where: { key: 'instance.operatorOrgId' } })
    ).value;
    const memberships = await prisma.membership.findMany({ where: { userId: user.id } });
    expect(memberships).toHaveLength(1);
    expect(memberships[0]!.organizationId).not.toBe(operatorOrgId);
    const org = await prisma.organization.findUniqueOrThrow({
      where: { id: memberships[0]!.organizationId },
    });
    expect(org.kind).toBe('PERSONAL');
    expect(org.createdById).toBe(user.id);
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

// R2-20: the generated-token path — VL_SETUP_TOKEN UNSET. The web role
// generates the token at boot, stores only its hash, and the operator reads
// the plaintext from the boot log; registering with that token must complete
// first-run setup exactly like the configured token.
it('R2-20 generated token (VL_SETUP_TOKEN unset) completes first-run setup', async () => {
  const saved = process.env.VL_SETUP_TOKEN;
  try {
    delete process.env.VL_SETUP_TOKEN;
    // Unseed again: the suite bootstrapped and toggled modes before this
    // test; the generated-token path needs a setup-state instance.
    await prisma.appSetting.deleteMany({
      where: {
        key: {
          in: ['instance.bootstrappedAt', 'instance.operatorOrgId', 'instance.setupTokenHash'],
        },
      },
    });
    await prisma.user.deleteMany({});
    await prisma.organization.deleteMany({});
    const { ensureSetupToken } = await import('../src/auth/setup-token');
    const token = await ensureSetupToken();
    expect(token).toBeTruthy();
    expect(token!.length).toBeGreaterThanOrEqual(32);
    const row = await prisma.appSetting.findUnique({
      where: { key: 'instance.setupTokenHash' },
    });
    expect(row, 'generated token must be hashed at rest').toBeTruthy();
    expect(row!.value).toBe(sha256hex(token!));

    const email = `r20g-${uniq()}@test.dev`;
    const res = await csrfAndPost('/api/v1/auth/register', {
      email,
      name: 'Generated Token User',
      password: 'long-enough-123',
      setupToken: token,
    });
    const bodyText = await res.text();
    expect(res.status, bodyText).toBe(201);

    const u = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(u.isInstanceAdmin, 'first admin must be instance admin').toBe(true);
    const opOrg = await prisma.appSetting.findUnique({
      where: { key: 'instance.operatorOrgId' },
    });
    expect(opOrg).toBeTruthy();
    const membership = await prisma.membership.findFirst({
      where: { organizationId: opOrg!.value, userId: u.id, role: 'OWNER' },
    });
    expect(membership, 'first admin must own the operator org').toBeTruthy();
    // The hash row is consumed by the bootstrap.
    const after = await prisma.appSetting.findUnique({
      where: { key: 'instance.setupTokenHash' },
    });
    expect(after).toBeNull();
    await prisma.user.delete({ where: { id: u.id } });
  } finally {
    if (saved === undefined) delete process.env.VL_SETUP_TOKEN;
    else process.env.VL_SETUP_TOKEN = saved;
  }
});

// R2-20 (review #2 point 9): the documented extraction greps the BOOT LOG —
// start-stack.sh and ci.yml run
//   grep -o 'first-run setup token [A-Za-z0-9_-]*' | awk '{print $NF}'
// The boot line now prints 'first-run setup token <token> (shown once…)' so
// that extraction returns the token itself (R2-01 fix). Boot the REAL web
// role (apps/api/src/index.ts) with VL_SETUP_TOKEN unset on this file's own
// unseeded database, parse the token from its stdout, and register with it.
// The child is a FILE-LEVEL resource: the pid is printed, and afterAll kills
// it (SIGTERM, wait, SIGKILL) so a timeout can never orphan it.
it(
  'R2-20 real web-role boot (VL_SETUP_TOKEN unset) logs a token that completes first-run setup',
  { timeout: 45_000 },
  async () => {
    const saved = process.env.VL_SETUP_TOKEN;
    try {
      delete process.env.VL_SETUP_TOKEN;
      await prisma.appSetting.deleteMany({
        where: {
          key: {
            in: ['instance.bootstrappedAt', 'instance.operatorOrgId', 'instance.setupTokenHash'],
          },
        },
      });
      await prisma.user.deleteMany({});
      await prisma.organization.deleteMany({});

      const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
      const port = await freePort();
      const child = spawnBoot(repoRoot, port);
      let captured = '';
      child.stdout!.on('data', (d: Buffer) => {
        captured += d.toString('utf8');
      });
      child.stderr!.on('data', (d: Buffer) => {
        captured += d.toString('utf8');
      });

      // Wait for readiness well inside the test timeout; then the token
      // assertions decide the test — a red is a failed assertion, never a
      // vitest timeout.
      const deadline = Date.now() + 20_000;
      let ready = false;
      while (Date.now() < deadline && !ready && child.exitCode === null) {
        ready = /\[voltlink\] web listening/.test(captured);
        if (!ready) await new Promise((r) => setTimeout(r, 100));
      }
      const tokenMatch = captured.match(/setup token ([A-Za-z0-9_-]{32,})/);
      const token = tokenMatch?.[1] ?? '';
      expect(
        token,
        `boot log must print the token; captured was:\n${captured.slice(-2000)}`,
      ).toMatch(/^[A-Za-z0-9_-]{32,}$/);

      // R2-01: the documented extraction (start-stack.sh / ci.yml) must return
      // the token itself. Decoupled from the token regex above: a boot line
      // that prints the token with a different wording fails HERE alone.
      const documented = [...captured.matchAll(/first-run setup token [A-Za-z0-9_-]*/g)].map((m) =>
        m[0].split(' ').at(-1)!,
      );
      expect(documented, 'the documented grep must extract the token').toContain(token);

      // Hash at rest; the plaintext never is.
      const row = await prisma.appSetting.findUnique({
        where: { key: 'instance.setupTokenHash' },
      });
      expect(row, 'generated token must be hashed at rest').toBeTruthy();
      expect(row!.value).toBe(sha256hex(token));
      expect(row!.value).not.toBe(token);

      // Register with the boot-log token against this file's own server (same DB).
      const email = `r20boot-${uniq()}@test.dev`;
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/auth/csrf`);
      const setCookies = res.headers.getSetCookie?.() ?? [];
      const csrf = setCookies.join(';').match(/vl_csrf=([^;]+)/)?.[1] ?? '';
      const cookie = setCookies.find((x) => x.startsWith('vl_csrf='))?.split(';')[0] ?? '';
      const reg = await fetch(`http://127.0.0.1:${port}/api/v1/auth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-vl-csrf': csrf, cookie },
        body: JSON.stringify({
          email,
          name: 'Boot User',
          password: 'long-enough-123',
          setupToken: token,
        }),
      });
      const bodyText = await reg.text();
      expect(reg.status, bodyText).toBe(201);
      const u = await prisma.user.findUniqueOrThrow({ where: { email } });
      expect(u.isInstanceAdmin, 'first admin must be instance admin').toBe(true);
      const opOrg = await prisma.appSetting.findUnique({
        where: { key: 'instance.operatorOrgId' },
      });
      const membership = await prisma.membership.findFirst({
        where: { organizationId: opOrg!.value, userId: u.id, role: 'OWNER' },
      });
      expect(membership, 'first admin must own the operator org').toBeTruthy();
      // The hash row is consumed by the bootstrap.
      expect(
        await prisma.appSetting.findUnique({ where: { key: 'instance.setupTokenHash' } }),
      ).toBeNull();
      await prisma.user.delete({ where: { id: u.id } });
    } finally {
      if (saved === undefined) delete process.env.VL_SETUP_TOKEN;
      else process.env.VL_SETUP_TOKEN = saved;
    }
  },
);

// TI-53: after bootstrap, later boots must NOT generate and log a fresh setup
// token (the old ensureSetupToken only checked for a leftover hash row, which
// bootstrap consumes — so every post-bootstrap boot leaked a new token).
it(
  'TI-53: a bootstrapped instance logs no fresh setup token on later boots',
  { timeout: 45_000 },
  async () => {
    const saved = process.env.VL_SETUP_TOKEN;
    try {
      delete process.env.VL_SETUP_TOKEN;
      // Any hash row left by an earlier test in THIS file is not this boot's
      // business: clear it so the check below observes only this boot.
      await prisma.appSetting.deleteMany({ where: { key: 'instance.setupTokenHash' } });
      const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
      const port = await freePort();
      const child = spawnBoot(repoRoot, port);
      let captured = '';
      child.stdout!.on('data', (d: Buffer) => {
        captured += d.toString('utf8');
      });
      child.stderr!.on('data', (d: Buffer) => {
        captured += d.toString('utf8');
      });
      const deadline = Date.now() + 20_000;
      let ready = false;
      while (Date.now() < deadline && !ready && child.exitCode === null) {
        ready = /\[voltlink\] web listening/.test(captured);
        if (!ready) await new Promise((r) => setTimeout(r, 100));
      }
      expect(
        captured,
        `bootstrapped instance must not log a fresh token; captured was:\n${captured.slice(-2000)}`,
      ).not.toMatch(/first-run setup token [A-Za-z0-9_-]{32,}/);
      expect(
        await prisma.appSetting.findUnique({ where: { key: 'instance.setupTokenHash' } }),
      ).toBeNull();
    } finally {
      if (saved === undefined) delete process.env.VL_SETUP_TOKEN;
      else process.env.VL_SETUP_TOKEN = saved;
    }
  },
);
