// Seeds a complete, deterministic demo world for a user: vehicles, history,
// places, rates, automations, notifications, fleet, and status content.
// All data is fictional and identifiable via `demo: true` markers.

import { prisma, ensureTelemetryPartition } from '../core/db';
import { haversineKm, round2 } from '../core/geo';
import { DEMO_HOME, DEMO_WORK, DEMO_OFFICE, DEMO_SITE, DEMO_CHARGER, DEMO_VEHICLES, simulatedState } from '../providers/demo';
import { seededRng, hashString } from '../providers/types';
import { getQueue } from '../core/queue';

const DAY = 86400000;

export async function seedDemoWorld(organizationId: string, userId: string, vehicles: { id: string; providerVehicleId: string }[]): Promise<void> {
  const rng = seededRng(hashString(organizationId) ^ 0x9e3779b9);
  const now = new Date();

  // ---- Places ----
  const placeHome = await prisma.place.create({ data: { organizationId, createdById: null, name: 'Home', type: 'home', lat: DEMO_HOME.lat, lon: DEMO_HOME.lon, radiusM: 150 } });
  const placeWork = await prisma.place.create({ data: { organizationId, createdById: null, name: 'Work', type: 'work', lat: DEMO_WORK.lat, lon: DEMO_WORK.lon, radiusM: 200 } });
  const placeCharger = await prisma.place.create({ data: { organizationId, createdById: null, name: 'Rivermark Supercharge', type: 'charger', lat: DEMO_CHARGER.lat, lon: DEMO_CHARGER.lon, radiusM: 100 } });
  await prisma.place.create({ data: { organizationId, createdById: null, name: 'Hawk Ridge Trailhead', type: 'custom', lat: DEMO_SITE.lat, lon: DEMO_SITE.lon, radiusM: 300 } });

  // ---- Rate rules ----
  const tou = await prisma.rateRule.create({
    data: {
      organizationId, createdById: null, name: 'Home TOU', type: 'tou', pricePerKwh: 0.12, currency: 'USD', placeId: placeHome.id,
      periods: JSON.parse(JSON.stringify([
        { startMin: 0, endMin: 360, pricePerKwh: 0.09 },
        { startMin: 360, endMin: 960, pricePerKwh: 0.16 },
        { startMin: 960, endMin: 1260, pricePerKwh: 0.28 },
        { startMin: 1260, endMin: 1440, pricePerKwh: 0.16 },
      ])),
    },
  });
  const workFlat = await prisma.rateRule.create({ data: { organizationId, createdById: null, name: 'Work flat rate', type: 'location', pricePerKwh: 0.31, currency: 'USD', placeId: placeWork.id } });
  const fast = await prisma.rateRule.create({ data: { organizationId, createdById: null, name: 'Fast charging', type: 'location', pricePerKwh: 0.45, currency: 'USD', placeId: placeCharger.id } });

  // ---- Geofences and privacy zones ----
  await prisma.geofence.create({ data: { organizationId, createdById: null, name: 'Home', lat: DEMO_HOME.lat, lon: DEMO_HOME.lon, radiusM: 250, alertOn: 'both' } });
  await prisma.geofence.create({ data: { organizationId, createdById: null, name: 'Work', lat: DEMO_WORK.lat, lon: DEMO_WORK.lon, radiusM: 300, alertOn: 'both' } });
  await prisma.privacyZone.create({ data: { organizationId, createdById: null, name: 'Home privacy zone', lat: DEMO_HOME.lat, lon: DEMO_HOME.lon, radiusM: 400 } });

  // ---- Fleet structures ----
  const group = await prisma.fleetGroup.create({ data: { organizationId, createdById: null, name: 'Demo fleet' } });
  const deptOps = await prisma.department.create({ data: { organizationId, createdById: null, name: 'Operations' } });
  const deptSales = await prisma.department.create({ data: { organizationId, createdById: null, name: 'Field Sales' } });
  const ccOps = await prisma.costCenter.create({ data: { organizationId, createdById: null, name: 'Operations', code: 'OPS-01' } });
  const ccSales = await prisma.costCenter.create({ data: { organizationId, createdById: null, name: 'Sales', code: 'SAL-02' } });
  const drivers = [
    await prisma.driver.create({ data: { organizationId, createdById: null, name: 'Mara Voss', email: 'mara.voss@example.invalid', phone: '+1-555-0101' } }),
    await prisma.driver.create({ data: { organizationId, createdById: null, name: 'Dmitri Hale', email: 'dmitri.hale@example.invalid' } }),
    await prisma.driver.create({ data: { organizationId, createdById: null, name: 'Priya Anand', email: 'priya.anand@example.invalid' } }),
  ];
  await prisma.fleetGroupVehicle.createMany({
    data: vehicles.map((v) => ({ fleetGroupId: group.id, vehicleId: v.id })),
  });
  const bySpec = new Map(vehicles.map((v) => [v.providerVehicleId, v.id]));
  const aurora = bySpec.get('demo-aurora');
  const comet = bySpec.get('demo-comet');
  const terra = bySpec.get('demo-terra');
  const bison = bySpec.get('demo-bison');
  if (aurora) await prisma.vehicleAssignment.create({ data: { organizationId, vehicleId: aurora, driverId: drivers[0]!.id, departmentId: deptOps.id, costCenterId: ccOps.id, fromAt: new Date(now.getTime() - 30 * DAY) } });
  if (comet) await prisma.vehicleAssignment.create({ data: { organizationId, vehicleId: comet, driverId: drivers[1]!.id, departmentId: deptSales.id, costCenterId: ccSales.id, fromAt: new Date(now.getTime() - 30 * DAY) } });
  if (terra) await prisma.vehicleAssignment.create({ data: { organizationId, vehicleId: terra, driverId: drivers[2]!.id, departmentId: deptOps.id, costCenterId: ccOps.id, fromAt: new Date(now.getTime() - 30 * DAY) } });
  if (bison) await prisma.vehicleAssignment.create({ data: { organizationId, vehicleId: bison, driverId: drivers[1]!.id, departmentId: deptSales.id, costCenterId: ccSales.id, fromAt: new Date(now.getTime() - 30 * DAY) } });
  await prisma.maintenanceRecord.create({ data: { vehicleId: bison ?? vehicles[0]!.id, title: 'Annual inspection', kind: 'inspection', dueAt: new Date(now.getTime() + 14 * DAY), notes: 'Scheduled by service plan.' } });
  await prisma.maintenanceRecord.create({ data: { vehicleId: aurora ?? vehicles[0]!.id, title: 'Registration renewal', kind: 'registration', dueAt: new Date(now.getTime() + 60 * DAY) } });
  await prisma.maintenanceRecord.create({ data: { vehicleId: terra ?? vehicles[0]!.id, title: 'Tire rotation', kind: 'tires', dueOdometerKm: 15000 } });

  // ---- History: drives, charges, telemetry, aggregates ----
  const telemetryBatch: { vehicleId: string; ts: Date; data: Record<string, unknown> }[] = [];
  for (const spec of DEMO_VEHICLES) {
    const vehicleId = bySpec.get(spec.id);
    if (!vehicleId) continue;
    for (let dayOffset = 30; dayOffset >= 1; dayOffset--) {
      const dayStart = new Date(now.getTime() - dayOffset * DAY);
      const dow = dayStart.getUTCDay();
      const isWeekend = dow === 0 || dow === 6;

      const makeDrive = async (from: { lat: number; lon: number; name: string }, to: { lat: number; lon: number; name: string }, h: number, durationMin: number, pct: number) => {
        const startAt = new Date(dayStart.getTime() + h * 3600000);
        const endAt = new Date(startAt.getTime() + durationMin * 60000);
        const distance = haversineKm(from.lat, from.lon, to.lat, to.lon) * 1.35; // road factor
        const energy = (distance * spec.efficiencyWhPerKm) / 1000;
        const durationSec = durationMin * 60;
        const drive = await prisma.drive.create({
          data: {
            vehicleId, startAt, endAt,
            startLat: from.lat, startLon: from.lon, startAddress: from.name,
            endLat: to.lat, endLon: to.lon, endAddress: to.name,
            distanceKm: round2(distance), durationSec,
            avgSpeedKmh: round2((distance / durationSec) * 3600),
            maxSpeedKmh: round2(72 + rng() * 30),
            energyKwh: round2(energy),
            efficiencyWhPerKm: round2(spec.efficiencyWhPerKm * (0.92 + rng() * 0.16)),
            currency: 'USD',
            elevationGainM: Math.round(rng() * 80),
            avgOutsideTempC: round2(8 + rng() * 16),
            driverName: rng() > 0.5 ? 'Mara Voss' : rng() > 0.5 ? 'Dmitri Hale' : 'Priya Anand',
            tags: JSON.parse(JSON.stringify(rng() > 0.7 ? ['commute'] : [])),
            classification: rng() > 0.6 ? 'business' : 'personal',
          },
        });
        const pts = [];
        const steps = 12;
        for (let s = 0; s <= steps; s++) {
          const frac = s / steps;
          pts.push({
            driveId: drive.id, seq: s,
            ts: new Date(startAt.getTime() + frac * durationMin * 60000),
            lat: round2(from.lat + (to.lat - from.lat) * frac + Math.sin(frac * 9 + rng()) * 0.004),
            lon: round2(from.lon + (to.lon - from.lon) * frac + Math.cos(frac * 7 + rng()) * 0.004),
            speedKmh: round2(40 + Math.sin(frac * Math.PI) * 35),
            headingDeg: Math.round(rng() * 360),
            batteryPct: round2(pct - frac * energy * 1.4),
          });
        }
        await prisma.driveRoutePoint.createMany({ data: pts });
        return drive;
      };

      if (spec.role === 'home') {
        if (!isWeekend) {
          await makeDrive(DEMO_HOME, DEMO_WORK, 7.4, 28, 84);
          await makeDrive(DEMO_WORK, DEMO_HOME, 17.2, 30, 79);
        } else if (rng() > 0.4) {
          await makeDrive(DEMO_HOME, DEMO_CHARGER, 11, 22, 66);
        }
      } else if (spec.role === 'driver') {
        if (rng() > 0.3) await makeDrive(DEMO_HOME, { lat: 39.0734, lon: -104.6211, name: 'Lakefront Dr' }, 10.5, 26, 72);
        if (rng() > 0.3) await makeDrive({ lat: 39.0734, lon: -104.6211, name: 'Lakefront Dr' }, DEMO_HOME, 15.8, 25, 64);
      } else if (spec.role === 'office') {
        if (!isWeekend && rng() > 0.25) await makeDrive(DEMO_HOME, DEMO_OFFICE, 8.1, 31, 82);
        if (!isWeekend && rng() > 0.25) await makeDrive(DEMO_OFFICE, DEMO_HOME, 17.5, 32, 76);
      } else if (spec.role === 'offline') {
        if (isWeekend && rng() > 0.3) await makeDrive(DEMO_HOME, DEMO_SITE, 9.2, 48, 88);
        if (isWeekend && rng() > 0.3) await makeDrive(DEMO_SITE, DEMO_HOME, 16.5, 50, 62);
      }
      // charges
      if (spec.role === 'home' && !isWeekend && rng() > 0.3) {
        const startAt = new Date(dayStart.getTime() + 23.2 * 3600000);
        const energy = 8 + rng() * 20;
        await prisma.chargingSession.create({
          data: {
            vehicleId, startAt, endAt: new Date(startAt.getTime() + 5.5 * 3600000),
            locationName: DEMO_HOME.name, lat: DEMO_HOME.lat, lon: DEMO_HOME.lon,
            energyAddedKwh: round2(energy), batteryStartPct: Math.round(30 + rng() * 30), batteryEndPct: 90,
            durationSec: Math.round(5.5 * 3600), avgPowerKw: 9.4, peakPowerKw: 11.4, cost: round2(energy * 0.09), currency: 'USD',
            source: 'home', idleTimeSec: Math.round(rng() * 1800), estLossKwh: round2(energy * 0.05), rateRuleId: tou.id, rateName: tou.name, pricePerKwh: 0.09,
          },
        });
      } else if (spec.role === 'charger') {
        const startAt = new Date(dayStart.getTime() + 20 * 3600000);
        const energy = 30 + rng() * 15;
        await prisma.chargingSession.create({
          data: {
            vehicleId, startAt, endAt: new Date(startAt.getTime() + 4 * 3600000),
            locationName: DEMO_HOME.name, lat: DEMO_HOME.lat, lon: DEMO_HOME.lon,
            energyAddedKwh: round2(energy), batteryStartPct: Math.round(15 + rng() * 20), batteryEndPct: 85,
            durationSec: Math.round(4 * 3600), avgPowerKw: 10.8, peakPowerKw: 11.4, cost: round2(energy * 0.1), currency: 'USD',
            source: 'home', idleTimeSec: Math.round(rng() * 1200), estLossKwh: round2(energy * 0.06), rateRuleId: tou.id, rateName: tou.name, pricePerKwh: 0.1,
          },
        });
      } else if (spec.role === 'driver' && rng() > 0.5) {
        const startAt = new Date(dayStart.getTime() + 12 * 3600000);
        const energy = 20 + rng() * 25;
        await prisma.chargingSession.create({
          data: {
            vehicleId, startAt, endAt: new Date(startAt.getTime() + 30 * 60000),
            locationName: DEMO_CHARGER.name, lat: DEMO_CHARGER.lat, lon: DEMO_CHARGER.lon,
            energyAddedKwh: round2(energy), batteryStartPct: Math.round(10 + rng() * 30), batteryEndPct: Math.round(60 + rng() * 20),
            durationSec: 1800, avgPowerKw: 140, peakPowerKw: 210, cost: round2(energy * 0.45), currency: 'USD',
            source: 'public', idleTimeSec: 0, estLossKwh: round2(energy * 0.03), rateRuleId: fast.id, rateName: fast.name, pricePerKwh: 0.45,
          },
        });
      } else if (spec.role === 'office' && !isWeekend && rng() > 0.5) {
        const startAt = new Date(dayStart.getTime() + 9 * 3600000);
        const energy = 25 + rng() * 20;
        await prisma.chargingSession.create({
          data: {
            vehicleId, startAt, endAt: new Date(startAt.getTime() + 3 * 3600000),
            locationName: DEMO_OFFICE.name, lat: DEMO_OFFICE.lat, lon: DEMO_OFFICE.lon,
            energyAddedKwh: round2(energy), batteryStartPct: 20, batteryEndPct: 80,
            durationSec: 10800, avgPowerKw: 6.8, peakPowerKw: 7.2, cost: round2(energy * 0.31), currency: 'USD',
            source: 'work', idleTimeSec: Math.round(rng() * 3600), estLossKwh: round2(energy * 0.05), rateRuleId: workFlat.id, rateName: workFlat.name, pricePerKwh: 0.31,
          },
        });
      }
      // telemetry rows (4 per day per vehicle to keep seed fast but useful)
      for (let q = 0; q < 4; q++) {
        const ts = new Date(dayStart.getTime() + (6 + q * 5) * 3600000 + Math.round(rng() * 600) * 1000);
        const sim = simulatedState(spec, ts);
        telemetryBatch.push({
          vehicleId,
          ts,
          data: {
            b: round2(Math.max(10, (sim.batteryPercent ?? 50) + (rng() - 0.5) * 6)),
            r: sim.batteryRangeKm,
            c: sim.chargingState ?? null,
            p: sim.chargePowerKw ?? null,
            o: sim.odometerKm,
            lt: sim.lat ?? null,
            ln: sim.lon ?? null,
            sp: sim.speedKmh ?? null,
            it: sim.insideTempC ?? null,
            ot: sim.outsideTempC ?? null,
            lk: sim.locked,
            st: sim.status,
            fr: 'live',
          },
        });
      }
    }
    // aggregates for the last 30 days
    const drives = await prisma.drive.findMany({ where: { vehicleId } });
    const charges = await prisma.chargingSession.findMany({ where: { vehicleId } });
    const byDay = new Map<string, { d: number; e: number; ce: number; cc: number; dc: number; csc: number }>();
    for (const d of drives) {
      const k = d.startAt.toISOString().slice(0, 10);
      const row = byDay.get(k) ?? { d: 0, e: 0, ce: 0, cc: 0, dc: 0, csc: 0 };
      row.d += d.distanceKm;
      row.e += d.energyKwh;
      row.dc += 1;
      byDay.set(k, row);
    }
    for (const c of charges) {
      const k = c.startAt.toISOString().slice(0, 10);
      const row = byDay.get(k) ?? { d: 0, e: 0, ce: 0, cc: 0, dc: 0, csc: 0 };
      row.ce += c.energyAddedKwh;
      row.cc += c.cost;
      row.csc += 1;
      byDay.set(k, row);
    }
    for (const [k, row] of byDay) {
      const date = new Date(`${k}T00:00:00Z`);
      const month = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
      await prisma.aggregateDaily.upsert({
        where: { vehicleId_date: { vehicleId, date } },
        update: {},
        create: { vehicleId, date, distanceKm: round2(row.d), energyKwh: round2(row.e), chargeEnergyKwh: round2(row.ce), chargeCost: round2(row.cc), driveCount: row.dc, chargeSessionCount: row.csc, minBatteryPct: 20, maxBatteryPct: 90 },
      });
      void month;
    }
  }

  // Bulk-insert telemetry into the partitioned table.
  for (const t of telemetryBatch) {
    await ensureTelemetryPartition(t.ts);
  }
  const { query } = await import('../core/db');
  for (let i = 0; i < telemetryBatch.length; i += 500) {
    const chunk = telemetryBatch.slice(i, i + 500);
    const values: string[] = [];
    const params: unknown[] = [];
    chunk.forEach((t, idx) => {
      params.push(t.vehicleId, t.ts, JSON.stringify(t.data));
      values.push(`($${idx * 3 + 1}, $${idx * 3 + 2}, $${idx * 3 + 3})`);
    });
    await query(`INSERT INTO telemetry.telemetry_reading (vehicle_id, ts, data) VALUES ${values.join(',')}`, params);
  }

  // ---- Automations ----
  const auto1 = await prisma.automation.create({
    data: {
      organizationId, userId, createdById: null, name: 'Charge-complete notification', description: 'Notify when charging completes.', enabled: true,
      triggerType: 'charging_completed', triggerParams: JSON.parse('{}'),
      conditions: JSON.parse('[]'),
      actions: JSON.parse('[{"type":"notify_app","params":{"message":"Charging completed for your vehicle."}}]'),
      cooldownSec: 3600, maxRetries: 1, runCount: 4, lastResult: 'success', lastRunAt: new Date(now.getTime() - DAY),
    },
  });
  const auto2 = await prisma.automation.create({
    data: {
      organizationId, userId, createdById: null, name: 'Low battery alert', description: 'Warn when the battery falls below 20%.', enabled: true,
      triggerType: 'battery_threshold', triggerParams: JSON.parse('{"pct":20}'),
      conditions: JSON.parse('[{"type":"battery_below","params":{"pct":20}}]'),
      actions: JSON.parse('[{"type":"notify_app","params":{"message":"Battery is below 20% — plug in soon."}},{"type":"notify_email","params":{"message":"Battery is below 20%."}}]'),
      cooldownSec: 7200, maxRetries: 1, runCount: 2,
    },
  });
  const auto3 = await prisma.automation.create({
    data: {
      organizationId, userId, createdById: null, name: 'Precondition before commute', description: 'Start climate on weekday mornings.', enabled: true,
      triggerType: 'scheduled', triggerParams: JSON.parse('{"cron":"0 7 * * 1-5"}'),
      conditions: JSON.parse('[{"type":"day","params":{"days":[1,2,3,4,5]}}]'),
      actions: JSON.parse('[{"type":"climate_start","params":{}}]'),
      cooldownSec: 3600, maxRetries: 1, runCount: 9, lastRunAt: new Date(now.getTime() - 2 * 3600000),
    },
  });
  await prisma.automation.create({
    data: {
      organizationId, userId, createdById: null, name: 'Late-night door check', description: 'Alert if a door is open after 22:00.', enabled: false,
      triggerType: 'door_open', triggerParams: JSON.parse('{}'),
      conditions: JSON.parse('[{"type":"time_range","params":{"start":"22:00","end":"06:00"}}]'),
      actions: JSON.parse('[{"type":"notify_push","params":{"message":"A door is open late at night."}}]'),
      cooldownSec: 600, maxRetries: 2, runCount: 0,
    },
  });
  await prisma.automationExecution.createMany({
    data: [
      { automationId: auto1.id, triggeredAt: new Date(now.getTime() - DAY), triggerEvent: 'charging_completed', conditionsMet: true, result: 'success', actionResults: JSON.parse('[{"action":"notify_app","ok":true,"detail":"In-app notification queued"}]') },
      { automationId: auto1.id, triggeredAt: new Date(now.getTime() - 3 * DAY), triggerEvent: 'charging_completed', conditionsMet: true, result: 'success', actionResults: JSON.parse('[{"action":"notify_app","ok":true,"detail":"In-app notification queued"}]') },
      { automationId: auto2.id, triggeredAt: new Date(now.getTime() - 2 * DAY), triggerEvent: 'battery_threshold', conditionsMet: true, result: 'success', actionResults: JSON.parse('[{"action":"notify_app","ok":true,"detail":"In-app notification queued"}]') },
      { automationId: auto3.id, triggeredAt: new Date(now.getTime() - 2 * 3600000), triggerEvent: 'scheduled', conditionsMet: true, result: 'success', actionResults: JSON.parse('[{"action":"climate_start","ok":true,"detail":"Vehicle command accepted"}]') },
    ],
  });

  // ---- Notifications ----
  await prisma.appNotification.createMany({
    data: [
      { userId, event: 'charging_completed', severity: 'success', title: 'Charging complete', body: 'Terra finished charging to 85%.', vehicleId: terra ?? '', vehicleName: 'Terra', createdAt: new Date(now.getTime() - 3 * 3600000) },
      { userId, event: 'geofence_enter', severity: 'info', title: 'Aurora arrived home', body: 'Geofence "Home" was entered.', vehicleId: aurora ?? '', vehicleName: 'Aurora', createdAt: new Date(now.getTime() - 20 * 3600000) },
      { userId, event: 'automation_fired', severity: 'info', title: 'Automation ran', body: 'Precondition before commute executed.', createdAt: new Date(now.getTime() - 2 * 3600000) },
      { userId, event: 'command_failed', severity: 'warning', title: 'Command failed', body: 'Bison: Open trunk was rejected (vehicle offline).', vehicleId: bison ?? '', vehicleName: 'Bison', createdAt: new Date(now.getTime() - DAY) },
      { userId, event: 'system', severity: 'info', title: 'Welcome to VoltLink', body: 'Your demo fleet is ready. Explore the vehicles, drives, and charging analytics.', createdAt: new Date(now.getTime() - 30 * DAY) },
    ],
  });

  // ---- Status components, incidents, maintenance ----
  await seedStatusContent();

  // ---- Snapshot the demo states now ----
  const { ingestVehicleState } = await import('../telemetry/ingest');
  for (const spec of DEMO_VEHICLES) {
    const vehicleId = bySpec.get(spec.id);
    if (!vehicleId) continue;
    const vehicle = await prisma.vehicle.findUnique({ where: { id: vehicleId }, include: { snapshot: true, providerAccount: true } });
    if (!vehicle) continue;
    const state = simulatedState(spec, now);
    await ingestVehicleState(vehicle, { ...state, vehicleId: vehicle.id, provider: 'demo', providerVehicleId: spec.id, fetchedAt: now.toISOString() }, { live: true });
  }

  // ---- A couple of demo commands in history ----
  if (aurora) {
    await prisma.vehicleCommand.create({
      data: {
        organizationId, vehicleId: aurora, vehicleName: 'Aurora', providerAccountId: (await prisma.vehicle.findUniqueOrThrow({ where: { id: aurora } })).providerAccountId,
        userId, type: 'lock', params: JSON.parse('{}'), status: 'confirmed', risk: 'low', idempotencyKey: `seed:${aurora}:lock`, confirmed: true,
        createdAt: new Date(now.getTime() - DAY), submittedAt: new Date(now.getTime() - DAY + 1000), completedAt: new Date(now.getTime() - DAY + 9000),
      },
    });
  }
  if (bison) {
    await prisma.vehicleCommand.create({
      data: {
        organizationId, vehicleId: bison, vehicleName: 'Bison', providerAccountId: (await prisma.vehicle.findUniqueOrThrow({ where: { id: bison } })).providerAccountId,
        userId, type: 'open_trunk', params: JSON.parse('{}'), status: 'rejected', risk: 'low', idempotencyKey: `seed:${bison}:trunk`,
        errorMessage: 'Vehicle is offline.', createdAt: new Date(now.getTime() - DAY), completedAt: new Date(now.getTime() - DAY + 4000),
      },
    });
    await prisma.vehicleCommand.create({
      data: {
        organizationId, vehicleId: bison, vehicleName: 'Bison', providerAccountId: (await prisma.vehicle.findUniqueOrThrow({ where: { id: bison } })).providerAccountId,
        userId, type: 'wake', params: JSON.parse('{}'), status: 'timed_out', risk: 'low', idempotencyKey: `seed:${bison}:wake`,
        errorMessage: 'Vehicle did not confirm the command within the timeout.', createdAt: new Date(now.getTime() - 2 * DAY), completedAt: new Date(now.getTime() - 2 * DAY + 61000),
      },
    });
  }

  void getQueue().enqueue('demo', { userId, kind: 'seeded' }, { dedupeKey: `demo-seed:${userId}` });
}

