// Push notifications via Web Push (VAPID) — the actual payload encryption
// lives in this module, so the notification service stays readable.

import webpush from 'web-push';
import { env } from '../core/env';

export interface PushSubRow {
  endpoint: string;
  keys: unknown;
}

export async function sendPush(
  sub: PushSubRow,
  message: { title: string; body: string; severity: string; event: string },
): Promise<void> {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return; // push not configured
  webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  const payload = JSON.stringify({
    title: message.title,
    body: message.body,
    data: { event: message.event, severity: message.severity },
  });
  await webpush.sendNotification(
    { endpoint: sub.endpoint, keys: sub.keys as webpush.PushSubscription['keys'] },
    payload,
    { TTL: 3600 },
  );
}
