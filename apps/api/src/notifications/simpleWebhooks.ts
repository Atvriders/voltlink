// Simple external notification providers configured per user:
// ntfy, Gotify, Discord webhooks, Microsoft Teams webhooks.
// Endpoint URLs are validated as http(s) and rate-limited; delivery failures
// are recorded but never crash the caller.

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

const RATE_LIMIT = 30_000; // one delivery per provider per user per 30s

const lastSent = new Map<string, number>();

export async function pushSimpleWebhook(
  userId: string,
  channel: DeliveryChannel,
  msg: { title: string; body: string; severity: string; event: string },
): Promise<void> {
  const key = PROVIDER_SETTING[channel];
  if (!key) return;
  const url = await userChannelUrl(userId, key);
  if (!url) return;

  const now = Date.now();
  const last = lastSent.get(`${userId}:${channel}`);
  if (last && now - last < RATE_LIMIT) return;
  lastSent.set(`${userId}:${channel}`, now);

  let payload: string;
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
    payload = JSON.stringify({
      title: msg.title,
      message: msg.body,
      priority: msg.severity === 'critical' ? 8 : 5,
    });
    await safeFetch(getOutboundPolicy(), url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    });
    return;
  }
  if (channel === 'discord') {
    const color =
      msg.severity === 'critical' ? 15548997 : msg.severity === 'warning' ? 16705372 : 3447003;
    payload = JSON.stringify({
      username: 'VoltLink',
      embeds: [
        { title: msg.title, description: msg.body, color, timestamp: new Date().toISOString() },
      ],
    });
    await safeFetch(getOutboundPolicy(), url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    });
    return;
  }
  if (channel === 'teams') {
    payload = JSON.stringify({
      '@type': 'MessageCard',
      '@context': 'http://schema.org/extensions',
      summary: msg.title,
      themeColor: '0078D7',
      title: msg.title,
      text: msg.body,
    });
    await safeFetch(getOutboundPolicy(), url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    });
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
