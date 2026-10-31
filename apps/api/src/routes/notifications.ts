// Notification routes: in-app list, mark read, preferences, webhook
// endpoints, push subscriptions, and external channel URLs.

import { policyRouter, sessionActor } from '../authz/policy';
import { prisma } from '../core/db';
import { audit } from '../core/settings';
import { validateWebhookUrl, setUserChannelUrl, userChannelUrl } from '../notifications/simpleWebhooks';
import { sealJson, openJson, randomToken } from '../core/crypto';

/** G-08: hide token-bearing URL paths; only the scheme and host are shown. */
function maskUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.protocol}//${u.host}/…`;
  } catch {
    return '(invalid)';
  }
}

export const notificationsRouter = policyRouter('/api/v1/notifications');

notificationsRouter.get('/', { auth: 'session', target: { kind: 'none' } }, async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
  const unreadOnly = req.query.unread === 'true';
  const where = { userId: sessionActor(req).userId, ...(unreadOnly ? { readAt: null } : {}) };
  const [rows, total, unread] = await Promise.all([
    prisma.appNotification.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
    prisma.appNotification.count({ where }),
    prisma.appNotification.count({ where: { userId: sessionActor(req).userId, readAt: null } }),
  ]);
  res.json({
    data: {
      items: rows.map((n) => ({
        id: n.id,
        event: n.event,
        severity: n.severity,
        title: n.title,
        body: n.body,
        vehicleId: n.vehicleId ?? undefined,
        vehicleName: n.vehicleName ?? undefined,
        readAt: n.readAt?.toISOString(),
        createdAt: n.createdAt.toISOString(),
      })),
      page,
      pageSize,
      total,
      unread,
    },
  });
});

notificationsRouter.post('/:id/read', { auth: 'session', target: { kind: 'none' } }, async (req, res) => {
  const n = await prisma.appNotification.findUnique({ where: { id: String(req.params.id) } });
  if (!n || n.userId !== sessionActor(req).userId) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Notification not found.' } });
    return;
  }
  await prisma.appNotification.update({ where: { id: n.id }, data: { readAt: new Date() } });
  res.json({ data: { ok: true } });
});

notificationsRouter.post('/read-all', { auth: 'session', target: { kind: 'none' } }, async (req, res) => {
  await prisma.appNotification.updateMany({ where: { userId: sessionActor(req).userId, readAt: null }, data: { readAt: new Date() } });
  res.json({ data: { ok: true } });
});

// ---- Preferences ----

notificationsRouter.get('/preferences', { auth: 'session', target: { kind: 'none' } }, async (req, res) => {
  const prefs = await prisma.notificationPreference.findMany({ where: { userId: sessionActor(req).userId } });
  // G-08: never return raw channel URLs (embedded tokens included) — only
  // a masked display form.
  const channelUrls: Record<string, string> = {};
  for (const key of ['ntfyUrl', 'gotifyUrl', 'discordWebhook', 'teamsWebhook']) {
    const url = await userChannelUrl(sessionActor(req).userId, key);
    channelUrls[key] = url ? maskUrl(url) : '';
  }
  res.json({
    data: {
      prefs: prefs.map((p) => ({ channel: p.channel, event: p.event, severity: p.severity, enabled: p.enabled })),
      channelUrls,
    },
  });
});

notificationsRouter.put('/preferences', { auth: 'session', target: { kind: 'none' } }, async (req, res) => {
  const { channel, event, severity, enabled } = (req.body ?? {}) as { channel?: string; event?: string; severity?: string; enabled?: boolean };
  if (!channel || !event || !severity || typeof enabled !== 'boolean') {
    res.status(400).json({ error: { code: 'VALIDATION', message: 'channel, event, severity, enabled required.' } });
    return;
  }
  await prisma.notificationPreference.upsert({
    where: { userId_channel_event_severity: { userId: sessionActor(req).userId, channel, event, severity } },
    update: { enabled },
    create: { userId: sessionActor(req).userId, channel, event, severity, enabled },
  });
  res.json({ data: { ok: true } });
});

notificationsRouter.put('/channel-urls', { auth: 'session', target: { kind: 'none' } }, async (req, res) => {
  const body = (req.body ?? {}) as Record<string, string | null>;
  const allowed = ['ntfyUrl', 'gotifyUrl', 'discordWebhook', 'teamsWebhook'];
  for (const key of allowed) {
    if (key in body) {
      const v = body[key];
      if (v && !validateWebhookUrl(v)) {
        res.status(400).json({ error: { code: 'VALIDATION', message: `${key} must be a valid http(s) URL.` } });
        return;
      }
      if (v) {
        try {
          const { getOutboundPolicy } = await import('../net/policy');
          const { preflightUrl } = await import('../net/safeFetch');
          await preflightUrl(getOutboundPolicy(), v);
        } catch (err) {
          res.status(422).json({ error: { code: 'URL_BLOCKED', message: (err as Error).message } });
          return;
        }
      }
      await setUserChannelUrl(sessionActor(req).userId, key, v ?? null);
    }
  }
  res.json({ data: { ok: true } });
});

// ---- Webhook endpoints ----

