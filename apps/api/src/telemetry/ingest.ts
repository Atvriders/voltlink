// Telemetry ingestion: snapshot updates, partitioned telemetry writes,
// latest location, drive/charge lifecycle detection, geofence evaluation,
// and automation trigger dispatch. Never logs precise coordinates.

import { prisma, ensureTelemetryPartition } from '../core/db';
import { ssePublish } from '../core/sse';
import { haversineKm, round2 } from '../core/geo';
import { dispatchTrigger } from '../automations/engine';
import { notify } from '../notifications/service';
import type { VehicleState } from '@voltlink/shared';
type IngestVehicle = { id: string; organizationId: string; displayName: string; demo: boolean; addedById: string | null };

// In-flight lifecycle trackers keyed by vehicleId (per process).
const driveTracker = new Map<string, { startedAt: Date; startedPct: number; maxSpeed: number; points: { ts: Date; lat: number; lon: number; speedKmh: number; batteryPct: number | null }[]; lastMoving: Date }>();
const chargeTracker = new Map<string, { startedAt: Date; startPct: number; peakKw: number; lastPct: number }>();
const geofenceState = new Map<string, boolean>(); // `${geofenceId}:${vehicleId}` -> inside

const MIN_DRIVE_SPEED = 8; // km/h
const DRIVE_END_IDLE_SEC = 180;

export async function ingestVehicleState(vehicle: IngestVehicle, state: VehicleState, opts: { live: boolean }): Promise<void> {
  const fetchedAt = new Date(state.fetchedAt ?? Date.now());
  const ageSec = Math.max(0, (Date.now() - fetchedAt.getTime()) / 1000);
  const freshLimit = freshLimitFor(state);
  const freshness = opts.live && ageSec <= freshLimit ? 'live' : ageSec <= freshLimit * 3 ? 'recent' : ageSec <= freshLimit * 12 ? 'stale' : 'last_known';

  const stored = { ...state, freshness } as unknown as Record<string, unknown>;
  const storedJson = JSON.parse(JSON.stringify(stored)) as object;

  // 1. Snapshot (latest-state table — dashboards never scan history).
  await prisma.vehicleSnapshot.upsert({
    where: { vehicleId: vehicle.id },
    update: { state: storedJson, fetchedAt, freshness },
    create: { vehicleId: vehicle.id, state: storedJson, fetchedAt, freshness },
  });

  // 2. Partitioned telemetry row.
  try {
    await ensureTelemetryPartition(fetchedAt);
    const data = {
      b: state.batteryPercent ?? null,
      r: state.batteryRangeKm ?? null,
      c: state.chargingState ?? null,
      p: state.chargePowerKw ?? null,
      cl: state.chargeLimitPct ?? null,
      o: state.odometerKm ?? null,
      sp: state.speedKmh ?? null,
      lt: state.lat ?? null,
      ln: state.lon ?? null,
      hd: state.headingDeg ?? null,
      it: state.insideTempC ?? null,
      ot: state.outsideTempC ?? null,
      lk: state.locked ?? null,
      st: state.status,
      fr: freshness,
      dp: state.doors ?? null,
    };
    const { query } = await import('../core/db');
    await query(
      `INSERT INTO telemetry.telemetry_reading (vehicle_id, ts, data) VALUES ($1, $2, $3)`,
      [vehicle.id, fetchedAt, JSON.stringify(data)],
    );
  } catch (err) {
    console.error('telemetry write failed:', (err as Error).message);
  }

  // 3. Latest location (no logs — DB only).
  if (typeof state.lat === 'number' && typeof state.lon === 'number') {
    // Redact address when inside any privacy zone (iterate lazily).
    let address = state.address ?? null;
    if (address) {
      const zones = await prisma.privacyZone.findMany({ where: { organizationId: vehicle.organizationId, enabled: true } });
      for (const z of zones) {
        if (haversineKm(state.lat, state.lon, z.lat, z.lon) <= z.radiusM / 1000) {
          address = 'Private area';
          break;
        }
      }
    }
    await prisma.vehicleLocation.upsert({
      where: { vehicleId: vehicle.id },
      update: { ts: fetchedAt, lat: state.lat, lon: state.lon, headingDeg: state.headingDeg, speedKmh: state.speedKmh, accuracyM: 5, address },
      create: { vehicleId: vehicle.id, ts: fetchedAt, lat: state.lat, lon: state.lon, headingDeg: state.headingDeg, speedKmh: state.speedKmh, accuracyM: 5, address },
    });
  }

  // 4. Drive detection (real providers only — demo history is seeded).
  if (!vehicle.demo) {
    await detectDrive(vehicle.id, state, fetchedAt);
  }
  // 5. Charging lifecycle (all providers; demo charging cycles are throttled).
  await detectCharging(vehicle.id, vehicle.addedById ?? '', vehicle.displayName, state, fetchedAt, vehicle.demo);

  // 6. Geofence evaluation.
  await evaluateGeofences(vehicle, state);

  // 7. Automation triggers (event-driven, not polling-driven).
  await evaluateTriggers(vehicle, state);

  // 8. Real-time update to the owner.
  ssePublish({
    type: 'vehicle_state',
    data: { vehicleId: vehicle.id, state: publicStateForSse(stored) },
    userId: vehicle.addedById ?? '',
  });
}

