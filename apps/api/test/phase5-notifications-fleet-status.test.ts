// Gate 5 tests: automations (N-CONDITIONS, N-TRIGGERS, P-DRYRUN), the
// notification outbox (N-DROPPED), push hardening (N-PUSH), Gotify header
// (N-GOTIFY), Teams Adaptive Cards (N-TEAMS), fleet maintenance validation
// (NEW-09), time-driven maintenance windows (N-MAINT), status subscriptions
// (N-SUBS), and optional-provider health (N-STATUSHEALTH).

process.env.NODE_ENV = 'test';

import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { buildApp } from '../src/app';
import { initRedis } from '../src/core/redis';
import { prisma } from '../src/core/db';
import { createSession } from '../src/auth/service';

// ---------------------------------------------------------------------------
// Mocks: SMTP always fails in tests (so outbox retry/dead-letter and N-SUBS
// resilience are deterministic) and safeFetch is a capture server.
// ---------------------------------------------------------------------------

const captured = vi.hoisted(() => ({
  requests: [] as {
    url: string;
    init: RequestInit & { headers?: Record<string, string> };
  }[],
}));

vi.mock('../src/auth/service', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/auth/service')>();
  return {
    ...mod,
    sendMail: vi.fn(async () => {
      throw new Error('smtp down (test)');
    }),
  };
});

vi.mock('../src/net/safeFetch', () => ({
  safeFetch: vi.fn(async (_policy: unknown, url: string, init: RequestInit = {}) => {
    captured.requests.push({
      url,
      init: init as RequestInit & { headers?: Record<string, string> },
    });
    return { status: 200 } as unknown as Response;
  }),
  preflightUrl: vi.fn(async () => undefined),
}));

const { sendMail } = await import('../src/auth/service');

let server: Server;
let port = 0;
const base = () => `http://127.0.0.1:${port}`;

class Api {
  csrf = '';
  cookie = '';

