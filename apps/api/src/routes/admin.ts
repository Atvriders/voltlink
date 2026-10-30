// Admin routes: users, roles, settings, retention, health, and demo controls.

import { policyRouter, sessionActor } from '../authz/policy';
import { prisma } from '../core/db';
import { audit } from '../core/settings';
import { getSettingsBundle, setSetting, getSetting } from '../core/settings';
import { runRetention } from '../telemetry/retention';
import { getQueue } from '../core/queue';
import { sseCount } from '../core/sse';
import { env } from '../core/env';
import { APP_VERSION } from '@voltlink/shared';

export const adminRouter = policyRouter('/api/v1/admin');

// ---- Settings (owner/admin write, others read) ----

adminRouter.get('/settings', { auth: 'session', target: { kind: 'instanceAdmin' } }, async (req, res) => {
  const bundle = await getSettingsBundle();
  res.json({ data: { ...bundle, appVersion: APP_VERSION, demoDefaultEnabled: env.DEMO_DEFAULT_ENABLED } });
});

adminRouter.patch('/settings', { auth: 'session', stepUp: {}, target: { kind: 'instanceAdmin' } }, async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const allowed = ['orgName', 'telemetryRetentionDays', 'locationRetentionDays'];
  for (const key of allowed) {
    if (typeof body[key] === 'string' && body[key]) {
      const v = String(body[key]);
      if (key.endsWith('Days') && (!/^\d+$/.test(v) || Number(v) < 7 || Number(v) > 3650)) {
        res.status(400).json({ error: { code: 'VALIDATION', message: `${key} must be a number of days between 7 and 3650.` } });
        return;
      }
      await setSetting(key, v.slice(0, 100));
    }
  }
  res.json({ data: { ok: true } });
});

// ---- Users ----

adminRouter.get('/users', { auth: 'session', target: { kind: 'instanceAdmin' } }, async (req, res) => {
  const users = await prisma.user.findMany({
    where: { deletionRequestedAt: null },
    orderBy: { createdAt: 'desc' },
    include: { _count: { select: { memberships: true } } },
  });
  res.json({
    data: users.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      isInstanceAdmin: u.isInstanceAdmin,
      suspendedAt: u.suspendedAt?.toISOString() ?? null,
      emailVerified: !!u.emailVerifiedAt,
      totpEnabled: u.totpEnabled,
      membershipCount: u._count.memberships,
      createdAt: u.createdAt.toISOString(),
    })),
  });
});

adminRouter.patch('/users/:id/suspend', { auth: 'session', stepUp: {}, target: { kind: 'instanceAdmin' } }, async (req, res) => {
  const { suspended } = (req.body ?? {}) as { suspended?: boolean };
  if (typeof suspended !== 'boolean') {
    res.status(400).json({ error: { code: 'VALIDATION', message: 'suspended boolean required.' } });
    return;
  }
  const target = await prisma.user.findUnique({ where: { id: String(req.params.id) } });
  if (!target) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found.' } });
    return;
  }
  if (target.isInstanceAdmin && suspended) {
    res.status(400).json({ error: { code: 'VALIDATION', message: 'Instance administrators cannot be suspended.' } });
    return;
  }
  await prisma.$transaction([
    prisma.user.update({
      where: { id: target.id },
      data: { suspendedAt: suspended ? new Date() : null },
    }),
    ...(suspended
      ? [prisma.userSession.updateMany({ where: { userId: target.id, revokedAt: null }, data: { revokedAt: new Date() } })]
      : []),
  ]);
  res.json({ data: { ok: true } });
});

adminRouter.post('/users/:id/mfa-reset', { auth: 'session', stepUp: {}, target: { kind: 'instanceAdmin' } }, async (req, res) => {
  const target = await prisma.user.findUnique({ where: { id: String(req.params.id) } });
  if (!target) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found.' } });
    return;
  }
  await prisma.$transaction([
    prisma.user.update({ where: { id: target.id }, data: { totpEnabled: false, totpSecretSealed: null, totpLastStep: null, totpEnabledAt: null } }),
    prisma.recoveryCode.deleteMany({ where: { userId: target.id } }),
    prisma.appNotification.create({
      data: { userId: target.id, event: 'security', severity: 'warning', title: 'Two-factor authentication reset', body: 'An administrator reset your two-factor authentication. Set it up again in Settings.', channel: 'in_app' },
    }),
  ]);
  await audit({ actorId: sessionActor(req).userId, action: 'admin.mfa_reset', entityType: 'user', entityId: target.id });
  res.json({ data: { ok: true } });
});

// ---- Health ----

adminRouter.get('/health', { auth: 'session', target: { kind: 'instanceAdmin' } }, async (req, res) => {
  let database = 'ok';
  let migrationsCurrent = true;
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    database = 'error';
    migrationsCurrent = false;
  }
  const queue = getQueue();
  const depth = await queue.depth('default').catch(() => -1);
  const workersActive = await prisma.backgroundJob.count({ where: { status: 'processing', lockedAt: { gt: new Date(Date.now() - 60_000) } } }).then((n) => n > 0);
  const freshSnap = await prisma.vehicleSnapshot.findFirst({ where: { fetchedAt: { gt: new Date(Date.now() - 15 * 60000) } } });
  res.json({
    data: {
      process: 'web',
      version: APP_VERSION,
      uptimeSec: Math.round(process.uptime()),
      database,
      redis: env.REDIS_URL ? ((await queue.ping().catch(() => false)) ? 'ok' : 'error') : 'unused',
      migrationsCurrent,
      queueDepth: depth,
      workersActive,
      schedulerActive: (await getSetting('schedulerBeat')) === '1' || env.NODE_ENV === 'test',
      telemetryFresh: !!freshSnap,
      memoryMb: Math.round(process.memoryUsage().rss / 1048576),
      sseClients: sseCount(),
    },
  });
});

adminRouter.post('/retention/run', { auth: 'session', target: { kind: 'instanceAdmin' } }, async (_req, res) => {
  const result = await runRetention();
  res.json({ data: result });
});

adminRouter.post('/queue/:queueName/flush', { auth: 'session', target: { kind: 'instanceAdmin' } }, async (req, res) => {
  const queueName = String(req.params.queueName).slice(0, 40);
  const n = await prisma.backgroundJob.updateMany({ where: { queue: queueName, status: 'dead' }, data: { status: 'pending', attempts: 0, runAt: new Date() } });
  res.json({ data: { requeued: n.count } });
});

adminRouter.get('/queue/dead', { auth: 'session', target: { kind: 'instanceAdmin' } }, async (req, res) => {
  const rows = await prisma.backgroundJob.findMany({ where: { status: 'dead' }, orderBy: { doneAt: 'desc' }, take: 50 });
  res.json({
    data: rows.map((r) => ({ id: r.id, queue: r.queue, error: r.error ?? '', attempts: r.attempts, doneAt: r.doneAt?.toISOString(), payload: (() => { try { return JSON.parse(r.payload); } catch { return null; } })() })),
  });
});