notificationsRouter.get('/webhooks', { auth: 'session', target: { kind: 'none' } }, async (req, res) => {
  const rows = await prisma.webhookEndpoint.findMany({ where: { userId: sessionActor(req).userId }, orderBy: { name: 'asc' } });
  res.json({
    data: rows.map((w) => ({
      id: w.id,
      name: w.name,
      // G-08: never return the raw URL (it may embed a token).
      displayHint: w.displayHint ?? maskUrl(w.url),
      enabled: w.enabled,
      lastStatus: w.lastStatus ?? undefined,
      lastDeliveryAt: w.lastDeliveryAt?.toISOString(),
    })),
  });
});

notificationsRouter.post('/webhooks', { auth: 'session', target: { kind: 'none' } }, async (req, res) => {
  const { name, url } = (req.body ?? {}) as { name?: string; url?: string };
  if (!name || !url || !validateWebhookUrl(url)) {
    res.status(400).json({ error: { code: 'VALIDATION', message: 'Name and a valid http(s) URL are required.' } });
    return;
  }
  try {
    const { getOutboundPolicy } = await import('../net/policy');
    const { preflightUrl } = await import('../net/safeFetch');
    await preflightUrl(getOutboundPolicy(), url);
  } catch (err) {
    res.status(422).json({ error: { code: 'URL_BLOCKED', message: (err as Error).message } });
    return;
  }
  const secret = `whsec_${randomToken(24)}`;
  const events = Array.isArray((req.body as { events?: unknown }).events) ? ((req.body as { events: string[] }).events.slice(0, 64)) : [];
  const w = await prisma.webhookEndpoint.create({
    data: { userId: sessionActor(req).userId, name: name.slice(0, 60), url, events: JSON.parse(JSON.stringify(events)), displayHint: maskUrl(url), secretSealed: sealJson({ current: secret }).ciphertext },
  });
  res.status(201).json({ data: { id: w.id, name: w.name, displayHint: w.displayHint, enabled: w.enabled, secret } });
});

// Rotate the signing secret: the previous one stays valid for 24 h and both
// signatures are sent meanwhile (Standard Webhooks).
notificationsRouter.post('/webhooks/:id/rotate-secret', { auth: 'session', stepUp: {}, target: { kind: 'none' } }, async (req, res) => {
  const w = await prisma.webhookEndpoint.findUnique({ where: { id: String(req.params.id) } });
  if (!w || w.userId !== sessionActor(req).userId) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Webhook not found.' } });
    return;
  }
  const previous = (() => {
    try {
      return w.secretSealed ? openJson<{ current: string }>(w.secretSealed).current : undefined;
    } catch {
      return undefined;
    }
  })();
  const secret = `whsec_${randomToken(24)}`;
  const sealed = sealJson(previous ? { current: secret, previous } : { current: secret });
  await prisma.webhookEndpoint.update({
    where: { id: w.id },
    data: { secretSealed: sealed.ciphertext, previousSecretSealed: previous ? w.secretSealed : null, previousUntil: previous ? new Date(Date.now() + 86_400_000) : null },
  });
  await audit({ actorId: sessionActor(req).userId, action: 'webhook.rotate_secret', entityType: 'webhookEndpoint', entityId: w.id });
  res.json({ data: { ok: true, secret } });
});

notificationsRouter.patch('/webhooks/:id', { auth: 'session', target: { kind: 'none' } }, async (req, res) => {
  const w = await prisma.webhookEndpoint.findUnique({ where: { id: String(req.params.id) } });
  if (!w || w.userId !== sessionActor(req).userId) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Webhook not found.' } });
    return;
  }
  const body = (req.body ?? {}) as { enabled?: boolean };
  await prisma.webhookEndpoint.update({ where: { id: w.id }, data: { enabled: body.enabled ?? w.enabled } });
  res.json({ data: { ok: true } });
});

notificationsRouter.delete('/webhooks/:id', { auth: 'session', target: { kind: 'none' } }, async (req, res) => {
  const w = await prisma.webhookEndpoint.findUnique({ where: { id: String(req.params.id) } });
  if (!w || w.userId !== sessionActor(req).userId) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Webhook not found.' } });
    return;
  }
  await prisma.webhookEndpoint.delete({ where: { id: w.id } });
  res.json({ data: { ok: true } });
});

// ---- Push subscriptions (Web Push) ----

notificationsRouter.put('/push/subscriptions', { auth: 'session', target: { kind: 'none' } }, async (req, res) => {
  const { endpoint, keys } = (req.body ?? {}) as { endpoint?: string; keys?: Record<string, string> };
  if (!endpoint || !keys) {
    res.status(400).json({ error: { code: 'VALIDATION', message: 'endpoint and keys required.' } });
    return;
  }
  await prisma.pushSubscription.upsert({
    where: { userId_endpoint: { userId: sessionActor(req).userId, endpoint } },
    update: { keys: JSON.parse(JSON.stringify(keys)) },
    create: { userId: sessionActor(req).userId, endpoint, keys: JSON.parse(JSON.stringify(keys)) },
  });
  res.json({ data: { ok: true } });
});

notificationsRouter.delete('/push/subscriptions', { auth: 'session', target: { kind: 'none' } }, async (req, res) => {
  const { endpoint } = (req.body ?? {}) as { endpoint?: string };
  if (!endpoint) {
    res.status(400).json({ error: { code: 'VALIDATION', message: 'endpoint required.' } });
    return;
  }
  await prisma.pushSubscription.deleteMany({ where: { endpoint, userId: sessionActor(req).userId } });
  res.json({ data: { ok: true } });
});
