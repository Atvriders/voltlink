// Charging routes: sessions, rate rules, cost correction, exports.

import { policyRouter, sessionActor } from '../authz/policy';
import { prisma } from '../core/db';
import { applyCostCalculation } from '../telemetry/ingest';
import { csv } from '../core/util';
import { orgPermissions } from '../authz/access';
import { AccessDenied } from '../authz/errors';

export const chargingRouter = policyRouter('/api/v1/charging');

chargingRouter.get(
  '/',
  {
    auth: 'any',
    apiScope: 'vehicles:read',
    target: { kind: 'vehicle', from: 'query:vehicleId', perm: 'vehicles.read', optional: true },
  },
  async (req, res) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize) || 20));
    const vehicleId =
      typeof req.query.vehicleId === 'string' && req.query.vehicleId
        ? req.query.vehicleId
        : undefined;
    const source = typeof req.query.source === 'string' ? req.query.source : undefined;
    const ids = vehicleId ? [vehicleId] : req.access!.vehicleIds!;
    if (ids.length === 0) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No vehicles accessible.' } });
      return;
    }
    const where = { vehicleId: { in: ids }, ...(source ? { source } : {}) };
    const [rows, total] = await Promise.all([
      prisma.chargingSession.findMany({
        where,
        orderBy: { startAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { vehicle: { select: { displayName: true } } },
      }),
      prisma.chargingSession.count({ where }),
    ]);
    res.json({ data: { items: rows.map(toSessionDto), page, pageSize, total } });
  },
);

chargingRouter.get(
  '/totals',
  {
    auth: 'any',
    apiScope: 'vehicles:read',
    target: { kind: 'vehicle', from: 'query:vehicleId', perm: 'vehicles.read', optional: true },
  },
  async (req, res) => {
    const vehicleId =
      typeof req.query.vehicleId === 'string' && req.query.vehicleId
        ? req.query.vehicleId
        : undefined;
    const ids = vehicleId ? [vehicleId] : req.access!.vehicleIds!;
    if (ids.length === 0) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No vehicles accessible.' } });
      return;
    }
    const agg = await prisma.chargingSession.aggregate({
      where: { vehicleId: { in: ids } },
      _sum: { energyAddedKwh: true, cost: true },
      _count: true,
    });
    res.json({
      data: {
        count: agg._count,
        energyKwh: Math.round((agg._sum.energyAddedKwh ?? 0) * 10) / 10,
        cost: Math.round((agg._sum.cost ?? 0) * 100) / 100,
      },
    });
  },
);

chargingRouter.get(
  '/:id',
  {
    auth: 'any',
    apiScope: 'vehicles:read',
    target: {
      kind: 'resource',
      resource: 'chargingSession',
      from: 'param:id',
      perm: 'vehicles.read',
    },
  },
  async (req, res) => {
    const session = await prisma.chargingSession.findUnique({
      where: { id: String(req.params.id) },
      include: { vehicle: { select: { displayName: true } } },
    });
    if (!session) {
      res
        .status(404)
        .json({ error: { code: 'NOT_FOUND', message: 'Charging session not found.' } });
      return;
    }
    res.json({ data: toSessionDto(session) });
  },
);

chargingRouter.patch(
  '/:id',
  {
    auth: 'any',
    apiScope: 'history:write',
    target: {
      kind: 'resource',
      resource: 'chargingSession',
      from: 'param:id',
      perm: 'vehicles.history_edit',
    },
  },
  async (req, res) => {
    const session = await prisma.chargingSession.findUnique({
      where: { id: String(req.params.id) },
      include: { vehicle: { select: { displayName: true } } },
    });
    if (!session) {
      res
        .status(404)
        .json({ error: { code: 'NOT_FOUND', message: 'Charging session not found.' } });
      return;
    }
    const body = (req.body ?? {}) as {
      manualCost?: number | null;
      notes?: string;
      source?: string;
    };
    const data: Record<string, unknown> = {};
    if ('manualCost' in body)
      data.manualCost = typeof body.manualCost === 'number' ? body.manualCost : null;
    if (typeof body.notes === 'string') data.notes = body.notes.slice(0, 2000);
    if (['home', 'work', 'public', 'fast', 'other'].includes(body.source ?? ''))
      data.source = body.source;
    await prisma.chargingSession.update({ where: { id: session.id }, data });
    await applyCostCalculation(session.id);
    const updated = await prisma.chargingSession.findUniqueOrThrow({
      where: { id: session.id },
      include: { vehicle: { select: { displayName: true } } },
    });
    res.json({ data: toSessionDto(updated) });
  },
);

