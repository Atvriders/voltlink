// Notification service: in-app, email, push, ntfy, Gotify, Discord, Teams,
// and generic webhooks — routed by per-user preferences.
// N-DROPPED: every external channel writes to the NotificationOutbox first and
// is delivered by the worker with retries and a dead-letter state. In-app
// notifications and SSE remain synchronous so the UI feels instant, and an
// SMTP failure can never abort telemetry ingest (delivery is fully decoupled).

import crypto from 'node:crypto';
import { prisma } from '../core/db';
import { randomId } from '../core/crypto';
import { ssePublish } from '../core/sse';
import { sendMail } from '../auth/service';
import { enqueue } from '../jobs/queues';
import { PushEndpointGone, VapidRejected, sendPush } from './push';
import { throttled, userChannelUrl, pushSimpleWebhook } from './simpleWebhooks';
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
  /** Restrict 'webhook' delivery to one endpoint (automations). */
  webhookEndpointId?: string;
}

const OUTBOX_CHANNELS = new Set<DeliveryChannel>([
  'email',
  'push',
  'webhook',
  'ntfy',
  'gotify',
  'discord',
  'teams',
]);

export const OUTBOX_MAX_ATTEMPTS = 4;

export async function notify(input: NotifyInput): Promise<void> {
  const severity = input.severity ?? 'info';
  let channels = input.channels;
  if (!channels) {
    const prefs = await prisma.notificationPreference.findMany({
      where: { userId: input.userId, event: input.event, enabled: true },
    });
    channels =
      prefs.length > 0
        ? (prefs.map((p) => p.channel as DeliveryChannel) as DeliveryChannel[])
        : (['in_app'] as DeliveryChannel[]);
  }
  if (!channels.includes('in_app') && !input.force) {
    // in-app is the baseline; every user gets in-app copies
    channels = ['in_app', ...channels];
  }
  const user = await prisma.user.findUnique({ where: { id: input.userId } });
  if (!user || user.deletionRequestedAt || user.suspendedAt) return;

  for (const channel of new Set(channels)) {
    if (channel === 'in_app') {
      await deliverInApp({ ...input, severity });
      continue;
    }
    // N-DROPPED: external channels go through the outbox. The row is the
    // source of truth; the worker owns the actual network I/O.
    if (!OUTBOX_CHANNELS.has(channel)) continue;
    const outbox = await prisma.notificationOutbox.create({
      data: {
        userId: input.userId,
        channel,
        event: input.event,
        severity,
        title: input.title,
        body: input.body,
        vehicleId: input.vehicleId,
      },
    });
    await enqueue('notifications', { outboxId: outbox.id, channel }, { jobId: `n-${outbox.id}` });
  }
  if (channels.includes('in_app')) {
    ssePublish({
      type: 'notification',
      data: { event: input.event, severity, title: input.title },
      userId: input.userId,
    });
  }
}

async function deliverInApp(input: NotifyInput & { severity: Severity }): Promise<void> {
  await prisma.appNotification.create({
    data: {
      userId: input.userId,
      event: input.event,
      severity: input.severity,
      title: input.title,
      body: input.body,
      vehicleId: input.vehicleId,
      vehicleName: input.vehicleName,
      channel: 'in_app',
    },
  });
}

/** Worker entry point for the 'notifications' queue (N-DROPPED). */
export async function processOutboxJob(payload: {
  outboxId: string;
  channel: string;
}): Promise<void> {
  const row = await prisma.notificationOutbox.findUnique({ where: { id: payload.outboxId } });
  if (!row || row.status !== 'pending') return; // already delivered / dead / cancelled
  const user = await prisma.user.findUnique({ where: { id: row.userId } });
  if (!user || user.deletionRequestedAt || user.suspendedAt) {
    await prisma.notificationOutbox.update({
      where: { id: row.id },
      data: { status: 'dead', lastError: 'user gone', deadAt: new Date() },
    });
    return;
  }
  try {
    await deliverChannel(row, user.email);
    await prisma.notificationOutbox.update({
      where: { id: row.id },
      data: { status: 'sent', sentAt: new Date(), attempts: { increment: 1 }, lastError: null },
    });
  } catch (err) {
    const msg = (err as Error).message.slice(0, 500);
    const attempts = row.attempts + 1;
    if (attempts >= OUTBOX_MAX_ATTEMPTS) {
      await prisma.notificationOutbox.update({
        where: { id: row.id },
        data: { status: 'dead', deadAt: new Date(), attempts, lastError: msg },
      });
      console.warn('[voltlink] notification dead-lettered:', payload.outboxId, msg);
      return;
    }
    await prisma.notificationOutbox
      .update({ where: { id: row.id }, data: { attempts, lastError: msg } })
      .catch(() => undefined);
    throw err; // BullMQ retries with backoff
  }
}

