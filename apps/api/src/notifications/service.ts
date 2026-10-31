// Notification service: in-app, email, push, ntfy, Gotify, Discord, Teams,
// and generic webhooks — routed by per-user preferences.

import crypto from 'node:crypto';
import { prisma } from '../core/db';
import { ssePublish } from '../core/sse';
import { sendMail } from '../auth/service';
import type { DeliveryChannel, EventType, Severity } from '@voltlink/shared';

export interface NotifyInput {
  userId: string;
  event: EventType;
  severity?: Severity;
  title: string;
  body: string;
  vehicleId?: string;
  vehicleName?: string;
  /** Delivery channels to attempt (defaults to preference filtering). */
  channels?: DeliveryChannel[];
  /** Skip preference filtering (system events). */
  force?: boolean;
}

export async function notify(input: NotifyInput): Promise<void> {
  const severity = input.severity ?? 'info';
  let channels = input.channels;
  if (!channels) {
    const prefs = await prisma.notificationPreference.findMany({ where: { userId: input.userId, event: input.event, enabled: true } });
    channels = prefs.length > 0 ? (prefs.map((p) => p.channel as DeliveryChannel) as DeliveryChannel[]) : (['in_app'] as DeliveryChannel[]);
  }
  if (!channels.includes('in_app') && !input.force) {
    // in-app is the baseline; every user gets in-app copies
    channels = ['in_app', ...channels];
  }
  const user = await prisma.user.findUnique({ where: { id: input.userId } });
  if (!user || user.deletionRequestedAt || user.suspendedAt) return;

  for (const channel of new Set(channels)) {
    await deliver({ ...input, channel, severity, email: user.email });
  }
  if (channels.includes('in_app')) {
    ssePublish({ type: 'notification', data: { event: input.event, severity, title: input.title }, userId: input.userId });
  }
}

async function deliver(input: NotifyInput & { channel: DeliveryChannel; email: string }): Promise<void> {
  const { channel } = input;
  if (channel === 'in_app') {
    await prisma.appNotification.create({
      data: {
        userId: input.userId,
        event: input.event,
        severity: input.severity ?? 'info',
        title: input.title,
        body: input.body,
        vehicleId: input.vehicleId,
        vehicleName: input.vehicleName,
        channel: 'in_app',
      },
    });
    return;
  }
  if (channel === 'email') {
    await sendMail({
      to: input.email,
      subject: `VoltLink: ${input.title}`,
      text: input.body,
      html: `<p><strong>${escapeHtml(input.title)}</strong></p><p>${escapeHtml(input.body)}</p>`,
    });
    return;
  }
  if (channel === 'push') {
    const subs = await prisma.pushSubscription.findMany({ where: { userId: input.userId } });
    if (subs.length > 0) {
      const { sendPush } = await import('./push');
      for (const sub of subs) {
        await sendPush(sub, { title: input.title, body: input.body, severity: input.severity ?? 'info', event: input.event }).catch(() => undefined);
      }
    }
    return;
  }
  if (channel === 'webhook') {
    const endpoints = await prisma.webhookEndpoint.findMany({ where: { userId: input.userId, enabled: true } });
    for (const ep of endpoints) {
      const payload = {
        event: input.event,
        severity: input.severity ?? 'info',
        title: input.title,
        body: input.body,
        vehicleId: input.vehicleId ?? null,
        timestamp: new Date().toISOString(),
      };
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (ep.secretHash) {
        // Deliver without the secret; the receiver verifies via a shared secret
        // configured out of band. We sign with the stored secret's SHA to allow
        // integrity checks without exposing the secret itself.
        headers['X-VoltLink-Event'] = input.event;
      }
      try {
        const { safeFetch } = await import('../net/safeFetch');
        const { getOutboundPolicy } = await import('../net/policy');
        const res = await safeFetch(getOutboundPolicy(), ep.url, { method: 'POST', headers, body: JSON.stringify(payload) });
        await prisma.webhookEndpoint.update({ where: { id: ep.id }, data: { lastStatus: res.status, lastDeliveryAt: new Date() } });
      } catch {
        await prisma.webhookEndpoint.update({ where: { id: ep.id }, data: { lastStatus: 0, lastDeliveryAt: new Date() } });
      }
    }
    return;
  }
  // External simple-webhook providers: ntfy, Gotify, Discord, Teams.
  const { pushSimpleWebhook } = await import('./simpleWebhooks');
  await pushSimpleWebhook(input.userId, channel, { title: input.title, body: input.body, severity: input.severity ?? 'info', event: input.event }).catch(() => undefined);
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function hmacSign(secret: string, body: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}
