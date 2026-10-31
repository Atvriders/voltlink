// Simple external notification providers configured per user:
// ntfy, Gotify, Discord webhooks, Microsoft Teams webhooks.
// Endpoint URLs are validated as http(s) and rate-limited; delivery failures
// are recorded but never crash the caller.
// N-TEAMS: Teams payload is an Adaptive Card envelope.
// N-SMTP/Gotify: the Gotify token is sent as X-Gotify-Key, never in the URL.

import { prisma } from '../core/db';
import { safeFetch } from '../net/safeFetch';
import { getOutboundPolicy } from '../net/policy';
import { getSetting } from '../core/settings';
import { sealJson, openJson } from '../core/crypto';
import type { DeliveryChannel } from '@voltlink/shared';

const PROVIDER_SETTING: Record<string, string> = {
  ntfy: 'ntfyUrl',
  gotify: 'gotifyUrl',
  discord: 'discordWebhook',
  teams: 'teamsWebhook',
};

const lastSent = new Map<string, number>();

/** Minimum interval between deliveries per user+provider, in ms (N-DROPPED). */
export function channelMinInterval(_userId: string, channel: string, url?: string | null): number {
  if (channel === 'ntfy' && url) {
    try {
      return new URL(url).hostname === 'ntfy.sh' ? 5_000 : 1_000;
    } catch {
      /* fall through */
    }
  }
  return (
    { discord: 1_000, teams: 1_000, ntfy: 1_000, gotify: 0, email: 0, push: 250 }[channel] ?? 1_000
  );
}

export function throttled(userId: string, channel: string, url?: string | null): boolean {
  const key = `${userId}:${channel}`;
  const interval = channelMinInterval(userId, channel, url);
  if (interval <= 0) return false;
  const now = Date.now();
  const last = lastSent.get(key);
  if (last && now - last < interval) return true;
  lastSent.set(key, now);
  return false;
}

export async function pushSimpleWebhook(
  userId: string,
  channel: DeliveryChannel,
  msg: { title: string; body: string; severity: string; event: string },
): Promise<void> {
  const key = PROVIDER_SETTING[channel];
  if (!key) return;
  const url = await userChannelUrl(userId, key);
  if (!url) return;

  if (channel === 'ntfy') {
    await safeFetch(getOutboundPolicy(), url, {
      method: 'POST',
      body: msg.body,
      headers: {
        Title: msg.title,
        Priority: msg.severity === 'critical' ? '5' : '3',
        Tags: 'voltlink',
      },
    });
    return;
  }
  if (channel === 'gotify') {
    // N-GOTIFY: the token travels in X-Gotify-Key; strip it from the URL.
    const { url: cleanUrl, token } = splitGotify(url);
    await safeFetch(getOutboundPolicy(), cleanUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Gotify-Key': token },
      body: JSON.stringify({
        title: msg.title,
        message: msg.body,
        priority: msg.severity === 'critical' ? 8 : 5,
      }),
    });
    return;
  }
  if (channel === 'discord') {
    const color =
      msg.severity === 'critical' ? 15548997 : msg.severity === 'warning' ? 16705372 : 3447003;
    await safeFetch(getOutboundPolicy(), url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'VoltLink',
        embeds: [
          { title: msg.title, description: msg.body, color, timestamp: new Date().toISOString() },
        ],
      }),
    });
    return;
  }
  if (channel === 'teams') {
    // N-TEAMS: Adaptive Card envelope.
    await safeFetch(getOutboundPolicy(), url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'message',
        attachments: [
          {
            contentType: 'application/vnd.microsoft.card.adaptive',
            content: {
              $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
              type: 'AdaptiveCard',
              version: '1.4',
              body: [
                { type: 'TextBlock', size: 'Large', weight: 'Bolder', text: msg.title, wrap: true },
                { type: 'TextBlock', text: msg.body, wrap: true },
                { type: 'TextBlock', text: `Event: ${msg.event}`, size: 'Small', isSubtle: true },
              ],
            },
          },
        ],
      }),
    });
  }
}

/** Gotify URLs are commonly https://host/message?token=…; move the token to a header. */
export function splitGotify(raw: string): { url: string; token: string } {
  try {
    const u = new URL(raw);
    const token = u.searchParams.get('token') ?? '';
    u.searchParams.delete('token');
    return { url: u.toString(), token };
  } catch {
    return { url: raw, token: '' };
  }
}

/** Channel URL is sealed at rest in NotificationChannel.configCiphertext
 * (N-CHANSECRETS); raw URLs never appear in GET responses (G-08). */
export async function userChannelUrl(userId: string, key: string): Promise<string | null> {
  const kind = keyToKind(key);
  const row = await prisma.notificationChannel.findFirst({ where: { userId, kind } });
  if (!row) {
    const v = await getSetting(`user:${userId}:${key}`);
    if (!v) return null;
    if (!validateWebhookUrl(v)) return null;
    await setUserChannelUrl(userId, key, v).catch(() => undefined);
    return v;
  }
  try {
    const cfg = openJson<{ url: string }>(row.configCiphertext);
    return validateWebhookUrl(cfg.url) ? cfg.url : null;
  } catch {
    return null;
  }
}

export function validateWebhookUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return (
      (u.protocol === 'https:' || u.protocol === 'http:') &&
      u.hostname !== 'localhost' &&
      u.hostname !== '127.0.0.1'
    );
  } catch {
    return false;
  }
}

function keyToKind(key: string): string {
  return (
    { ntfyUrl: 'ntfy', gotifyUrl: 'gotify', discordWebhook: 'discord', teamsWebhook: 'teams' }[
      key
    ] ?? key
  );
}

export async function setUserChannelUrl(
  userId: string,
  key: string,
  url: string | null,
): Promise<void> {
  if (url && !validateWebhookUrl(url)) throw new Error('Webhook URL must be a valid http(s) URL.');
  const kind = keyToKind(key);
  const row = await prisma.notificationChannel.findFirst({ where: { userId, kind } });
  if (row) {
    if (!url) {
      await prisma.notificationChannel.delete({ where: { id: row.id } });
    } else {
      await prisma.notificationChannel.update({
        where: { id: row.id },
        data: { configCiphertext: sealJson({ url }).ciphertext },
      });
    }
  } else if (url) {
    await prisma.notificationChannel.create({
      data: { userId, kind, name: key, configCiphertext: sealJson({ url }).ciphertext },
    });
  }
  await prisma.appSetting
    .deleteMany({ where: { key: `user:${userId}:${key}` } })
    .catch(() => undefined);
}