async function rateOrg(
  req: { query: { orgId?: unknown } },
  perm: 'fleet.read' | 'fleet.manage',
): Promise<string> {
  const actor = sessionActor(req as never);
  const requested = typeof req.query.orgId === 'string' ? req.query.orgId : undefined;
  if (requested) {
    const perms = await orgPermissions(actor, requested);
    if (!perms.has(perm))
      throw new AccessDenied('FORBIDDEN', `Missing ${perm} in this organization.`, 403);
    return requested;
  }
  const memberships = await prisma.membership.findMany({
    where: { userId: actor.userId, status: 'ACTIVE' },
  });
  for (const m of memberships) {
    const perms = await orgPermissions(actor, m.organizationId);
    if (perms.has(perm)) return m.organizationId;
  }
  throw new AccessDenied('FORBIDDEN', `Missing ${perm} in any organization.`, 403);
}

// ---- Rate rules ----

chargingRouter.get(
  '/rates/list',
  { auth: 'session', target: { kind: 'org', own: true, perm: 'fleet.read' } },
  async (req, res) => {
    const orgId =
      typeof req.query.orgId === 'string'
        ? await rateOrg(req, 'fleet.read')
        : req.access!.organizationId!;
    const rules = await prisma.rateRule.findMany({
      where: { organizationId: orgId },
      orderBy: { name: 'asc' },
    });
    res.json({ data: rules.map((r) => ({ ...r, periods: r.periods ?? [] })) });
  },
);

chargingRouter.post(
  '/rates/list',
  { auth: 'session', target: { kind: 'none' } },
  async (req, res) => {
    const body = (req.body ?? {}) as {
      name?: string;
      type?: string;
      pricePerKwh?: number;
      currency?: string;
      periods?: unknown;
      placeId?: string;
    };
    if (
      !body.name ||
      !['flat', 'tou', 'location'].includes(body.type ?? '') ||
      typeof body.pricePerKwh !== 'number'
    ) {
      res
        .status(400)
        .json({
          error: {
            code: 'VALIDATION',
            message: 'Rate rule needs name, type (flat|tou|location), and pricePerKwh.',
          },
        });
      return;
    }
    const orgId = await rateOrg(req, 'fleet.manage');
    const rule = await prisma.rateRule.create({
      data: {
        organizationId: orgId,
        createdById: sessionActor(req).userId,
        name: body.name.slice(0, 60),
        type: body.type,
        pricePerKwh: body.pricePerKwh,
        currency: body.currency ?? 'USD',
        periods: JSON.parse(JSON.stringify(Array.isArray(body.periods) ? body.periods : [])),
        placeId: body.placeId,
      },
    });
    res.status(201).json({ data: rule });
  },
);

chargingRouter.patch(
  '/rates/list/:id',
  {
    auth: 'session',
    target: { kind: 'resource', resource: 'rateRule', from: 'param:id', perm: 'fleet.manage' },
  },
  async (req, res) => {
    const rule = await prisma.rateRule.findUnique({ where: { id: String(req.params.id) } });
    if (!rule) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Rate rule not found.' } });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const data: Record<string, unknown> = {};
    if (typeof body.name === 'string') data.name = body.name.slice(0, 60);
    if (typeof body.pricePerKwh === 'number') data.pricePerKwh = body.pricePerKwh;
    if (typeof body.enabled === 'boolean') data.enabled = body.enabled;
    if (Array.isArray(body.periods)) data.periods = JSON.parse(JSON.stringify(body.periods));
    await prisma.rateRule.update({ where: { id: rule.id }, data });
    res.json({ data: { ok: true } });
  },
);

chargingRouter.delete(
  '/rates/list/:id',
  {
    auth: 'session',
    target: { kind: 'resource', resource: 'rateRule', from: 'param:id', perm: 'fleet.manage' },
  },
  async (req, res) => {
    const rule = await prisma.rateRule.findUnique({ where: { id: String(req.params.id) } });
    if (!rule) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Rate rule not found.' } });
      return;
    }
    await prisma.rateRule.delete({ where: { id: rule.id } });
    res.json({ data: { ok: true } });
  },
);

