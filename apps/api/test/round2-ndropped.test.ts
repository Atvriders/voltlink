// R5: N-DROPPED — a notification is never marked sent unless it was actually
// delivered: 4xx webhook answers, throttled channels and empty push
// subscriptions must not produce 'sent' rows.
const envs = vi.hoisted(() => {
  // Only this fork: allow the mocked undici fetch to be reached.
  process.env.VL_OUTBOUND_ALLOW = '*';
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
        secretSealed: sealJson({ current: 'whsec_test' }).ciphertext,
      },
    });
    const row = await mkOutbox(user.id, 'webhook');
    await expect(processOutboxJob({ outboxId: row.id, channel: 'webhook' })).rejects.toThrow();
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