function freshLimitFor(state: VehicleState): number {
  if (state.status === 'online' || state.status === 'charging' || state.status === 'driving') return 120;
  if (state.status === 'asleep') return 15 * 60;
  return 10 * 60;
}

/** SSE payload strips nothing sensitive but drops bulky fields. */
function publicStateForSse(stored: Record<string, unknown>): Record<string, unknown> {
  const { fetchedAt, freshness, status, batteryPercent, chargingState, chargePowerKw, timeToFullChargeMin, locked, lat, lon, climateOn, sentryMode, batteryRangeKm, speedKmh, odometerKm, insideTempC } = stored;
  return { fetchedAt, freshness, status, batteryPercent, chargingState, chargePowerKw, timeToFullChargeMin, locked, lat, lon, climateOn, sentryMode, batteryRangeKm, speedKmh, odometerKm, insideTempC };
}

// ---------------------------------------------------------------------------
// Drive lifecycle
// ---------------------------------------------------------------------------

async function detectDrive(vehicleId: string, state: VehicleState, now: Date): Promise<void> {
  const speed = state.speedKmh ?? 0;
  const moving = speed > MIN_DRIVE_SPEED;
  const current = driveTracker.get(vehicleId);

  if (moving) {
    if (!current) {
      driveTracker.set(vehicleId, {
        startedAt: now,
        startedPct: state.batteryPercent ?? 0,
        maxSpeed: speed,
        points: [],
        lastMoving: now,
      });
    } else {
      current.maxSpeed = Math.max(current.maxSpeed, speed);
      current.lastMoving = now;
      if (typeof state.lat === 'number' && typeof state.lon === 'number') {
        current.points.push({ ts: now, lat: state.lat, lon: state.lon, speedKmh: speed, batteryPct: state.batteryPercent ?? null });
        if (current.points.length > 4000) current.points.splice(0, 2000); // bound memory
      }
    }
    return;
  }

  if (current && now.getTime() - current.lastMoving.getTime() > DRIVE_END_IDLE_SEC * 1000) {
    driveTracker.delete(vehicleId);
    const points = current.points;
    if (points.length < 3) return;
    const first = points[0]!;
    const last = points[points.length - 1]!;
    let distanceKm = 0;
    for (let i = 1; i < points.length; i++) {
      distanceKm += haversineKm(points[i - 1]!.lat, points[i - 1]!.lon, points[i]!.lat, points[i]!.lon);
    }
    const durationSec = Math.max(1, Math.round((last.ts.getTime() - first.ts.getTime()) / 1000));
    if (distanceKm < 0.15 || durationSec < 30) return;
    const energyKwh = Math.max(0, (current.startedPct - (state.batteryPercent ?? current.startedPct)) / 100 * 60);
    const efficiency = distanceKm > 0 ? (energyKwh * 1000) / distanceKm : 0;
    const drive = await prisma.drive.create({
      data: {
        vehicleId,
        startAt: first.ts,
        endAt: last.ts,
        startLat: first.lat,
        startLon: first.lon,
        endLat: last.lat,
        endLon: last.lon,
        distanceKm: round2(distanceKm),
        durationSec,
        avgSpeedKmh: round2((distanceKm / durationSec) * 3600),
        maxSpeedKmh: round2(current.maxSpeed),
        energyKwh: round2(energyKwh),
        efficiencyWhPerKm: round2(efficiency),
        currency: 'USD',
        tags: JSON.parse('[]'),
        classification: 'unknown',
      },
    });
    await prisma.driveRoutePoint.createMany({
      data: points.map((p, i) => ({
        driveId: drive.id,
        seq: i,
        ts: p.ts,
        lat: p.lat,
        lon: p.lon,
        speedKmh: round2(p.speedKmh),
        headingDeg: 0,
        batteryPct: p.batteryPct,
      })),
    });
    await recomputeAggregate(vehicleId, first.ts);
    void dispatchTrigger({ type: 'drive_started', vehicleId, data: { driveId: drive.id } });
  }
}

