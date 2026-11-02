// Drives routes: listing, route replay, totals, CSV/JSON export, tags.

import type { Prisma } from '@prisma/client';

import { policyRouter, type RoutePolicy } from '../authz/policy';
import { prisma } from '../core/db';
import { csv } from '../core/util';

export const drivesRouter = policyRouter('/api/v1/drives');

const readAll: RoutePolicy = {
  auth: 'any',
  apiScope: 'vehicles:read',
  target: { kind: 'vehicle', from: 'query:vehicleId', perm: 'vehicles.read', optional: true },
};

drivesRouter.get('/', readAll, async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize) || 20));
  const vehicleId =
    typeof req.query.vehicleId === 'string' && req.query.vehicleId
      ? req.query.vehicleId
      : undefined;
  const search = typeof req.query.search === 'string' ? req.query.search : undefined;
  const from = typeof req.query.from === 'string' ? new Date(req.query.from) : undefined;
  const to = typeof req.query.to === 'string' ? new Date(req.query.to) : undefined;
  const classification =
    typeof req.query.classification === 'string' ? req.query.classification : undefined;
  const sort = String(req.query.sort ?? 'startAt');
  const order = req.query.order === 'asc' ? 'asc' : 'desc';

  const ids = vehicleId ? [vehicleId] : req.access!.vehicleIds!;
  if (ids.length === 0) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No vehicles accessible.' } });
    return;
  }
  const where: Record<string, unknown> = {
    vehicleId: { in: ids },
    ...(from || to
      ? { startAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
      : {}),
    ...(classification ? { classification } : {}),
  };
  if (search) {
    where.OR = [
      { startAddress: { contains: search, mode: 'insensitive' } },
      { endAddress: { contains: search, mode: 'insensitive' } },
      { driverName: { contains: search, mode: 'insensitive' } },
    ];
  }
  const [rows, total] = await Promise.all([
    prisma.drive.findMany({
      where: where as never,
      orderBy: {
        [sort in
        [
          'startAt',
          'endAt',
          'distanceKm',
          'durationSec',
          'energyKwh',
          'efficiencyWhPerKm',
          'maxSpeedKmh',
        ]
          ? sort
          : 'startAt']: order,
      },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { vehicle: { select: { displayName: true } } },
    }),
    prisma.drive.count({ where: where as never }),
  ]);
  res.json({ data: { items: rows.map(toDriveDto), page, pageSize, total } });
});

drivesRouter.get('/totals', readAll, async (req, res) => {
  const vehicleId =
    typeof req.query.vehicleId === 'string' && req.query.vehicleId
      ? req.query.vehicleId
      : undefined;
  const ids = vehicleId ? [vehicleId] : req.access!.vehicleIds!;
  if (ids.length === 0) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No vehicles accessible.' } });
    return;
  }
  const from =
    typeof req.query.from === 'string' && req.query.from ? new Date(req.query.from) : undefined;
  const to = typeof req.query.to === 'string' && req.query.to ? new Date(req.query.to) : undefined;
  const startAt: { gte?: Date; lte?: Date } = {
    ...(from && !Number.isNaN(from.getTime()) ? { gte: from } : {}),
    ...(to && !Number.isNaN(to.getTime()) ? { lte: to } : {}),
  };
  const where: Prisma.DriveWhereInput = {
    vehicleId: { in: ids },
    ...(Object.keys(startAt).length > 0 ? { startAt } : {}),
  };
  const agg = await prisma.drive.aggregate({
    where,
    _sum: { distanceKm: true, energyKwh: true, estCost: true },
    _count: true,
  });
  const distanceKm = agg._sum.distanceKm ?? 0;
  const cost = agg._sum.estCost ?? 0;
  res.json({
    data: {
      count: agg._count,
      distanceKm: Math.round(distanceKm * 10) / 10,
      energyKwh: Math.round((agg._sum.energyKwh ?? 0) * 10) / 10,
      estCost: Math.round(cost * 100) / 100,
      costPerKm: distanceKm > 0 ? Math.round((cost / distanceKm) * 100) / 100 : 0,
    },
  });
});

drivesRouter.get(
  '/:id',
  {
    auth: 'any',
    apiScope: 'vehicles:read',
    target: { kind: 'resource', resource: 'drive', from: 'param:id', perm: 'vehicles.read' },
  },
  async (req, res) => {
    const drive = await prisma.drive.findUnique({
      where: { id: String(req.params.id) },
      include: { vehicle: { select: { displayName: true } } },
    });
    if (!drive) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Drive not found.' } });
      return;
    }
    const withRoute = typeof req.query.route === 'string' && req.query.route !== 'false';
    let route;
    if (withRoute) {
      const points = await prisma.driveRoutePoint.findMany({
        where: { driveId: drive.id },
        orderBy: { seq: 'asc' },
      });
      route = points.map((p) => ({
        ts: p.ts.toISOString(),
        lat: p.lat,
        lon: p.lon,
        speedKmh: p.speedKmh,
        headingDeg: p.headingDeg ?? undefined,
        batteryPct: p.batteryPct ?? undefined,
      }));
    }
    res.json({ data: { ...toDriveDto(drive), route } });
  },
);

