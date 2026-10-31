// User settings, activity, export and account deletion. Retention is per
// organization now (Z-RETENTION): the old global /retention route is gone.

import { prisma, query } from '../core/db';
import { policyRouter, sessionActor } from '../authz/policy';
import { AccessDenied } from '../authz/errors';
import { hashPassword, verifyPassword, randomToken } from '../core/crypto';
import { audit, getSettingsBundle } from '../core/settings';
import { sseRevokeUser } from '../core/sse';
import { getQueue } from '../core/queue';
import { removeCredentials } from '../providers/registry';
import { sha256hex } from '../core/crypto';

export const usersRouter = policyRouter('/api/v1/users');

const self: { auth: 'session'; stepUp?: { possession?: boolean }; target: { kind: 'self' } } = {
  auth: 'session',
  target: { kind: 'self' },
};

usersRouter.get('/settings', { auth: 'session', target: { kind: 'self' } }, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: sessionActor(req).userId } });
  if (!user) throw new AccessDenied('NOT_FOUND', 'User not found.', 404);
  const bundle = await getSettingsBundle();
  res.json({
    data: {
      units: user.units,
      timezone: user.timezone,
      locale: user.locale,
      theme: user.theme,
      demoMode: user.demoEnabled,
      presentationMode: user.presentationMode,
      orgName: bundle.orgName,
    },
  });
});

usersRouter.patch('/settings', { auth: 'session', target: { kind: 'self' } }, async (req, res) => {
  const body = (req.body ?? {}) as {
    units?: string;
    timezone?: string;
    theme?: string;
    presentationMode?: boolean;
  };
  const data: Record<string, unknown> = {};
  if (['metric', 'imperial'].includes(body.units ?? '')) data.units = body.units;
  if (typeof body.timezone === 'string' && /^[A-Za-z_+\-0-9/]{2,40}$/.test(body.timezone))
    data.timezone = body.timezone;
  if (typeof body.theme === 'string' && body.theme.length <= 40) data.theme = body.theme;
  if (typeof body.presentationMode === 'boolean') data.presentationMode = body.presentationMode;
  await prisma.user.update({ where: { id: sessionActor(req).userId }, data });
  res.json({ data: { ok: true } });
});

usersRouter.post(
  '/change-password',
  { auth: 'session', stepUp: {}, target: { kind: 'self' } },
  async (req, res) => {
    const actor = sessionActor(req);
    const { currentPassword, newPassword } = (req.body ?? {}) as {
      currentPassword?: string;
      newPassword?: string;
    };
    if (!currentPassword || !newPassword || newPassword.length < 10) {
      res
        .status(400)
        .json({
          error: {
            code: 'VALIDATION',
            message: 'Current password and a new password (10+ characters) required.',
          },
        });
      return;
    }
    const user = await prisma.user.findUnique({ where: { id: actor.userId } });
    if (!user || !(await verifyPassword(user.passwordHash, currentPassword))) {
      res
        .status(403)
        .json({ error: { code: 'BAD_PASSWORD', message: 'Current password is incorrect.' } });
      return;
    }
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(newPassword) },
    });
    await prisma.userSession.updateMany({
      where: { userId: user.id, id: { not: actor.sessionId }, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await audit({
      actorId: user.id,
      action: 'user.change_password',
      entityType: 'user',
      entityId: user.id,
    });
    res.json({ data: { ok: true } });
  },
);

// ---- Data export ----

usersRouter.get('/export', { auth: 'session', target: { kind: 'self' } }, async (req, res) => {
  const userId = sessionActor(req).userId;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { memberships: true },
  });
  if (!user) throw new AccessDenied('NOT_FOUND', 'User not found.', 404);
  const orgIds = user.memberships.map((m) => m.organizationId);
  const [vehicles, drives, charges, commands, notifications, automations, places] =
    await Promise.all([
      prisma.vehicle.findMany({ where: { organizationId: { in: orgIds } } }),
      prisma.drive.findMany({ where: { vehicle: { organizationId: { in: orgIds } } } }),
      prisma.chargingSession.findMany({ where: { vehicle: { organizationId: { in: orgIds } } } }),
      prisma.vehicleCommand.findMany({ where: { userId } }),
      prisma.appNotification.findMany({ where: { userId }, take: 1000 }),
      prisma.automation.findMany({ where: { userId } }),
      prisma.place.findMany({ where: { organizationId: { in: orgIds } } }),
    ]);
  const telemetryCount = await query<{ n: string }>(
    `SELECT count(*)::text AS n FROM telemetry.telemetry_reading WHERE vehicle_id IN (SELECT id FROM "Vehicle" WHERE "organizationId" = ANY($1::text[]))`,
    [orgIds],
  );
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="voltlink-export.json"');
  res.send(
    JSON.stringify(
      {
        export: 'voltlink',
        version: 1,
        generatedAt: new Date().toISOString(),
        account: {
          email: user.email,
          name: user.name,
          timezone: user.timezone,
          units: user.units,
          createdAt: user.createdAt.toISOString(),
        },
        vehicles,
        drives,
        chargingSessions: charges,
        commands,
        notifications,
        automations,
        places,
        telemetryPointCount: Number(telemetryCount.rows[0]?.n ?? 0),
      },
      null,
      2,
    ),
  );
});