// ---------------------------------------------------------------------------
// Charging lifecycle
// ---------------------------------------------------------------------------

async function detectCharging(vehicleId: string, ownerId: string, vehicleName: string, state: VehicleState, now: Date, isDemo: boolean): Promise<void> {
  const charging = state.chargingState === 'charging';
  const current = chargeTracker.get(vehicleId);

  if (charging) {
    if (!current) {
      chargeTracker.set(vehicleId, { startedAt: now, startPct: state.batteryPercent ?? 0, peakKw: state.chargePowerKw ?? 0, lastPct: state.batteryPercent ?? 0 });
      void dispatchTrigger({ type: 'charging_started', userId: ownerId, vehicleId, data: {} });
      void dispatchTrigger({ type: 'plug_connected', userId: ownerId, vehicleId, data: {} });
      await notify({ userId: ownerId, event: 'charging_started', severity: 'info', title: 'Charging started', body: `${vehicleName} started charging.`, vehicleId, vehicleName });
      return;
    }
    current.peakKw = Math.max(current.peakKw, state.chargePowerKw ?? 0);
    current.lastPct = state.batteryPercent ?? current.lastPct;
    return;
  }

  if (current && (state.chargingState === 'complete' || state.chargingState === 'stopped' || state.chargingState === 'disconnected' || !state.plugConnected)) {
    chargeTracker.delete(vehicleId);
    const energyAddedKwh = Math.max(0, ((state.batteryPercent ?? current.lastPct) - current.startPct) / 100 * 60);
    if (energyAddedKwh < 0.2 && isDemo) return; // demo throttling
    const durationSec = Math.max(1, Math.round((now.getTime() - current.startedAt.getTime()) / 1000));
    const session = await prisma.chargingSession.create({
      data: {
        vehicleId,
        startAt: current.startedAt,
        endAt: now,
        energyAddedKwh: round2(energyAddedKwh),
        batteryStartPct: current.startPct,
        batteryEndPct: state.batteryPercent ?? current.lastPct,
        durationSec,
        avgPowerKw: round2(energyAddedKwh / (durationSec / 3600)),
        peakPowerKw: round2(current.peakKw),
        source: 'other',
        currency: 'USD',
        cost: 0,
        idleTimeSec: 0,
        estLossKwh: round2(energyAddedKwh * 0.06),
      },
    });
    await applyCostCalculation(session.id);
    await recomputeAggregate(vehicleId, current.startedAt);
    const event = state.chargingState === 'complete' ? 'charging_completed' : 'charging_stopped';
    await notify({
      userId: ownerId,
      event,
      severity: state.chargingState === 'complete' ? 'success' : 'info',
      title: state.chargingState === 'complete' ? 'Charging complete' : 'Charging stopped',
      body: `${vehicleName}: ${energyAddedKwh.toFixed(1)} kWh added.`,
      vehicleId,
      vehicleName,
    });
    void dispatchTrigger({ type: event, userId: ownerId, vehicleId, data: { sessionId: session.id } });
  }
}

// ---------------------------------------------------------------------------
// Cost calculation
// ---------------------------------------------------------------------------

