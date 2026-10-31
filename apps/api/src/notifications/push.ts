// Push notifications via Web Push (VAPID) — the actual payload encryption
// lives in this module, so the notification service stays readable.
// N-PUSH hardening: per-severity TTL/urgency, topic + tag collapsing,
// endpoint allow-listing at registration, and endpoint cleanup (404/410/403).

import { createHash } from 'node:crypto';
import webpush from 'web-push';
import { env } from '../core/env';

export interface PushSubRow {
  id?: string;
  endpoint: string;
  keys: unknown;
}

/** Thrown when the push service reports the subscription gone (404/410). */
export class PushEndpointGone extends Error {}

/** Thrown when the push service rejects our VAPID identity (403). */
export class VapidRejected extends Error {}

const URGENCY: Record<string, { ttl: number; urgency: 'high' | 'normal' | 'low' }> = {
  critical: { ttl: 3600, urgency: 'high' },
  warning: { ttl: 1800, urgency: 'normal' },
  info: { ttl: 600, urgency: 'low' },
};

export function pushConfig(): { enabled: boolean; publicKey: string; keyId: string } {
  const publicKey = env.VAPID_PUBLIC_KEY ?? '';
  const enabled = Boolean(publicKey && env.VAPID_PRIVATE_KEY);
  return {
    enabled,
    publicKey,
    keyId: enabled ? publicKeyId(publicKey) : '',
  };
}

/** VAPID key id (RFC 8292 §2): first 12 bytes of the SHA-256 of the key, base64url. */
export function publicKeyId(publicKey: string): string {
  const digest = createHash('sha256').update(publicKey, 'utf8').digest();
  return digest.subarray(0, 12).toString('base64url');
}

/** Only well-known browser push services may receive subscriptions (N-PUSH). */
export function isKnownPushEndpoint(endpoint: string): boolean {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || (u.port && u.port !== '443')) return false;
  const host = u.hostname;
  const extra = (env.VL_PUSH_SERVICE_HOSTS ?? '')
    .split(',')
    .map((h: string) => h.trim())
    .filter(Boolean);
  const known =
    host === 'fcm.googleapis.com' ||
    host === 'updates.push.services.mozilla.com' ||
    host.endsWith('.push.apple.com') ||
    host.endsWith('.notify.windows.com') ||
    extra.includes(host);
  return known;
}

/** Base64url-decode a key value; throws on invalid encoding. */
export function decodeKey(value: string): Buffer {
  const norm = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = norm + '='.repeat((4 - (norm.length % 4)) % 4);
  const buf = Buffer.from(padded, 'base64');
  if (buf.toString('base64').replace(/=+$/, '') !== norm) {
    throw new Error('invalid base64url');
  }
  return buf;
}

/** N-PUSH: p256dh must be a 65-byte uncompressed EC point (0x04 header), auth 16 bytes. */
export function validatePushKeys(keys: Record<string, unknown>): boolean {
  try {
    const p256dh = decodeKey(String(keys.p256dh));
    const auth = decodeKey(String(keys.auth));
    return p256dh.length === 65 && p256dh[0] === 0x04 && auth.length === 16;
  } catch {
    return false;
  }
}

export async function sendPush(
  sub: PushSubRow,
  message: { title: string; body: string; severity: string; event: string; vehicleId?: string },
): Promise<void> {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return; // push not configured
  webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  const level = URGENCY[message.severity] ?? URGENCY['info']!;
  const payload = JSON.stringify({
    title: message.title,
    body: message.body,
    data: {
      event: message.event,
      severity: message.severity,
      url: '/notifications',
    },
  });
  if (Buffer.byteLength(payload, 'utf8') > 3000) {
    // N-PUSH: keep push payloads small; truncate body rather than dropping.
    const trimmed = JSON.stringify({
      title: message.title.slice(0, 120),
      body: `${message.body.slice(0, 2400)}…`,
      data: { event: message.event, severity: message.severity, url: '/notifications' },
    });
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: sub.keys as webpush.PushSubscription['keys'] },
      trimmed,
      { TTL: level.ttl, urgency: level.urgency, topic: topicFor(message) },
    );
    return;
  }
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: sub.keys as webpush.PushSubscription['keys'] },
      payload,
      { TTL: level.ttl, urgency: level.urgency, topic: topicFor(message) },
    );
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 404 || status === 410) throw new PushEndpointGone('subscription gone');
    if (status === 403) throw new VapidRejected('vapid rejected');
    throw err;
  }
}

/** Topic collapses repeated notifications for the same event + vehicle. */
export function topicFor(message: { event: string; vehicleId?: string }): string {
  return `${message.event}-${(message.vehicleId ?? 'all').slice(0, 8)}`;
}
