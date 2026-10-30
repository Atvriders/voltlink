// User settings, privacy/retention, data export and account deletion.

import { Router } from 'express';
import { prisma } from '../core/db';
import { requireAuth } from '../auth/middleware';
import { hashPassword, verifyPassword, randomToken } from '../core/crypto';
import { audit } from '../core/settings';
import { getSettingsBundle, setSetting } from '../core/settings';
import { query } from '../core/db';
import { removeCredentials } from '../providers/registry';

export const usersRouter = Router();

usersRouter.use(requireAuth);

usersRouter.get('/settings', async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
  if (!user) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found.' } });
    return;
  }
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
      telemetryRetentionDays: Number(bundle.telemetryRetentionDays || 365),
      locationRetentionDays: Number(bundle.locationRetentionDays || 90),
    },
  });
});

usersRouter.patch('/settings', async (req, res) => {
  const body = (req.body ?? {}) as { units?: string; timezone?: string; theme?: string; presentationMode?: boolean };
  const data: Record<string, unknown> = {};
  if (['metric', 'imperial'].includes(body.units ?? '')) data.units = body.units;
  if (typeof body.timezone === 'string' && /^[A-Za-z_+\-0-9/]{2,40}$/.test(body.timezone)) data.timezone = body.timezone;
  if (typeof body.theme === 'string' && body.theme.length <= 40) data.theme = body.theme;
  if (typeof body.presentationMode === 'boolean') data.presentationMode = body.presentationMode;
  await prisma.user.update({ where: { id: req.user!.id }, data });
  res.json({ data: { ok: true } });
});

usersRouter.post('/change-password', async (req, res) => {
  const { currentPassword, newPassword } = (req.body ?? {}) as { currentPassword?: string; newPassword?: string };
  if (!currentPassword || !newPassword || newPassword.length < 10) {
    res.status(400).json({ error: { code: 'VALIDATION', message: 'Current password and a new password (10+ characters) required.' } });
    return;
  }
  const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
  if (!user || !(await verifyPassword(user.passwordHash, currentPassword))) {
    res.status(403).json({ error: { code: 'BAD_PASSWORD', message: 'Current password is incorrect.' } });
    return;
  }
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(newPassword) } });
  await prisma.userSession.updateMany({ where: { userId: user.id, id: { not: req.user!.sessionId }, revokedAt: null }, data: { revokedAt: new Date() } });
  await audit({ actorId: user.id, action: 'user.change_password', entityType: 'user', entityId: user.id });
  res.json({ data: { ok: true } });
});

// ---- Data export ----

