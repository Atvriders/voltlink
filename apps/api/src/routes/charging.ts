// Charging routes: sessions, rate rules, cost correction, exports.

import { Router } from 'express';
import { prisma } from '../core/db';
import { requireAuth } from '../auth/middleware';
import { loadVehicleForUser } from '../access';
import { applyCostCalculation } from '../telemetry/ingest';
import { csv } from '../core/util';

export const chargingRouter = Router();

chargingRouter.use(requireAuth);

async function accessibleVehicleIds(userId: string, role: string): Promise<string[]> {
  const { listVehiclesForUser } = await import('../access');
  const vehicles = await listVehiclesForUser(userId, role);
  return vehicles.map((v) => v.id);
}

chargingRouter.get('/', async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize) || 20));
  const vehicleId = typeof req.query.vehicleId === 'string' && req.query.vehicleId ? req.query.vehicleId : undefined;
  const source = typeof req.query.source === 'string' ? req.query.source : undefined;
  const ids = vehicleId ? [vehicleId] : await accessibleVehicleIds(req.user!.id, req.user!.role);
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
});

chargingRouter.get('/totals', async (req, res) => {
  const vehicleId = typeof req.query.vehicleId === 'string' && req.query.vehicleId ? req.query.vehicleId : undefined;
  const ids = vehicleId ? [vehicleId] : await accessibleVehicleIds(req.user!.id, req.user!.role);
  const agg = await prisma.chargingSession.aggregate({ where: { vehicleId: { in: ids } }, _sum: { energyAddedKwh: true, cost: true }, _count: true });
  res.json({
    data: {
      count: agg._count,
      energyKwh: Math.round((agg._sum.energyAddedKwh ?? 0) * 10) / 10,
      cost: Math.round((agg._sum.cost ?? 0) * 100) / 100,
    },
  });
});

chargingRouter.get('/:id', async (req, res) => {
  const session = await prisma.chargingSession.findUnique({ where: { id: req.params.id }, include: { vehicle: { select: { displayName: true, ownerId: true } } } });
  if (!session) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Charging session not found.' } });
    return;
  }
  await loadVehicleForUser(session.vehicleId, req.user!.id, req.user!.role);
  res.json({ data: toSessionDto(session) });
});

chargingRouter.patch('/:id', async (req, res) => {
  const session = await prisma.chargingSession.findUnique({ where: { id: req.params.id }, include: { vehicle: { select: { ownerId: true } } } });
  if (!session) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Charging session not found.' } });
    return;
  }
  await loadVehicleForUser(session.vehicleId, req.user!.id, req.user!.role);
  const body = (req.body ?? {}) as { manualCost?: number | null; notes?: string; source?: string };
  const data: Record<string, unknown> = {};
  if ('manualCost' in body) data.manualCost = typeof body.manualCost === 'number' ? body.manualCost : null;
  if (typeof body.notes === 'string') data.notes = body.notes.slice(0, 2000);
  if (['home', 'work', 'public', 'fast', 'other'].includes(body.source ?? '')) data.source = body.source;
  await prisma.chargingSession.update({ where: { id: session.id }, data });
  await applyCostCalculation(session.id, req.user!.id);
  const updated = await prisma.chargingSession.findUniqueOrThrow({ where: { id: session.id }, include: { vehicle: { select: { displayName: true } } } });
  res.json({ data: toSessionDto(updated) });
});

// ---- Rate rules ----

chargingRouter.get('/rates/list', async (req, res) => {
  const rules = await prisma.rateRule.findMany({ where: { userId: req.user!.id }, orderBy: { name: 'asc' } });
  res.json({ data: rules.map((r) => ({ ...r, periods: r.periods ?? [] })) });
});