// ---- Activity (audit trail) ----

usersRouter.get('/me/activity', { auth: 'session', target: { kind: 'self' } }, async (req, res) => {
  const rows = await prisma.auditLog.findMany({
    where: { actorId: sessionActor(req).userId },
    orderBy: { createdAt: 'desc' },
    take: 200,
  });
  res.json({
    data: rows.map((r) => ({
      id: r.id,
      action: r.action,
      entityType: r.entityType,
      entityId: r.entityId,
      createdAt: r.createdAt.toISOString(),
    })),
  });
});

// ---- Account deletion (Z-DELETE: real deletion via a queued job) ----

usersRouter.post(
  '/me/delete',
  { auth: 'session', stepUp: {}, target: { kind: 'self' } },
  async (req, res) => {
    const actor = sessionActor(req);
    const { confirm } = (req.body ?? {}) as { confirm?: string };
    if (confirm !== 'DELETE') {
      res
        .status(400)
        .json({ error: { code: 'VALIDATION', message: "Send { confirm: 'DELETE' }." } });
      return;
    }
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: actor.userId },
      include: { memberships: true },
    });
    for (const m of user.memberships) {
      if (m.role === 'OWNER') {
        const others = await prisma.membership.count({
          where: { organizationId: m.organizationId, status: 'ACTIVE', userId: { not: user.id } },
        });
        if (others > 0) {
          res
            .status(409)
            .json({
              error: {
                code: 'OWNERSHIP_TRANSFER_REQUIRED',
                message: 'Transfer ownership of your organization before deleting the account.',
              },
            });
          return;
        }
      }
    }
    const accounts = await prisma.providerAccount.findMany({
      where: { organization: { memberships: { some: { userId: user.id } } } },
    });
    await prisma.user.update({ where: { id: user.id }, data: { deletionRequestedAt: new Date() } });
    await prisma.userSession.updateMany({
      where: { userId: user.id },
      data: { revokedAt: new Date() },
    });
    sseRevokeUser(user.id);
    await prisma.apiKey.updateMany({ where: { userId: user.id }, data: { revokedAt: new Date() } });
    await prisma.pushSubscription.deleteMany({ where: { userId: user.id } });
    await prisma.webhookEndpoint.deleteMany({ where: { userId: user.id } });
    for (const account of accounts) await removeCredentials(account.id);
    await getQueue().enqueue('account-deletion', { userId: user.id });
    await audit({
      actorId: user.id,
      action: 'user.request_delete',
      entityType: 'user',
      entityId: user.id,
    });
    res.clearCookie('vl_session');
    res
      .status(202)
      .json({
        data: {
          providerRevocation: accounts.map(() => ({
            message: 'See docs/PRIVACY.md for provider revocation links.',
          })),
        },
      });
  },
);

// ---- Demo mode toggle ----

usersRouter.post(
  '/demo-mode',
  { auth: 'session', target: { kind: 'org', own: true, perm: 'vehicles.manage' } },
  async (req, res) => {
    const actor = sessionActor(req);
    const organizationId = req.access!.organizationId!;
    const { enabled } = (req.body ?? {}) as { enabled?: boolean };
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ error: { code: 'VALIDATION', message: 'enabled required.' } });
      return;
    }
    if (enabled) {
      const { connectDemoAccount } = await import('../providers/registry');
      const { seedDemoWorld } = await import('../telemetry/seed');
      const result = await connectDemoAccount(organizationId, actor.userId);
      if (result.vehiclesImported === 0) {
        const vehicles = await prisma.vehicle.findMany({
          where: { providerAccountId: result.accountId },
          select: { id: true, providerVehicleId: true },
        });
        await seedDemoWorld(organizationId, actor.userId, vehicles);
      }
      await prisma.user.update({ where: { id: actor.userId }, data: { demoEnabled: true } });
      res.json({ data: { ok: true, accountId: result.accountId } });
      return;
    }
    await prisma.user.update({ where: { id: actor.userId }, data: { demoEnabled: false } });
    res.json({ data: { ok: true } });
  },
);

// The old global retention route is gone (Z-RETENTION): it must 404.
usersRouter.patch(
  '/retention',
  { auth: 'session', target: { kind: 'self' } },
  async (_req, res) => {
    res
      .status(404)
      .json({
        error: {
          code: 'NOT_FOUND',
          message:
            'Retention is configured per organization at PATCH /api/v1/orgs/:orgId/settings/retention.',
        },
      });
  },
);

void self;
void sha256hex;
void randomToken;