chargingRouter.get(
  '/export/csv',
  {
    auth: 'any',
    apiScope: 'vehicles:read',
    target: { kind: 'vehicle', from: 'query:vehicleId', perm: 'vehicles.read', optional: true },
  },
  async (req, res) => {
    const vehicleId =
      typeof req.query.vehicleId === 'string' && req.query.vehicleId
        ? req.query.vehicleId
        : undefined;
    const ids = vehicleId ? [vehicleId] : req.access!.vehicleIds!;
    if (ids.length === 0) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No vehicles accessible.' } });
      return;
    }
    const rows = await prisma.chargingSession.findMany({
      where: { vehicleId: { in: ids } },
      orderBy: { startAt: 'desc' },
      include: { vehicle: { select: { displayName: true } } },
    });
    const header = [
      'id',
      'vehicle',
      'startAt',
      'endAt',
      'location',
      'energyAddedKwh',
      'batteryStartPct',
      'batteryEndPct',
      'durationSec',
      'avgPowerKw',
      'peakPowerKw',
      'cost',
      'currency',
      'source',
      'rateName',
    ];
    const lines = rows.map((s) =>
      [
        s.id,
        s.vehicle.displayName,
        s.startAt.toISOString(),
        s.endAt?.toISOString() ?? '',
        s.locationName ?? '',
        s.energyAddedKwh,
        s.batteryStartPct ?? '',
        s.batteryEndPct ?? '',
        s.durationSec,
        s.avgPowerKw,
        s.peakPowerKw,
        s.cost,
        s.currency,
        s.source,
        s.rateName ?? '',
      ].map((v) => String(v).replace(/"/g, '""')),
    );
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="voltlink-charging.csv"');
    res.send(csv([header, ...lines]));
  },
);

chargingRouter.get(
  '/export/json',
  {
    auth: 'any',
    apiScope: 'vehicles:read',
    target: { kind: 'vehicle', from: 'query:vehicleId', perm: 'vehicles.read', optional: true },
  },
  async (req, res) => {
    const vehicleId =
      typeof req.query.vehicleId === 'string' && req.query.vehicleId
        ? req.query.vehicleId
        : undefined;
    const ids = vehicleId ? [vehicleId] : req.access!.vehicleIds!;
    if (ids.length === 0) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No vehicles accessible.' } });
      return;
    }
    const rows = await prisma.chargingSession.findMany({
      where: { vehicleId: { in: ids } },
      orderBy: { startAt: 'desc' },
      include: { vehicle: { select: { displayName: true } } },
    });
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="voltlink-charging.json"');
    res.send(JSON.stringify(rows.map(toSessionDto), null, 2));
  },
);

function toSessionDto(s: {
  id: string;
  vehicleId: string;
  startAt: Date;
  endAt: Date | null;
  locationName: string | null;
  lat: number | null;
  lon: number | null;
  energyAddedKwh: number;
  batteryStartPct: number | null;
  batteryEndPct: number | null;
  durationSec: number;
  avgPowerKw: number;
  peakPowerKw: number;
  cost: number;
  currency: string;
  source: string;
  idleTimeSec: number;
  estLossKwh: number;
  notes: string | null;
  rateRuleId: string | null;
  rateName: string | null;
  pricePerKwh: number | null;
  manualCost: number | null;
  vehicle?: { displayName: string };
}) {
  return {
    id: s.id,
    vehicleId: s.vehicleId,
    vehicleName: s.vehicle?.displayName ?? '',
    startAt: s.startAt.toISOString(),
    endAt: s.endAt?.toISOString(),
    locationName: s.locationName ?? undefined,
    lat: s.lat ?? undefined,
    lon: s.lon ?? undefined,
    energyAddedKwh: s.energyAddedKwh,
    batteryStartPct: s.batteryStartPct ?? undefined,
    batteryEndPct: s.batteryEndPct ?? undefined,
    durationSec: s.durationSec,
    avgPowerKw: s.avgPowerKw,
    peakPowerKw: s.peakPowerKw,
    cost: s.cost,
    currency: s.currency,
    source: s.source,
    idleTimeSec: s.idleTimeSec,
    estLossKwh: s.estLossKwh,
    notes: s.notes ?? undefined,
    rateRuleId: s.rateRuleId ?? undefined,
    rateName: s.rateName ?? undefined,
    pricePerKwh: s.pricePerKwh ?? undefined,
    manualCost: s.manualCost,
  };
}
