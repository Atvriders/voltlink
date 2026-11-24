// R5: N-TEAMS (red run) — payload sent to a Teams webhook must be a modern
// Adaptive Card envelope, and a non-ASCII title must stay raw UTF-8.
process.env.NODE_ENV = 'test';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/core/db';
import { initRedis } from '../src/core/redis';
import { randomId } from '../src/core/crypto';
import { sealJson } from '../src/core/crypto';

const captured: { url: string; init: { body?: unknown; headers?: Record<string, string> } }[] = [];

vi.mock('../src/net/safeFetch', () => ({
  safeFetch: async (_policy: unknown, url: string, init: unknown) => {
    captured.push({ url, init: init as { body?: unknown } });
    return new Response('{}', { status: 200 });
  },
}));

beforeAll(async () => {
  await initRedis();
}, 30_000);

afterAll(async () => {
  await prisma.$disconnect();
});

describe('Teams Adaptive Card (N-TEAMS)', () => {
  it('sends an Adaptive Card envelope with a raw UTF-8 title', async () => {
    const { pushSimpleWebhook } = await import('../src/notifications/simpleWebhooks');
    const user = await prisma.user.create({
      data: {
        email: `nt-${Date.now()}-${randomId()}@test.dev`,
        name: 'NT',
        passwordHash: 'x',
        webauthnUserId: randomId(),
      },
    });
    await prisma.notificationChannel.create({
      data: {
        userId: user.id,
        kind: 'teams',
        name: 'teamsWebhook',
        configCiphertext: sealJson({ url: 'https://hooks.example/teams' }).ciphertext,
      },
    });
    const title = 'Olá — système 車両';
    await pushSimpleWebhook(user.id, 'teams', {
      title,
      body: 'body text',
      severity: 'info',
      event: 'system',
    });
    const call = captured.find((c) => c.url === 'https://hooks.example/teams');
    expect(call).toBeDefined();
    const body = JSON.parse(String(call!.init.body)) as {
      type?: string;
      attachments?: {
        contentType?: string;
        content?: { type?: string; body?: { text?: string }[] };
      }[];
    };
    expect(body.type).toBe('message');
    expect(body.attachments?.[0]?.contentType).toBe('application/vnd.microsoft.card.adaptive');
    expect(body.attachments?.[0]?.content?.body?.[0]?.text).toBe(title);
    expect(JSON.stringify(body)).toContain(title);
  });
});
