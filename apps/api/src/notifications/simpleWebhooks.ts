// Simple external notification providers configured per user:
// ntfy, Gotify, Discord webhooks, Microsoft Teams webhooks.
// Endpoint URLs are validated as http(s) and rate-limited; delivery failures
// are recorded but never crash the caller.

import { prisma } from '../core/db';
import { safeFetch } from '../net/safeFetch';
import { getOutboundPolicy } from '../net/policy';
import { getSetting } from '../core/settings';
import type { DeliveryChannel } from '@voltlink/shared';

const PROVIDER_SETTING: Record<string, string> = {
  ntfy: 'ntfyUrl',
  gotify: 'gotifyUrl',
  discord: 'discordWebhook',
  teams: 'teamsWebhook',
};

const RATE_LIMIT = 30_000; // one delivery per provider per user per 30s

const lastSent = new Map<string, number>();

export async function pushSimpleWebhook(userId: string, channel: DeliveryChannel, msg: { title: string; body: string; severity: string; event: string }): Promise<void> {
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
    await safeFetch(getOutboundPolicy(), url, { method: 'POST', body: msg.body, headers: { Title: msg.title, Priority: msg.severity === 'critical' ? '5' : '3', Tags: 'voltlink' } });
    return;
  }
  if (channel === 'gotify') {
    payload = JSON.stringify({ title: msg.title, message: msg.body, priority: msg.severity === 'critical' ? 8 : 5 });
    await safeFetch(getOutboundPolicy(), url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload });
    return;
  }
  if (channel === 'discord') {
    const color = msg.severity === 'critical' ? 15548997 : msg.severity === 'warning' ? 16705372 : 3447003;
    payload = JSON.stringify({
      username: 'VoltLink',
      embeds: [{ title: msg.title, description: msg.body, color, timestamp: new Date().toISOString() }],
    });
    await safeFetch(getOutboundPolicy(), url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload });
    return;
  }
  if (channel === 'teams') {
    payload = JSON.stringify({ '@type': 'MessageCard', '@context': 'http://schema.org/extensions', summary: msg.title, themeColor: '0078D7', title: msg.title, text: msg.body });
    await safeFetch(getOutboundPolicy(), url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload });
  }
}

/** Channel URL is stored as an AppSetting per user+channel (validated http(s)). */
export async function userChannelUrl(userId: string, key: string): Promise<string | null> {
  const v = await getSetting(`user:${userId}:${key}`);
  if (!v) return null;
  return validateWebhookUrl(v) ? v : null;
}

export function validateWebhookUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1';
  } catch {
    return false;
  }
}

export async function setUserChannelUrl(userId: string, key: string, url: string | null): Promise<void> {
  if (url && !validateWebhookUrl(url)) throw new Error('Webhook URL must be a valid http(s) URL.');
  await prisma.appSetting.upsert({ where: { key: `user:${userId}:${key}` }, update: { value: url ?? '' }, create: { key: `user:${userId}:${key}`, value: url ?? '' } });
}
