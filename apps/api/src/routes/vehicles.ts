// Vehicle routes: listing, state, places, geofences, privacy zones, and
// per-vehicle grants. Organization-scoped; never trusts client-supplied ids.

import { z } from 'zod';
import { prisma } from '../core/db';
import { env } from '../core/env';
import { sha256hex, randomToken } from '../core/crypto';
import { policyRouter, sessionActor, type RoutePolicy } from '../authz/policy';
import { invalidateZonesForOrg } from '../privacy/zones';
import { accessibleVehicleIds } from '../authz/access';
import { AccessDenied } from '../authz/errors';
import { ingestVehicleState } from '../telemetry/ingest';
import { getProvider, buildContext } from '../providers/registry';
import { getQueue } from '../core/queue';
import { audit } from '../core/settings';
import { sendMail } from '../auth/service';
import { computeFreshness } from '@voltlink/shared';

export const vehiclesRouter = policyRouter('/api/v1/vehicles');

function toVehicleWithState(v: {
  id: string;
  displayName: string;
  provider: string;
  providerVehicleId: string;
  vehicleClass: string;
  make: string | null;
  model: string | null;
  year: number | null;
  exteriorColor: string | null;
  wheelStyle: string | null;
  labels: string[];
  vinLast4: string | null;
  capabilities: unknown;
  demo: boolean;
  organizationId: string;
  providerAccountId: string;
  createdAt: Date;
  updatedAt: Date;
  snapshot: { state: unknown; fetchedAt: Date; freshness: string } | null;
  providerAccount: { label: string };
}) {
  return {
    id: v.id,
    displayName: v.displayName,
    provider: v.provider,
    // G-12: a 17-character VIN never reaches browsers — only its last four.
    providerVehicleId: /^[A-HJ-NPR-Z0-9]{17}$/i.test(v.providerVehicleId)
      ? `VIN…${v.providerVehicleId.slice(-4)}`
      : v.providerVehicleId,
    vehicleClass: v.vehicleClass,
    make: v.make ?? undefined,
    model: v.model ?? undefined,
    year: v.year ?? undefined,
    exteriorColor: v.exteriorColor ?? undefined,
    wheelStyle: v.wheelStyle ?? undefined,
    labels: v.labels ?? [],
    vinLast4: v.vinLast4 ?? undefined,
    capabilities: (v.capabilities ?? []) as string[],
    demo: v.demo,
    organizationId: v.organizationId,
    providerAccountId: v.providerAccountId,
    providerAccountLabel: v.providerAccount.label,
    groupIds: [] as string[],
    createdAt: v.createdAt.toISOString(),
    state: v.snapshot
      ? {
          ...(v.snapshot.state as object),
          // F-FRESH: recompute at read time so the label reflects the true age.
          freshness: computeFreshness(
            {
              status: (v.snapshot.state as { status?: never })?.status,
              fetchedAt: v.snapshot.fetchedAt.toISOString(),
              liveAtIngest: (v.snapshot.state as { liveAtIngest?: boolean })?.liveAtIngest,
            },
            Date.now(),
          ),
          fetchedAt: v.snapshot.fetchedAt.toISOString(),
        }
      : null,
  };
}

const listPolicy: RoutePolicy = {
  auth: 'any',
  apiScope: 'vehicles:read',
  target: { kind: 'none' },
};

// ---- Listing ----

vehiclesRouter.get('/', listPolicy, async (req, res) => {
  const actor = req.actor!;
  const ids = await accessibleVehicleIds(actor, 'vehicles.read');
  const vehicles = await prisma.vehicle.findMany({
    where: { id: { in: ids }, active: true },
    include: { snapshot: true, providerAccount: true },
    orderBy: { displayName: 'asc' },
  });
  const groupLinks = await prisma.fleetGroupVehicle.findMany({ where: { vehicleId: { in: ids } } });
  const groups = new Map<string, string[]>();
  for (const g of groupLinks)
    groups.set(g.vehicleId, [...(groups.get(g.vehicleId) ?? []), g.fleetGroupId]);
  res.json({
    data: vehicles.map((v) => ({ ...toVehicleWithState(v), groupIds: groups.get(v.id) ?? [] })),
  });
});

// ---- Privacy zones (privacy.manage; retroactive redaction enqueued in Phase 2
// privacy work) ----