export async function applyCostCalculation(sessionId: string): Promise<void> {
  const session = await prisma.chargingSession.findUnique({ where: { id: sessionId } });
  if (!session) return;
  if (session.manualCost !== null && session.manualCost !== undefined) {
    await prisma.chargingSession.update({ where: { id: sessionId }, data: { cost: session.manualCost } });
    return;
  }
  const vehicle = await prisma.vehicle.findUnique({ where: { id: session.vehicleId }, select: { organizationId: true } });
  const organizationId = vehicle?.organizationId ?? '';
  const rules = await prisma.rateRule.findMany({ where: { organizationId, enabled: true } });
  if (rules.length === 0) return;
  // Prefer location rules matching a nearby place, then TOU, then flat.
  const places = await prisma.place.findMany({ where: { organizationId } });
  let price = 0;
  let ruleName = '';
  let ruleId = '';
  let source: string = session.source;
  const near = places
    .filter((p) => session.lat !== null && session.lon !== null && haversineKm(session.lat as number, session.lon as number, p.lat, p.lon) <= p.radiusM / 1000)
    .sort((a, b) => a.radiusM - b.radiusM)[0];
  const locRule = rules.find((r) => r.type === 'location' && r.placeId === near?.id);
  if (locRule) {
    price = locRule.pricePerKwh;
    ruleId = locRule.id;
    ruleName = locRule.name;
  } else {
    const tou = rules.find((r) => r.type === 'tou');
    if (tou) {
      const startMin = session.startAt.getUTCHours() * 60 + session.startAt.getUTCMinutes();
      const periods = (tou.periods ?? []) as { startMin: number; endMin: number; pricePerKwh: number }[];
      const period = periods.find((p) => startMin >= p.startMin && startMin < p.endMin) ?? periods[0];
      price = period?.pricePerKwh ?? tou.pricePerKwh;
      ruleId = tou.id;
      ruleName = tou.name;
    } else {
      const flat = rules.find((r) => r.type === 'flat');
      if (flat) {
        price = flat.pricePerKwh;
        ruleId = flat.id;
        ruleName = flat.name;
      }
    }
  }
  if (near) {
    if (near.type === 'home') source = 'home';
    else if (near.type === 'work') source = 'work';
    else if (near.type === 'charger') source = 'public';
  }
  const cost = round2(session.energyAddedKwh * price);
  await prisma.chargingSession.update({
    where: { id: sessionId },
    data: { cost, rateRuleId: ruleId || undefined, rateName: ruleName || undefined, pricePerKwh: price || undefined, source },
  });
}

// ---------------------------------------------------------------------------
// Geofences
// ---------------------------------------------------------------------------

async function evaluateGeofences(vehicle: IngestVehicle, state: VehicleState): Promise<void> {
  if (typeof state.lat !== 'number' || typeof state.lon !== 'number') return;
  const fences = await prisma.geofence.findMany({ where: { organizationId: vehicle.organizationId, enabled: true } });
  for (const f of fences) {
    const inside = haversineKm(state.lat, state.lon, f.lat, f.lon) <= f.radiusM / 1000;
    const key = `${f.id}:${vehicle.id}`;
    const prev = geofenceState.get(key);
    geofenceState.set(key, inside);
    if (prev === undefined || prev === inside) continue;
    const event = inside ? 'geofence_enter' : 'geofence_leave';
    await prisma.geofence.update({ where: { id: f.id }, data: { lastTriggeredAt: new Date() } });
    await notify({
      userId: vehicle.addedById ?? '',
      event,
      severity: 'info',
      title: inside ? `${vehicle.displayName} entered ${f.name}` : `${vehicle.displayName} left ${f.name}`,
      body: inside ? `Geofence "${f.name}" was entered.` : `Geofence "${f.name}" was left.`,
      vehicleId: vehicle.id,
      vehicleName: vehicle.displayName,
    });
    void dispatchTrigger({ type: inside ? 'enter_place' : 'leave_place', userId: vehicle.addedById ?? '', vehicleId: vehicle.id, data: { fenceId: f.id } });
  }
}

// ---------------------------------------------------------------------------
// Automation triggers from state transitions
// ---------------------------------------------------------------------------

const prevTriggerState = new Map<string, Record<string, unknown>>();