drivesRouter.patch(
  '/:id',
  {
    auth: 'any',
    apiScope: 'history:write',
    target: {
      kind: 'resource',
      resource: 'drive',
      from: 'param:id',
      perm: 'vehicles.history_edit',
    },
  },
  async (req, res) => {
    const drive = await prisma.drive.findUnique({
      where: { id: String(req.params.id) },
      include: { vehicle: { select: { displayName: true } } },
    });
    if (!drive) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Drive not found.' } });
      return;
    }
    const body = (req.body ?? {}) as { classification?: string; tags?: string[]; notes?: string };
    const data: Record<string, unknown> = {};
    if (['business', 'personal', 'unknown'].includes(body.classification ?? ''))
      data.classification = body.classification;
    if (Array.isArray(body.tags)) data.tags = JSON.parse(JSON.stringify(body.tags.slice(0, 20)));
    if (typeof body.notes === 'string') data.notes = body.notes.slice(0, 2000);
    await prisma.drive.update({ where: { id: drive.id }, data });
    res.json({ data: { ok: true } });
  },
);

drivesRouter.get('/export/csv', readAll, async (req, res) => {
  const vehicleId =
    typeof req.query.vehicleId === 'string' && req.query.vehicleId
      ? req.query.vehicleId
      : undefined;
  const ids = vehicleId ? [vehicleId] : req.access!.vehicleIds!;
  if (ids.length === 0) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No vehicles accessible.' } });
    return;
  }
  const rows = await prisma.drive.findMany({
    where: { vehicleId: { in: ids } },
    orderBy: { startAt: 'desc' },
    include: { vehicle: { select: { displayName: true } } },
  });
  const header = [
    'id',
    'vehicle',
    'startAt',
    'endAt',
    'startAddress',
    'endAddress',
    'distanceKm',
    'durationSec',
    'avgSpeedKmh',
    'maxSpeedKmh',
    'energyKwh',
    'efficiencyWhPerKm',
    'classification',
    'tags',
    'driverName',
  ];
  const lines = rows.map((d) =>
    [
      d.id,
      d.vehicle.displayName,
      d.startAt.toISOString(),
      d.endAt.toISOString(),
      d.startAddress ?? '',
      d.endAddress ?? '',
      d.distanceKm,
      d.durationSec,
      d.avgSpeedKmh,
      d.maxSpeedKmh,
      d.energyKwh,
      d.efficiencyWhPerKm,
      d.classification,
      (d.tags as string[]).join('|'),
      d.driverName ?? '',
    ].map((v) => String(v).replace(/"/g, '""')),
  );
  const body = csv([header, ...lines]);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="voltlink-drives.csv"');
  res.send(body);
});

drivesRouter.get('/export/json', readAll, async (req, res) => {
  const vehicleId =
    typeof req.query.vehicleId === 'string' && req.query.vehicleId
      ? req.query.vehicleId
      : undefined;
  const ids = vehicleId ? [vehicleId] : req.access!.vehicleIds!;
  if (ids.length === 0) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No vehicles accessible.' } });
    return;
  }
  const rows = await prisma.drive.findMany({
    where: { vehicleId: { in: ids } },
    orderBy: { startAt: 'desc' },
    include: { vehicle: { select: { displayName: true } } },
  });
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="voltlink-drives.json"');
  res.send(JSON.stringify(rows.map(toDriveDto), null, 2));
});

function toDriveDto(d: {
  id: string;
  vehicleId: string;
  startAt: Date;
  endAt: Date;
  startLat: number | null;
  startLon: number | null;
  startAddress: string | null;
  endLat: number | null;
  endLon: number | null;
  endAddress: string | null;
  distanceKm: number;
  durationSec: number;
  avgSpeedKmh: number;
  maxSpeedKmh: number;
  energyKwh: number;
  efficiencyWhPerKm: number;
  estCost: number | null;
  currency: string;
  elevationGainM: number | null;
  avgOutsideTempC: number | null;
  driverName: string | null;
  tags: unknown;
  classification: string;
  notes: string | null;
  vehicle?: { displayName: string };
}) {
  return {
    id: d.id,
    vehicleId: d.vehicleId,
    vehicleName: d.vehicle?.displayName ?? '',
    startAt: d.startAt.toISOString(),
    endAt: d.endAt.toISOString(),
    startLat: d.startLat ?? undefined,
    startLon: d.startLon ?? undefined,
    startAddress: d.startAddress ?? undefined,
    endLat: d.endLat ?? undefined,
    endLon: d.endLon ?? undefined,
    endAddress: d.endAddress ?? undefined,
    distanceKm: d.distanceKm,
    durationSec: d.durationSec,
    avgSpeedKmh: d.avgSpeedKmh,
    maxSpeedKmh: d.maxSpeedKmh,
    energyKwh: d.energyKwh,
    efficiencyWhPerKm: d.efficiencyWhPerKm,
    estCost: d.estCost ?? undefined,
    currency: d.currency,
    elevationGainM: d.elevationGainM ?? undefined,
    avgOutsideTempC: d.avgOutsideTempC ?? undefined,
    driverName: d.driverName ?? undefined,
    tags: (d.tags ?? []) as string[],
    classification: d.classification,
    notes: d.notes ?? undefined,
  };
}