vehiclesRouter.get(
  '/privacy-zones',
  { auth: 'session', target: { kind: 'org', own: true, perm: 'privacy.manage' } },
  async (req, res) => {
    const orgId = req.access!.organizationId!;
    const rows = await prisma.privacyZone.findMany({
      where: { organizationId: orgId },
      orderBy: { name: 'asc' },
    });
    res.json({ data: rows });
  },
);

const zoneSchema = z.object({
  name: z.string().min(1).max(60),
  lat: z.number(),
  lon: z.number(),
  radiusM: z.number().min(10).max(10000),
  enabled: z.boolean().optional(),
});

vehiclesRouter.post(
  '/privacy-zones',
  { auth: 'session', target: { kind: 'org', own: true, perm: 'privacy.manage' } },
  async (req, res) => {
    const orgId = req.access!.organizationId!;
    const parsed = zoneSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: { code: 'VALIDATION', message: 'Privacy zone needs name, lat, lon.' } });
      return;
    }
    const z = await prisma.privacyZone.create({
      data: { organizationId: orgId, createdById: sessionActor(req).userId, ...parsed.data },
    });
    invalidateZonesForOrg(orgId);
    if (z.enabled)
      await getQueue().enqueue('privacy-redaction', { zoneId: z.id }, { delayMs: 60_000 });
    await audit({
      actorId: sessionActor(req).userId,
      action: 'privacy.zone_created',
      entityType: 'privacyZone',
      entityId: z.id,
    });
    res.status(201).json({ data: z });
  },
);

vehiclesRouter.patch(
  '/privacy-zones/:id',
  {
    auth: 'session',
    target: { kind: 'resource', resource: 'privacyZone', from: 'param:id', perm: 'privacy.manage' },
  },
  async (req, res) => {
    const zone = req.access!.resource!;
    const body = (req.body ?? {}) as {
      enabled?: boolean;
      name?: string;
      radiusM?: number;
      lat?: number;
      lon?: number;
    };
    const data: Record<string, unknown> = {};
    if (typeof body.enabled === 'boolean') data.enabled = body.enabled;
    if (typeof body.name === 'string' && body.name.trim())
      data.name = body.name.trim().slice(0, 60);
    if (typeof body.radiusM === 'number' && body.radiusM >= 10 && body.radiusM <= 10000)
      data.radiusM = body.radiusM;
    if (typeof body.lat === 'number' && body.lat >= -90 && body.lat <= 90) data.lat = body.lat;
    if (typeof body.lon === 'number' && body.lon >= -180 && body.lon <= 180) data.lon = body.lon;
    const updated = await prisma.privacyZone.update({ where: { id: zone.id }, data });
    invalidateZonesForOrg(updated.organizationId);
    // Enabling, moving or enlarging re-runs redaction (idempotent; the 60 s
    // delay exceeds the ingest cache TTL). Shrinking never restores data.
    if (
      updated.enabled &&
      ('enabled' in data || 'lat' in data || 'lon' in data || 'radiusM' in data)
    ) {
      await getQueue().enqueue('privacy-redaction', { zoneId: zone.id }, { delayMs: 60_000 });
    }
    await audit({
      actorId: sessionActor(req).userId,
      action: 'privacy.zone_updated',
      entityType: 'privacyZone',
      entityId: zone.id,
    });
    res.json({ data: { ok: true } });
  },
);

vehiclesRouter.delete(
  '/privacy-zones/:id',
  {
    auth: 'session',
    target: { kind: 'resource', resource: 'privacyZone', from: 'param:id', perm: 'privacy.manage' },
  },
  async (req, res) => {
    await prisma.privacyZone.delete({ where: { id: req.access!.resource!.id } });
    res.json({ data: { ok: true } });
  },
);

// ---- Single vehicle ----

vehiclesRouter.get(
  '/:id',
  {
    auth: 'any',
    apiScope: 'vehicles:read',
    target: { kind: 'vehicle', from: 'param:id', perm: 'vehicles.read' },
  },
  async (req, res) => {
    const vehicle = await prisma.vehicle.findUnique({
      where: { id: req.access!.vehicle!.id },
      include: { snapshot: true, providerAccount: true },
    });
    if (!vehicle) throw new AccessDenied('NOT_FOUND', 'Vehicle not found.', 404);
    res.json({ data: toVehicleWithState(vehicle) });
  },
);