chargingRouter.post('/rates/list', async (req, res) => {
  const body = (req.body ?? {}) as { name?: string; type?: string; pricePerKwh?: number; currency?: string; periods?: unknown; placeId?: string };
  if (!body.name || !['flat', 'tou', 'location'].includes(body.type ?? '') || typeof body.pricePerKwh !== 'number') {
    res.status(400).json({ error: { code: 'VALIDATION', message: 'Rate rule needs name, type (flat|tou|location), and pricePerKwh.' } });
    return;
  }
  const rule = await prisma.rateRule.create({
    data: {
      userId: req.user!.id,
      name: body.name.slice(0, 60),
      type: body.type,
      pricePerKwh: body.pricePerKwh,
      currency: body.currency ?? 'USD',
      periods: JSON.parse(JSON.stringify(Array.isArray(body.periods) ? body.periods : [])),
      placeId: body.placeId,
    },
  });
  res.status(201).json({ data: rule });
});

chargingRouter.patch('/rates/list/:id', async (req, res) => {
  const rule = await prisma.rateRule.findUnique({ where: { id: req.params.id } });
  if (!rule || rule.userId !== req.user!.id) {
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
});

chargingRouter.delete('/rates/list/:id', async (req, res) => {
  const rule = await prisma.rateRule.findUnique({ where: { id: req.params.id } });
  if (!rule || rule.userId !== req.user!.id) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Rate rule not found.' } });
    return;
  }
  await prisma.rateRule.delete({ where: { id: rule.id } });
  res.json({ data: { ok: true } });
});

chargingRouter.get('/export/csv', async (req, res) => {
  const vehicleId = typeof req.query.vehicleId === 'string' && req.query.vehicleId ? req.query.vehicleId : undefined;
  const ids = vehicleId ? [vehicleId] : await accessibleVehicleIds(req.user!.id, req.user!.role);
  const rows = await prisma.chargingSession.findMany({ where: { vehicleId: { in: ids } }, orderBy: { startAt: 'desc' }, include: { vehicle: { select: { displayName: true } } } });
  const header = ['id', 'vehicle', 'startAt', 'endAt', 'location', 'energyAddedKwh', 'batteryStartPct', 'batteryEndPct', 'durationSec', 'avgPowerKw', 'peakPowerKw', 'cost', 'currency', 'source', 'rateName'];
  const lines = rows.map((s) =>
    [s.id, s.vehicle.displayName, s.startAt.toISOString(), s.endAt?.toISOString() ?? '', s.locationName ?? '', s.energyAddedKwh, s.batteryStartPct ?? '', s.batteryEndPct ?? '', s.durationSec, s.avgPowerKw, s.peakPowerKw, s.cost, s.currency, s.source, s.rateName ?? ''].map((v) => String(v).replace(/"/g, '""')),
  );
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="voltlink-charging.csv"');
  res.send(csv([header, ...lines]));
});

chargingRouter.get('/export/json', async (req, res) => {
  const vehicleId = typeof req.query.vehicleId === 'string' && req.query.vehicleId ? req.query.vehicleId : undefined;
  const ids = vehicleId ? [vehicleId] : await accessibleVehicleIds(req.user!.id, req.user!.role);
  const rows = await prisma.chargingSession.findMany({ where: { vehicleId: { in: ids } }, orderBy: { startAt: 'desc' }, include: { vehicle: { select: { displayName: true } } } });
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="voltlink-charging.json"');
  res.send(JSON.stringify(rows.map(toSessionDto), null, 2));
});

function toSessionDto(s: {
  id: string; vehicleId: string; startAt: Date; endAt: Date | null; locationName: string | null; lat: number | null; lon: number | null;
  energyAddedKwh: number; batteryStartPct: number | null; batteryEndPct: number | null; durationSec: number; avgPowerKw: number;
  peakPowerKw: number; cost: number; currency: string; source: string; idleTimeSec: number; estLossKwh: number; notes: string | null;
  rateRuleId: string | null; rateName: string | null; pricePerKwh: number | null; manualCost: number | null;
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
