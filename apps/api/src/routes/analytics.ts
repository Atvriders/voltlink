// Analytics routes: battery history, efficiency, aggregates, and the
// (clearly estimated) battery-health calculation.

import { policyRouter } from '../authz/policy';
import { prisma, query } from '../core/db';
import { round2 } from '../core/geo';

export const analyticsRouter = policyRouter('/api/v1/analytics');

analyticsRouter.get(
  '/:vehicleId/battery',
  {
    auth: 'any',
    apiScope: 'vehicles:read',
    target: { kind: 'vehicle', from: 'param:vehicleId', perm: 'vehicles.read' },
  },
  async (req, res) => {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 14));
    const from = new Date(Date.now() - days * 86400000);
    await query('SELECT voltlink_ensure_partition($1)', [from]);
    const rows = await query<{ ts: string; data: { b: number | null; r: number | null } }>(
      `SELECT ts, data FROM telemetry.telemetry_reading WHERE vehicle_id = $1 AND ts >= $2 AND (data->>'b') IS NOT NULL ORDER BY ts ASC`,
      [String(req.params.vehicleId), from],
    );
    // Downsample to ~400 points.
    const step = Math.max(1, Math.floor(rows.rows.length / 400));
    const points = rows.rows
      .filter((_, i) => i % step === 0)
      .map((r) => ({
        ts: new Date(r.ts).toISOString(),
        batteryPct: r.data.b,
        rangeKm: r.data.r ?? undefined,
      }));
    res.json({ data: points });
  },
);

analyticsRouter.get(
  '/:vehicleId/efficiency',
  {
    auth: 'any',
    apiScope: 'vehicles:read',
    target: { kind: 'vehicle', from: 'param:vehicleId', perm: 'vehicles.read' },
  },
  async (req, res) => {
    const days = Math.min(365, Math.max(7, Number(req.query.days) || 30));
    const from = new Date(Date.now() - days * 86400000);
    const drives = await prisma.drive.findMany({
      where: { vehicleId: String(req.params.vehicleId), startAt: { gte: from } },
      orderBy: { startAt: 'asc' },
      select: {
        startAt: true,
        distanceKm: true,
        energyKwh: true,
        efficiencyWhPerKm: true,
        avgOutsideTempC: true,
      },
    });
    const byDay = new Map<string, { d: number; e: number; temp: number; n: number }>();
    for (const d of drives) {
      const k = d.startAt.toISOString().slice(0, 10);
      const row = byDay.get(k) ?? { d: 0, e: 0, temp: 0, n: 0 };
      row.d += d.distanceKm;
      row.e += d.energyKwh;
      if (d.avgOutsideTempC !== null) {
        row.temp += d.avgOutsideTempC;
        row.n += 1;
      }
      byDay.set(k, row);
    }
    const points = [...byDay.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, row]) => ({
        date,
        whPerKm: round2(row.d > 0 ? (row.e * 1000) / row.d : 0),
        tempC: row.n > 0 ? round2(row.temp / row.n) : undefined,
        distanceKm: round2(row.d),
      }));
    res.json({ data: points });
  },
);

analyticsRouter.get(
  '/:vehicleId/aggregates',
  {
    auth: 'any',
    apiScope: 'vehicles:read',
    target: { kind: 'vehicle', from: 'param:vehicleId', perm: 'vehicles.read' },
  },
  async (req, res) => {
    const days = Math.min(90, Math.max(7, Number(req.query.days) || 30));
    const from = new Date(Date.now() - days * 86400000);
    const rows = await prisma.aggregateDaily.findMany({
      where: {
        vehicleId: String(req.params.vehicleId),
        date: { gte: new Date(from.toISOString().slice(0, 10)) },
      },
      orderBy: { date: 'asc' },
    });
    res.json({
      data: rows.map((r) => ({
        date: r.date.toISOString().slice(0, 10),
        vehicleId: r.vehicleId,
        distanceKm: r.distanceKm,
        energyKwh: r.energyKwh,
        chargeEnergyKwh: r.chargeEnergyKwh,
        chargeCost: r.chargeCost,
        driveCount: r.driveCount,
        chargeSessionCount: r.chargeSessionCount,
        minBatteryPct: r.minBatteryPct ?? undefined,
        maxBatteryPct: r.maxBatteryPct ?? undefined,
      })),
    });
  },
);

analyticsRouter.get(
  '/:vehicleId/battery-health',
  {
    auth: 'any',
    apiScope: 'vehicles:read',
    target: { kind: 'vehicle', from: 'param:vehicleId', perm: 'vehicles.read' },
  },
  async (req, res) => {
    const vehicle = req.access!.vehicle as unknown as {
      id: string;
      snapshot: { state: { batteryCapacityKwh?: number } | null } | null;
    };
    const capacity = (vehicle.snapshot?.state as { batteryCapacityKwh?: number } | null)
      ?.batteryCapacityKwh;
    const rows = await prisma.chargingSession.findMany({
      where: {
        vehicleId: vehicle.id,
        batteryStartPct: { not: null },
        batteryEndPct: { not: null },
        energyAddedKwh: { gt: 5 },
      },
      orderBy: { startAt: 'desc' },
      take: 20,
    });
    const estimates = rows
      .filter(
        (s) =>
          s.batteryEndPct !== null &&
          s.batteryStartPct !== null &&
          s.batteryEndPct > s.batteryStartPct,
      )
      .map((s) => s.energyAddedKwh / ((s.batteryEndPct! - s.batteryStartPct!) / 100));
    const estimatedUsableKwh =
      estimates.length > 0
        ? estimates.reduce((a, b) => a + b, 0) / estimates.length
        : (capacity ?? 0);
    const originalCapacity = capacity ?? estimatedUsableKwh;
    const degradation =
      originalCapacity > 0
        ? Math.max(
            0,
            Math.min(30, ((originalCapacity - estimatedUsableKwh) / originalCapacity) * 100),
          )
        : 0;
    res.json({
      data: {
        estimatedUsableKwh: round2(estimatedUsableKwh),
        originalCapacityKwh: round2(originalCapacity),
        estimatedDegradationPct: round2(degradation),
        sampleCount: estimates.length,
        lastSampleAt: rows[0]?.startAt.toISOString(),
        disclaimer:
          'Battery health is an estimate derived from charging-session energy data. It is not an official manufacturer diagnosis.',
      },
    });
  },
);

analyticsRouter.get(
  '/:vehicleId/charging-behavior',
  {
    auth: 'any',
    apiScope: 'vehicles:read',
    target: { kind: 'vehicle', from: 'param:vehicleId', perm: 'vehicles.read' },
  },
  async (req, res) => {
    const days = Math.min(365, Math.max(30, Number(req.query.days) || 90));
    const from = new Date(Date.now() - days * 86400000);
    const sessions = await prisma.chargingSession.findMany({
      where: { vehicleId: String(req.params.vehicleId), startAt: { gte: from } },
      orderBy: { startAt: 'asc' },
    });
    res.json({
      data: sessions.map((s) => ({
        ts: s.startAt.toISOString(),
        energyKwh: s.energyAddedKwh,
        durationSec: s.durationSec,
        avgPowerKw: s.avgPowerKw,
        peakPowerKw: s.peakPowerKw,
        cost: s.cost,
        source: s.source,
        startPct: s.batteryStartPct ?? undefined,
        endPct: s.batteryEndPct ?? undefined,
      })),
    });
  },
);