vehiclesRouter.get(
  '/:id/state',
  {
    auth: 'any',
    apiScope: 'vehicles:read',
    target: { kind: 'vehicle', from: 'param:id', perm: 'vehicles.read' },
  },
  async (req, res) => {
    const vehicle = await prisma.vehicle.findUnique({
      where: { id: req.access!.vehicle!.id },
      include: { snapshot: true },
    });
    if (!vehicle) throw new AccessDenied('NOT_FOUND', 'Vehicle not found.', 404);
    res.json({ data: vehicle.snapshot?.state ?? null });
  },
);

/** Refresh state on demand (rate limited by the queue dedupe). */
vehiclesRouter.post(
  '/:id/refresh',
  {
    auth: 'any',
    apiScope: 'vehicles:read',
    target: { kind: 'vehicle', from: 'param:id', perm: 'vehicles.read' },
  },
  async (req, res) => {
    const vehicle = await prisma.vehicle.findUnique({
      where: { id: req.access!.vehicle!.id },
      include: { providerAccount: true },
    });
    if (!vehicle) throw new AccessDenied('NOT_FOUND', 'Vehicle not found.', 404);
    if (vehicle.demo) {
      const ctx = await buildContext(vehicle.providerAccount);
      const result = await getProvider('demo').fetchState(ctx, vehicle.providerVehicleId);
      await ingestVehicleState(
        vehicle as never,
        {
          ...(result.state as Record<string, unknown>),
          vehicleId: vehicle.id,
          provider: 'demo',
          providerVehicleId: vehicle.providerVehicleId,
          fetchedAt: new Date().toISOString(),
        } as never,
        { live: true },
      );
      res.json({ data: { queued: false } });
      return;
    }
    await getQueue().enqueue(
      'telemetry',
      {
        accountId: vehicle.providerAccountId,
        vehicleId: vehicle.id,
        providerVehicleId: vehicle.providerVehicleId,
      },
      { dedupeKey: `refresh:${vehicle.id}:${Math.floor(Date.now() / 30_000)}` },
    );
    res.json({ data: { queued: true } });
  },
);

vehiclesRouter.patch(
  '/:id',
  { auth: 'session', target: { kind: 'vehicle', from: 'param:id', perm: 'vehicles.manage' } },
  async (req, res) => {
    const vehicle = req.access!.vehicle!;
    const body = (req.body ?? {}) as {
      displayName?: string;
      exteriorColor?: string;
      labels?: string[];
    };
    const data: Record<string, unknown> = {};
    if (typeof body.displayName === 'string' && body.displayName.trim())
      data.displayName = body.displayName.trim().slice(0, 60);
    if (typeof body.exteriorColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(body.exteriorColor))
      data.exteriorColor = body.exteriorColor;
    if (Array.isArray(body.labels))
      data.labels = body.labels
        .filter((l) => typeof l === 'string')
        .map((l) => l.trim().slice(0, 32))
        .filter(Boolean)
        .slice(0, 8);
    if (Object.keys(data).length > 0)
      await prisma.vehicle.update({ where: { id: vehicle.id }, data });
    res.json({ data: { ok: true } });
  },
);

// ---- Grants (NEW-02: sharing goes through step-up and invitations) ----

vehiclesRouter.get(
  '/:id/shares',
  { auth: 'session', target: { kind: 'vehicle', from: 'param:id', perm: 'vehicles.share' } },
  async (req, res) => {
    const rows = await prisma.vehicleGrant.findMany({
      where: { vehicleId: req.access!.vehicle!.id },
    });
    const users = await prisma.user.findMany({
      where: { id: { in: rows.map((r) => r.userId) } },
      select: { id: true, email: true, name: true },
    });
    const byId = new Map(users.map((u) => [u.id, u]));
    res.json({
      data: rows.map((r) => ({
        id: r.id,
        userId: r.userId,
        userEmail: byId.get(r.userId)?.email ?? 'unknown',
        level: r.level.toLowerCase(),
        allowHighRisk: r.allowHighRisk,
        expiresAt: r.expiresAt?.toISOString() ?? undefined,
      })),
    });
  },
);