usersRouter.get('/export', async (req, res) => {
  const userId = req.user!.id;
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found.' } });
    return;
  }
  const [vehicles, drives, charges, commands, notifications, automations, places, telemetryCount] = await Promise.all([
    prisma.vehicle.findMany({ where: { ownerId: userId } }),
    prisma.drive.findMany({ where: { vehicle: { ownerId: userId } } }),
    prisma.chargingSession.findMany({ where: { vehicle: { ownerId: userId } } }),
    prisma.vehicleCommand.findMany({ where: { userId } }),
    prisma.appNotification.findMany({ where: { userId }, take: 1000 }),
    prisma.automation.findMany({ where: { userId } }),
    prisma.place.findMany({ where: { userId } }),
    query<{ n: string }>(`SELECT count(*)::text AS n FROM telemetry.telemetry_reading WHERE vehicle_id IN (SELECT id FROM "Vehicle" WHERE "ownerId" = $1)`, [userId]),
  ]);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="voltlink-export.json"');
  res.send(
    JSON.stringify(
      {
        export: 'voltlink',
        version: 1,
        generatedAt: new Date().toISOString(),
        account: { email: user.email, name: user.name, role: user.role, timezone: user.timezone, units: user.units, createdAt: user.createdAt.toISOString() },
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

// ---- Account deletion (personal data removal) ----

usersRouter.post('/delete', async (req, res) => {
  const { password } = (req.body ?? {}) as { password?: string };
  const user = await prisma.user.findUnique({ where: { id: req.user!.id } });
  if (!user) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'User not found.' } });
    return;
  }
  if (!password || !(await verifyPassword(user.passwordHash, password))) {
    res.status(403).json({ error: { code: 'BAD_PASSWORD', message: 'Re-enter your password to delete the account.' } });
    return;
  }
  // Remove encrypted provider credentials and personal data.
  const accounts = await prisma.providerAccount.findMany({ where: { userId: user.id } });
  for (const account of accounts) {
    await removeCredentials(account.id);
  }
  const vehicles = await prisma.vehicle.findMany({ where: { ownerId: user.id }, select: { id: true } });
  await query(`DELETE FROM telemetry.telemetry_reading WHERE vehicle_id = ANY($1)`, [vehicles.map((v) => v.id)]);
  await prisma.providerAccount.updateMany({ where: { userId: user.id }, data: { status: 'revoked', lastError: 'account deleted' } });
  await prisma.vehicle.updateMany({ where: { ownerId: user.id }, data: { active: false } });
  await prisma.userSession.updateMany({ where: { userId: user.id }, data: { revokedAt: new Date() } });
  await prisma.pushSubscription.deleteMany({ where: { userId: user.id } });
  await prisma.webhookEndpoint.deleteMany({ where: { userId: user.id } });
  await prisma.user.update({ where: { id: user.id }, data: { deletedAt: new Date(), email: `deleted-${randomToken(8)}@deleted.invalid` } });
  await audit({ actorId: user.id, action: 'user.delete_account', entityType: 'user', entityId: user.id });
  res.clearCookie('vl_session');
  res.json({ data: { ok: true } });
});

// ---- Demo mode toggle ----

usersRouter.post('/demo-mode', async (req, res) => {
  const { enabled } = (req.body ?? {}) as { enabled?: boolean };
  if (typeof enabled !== 'boolean') {
    res.status(400).json({ error: { code: 'VALIDATION', message: 'enabled required.' } });
    return;
  }
  if (enabled) {
    const { connectDemoAccount } = await import('../providers/registry');
    const { seedDemoWorld } = await import('../telemetry/seed');
    const result = await connectDemoAccount(req.user!.id);
    if (result.vehiclesImported === 0) {
      const vehicles = await prisma.vehicle.findMany({ where: { providerAccountId: result.accountId }, select: { id: true, providerVehicleId: true } });
      await seedDemoWorld(req.user!.id, vehicles);
    }
    res.json({ data: { ok: true, accountId: result.accountId } });
    return;
  }
  await prisma.user.update({ where: { id: req.user!.id }, data: { demoEnabled: false } });
  res.json({ data: { ok: true } });
});

// ---- Retention settings (per-user defaults follow global) ----

usersRouter.patch('/retention', async (req, res) => {
  const body = (req.body ?? {}) as { telemetryRetentionDays?: number; locationRetentionDays?: number };
  if (body.telemetryRetentionDays !== undefined) {
    if (!Number.isInteger(body.telemetryRetentionDays) || body.telemetryRetentionDays < 7 || body.telemetryRetentionDays > 3650) {
      res.status(400).json({ error: { code: 'VALIDATION', message: 'telemetryRetentionDays must be 7–3650.' } });
      return;
    }
    await setSetting('telemetryRetentionDays', String(body.telemetryRetentionDays));
  }
  if (body.locationRetentionDays !== undefined) {
    if (!Number.isInteger(body.locationRetentionDays) || body.locationRetentionDays < 7 || body.locationRetentionDays > 3650) {
      res.status(400).json({ error: { code: 'VALIDATION', message: 'locationRetentionDays must be 7–3650.' } });
      return;
    }
    await setSetting('locationRetentionDays', String(body.locationRetentionDays));
  }
  res.json({ data: { ok: true } });
});
