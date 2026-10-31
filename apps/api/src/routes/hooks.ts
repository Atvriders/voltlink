// Inbound webhooks (Z-INBOUNDWH, guide 03 §6): POST /api/v1/hooks/automations/
// :publicId with Standard Webhooks headers. Mounted before express.json() so
// the raw body is available for signature verification; no session, no CSRF.

import { Router, type Request, type Response } from 'express';
import express from 'express';
import { prisma } from '../core/db';
import { openJson } from '../core/crypto';
import { verifyIncoming } from '../webhooks/standardWebhooks';
import { dispatchTrigger } from '../automations/engine';
import { audit } from '../core/settings';

export const hooksRouter = Router();

hooksRouter.post(
  '/automations/:publicId',
  express.raw({ type: '*/*', limit: '64kb' }),
  async (req: Request, res: Response) => {
    const publicId = String(req.params.publicId);
    const hook = await prisma.inboundWebhook.findUnique({
      where: { publicId },
      include: { automation: true },
    });
    if (!hook) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Unknown webhook.' } });
      return;
    }
    const secrets: string[] = [];
    try {
      const sealed = openJson<{ current: string; previous?: string }>(hook.secretSealed);
      secrets.push(sealed.current);
      if (sealed.previous) secrets.push(sealed.previous);
    } catch {
      res.status(500).json({ error: { code: 'CONFIG', message: 'Webhook secret is unreadable.' } });
      return;
    }
    const raw = req.body instanceof Buffer ? req.body : Buffer.from('');
    const v = verifyIncoming(secrets, req.headers, raw);
    if (!v.ok) {
      res
        .status(401)
        .json({ error: { code: 'SIGNATURE', message: `Webhook signature failed: ${v.reason}.` } });
      return;
    }
    // Deduplicate by message id (stable across retries).
    const fresh = await prisma.inboundWebhookReceipt.createMany({
      data: [{ hookId: hook.id, messageId: v.msgId }],
      skipDuplicates: true,
    });
    if (fresh.count === 0) {
      res.json({ data: { ok: true, replayed: true } });
      return;
    }
    await prisma.inboundWebhook.update({
      where: { id: hook.id },
      data: { lastReceivedAt: new Date() },
    });
    const body: unknown = (() => {
      try {
        return JSON.parse(raw.toString('utf8') || '{}');
      } catch {
        return { raw: raw.toString('utf8').slice(0, 8192) };
      }
    })();
    const count = await dispatchTrigger({
      type: 'webhook',
      userId: hook.userId,
      vehicleId: hook.automation.vehicleId ?? undefined,
      data: body as Record<string, unknown>,
    }).catch(() => 0);
    await audit({
      actorId: null,
      organizationId: hook.automation.organizationId,
      action: 'inbound_webhook.received',
      entityType: 'inboundWebhook',
      entityId: hook.id,
      details: { matched: count },
    });
    res.json({ data: { ok: true, matched: count } });
  },
);