async function evaluateTriggers(vehicle: IngestVehicle, state: VehicleState): Promise<void> {
  const key = vehicle.id;
  const prev = prevTriggerState.get(key) ?? {};
  const next: Record<string, unknown> = {
    battery: state.batteryPercent,
    chargingState: state.chargingState,
    plugged: state.plugConnected,
    status: state.status,
    tempC: state.insideTempC,
    anyDoorOpen: state.doors ? Object.values(state.doors).some(Boolean) : false,
  };
  prevTriggerState.set(key, next);

  if (prev.battery !== undefined && next.battery !== undefined) {
    const crossed = (Number(prev.battery) - Number(next.battery)) > 0.4; // discharging
    if (crossed && Number(next.battery) <= 20 && Number(prev.battery) > 20) {
      void dispatchTrigger({ type: 'battery_threshold', userId: vehicle.addedById ?? '', vehicleId: vehicle.id, data: { pct: next.battery } });
      await notify({ userId: vehicle.addedById ?? '', event: 'battery_low', severity: 'warning', title: 'Battery low', body: `${vehicle.displayName} is at ${Math.round(Number(next.battery))}%.`, vehicleId: vehicle.id, vehicleName: vehicle.displayName });
    }
  }
  if (prev.status && prev.status !== next.status && next.status === 'online') {
    void dispatchTrigger({ type: 'vehicle_online', userId: vehicle.addedById ?? '', vehicleId: vehicle.id, data: {} });
  }
  if (next.anyDoorOpen && prev.anyDoorOpen === false) {
    void dispatchTrigger({ type: 'door_open', userId: vehicle.addedById ?? '', vehicleId: vehicle.id, data: {} });
  }
  if (typeof next.tempC === 'number' && (next.tempC < 5 || next.tempC > 35)) {
    void dispatchTrigger({ type: 'temperature_threshold', userId: vehicle.addedById ?? '', vehicleId: vehicle.id, data: { tempC: next.tempC } });
  }
  if (prev.status && prev.status !== 'parked' && next.status === 'parked') {
    void dispatchTrigger({ type: 'vehicle_parked', userId: vehicle.addedById ?? '', vehicleId: vehicle.id, data: {} });
  }
  if (next.status === 'unknown' || (state.status === 'offline' && prev.status !== 'offline')) {
    void dispatchTrigger({ type: 'fault_detected', userId: vehicle.addedById ?? '', vehicleId: vehicle.id, data: { status: next.status } });
  }
}

// ---------------------------------------------------------------------------
// Aggregates
// ---------------------------------------------------------------------------

export async function recomputeAggregate(vehicleId: string, around: Date): Promise<void> {
  const day = new Date(Date.UTC(around.getUTCFullYear(), around.getUTCMonth(), around.getUTCDate()));
  const next = new Date(day.getTime() + 86400000);
  const [drives, charges, telemetryStats] = await Promise.all([
    prisma.drive.findMany({ where: { vehicleId, startAt: { gte: day, lt: next } }, select: { distanceKm: true, energyKwh: true } }),
    prisma.chargingSession.findMany({ where: { vehicleId, startAt: { gte: day, lt: next } }, select: { energyAddedKwh: true, cost: true } }),
    prisma.vehicleSnapshot.findUnique({ where: { vehicleId }, select: { state: true } }),
  ]);
  const distanceKm = round2(drives.reduce((s, d) => s + d.distanceKm, 0));
  const energyKwh = round2(drives.reduce((s, d) => s + d.energyKwh, 0));
  const chargeEnergyKwh = round2(charges.reduce((s, c) => s + c.energyAddedKwh, 0));
  const chargeCost = round2(charges.reduce((s, c) => s + c.cost, 0));
  const snap = telemetryStats?.state as { batteryPercent?: number } | null;
  await prisma.aggregateDaily.upsert({
    where: { vehicleId_date: { vehicleId, date: day } },
    update: { distanceKm, energyKwh, chargeEnergyKwh, chargeCost, driveCount: drives.length, chargeSessionCount: charges.length, maxBatteryPct: snap?.batteryPercent },
    create: { vehicleId, date: day, distanceKm, energyKwh, chargeEnergyKwh, chargeCost, driveCount: drives.length, chargeSessionCount: charges.length, minBatteryPct: snap?.batteryPercent, maxBatteryPct: snap?.batteryPercent },
  });
  const month = new Date(Date.UTC(around.getUTCFullYear(), around.getUTCMonth(), 1));
  const monthly = await prisma.aggregateDaily.aggregate({
    where: { vehicleId, date: { gte: month, lt: new Date(Date.UTC(around.getUTCFullYear(), around.getUTCMonth() + 1, 1)) } },
    _sum: { distanceKm: true, energyKwh: true, chargeEnergyKwh: true, chargeCost: true },
    _count: true,
  });
  await prisma.aggregateMonthly.upsert({
    where: { vehicleId_month: { vehicleId, month } },
    update: {
      distanceKm: round2(monthly._sum.distanceKm ?? 0),
      energyKwh: round2(monthly._sum.energyKwh ?? 0),
      chargeEnergyKwh: round2(monthly._sum.chargeEnergyKwh ?? 0),
      chargeCost: round2(monthly._sum.chargeCost ?? 0),
    },
    create: {
      vehicleId,
      month,
      distanceKm: round2(monthly._sum.distanceKm ?? 0),
      energyKwh: round2(monthly._sum.energyKwh ?? 0),
      chargeEnergyKwh: round2(monthly._sum.chargeEnergyKwh ?? 0),
      chargeCost: round2(monthly._sum.chargeCost ?? 0),
    },
  });
}