vehiclesRouter.post(
  '/:id/shares',
  {
    auth: 'session',
    verifiedEmail: true,
    stepUp: {},
    target: { kind: 'vehicle', from: 'param:id', perm: 'vehicles.share' },
  },
  async (req, res) => {
    const vehicle = req.access!.vehicle!;
    const actor = sessionActor(req);
    const { email, level, allowHighRisk } = (req.body ?? {}) as {
      email?: string;
      level?: string;
      allowHighRisk?: boolean;
    };
    if (!email || !['viewer', 'driver', 'manager'].includes(level ?? '')) {
      res.status(400).json({
        error: {
          code: 'VALIDATION',
          message: 'email and level (viewer|driver|manager) required.',
        },
      });
      return;
    }
    const target = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
    const token = randomToken();
    await prisma.invitation.create({
      data: {
        organizationId: vehicle.organizationId,
        kind: 'vehicle_share',
        email: email.trim().toLowerCase(),
        vehicleId: vehicle.id,
        grantLevel: (level as 'VIEWER' | 'DRIVER' | 'MANAGER').toUpperCase() as never,
        allowHighRisk: allowHighRisk === true,
        tokenHash: sha256hex(token),
        invitedById: actor.userId,
        deliveredByEmail: !!env.SMTP_URL,
        expiresAt: new Date(Date.now() + 7 * 86_400_000),
      },
    });
    if (target && target.id !== actor.userId) {
      await prisma.vehicleGrant.upsert({
        where: { vehicleId_userId: { vehicleId: vehicle.id, userId: target.id } },
        update: {
          level: (level as 'VIEWER' | 'DRIVER' | 'MANAGER').toUpperCase() as never,
          allowHighRisk: allowHighRisk === true,
          grantedById: actor.userId,
        },
        create: {
          vehicleId: vehicle.id,
          userId: target.id,
          level: (level as 'VIEWER' | 'DRIVER' | 'MANAGER').toUpperCase() as never,
          allowHighRisk: allowHighRisk === true,
          grantedById: actor.userId,
        },
      });
    } else if (target) {
      const link = `${env.PUBLIC_URL}/invite?token=${token}`;
      await sendMail({
        to: email.trim().toLowerCase(),
        subject: 'VoltLink vehicle invite',
        text: `You were invited to access a vehicle in VoltLink. Open ${link} to accept.`,
        html: `<p>You were invited to access a vehicle in VoltLink.</p><p><a href="${link}">Accept invitation</a></p>`,
      });
    }
    await audit({
      actorId: actor.userId,
      action: 'vehicle.share_invited',
      entityType: 'vehicle',
      entityId: vehicle.id,
    });
    res.status(202).json({ data: { status: 'invited' } });
  },
);

vehiclesRouter.delete(
  '/:id/shares/:shareId',
  { auth: 'session', target: { kind: 'vehicle', from: 'param:id', perm: 'vehicles.share' } },
  async (req, res) => {
    const vehicle = req.access!.vehicle!;
    const row = await prisma.vehicleGrant.findUnique({ where: { id: String(req.params.shareId) } });
    if (!row || row.vehicleId !== vehicle.id)
      throw new AccessDenied('NOT_FOUND', 'Share not found.', 404);
    await prisma.vehicleGrant.delete({ where: { id: row.id } });
    await audit({
      actorId: sessionActor(req).userId,
      action: 'vehicle.share_revoked',
      entityType: 'vehicle',
      entityId: vehicle.id,
    });
    res.json({ data: { ok: true } });
  },
);

// ---- Places (fleet.read / fleet.manage per organization) ----

vehiclesRouter.get(
  '/places/all',
  { auth: 'session', target: { kind: 'org', own: true, perm: 'fleet.read' } },
  async (req, res) => {
    const orgId = req.access!.organizationId!;
    const places = await prisma.place.findMany({
      where: { organizationId: orgId },
      orderBy: { name: 'asc' },
    });
    res.json({ data: places });
  },
);

const placeSchema = z.object({
  name: z.string().min(1).max(60),
  type: z.string().min(1).max(30),
  lat: z.number(),
  lon: z.number(),
  radiusM: z.number().min(10).max(5000).optional(),
});

vehiclesRouter.post(
  '/places/all',
  { auth: 'session', target: { kind: 'org', own: true, perm: 'fleet.manage' } },
  async (req, res) => {
    const orgId = req.access!.organizationId!;
    const parsed = placeSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json({ error: { code: 'VALIDATION', message: 'Place needs name, type, lat, lon.' } });
      return;
    }
    const place = await prisma.place.create({
      data: {
        organizationId: orgId,
        createdById: sessionActor(req).userId,
        ...parsed.data,
        radiusM: parsed.data.radiusM ?? 100,
      },
    });
    res.status(201).json({ data: place });
  },
);