export async function seedStatusContent(): Promise<void> {
  const components = [
    { key: 'web', name: 'Web application', group: 'Core', description: 'The VoltLink web application and API.' },
    { key: 'auth', name: 'Authentication', group: 'Core' },
    { key: 'postgres', name: 'PostgreSQL', group: 'Data' },
    { key: 'redis', name: 'Redis / job queue', group: 'Data' },
    { key: 'workers', name: 'Background workers', group: 'Core' },
    { key: 'scheduler', name: 'Scheduler', group: 'Core' },
    { key: 'telemetry', name: 'Telemetry ingestion', group: 'Vehicle' },
    { key: 'commands', name: 'Command service', group: 'Vehicle' },
    { key: 'automations', name: 'Automation engine', group: 'Vehicle' },
    { key: 'notifications', name: 'Notification delivery', group: 'Vehicle' },
    { key: 'realtime', name: 'Real-time updates', group: 'Core' },
    { key: 'maps', name: 'Map service', group: 'Integrations' },
    { key: 'tesla', name: 'Tesla provider', group: 'Providers' },
    { key: 'tessie', name: 'Tessie provider (optional)', group: 'Providers' },
    { key: 'demo', name: 'Demo provider', group: 'Providers' },
  ];
  for (const c of components) {
    await prisma.statusComponent.upsert({
      where: { key: c.key },
      update: {},
      create: { ...c, status: 'operational' },
    });
  }
  const existing = await prisma.incident.count();
  if (existing === 0) {
    const now = new Date();
    const active = await prisma.incident.create({
      data: {
        title: 'Demo provider sync delays',
        severity: 'minor',
        status: 'investigating',
        phases: JSON.parse(JSON.stringify({ investigating: new Date(now.getTime() - 25 * 60000).toISOString(), identified: null, monitoring: null, resolved: null })),
        components: JSON.parse(JSON.stringify(['demo'])),
        public: true,
        createdAt: new Date(now.getTime() - 25 * 60000),
      },
    });
    await prisma.incidentUpdate.create({
      data: { incidentId: active.id, phase: 'investigating', message: 'We are investigating delayed syncs from the demo provider.', author: 'VoltLink', createdAt: new Date(now.getTime() - 25 * 60000) },
    });
    const resolved = await prisma.incident.create({
      data: {
        title: 'Notification delivery delays',
        severity: 'minor',
        status: 'resolved',
        phases: JSON.parse(JSON.stringify({
          investigating: new Date(now.getTime() - 8 * DAY).toISOString(),
          identified: new Date(now.getTime() - 8 * DAY + 20 * 60000).toISOString(),
          monitoring: new Date(now.getTime() - 8 * DAY + 45 * 60000).toISOString(),
          resolved: new Date(now.getTime() - 8 * DAY + 90 * 60000).toISOString(),
        })),
        components: JSON.parse(JSON.stringify(['notifications'])),
        public: true,
        createdAt: new Date(now.getTime() - 8 * DAY),
      },
    });
    await prisma.incidentUpdate.createMany({
      data: [
        { incidentId: resolved.id, phase: 'investigating', message: 'Some email deliveries were delayed.', author: 'VoltLink', createdAt: new Date(now.getTime() - 8 * DAY) },
        { incidentId: resolved.id, phase: 'identified', message: 'The mail relay queue was backed up.', author: 'VoltLink', createdAt: new Date(now.getTime() - 8 * DAY + 20 * 60000) },
        { incidentId: resolved.id, phase: 'resolved', message: 'Queue drained and delivery returned to normal.', author: 'VoltLink', createdAt: new Date(now.getTime() - 8 * DAY + 90 * 60000) },
      ],
    });
  }
  const maintCount = await prisma.maintenanceWindow.count();
  if (maintCount === 0) {
    await prisma.maintenanceWindow.create({
      data: {
        title: 'Database maintenance',
        description: 'Routine index optimization.',
        startsAt: new Date(Date.now() + 3 * DAY),
        endsAt: new Date(Date.now() + 3 * DAY + 2 * 3600000),
        components: JSON.parse(JSON.stringify(['postgres'])),
        status: 'scheduled',
      },
    });
  }
  // status check history (last 24h, hourly)
  const checkCount = await prisma.statusCheck.count({ where: { at: { gt: new Date(Date.now() - DAY) } } });
  if (checkCount === 0) {
    const rows = [];
    for (const c of components) {
      for (let h = 24; h >= 0; h--) {
        rows.push({
          componentKey: c.key,
          at: new Date(Date.now() - h * 3600000),
          ok: c.key !== 'demo' || h > 1,
          latencyMs: 40 + Math.round(Math.random() * 160),
          detail: c.key === 'demo' && h <= 1 ? 'Simulated sync delay' : 'OK',
        });
      }
    }
    await prisma.statusCheck.createMany({ data: rows });
  }
}
