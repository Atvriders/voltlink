// R5: N-DROPPED — a notification is never marked sent unless it was actually
// delivered: 4xx webhook answers, throttled channels and empty push
// subscriptions must not produce 'sent' rows.
const envs = vi.hoisted(() => {
  // TI-06: '*' is not a valid allow entry — parseAllowlist threw before the
  // mocked undici fetch was ever reached, so the 4xx check never ran. A real
  // CIDR entry parses cleanly and the mocked fetch handles the request.
  process.env.VL_OUTBOUND_ALLOW = '8.8.8.8/32';
});
void envs;

const undiciMock = vi.hoisted(() => ({
  fetch: vi.fn(async () => ({
    ok: false,
    status: 410,
    headers: new Headers(),
    text: async () => 'gone',
    json: async () => ({}),
  })),
}));
vi.mock('undici', () => ({
  Agent: class {
    constructor() {
      /* stub */
    }
  },
  fetch: undiciMock.fetch,
}));

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/core/db';
import { initRedis } from '../src/core/redis';
import { randomId, sealJson } from '../src/core/crypto';
import { processOutboxJob, OUTBOX_MAX_ATTEMPTS } from '../src/notifications/service';
import { generateWebhookSecret } from '../src/webhooks/standardWebhooks';

beforeAll(async () => {
  await initRedis();
}, 30_000);

afterAll(async () => {
  await prisma.$disconnect();
});

async function mkUser() {
  return prisma.user.create({
    data: {
      email: `nd-${Date.now()}-${randomId()}@test.dev`,
      name: 'ND',
      passwordHash: 'x',
      webauthnUserId: randomId(),
    },
  });
}

async function mkOutbox(userId: string, channel: string) {
  return prisma.notificationOutbox.create({
    data: {
      userId,
      channel,
      event: 'automation_fired',
      severity: 'info',
      title: 'Tïtle wïth ünïcödé',
      body: 'b',
    },
  });
}

describe('notifications never lie about delivery (N-DROPPED)', () => {
  it('a webhook 4xx is retried, never marked sent', async () => {
    const user = await mkUser();
    await prisma.webhookEndpoint.create({
      data: {
        userId: user.id,
        name: 'W',
        url: 'https://hooks.example.test/w',
        events: JSON.parse('["automation_fired"]'),
        // TI-06: the real product requires the post-'whsec_' part to be
        // base64 that decodes to 24-64 bytes; the old fixtures made the job
        // throw before any fetch.
        secretSealed: sealJson({ current: generateWebhookSecret() }).ciphertext,
      },
    });
    const row = await mkOutbox(user.id, 'webhook');
    await expect(processOutboxJob({ outboxId: row.id, channel: 'webhook' })).rejects.toThrow();
    // TI-06: the 4xx must actually be SEEN by the delivery path.
    expect(undiciMock.fetch).toHaveBeenCalled();
    const after = await prisma.notificationOutbox.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe('pending');
    expect(after.attempts).toBe(1);
    expect(after.sentAt).toBeNull();
  });

  it('push with no subscriptions is dropped, not sent', async () => {
    const user = await mkUser();
    const row = await mkOutbox(user.id, 'push');
    await processOutboxJob({ outboxId: row.id, channel: 'push' });
    const after = await prisma.notificationOutbox.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.status).toBe('dropped');
    expect(after.sentAt).toBeNull();
  });

  it('a throttled simple-webhook channel is dropped, not sent', async () => {
    const user = await mkUser();
    await prisma.notificationChannel.create({
      data: {
        userId: user.id,
        kind: 'ntfy',
        name: 'ntfyUrl',
        configCiphertext: sealJson({ url: 'https://ntfy.example.test/topic' }).ciphertext,
      },
    });
    const first = await mkOutbox(user.id, 'ntfy');
    await expect(processOutboxJob({ outboxId: first.id, channel: 'ntfy' })).rejects.toThrow();
    // TI-06: the simple channel's 4xx must have been seen by the fetch too.
    expect(undiciMock.fetch).toHaveBeenCalled();
    const second = await mkOutbox(user.id, 'ntfy');
    await processOutboxJob({ outboxId: second.id, channel: 'ntfy' });
    const after = await prisma.notificationOutbox.findUniqueOrThrow({
      where: { id: second.id },
    });
    expect(after.status).toBe('dropped');
    expect(after.sentAt).toBeNull();
    void OUTBOX_MAX_ATTEMPTS;
  });
});