interface OutboxRow {
  id: string;
  userId: string;
  channel: string;
  event: string;
  severity: string;
  title: string;
  body: string;
  vehicleId: string | null;
}

async function deliverChannel(row: OutboxRow, email: string): Promise<void> {
  const channel = row.channel as DeliveryChannel;
  const input = {
    userId: row.userId,
    event: row.event as EventType,
    severity: row.severity,
    title: row.title,
    body: row.body,
    vehicleId: row.vehicleId ?? undefined,
  };
  if (channel === 'email') {
    // N-SMTP: failures throw here and are retried by the queue; callers of
    // notify() are long gone, so SMTP can never abort ingest or commands.
    await sendMail({
      to: email,
      subject: `VoltLink: ${input.title}`,
      text: input.body,
      html: `<p><strong>${escapeHtml(input.title)}</strong></p><p>${escapeHtml(input.body)}</p>`,
    });
    return;
  }
  if (channel === 'push') {
    const subs = await prisma.pushSubscription.findMany({ where: { userId: row.userId } });
    for (const sub of subs) {
      try {
        await sendPush(
          { id: sub.id, endpoint: sub.endpoint, keys: sub.keys },
          { ...input, vehicleId: row.vehicleId ?? undefined },
        );
      } catch (err) {
        if (err instanceof PushEndpointGone) {
          // N-PUSH: the browser revoked the subscription — remove it so we
          // stop sending to a dead endpoint.
          await prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => undefined);
          continue;
        }
        if (err instanceof VapidRejected) {
          await prisma.pushSubscription.delete({ where: { id: sub.id } }).catch(() => undefined);
          continue;
        }
        throw err;
      }
    }
    return;
  }
  if (channel === 'webhook') {
    const endpoints = await prisma.webhookEndpoint.findMany({
      where: { userId: row.userId, enabled: true },
    });
    for (const ep of endpoints) {
      const payload = {
        event: input.event,
        severity: input.severity,
        title: input.title,
        body: input.body,
        vehicleId: input.vehicleId ?? null,
        timestamp: new Date().toISOString(),
      };
      // Standard Webhooks: sign with the stored secret (never sent), with the
      // previous secret while it is still within its rotation window.
      const body = JSON.stringify(payload);
      const { outgoingHeaders } = await import('../webhooks/standardWebhooks');
      const { openJson } = await import('../core/crypto');
      const secrets: string[] = [];
      try {
        if (ep.secretSealed) {
          const sealed = openJson<{ current: string; previous?: string }>(ep.secretSealed);
          secrets.push(sealed.current);
          if (sealed.previous && (!ep.previousUntil || ep.previousUntil > new Date()))
            secrets.push(sealed.previous);
        }
      } catch {
        /* unreadable secret: send unsigned once, then record the failure */
      }
      const msgId = `msg_${ep.id}:${randomId()}`;
      const headers = { ...outgoingHeaders(secrets, msgId, body), 'x-voltlink-event': input.event };
      try {
        const { safeFetch } = await import('../net/safeFetch');
        const { getOutboundPolicy } = await import('../net/policy');
        const res = await safeFetch(getOutboundPolicy(), ep.url, { method: 'POST', headers, body });
        await prisma.webhookEndpoint.update({
          where: { id: ep.id },
          data: { lastStatus: res.status, lastDeliveryAt: new Date() },
        });
        if (res.status >= 500) throw new Error(`webhook ${res.status}`);
      } catch (err) {
        await prisma.webhookEndpoint
          .update({ where: { id: ep.id }, data: { lastStatus: 0, lastDeliveryAt: new Date() } })
          .catch(() => undefined);
        throw err;
      }
    }
    return;
  }
  // ntfy / gotify / discord / teams
  if (throttled(row.userId, channel)) return; // dropped by design (rate limit)
  const url = await userChannelUrl(row.userId, providerKey(channel));
  if (!url) return;
  await pushSimpleWebhook(row.userId, channel, {
    title: input.title,
    body: input.body,
    severity: input.severity,
    event: input.event,
  });
}

function providerKey(channel: string): string {
  return (
    { ntfy: 'ntfyUrl', gotify: 'gotifyUrl', discord: 'discordWebhook', teams: 'teamsWebhook' }[
      channel
    ] ?? ''
  );
}

export function escapeHtml(s: string): string {
  // G-10: single quotes too, so user text is safe inside single-quoted attributes.
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function hmacSign(secret: string, body: string): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}