vehiclesRouter.patch(
  '/places/all/:id',
  {
    auth: 'session',
    target: { kind: 'resource', resource: 'place', from: 'param:id', perm: 'fleet.manage' },
  },
  async (req, res) => {
    const place = req.access!.resource!;
    const body = (req.body ?? {}) as {
      name?: string;
      type?: string;
      lat?: number;
      lon?: number;
      radiusM?: number;
    };
    const data: Record<string, unknown> = {};
    if (typeof body.name === 'string' && body.name.trim())
      data.name = body.name.trim().slice(0, 60);
    if (typeof body.type === 'string' && body.type.trim())
      data.type = body.type.trim().slice(0, 30);
    if (typeof body.lat === 'number') data.lat = body.lat;
    if (typeof body.lon === 'number') data.lon = body.lon;
    if (typeof body.radiusM === 'number') data.radiusM = body.radiusM;
    await prisma.place.update({ where: { id: place.id }, data });
    res.json({ data: { ok: true } });
  },
);

vehiclesRouter.delete(
  '/places/all/:id',
  {
    auth: 'session',
    target: { kind: 'resource', resource: 'place', from: 'param:id', perm: 'fleet.manage' },
  },
  async (req, res) => {
    await prisma.place.delete({ where: { id: req.access!.resource!.id } });
    res.json({ data: { ok: true } });
  },
);

// ---- Geofences ----

vehiclesRouter.get(
  '/geofences/all',
  { auth: 'session', target: { kind: 'org', own: true, perm: 'fleet.read' } },
  async (req, res) => {
    const orgId = req.access!.organizationId!;
    const rows = await prisma.geofence.findMany({
      where: { organizationId: orgId },
      orderBy: { name: 'asc' },
    });
    res.json({
      data: rows.map((g) => ({ ...g, lastTriggeredAt: g.lastTriggeredAt?.toISOString() })),
    });
  },
);

const fenceSchema = z.object({
  name: z.string().min(1).max(60),
  lat: z.number(),
  lon: z.number(),
  radiusM: z.number().min(10).max(10000),
  alertOn: z.enum(['enter', 'leave', 'both']),
});

vehiclesRouter.post(
  '/geofences/all',
  { auth: 'session', target: { kind: 'org', own: true, perm: 'fleet.manage' } },
  async (req, res) => {
    const orgId = req.access!.organizationId!;
    const parsed = fenceSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: {
          code: 'VALIDATION',
          message: 'Geofence needs name, lat, lon, radiusM, alertOn.',
        },
      });
      return;
    }
    const g = await prisma.geofence.create({
      data: { organizationId: orgId, createdById: sessionActor(req).userId, ...parsed.data },
    });
    res.status(201).json({ data: g });
  },
);

vehiclesRouter.patch(
  '/geofences/all/:id',
  {
    auth: 'session',
    target: { kind: 'resource', resource: 'geofence', from: 'param:id', perm: 'fleet.manage' },
  },
  async (req, res) => {
    const row = req.access!.resource!;
    const body = (req.body ?? {}) as {
      enabled?: boolean;
      name?: string;
      radiusM?: number;
      alertOn?: string;
    };
    const data: Record<string, unknown> = {};
    if (typeof body.enabled === 'boolean') data.enabled = body.enabled;
    if (typeof body.name === 'string' && body.name.trim())
      data.name = body.name.trim().slice(0, 60);
    if (typeof body.radiusM === 'number') data.radiusM = body.radiusM;
    if (['enter', 'leave', 'both'].includes(body.alertOn ?? '')) data.alertOn = body.alertOn;
    await prisma.geofence.update({ where: { id: row.id }, data });
    res.json({ data: { ok: true } });
  },
);

vehiclesRouter.delete(
  '/geofences/all/:id',
  {
    auth: 'session',
    target: { kind: 'resource', resource: 'geofence', from: 'param:id', perm: 'fleet.manage' },
  },
  async (req, res) => {
    await prisma.geofence.delete({ where: { id: req.access!.resource!.id } });
    res.json({ data: { ok: true } });
  },
);