  async absorb(res: Response) {
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const pair = c.split(';')[0]!;
      const name = pair.split('=')[0]!;
      this.cookie = `${this.cookie.replace(new RegExp(`${name}=[^;]*;? ?`), '')}${pair}; `;
    }
  }

  async get(path: string) {
    const res = await fetch(`${base()}${path}`, { headers: { cookie: this.cookie } });
    await this.absorb(res);
    return res;
  }

  async mutate(method: 'POST' | 'PUT', path: string, body?: unknown): Promise<Response> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (this.csrf) headers['x-vl-csrf'] = this.csrf;
      if (this.cookie) headers.cookie = this.cookie;
      const res = await fetch(`${base()}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      await this.absorb(res);
      // Double-submit CSRF: first mutating request may get a fresh cookie and
      // a 403 telling us to retry with the matching header.
      if (res.status === 403) {
        try {
          const parsed = (await res.clone().json()) as { error?: { code?: string } };
          if (parsed.error?.code === 'CSRF') {
            const pairs = this.cookie.split(';').map((c) => c.trim());
            const next = pairs.find((c) => c.startsWith('vl_csrf='))?.split('=')[1] ?? '';
            if (next) this.csrf = next;
            continue;
          }
        } catch {
          /* not JSON */
        }
      }
      return res;
    }
    throw new Error('CSRF retry exhausted');
  }

  post(path: string, body?: unknown) {
    return this.mutate('POST', path, body);
  }

  put(path: string, body?: unknown) {
    return this.mutate('PUT', path, body);
  }

  async fetchCsrf() {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.cookie) headers.cookie = this.cookie;
    const res = await fetch(`${base()}/api/v1/auth/step-up`, {
      method: 'POST',
      headers,
      body: '{}',
    });
    await this.absorb(res);
    const pairs = this.cookie.split(';').map((c) => c.trim());
    this.csrf = pairs.find((c) => c.startsWith('vl_csrf='))?.split('=')[1] ?? '';
    expect(this.csrf.length).toBeGreaterThan(0);
  }

  /** Set the session cookie and obtain a matching CSRF cookie for it. */
  async authAs(token: string) {
    // Fetch the CSRF cookie anonymously (the step-up endpoint behaves
    // differently for signed-in sessions), then attach the session cookie.
    this.cookie = '';
    this.csrf = '';
    await this.fetchCsrf();
    const csrfPair = this.cookie
      .split(';')
      .map((c) => c.trim())
      .find((c) => c.startsWith('vl_csrf='));
    this.cookie = `vl_session=${token}; ${csrfPair ?? ''}`;
  }
}

const api = new Api();

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

const cleanupIds: string[] = [];

async function seedUser(email: string) {
  const user = await prisma.user.create({
    data: {
      email,
      name: 'Gate5 Tester',
      passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$s$s',
      webauthnUserId: crypto.randomBytes(16).toString('hex'),
      emailVerifiedAt: new Date(),
    },
  });
  cleanupIds.push(user.id);
  return user;
}

async function seedOrgWithVehicle(ownerId: string) {
  const org = await prisma.organization.create({
    data: {
      kind: 'PERSONAL',
      name: 'Gate5 org',
      createdById: ownerId,
      memberships: { create: { userId: ownerId, role: 'OWNER' } },
    },
  });
  cleanupIds.push(org.id);
  const account = await prisma.providerAccount.create({
    data: { organizationId: org.id, provider: 'demo', label: 'Gate5 demo', demo: true },
  });
  cleanupIds.push(account.id);
  const vehicle = await prisma.vehicle.create({
    data: {
      organizationId: org.id,
      providerAccountId: account.id,
      provider: 'demo',
      providerVehicleId: `v-${crypto.randomBytes(4).toString('hex')}`,
      displayName: 'Gate5 Car',
      demo: true,
    },
  });
  cleanupIds.push(vehicle.id);
  return { org, vehicle };
}

beforeAll(async () => {
  await initRedis();
  server = buildApp({ serveSpa: false }).listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  port = (server.address() as AddressInfo).port;
  await api.fetchCsrf();
}, 30_000);

afterAll(async () => {
  for (const id of cleanupIds) {
    await prisma
      .$transaction([
        prisma.maintenanceWindow.deleteMany({ where: { id } }),
        prisma.statusSubscription.deleteMany({ where: { id } }),
        prisma.pushSubscription.deleteMany({ where: { id } }),
        prisma.notificationOutbox.deleteMany({ where: { id } }),
        prisma.maintenanceRecord.deleteMany({ where: { id } }),
        prisma.automation.deleteMany({ where: { id } }),
        prisma.vehicle.deleteMany({ where: { id } }),
        prisma.providerAccount.deleteMany({ where: { id } }),
        prisma.organization.deleteMany({ where: { id } }),
        prisma.user.deleteMany({ where: { id } }),
      ])
      .catch(() => undefined);
  }
  await prisma.$disconnect();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// ---------------------------------------------------------------------------
// N-CONDITIONS / N-TRIGGERS: timezone-aware day and time_range conditions
// ---------------------------------------------------------------------------

describe('automations: timezone conditions (N-CONDITIONS, N-TRIGGERS)', () => {
  it('evaluates day in the vehicle organization timezone, not UTC', async () => {
    const { evaluateConditions } = await import('../src/automations/engine');
    // 2026-11-02T03:30:00Z = 2026-11-01T22:30 America/New_York (Sunday).
    const now = new Date('2026-11-02T03:30:00Z');
    const sundayInNY = await evaluateConditions([{ type: 'day', params: { days: [0] } }], {
      now,
      timezone: 'America/New_York',
    });
    expect(sundayInNY).toBe(true);
    // In UTC the same instant is Monday (day 1).
    const mondayInUTC = await evaluateConditions([{ type: 'day', params: { days: [0] } }], {
      now,
      timezone: 'UTC',
    });
    expect(mondayInUTC).toBe(false);
  });

  it('evaluates time_range in local time, including overnight ranges', async () => {
    const { evaluateConditions } = await import('../src/automations/engine');
    // 02:30Z is 21:30 the previous evening in New York (EST, UTC-5).
    const now = new Date('2026-11-02T02:30:00Z');
    const eveningInNY = await evaluateConditions(
      [{ type: 'time_range', params: { start: '21:00', end: '22:00' } }],
      { now, timezone: 'America/New_York' },
    );
    expect(eveningInNY).toBe(true);
    const eveningInUTC = await evaluateConditions(
      [{ type: 'time_range', params: { start: '21:00', end: '22:00' } }],
      { now, timezone: 'UTC' },
    );
    expect(eveningInUTC).toBe(false);
  });

  it('TRIGGER_TYPES includes trunk_open and provider_reconnected', async () => {
    const { TRIGGER_TYPES } = await import('@voltlink/shared');
    expect(TRIGGER_TYPES).toContain('trunk_open');
    expect(TRIGGER_TYPES).toContain('provider_reconnected');
  });
});

// ---------------------------------------------------------------------------
// P-DRYRUN: dry runs are pure — no notifications, no commands, no counters
// ---------------------------------------------------------------------------

describe('automations: dry-run purity (P-DRYRUN)', () => {
  it('dry run executes no actions and leaves the automation untouched', async () => {
    const { runAutomation } = await import('../src/automations/engine');
    const user = await seedUser(`dry-${Date.now()}@example.test`);
    const automation = await prisma.automation.create({
      data: {
        organizationId: (await seedOrgWithVehicle(user.id)).org.id,
        userId: user.id,
        name: 'Dry-run test',
        triggerType: 'trunk_open',
        actions: [
          { type: 'notify_app', params: { message: 'dry run must not notify' } },
          { type: 'create_incident', params: { title: 'dry run incident' } },
        ],
      },
    });
    cleanupIds.push(automation.id);
    const before = await prisma.appNotification.count({ where: { userId: user.id } });
    const res = await runAutomation(
      automation.id,
      { type: 'trunk_open', userId: user.id, data: {} },
      { dryRun: true },
    );
    expect(res.result).toBe('dry_run');
    const after = await prisma.appNotification.count({ where: { userId: user.id } });
    expect(after).toBe(before);
    const incidents = await prisma.incident.count({
      where: { title: 'dry run incident' },
    });
    expect(incidents).toBe(0);
    const updated = await prisma.automation.findUniqueOrThrow({
      where: { id: automation.id },
    });
    expect(updated.runCount).toBe(0);
    const executions = await prisma.automationExecution.findMany({
      where: { automationId: automation.id },
    });
    expect(executions).toHaveLength(1);
    expect(executions[0]!.result).toBe('dry_run');
  });
});

// ---------------------------------------------------------------------------
// N-DROPPED: outbox + retry + dead-letter (SMTP failure never aborts notify)
// ---------------------------------------------------------------------------

describe('notifications: outbox, retry, dead-letter (N-DROPPED)', () => {
  it('writes outbox rows, never delivers synchronously, and dead-letters after retries', async () => {
    const { notify, processOutboxJob, OUTBOX_MAX_ATTEMPTS } =
      await import('../src/notifications/service');
    const user = await seedUser(`outbox-${Date.now()}@example.test`);
    await notify({
      userId: user.id,
      event: 'system',
      severity: 'critical',
      title: 'Outbox test',
      body: 'delivery must be asynchronous',
      channels: ['email'],
      force: true,
    });
    const row = await prisma.notificationOutbox.findFirst({
      where: { userId: user.id },
    });
    expect(row).not.toBeNull();
    expect(row!.status).toBe('pending');
    expect(row!.channel).toBe('email');
    expect(sendMail).not.toHaveBeenCalled(); // nothing delivered inline

    // Worker retries: SMTP is mocked to fail; the first N-1 attempts rethrow.
    let attempts = 0;
    for (; attempts < OUTBOX_MAX_ATTEMPTS - 1; attempts++) {
      await expect(processOutboxJob({ outboxId: row!.id, channel: 'email' })).rejects.toThrow();
    }
    const mid = await prisma.notificationOutbox.findUniqueOrThrow({
      where: { id: row!.id },
    });
    expect(mid.status).toBe('pending');
    expect(mid.attempts).toBe(OUTBOX_MAX_ATTEMPTS - 1);

    // Final attempt: dead-lettered, no throw.
    await processOutboxJob({ outboxId: row!.id, channel: 'email' });
    const dead = await prisma.notificationOutbox.findUniqueOrThrow({
      where: { id: row!.id },
    });
    expect(dead.status).toBe('dead');
    expect(dead.attempts).toBe(OUTBOX_MAX_ATTEMPTS);
    expect(dead.lastError).toContain('smtp down');
  });

  it('marks successful deliveries sent', async () => {
    const { notify, processOutboxJob } = await import('../src/notifications/service');
    const user = await seedUser(`sent-${Date.now()}@example.test`);
    await prisma.notificationChannel.create({
      data: {
        userId: user.id,
        kind: 'teams',
        name: 'teamsWebhook',
        configCiphertext: (await import('../src/core/crypto')).sealJson({
          url: 'https://hooks.example/teams',
        }).ciphertext,
      },
    });
    await notify({
      userId: user.id,
      event: 'system',
      title: 'Teams test',
      body: 'hello',
      channels: ['teams'],
      force: true,
    });
    const row = await prisma.notificationOutbox.findFirstOrThrow({
      where: { userId: user.id, channel: 'teams' },
    });
    await processOutboxJob({ outboxId: row.id, channel: 'teams' });
    const done = await prisma.notificationOutbox.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(done.status).toBe('sent');
    expect(done.sentAt).not.toBeNull();
    // N-TEAMS: captured payload is an Adaptive Card envelope.
    const teams = captured.requests.find((r) => r.url === 'https://hooks.example/teams');
    expect(teams).toBeDefined();
    const body = JSON.parse(String(teams!.init.body));
    expect(body.type).toBe('message');
    expect(body.attachments[0].content.type).toBe('AdaptiveCard');
    expect(body.attachments[0].content.version).toBe('1.4');
    expect(body.attachments[0].content.body[0].text).toBe('Teams test');
  });
});

// ---------------------------------------------------------------------------
// N-GOTIFY: token travels in X-Gotify-Key, never in the URL
// ---------------------------------------------------------------------------

describe('notifications: Gotify header (N-GOTIFY)', () => {
  it('strips the token from the URL and sends X-Gotify-Key', async () => {
    const { splitGotify, pushSimpleWebhook } = await import('../src/notifications/simpleWebhooks');
    const parts = splitGotify('https://gotify.example/message?token=sekrit123');
    expect(parts.url).toBe('https://gotify.example/message');
    expect(parts.token).toBe('sekrit123');

    const user = await seedUser(`gotify-${Date.now()}@example.test`);
    await prisma.notificationChannel.create({
      data: {
        userId: user.id,
        kind: 'gotify',
        name: 'gotifyUrl',
        configCiphertext: (await import('../src/core/crypto')).sealJson({
          url: 'https://gotify.example/message?token=sekrit123',
        }).ciphertext,
      },
    });
    const before = captured.requests.length;
    await pushSimpleWebhook(user.id, 'gotify', {
      title: 'Gotify test',
      body: 'hello',
      severity: 'critical',
      event: 'system',
    });
    expect(captured.requests.length).toBe(before + 1);
    const req = captured.requests.at(-1)!;
    expect(req.url).toBe('https://gotify.example/message');
    expect(req.url).not.toContain('sekrit123');
    const headers = (req.init.headers ?? {}) as Record<string, string>;
    expect(headers['X-Gotify-Key']).toBe('sekrit123');
    const payload = JSON.parse(String(req.init.body));
    expect(payload.title).toBe('Gotify test');
    expect(payload.priority).toBe(8); // critical
  });
});

// ---------------------------------------------------------------------------
// N-PUSH: config endpoint + endpoint/key validation on registration
// ---------------------------------------------------------------------------

describe('push subscriptions (N-PUSH)', () => {
  it('GET /push/config reports enabled + keyId shape', async () => {
    const user = await seedUser(`pushcfg-${Date.now()}@example.test`);
    const { token } = await createSession(user.id);
    await api.authAs(token);
    const res = await api.get('/api/v1/notifications/push/config');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { enabled: boolean; publicKey: string; keyId: string };
    };
    expect(typeof body.data.enabled).toBe('boolean');
    if (body.data.enabled) {
      expect(body.data.publicKey.length).toBeGreaterThan(0);
      expect(body.data.keyId).toHaveLength(16); // 12 bytes base64url
    } else {
      expect(body.data.keyId).toBe('');
    }
  });

  it('rejects non-push endpoints and malformed keys', async () => {
    const user = await seedUser(`pushbad-${Date.now()}@example.test`);
    const { token } = await createSession(user.id);
    await api.authAs(token);

    const badEndpoint = await api.put('/api/v1/notifications/push/subscriptions', {
      endpoint: 'https://evil.example/spam',
      keys: { p256dh: 'x', auth: 'y' },
    });
    expect(badEndpoint.status).toBe(422);
    expect(((await badEndpoint.json()) as { error: { code: string } }).error.code).toBe(
      'INVALID_ENDPOINT',
    );

    const badKeys = await api.put('/api/v1/notifications/push/subscriptions', {
      endpoint: 'https://fcm.googleapis.com/fcm/send/test',
      keys: { p256dh: 'not-a-point', auth: 'short' },
    });
    expect(badKeys.status).toBe(422);
    expect(((await badKeys.json()) as { error: { code: string } }).error.code).toBe('INVALID_KEYS');
  });

  it('accepts a valid browser push subscription', async () => {
    const user = await seedUser(`pushok-${Date.now()}@example.test`);
    const { token } = await createSession(user.id);
    await api.authAs(token);
    const p256dh = Buffer.concat([Buffer.from([0x04]), crypto.randomBytes(64)]).toString(
      'base64url',
    );
    const auth = crypto.randomBytes(16).toString('base64url');
    const endpoint = `https://fcm.googleapis.com/fcm/send/${crypto.randomBytes(12).toString('hex')}`;
    const res = await api.put('/api/v1/notifications/push/subscriptions', {
      endpoint,
      keys: { p256dh, auth },
    });
    expect(res.status).toBe(200);
    const sub = await prisma.pushSubscription.findFirst({
      where: { userId: user.id, endpoint },
    });
    expect(sub).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// NEW-09: fleet maintenance validation
// ---------------------------------------------------------------------------

describe('fleet maintenance (NEW-09)', () => {
  it('rejects unparseable dueAt and requires dueAt or dueOdometerKm', async () => {
    const user = await seedUser(`fleet-${Date.now()}@example.test`);
    const { vehicle } = await seedOrgWithVehicle(user.id);
    const { token } = await createSession(user.id);
    await api.authAs(token);

    const badDate = await api.post('/api/v1/fleet/maintenance', {
      vehicleId: vehicle.id,
      title: 'Oil change',
      dueAt: 'not-a-date',
    });
    expect(badDate.status).toBe(400);
    expect(((await badDate.json()) as { error: { code: string } }).error.code).toBe('INVALID_DATE');

    const missing = await api.post('/api/v1/fleet/maintenance', {
      vehicleId: vehicle.id,
      title: 'Oil change',
    });
    expect(missing.status).toBe(400);

    const odometerOnly = await api.post('/api/v1/fleet/maintenance', {
      vehicleId: vehicle.id,
      title: 'Oil change',
      dueOdometerKm: 5000,
    });
    expect(odometerOnly.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// N-MAINT: maintenance windows are time-driven
// ---------------------------------------------------------------------------

describe('status maintenance windows (N-MAINT)', () => {
  it('flips components to maintenance inside the window and back afterwards', async () => {
    const { runStatusChecks } = await import('../src/status/service');
    await prisma.statusComponent.upsert({
      where: { key: 'web' },
      update: {},
      create: {
        key: 'web',
        name: 'Web application',
        group: 'Core',
        status: 'operational',
      },
    });
    const now = Date.now();
    const win = await prisma.maintenanceWindow.create({
      data: {
        title: 'Gate5 window',
        startsAt: new Date(now - 60_000),
        endsAt: new Date(now + 3600_000),
        status: 'scheduled',
        components: ['web'],
      },
    });
    await runStatusChecks();
    const active = await prisma.maintenanceWindow.findUniqueOrThrow({
      where: { id: win.id },
    });
    expect(active.status).toBe('in_progress');
    const comp = await prisma.statusComponent.findUniqueOrThrow({ where: { key: 'web' } });
    expect(comp.status).toBe('maintenance');

    // Window ends: the next check run restores the component.
    await prisma.maintenanceWindow.update({
      where: { id: win.id },
      data: { endsAt: new Date(now - 1_000) },
    });
    await runStatusChecks();
    const finished = await prisma.maintenanceWindow.findUniqueOrThrow({
      where: { id: win.id },
    });
    expect(finished.status).toBe('completed');
    const restored = await prisma.statusComponent.findUniqueOrThrow({
      where: { key: 'web' },
    });
    expect(restored.status).toBe('operational');
    await prisma.maintenanceWindow.delete({ where: { id: win.id } });
  });
});

// ---------------------------------------------------------------------------
// N-SUBS: status subscriptions — confirm, deliver, unsubscribe
// ---------------------------------------------------------------------------

describe('status subscriptions (N-SUBS)', () => {
  it('subscribes, confirms, delivers, and unsubscribes', async () => {
    const email = `status-${Date.now()}@example.test`;
    const res = await api.post('/api/v1/status/subscribe', { email });
    expect(res.status).toBe(200);
    const sub = await prisma.statusSubscription.findUniqueOrThrow({
      where: { email: email.toLowerCase() },
    });
    expect(sub.confirmed).toBe(false);

    const confirm = await api.get(`/api/v1/status/subscriptions/confirm/${sub.token}`);
    expect(confirm.status).toBe(200);
    const confirmed = await prisma.statusSubscription.findUniqueOrThrow({
      where: { id: sub.id },
    });
    expect(confirmed.confirmed).toBe(true);

    // Delivery: SMTP is mocked to fail — delivery errors never propagate.
    const { notifyStatusSubscribers } = await import('../src/routes/status');
    await expect(
      notifyStatusSubscribers('Test incident', 'Testing delivery'),
    ).resolves.toBeUndefined();
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: email.toLowerCase() }));

    const unsub = await api.get(`/api/v1/status/subscriptions/unsubscribe/${sub.token}`);
    expect(unsub.status).toBe(200);
    const gone = await prisma.statusSubscription.findUnique({
      where: { id: sub.id },
    });
    expect(gone).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// N-STATUSHEALTH: optional providers show not-configured, not outage
// ---------------------------------------------------------------------------

describe('status health (N-STATUSHEALTH)', () => {
  it('reports not-configured for optional providers and outage only when configured+broken', async () => {
    const { checkComponent } = await import('../src/status/service');
    const tessie = await checkComponent('tessie');
    expect(tessie.ok).toBe(true);
    expect(tessie.detail?.toLowerCase()).toContain('configured');

    const maps = await checkComponent('maps');
    expect(maps.ok).toBe(true);
    expect(maps.detail).toContain('Not configured');

    // A connected account with a fresh error is a real outage.
    const user = await seedUser(`health-${Date.now()}@example.test`);
    const { org } = await seedOrgWithVehicle(user.id);
    const account = await prisma.providerAccount.create({
      data: {
        organizationId: org.id,
        provider: 'tesla',
        label: 'Broken Tesla',
        status: 'connected',
        lastError: '401 unauthorized',
        lastSyncAt: new Date(),
      },
    });
    cleanupIds.push(account.id);
    const tesla = await checkComponent('tesla');
    expect(tesla.ok).toBe(false);
    expect(tesla.detail).toContain('with recent errors');
  });
});
