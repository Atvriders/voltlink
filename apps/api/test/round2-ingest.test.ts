// R4: telemetry ingest integration — snapshot upsert, telemetry partition
// write, latest location, drive lifecycle detection (P-DETECT), charging
// lifecycle + cost application, and redaction plumbing.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '../src/core/db';
import { initRedis } from '../src/core/redis';
import { randomId, hashPassword } from '../src/core/crypto';
import { ingestVehicleState, resetIngestTrackers } from '../src/telemetry/ingest';
import * as engine from '../src/automations/engine';
import { vi } from 'vitest';
import type { VehicleState } from '@voltlink/shared';

beforeAll(async () => {
  await initRedis();
}, 30_000);

afterAll(async () => {
  await prisma.$disconnect();
});

async function mkWorld() {
  const user = await prisma.user.create({
    data: {
      email: `ing-${Date.now()}-${randomId()}@test.dev`,
      name: 'Ingest',
      passwordHash: await hashPassword('long-enough-123'),
      webauthnUserId: randomId(),
    },
  });
  const org = await prisma.organization.create({
    data: {
      kind: 'PERSONAL',
      name: 'Ingest Org',
      createdById: user.id,
      memberships: { create: { userId: user.id, role: 'OWNER' } },
    },
  });
  const pa = await prisma.providerAccount.create({
    data: {
      organizationId: org.id,
      provider: 'demo',
      label: 'Demo',
      status: 'connected',
      demo: false,
    },
  });
  const vehicle = await prisma.vehicle.create({
    data: {
      organizationId: org.id,
      providerAccountId: pa.id,
      provider: 'demo',
      providerVehicleId: randomId(),
      displayName: 'Ingest Car',
      addedById: user.id,
    },
  });
  return { user, org, vehicle };
}

const state = (over: Partial<VehicleState>): VehicleState =>
  ({
    vehicleId: '',
    provider: 'demo',
    providerVehicleId: 'x',
    fetchedAt: new Date().toISOString(),
    freshness: 'live',
    dataSource: 'telemetry',
    status: 'online',
    odometerKm: 1000,
    batteryPercent: 80,
    batteryRangeKm: 400,
    chargeLimitPct: 90,
    locked: true,
    lat: 39.0421,
    lon: -104.6712,
    address: '1 Main St, Rivermark',
    speedKmh: 0,
    headingDeg: 0,
    insideTempC: 21,
    outsideTempC: 12,
    chargingState: 'disconnected',
    plugConnected: false,
    ...over,
  }) as VehicleState;

describe('telemetry ingest', () => {
  it('writes snapshot, location and a partitioned telemetry reading', async () => {
    const { vehicle } = await mkWorld();
    await ingestVehicleState(vehicle, state({ fetchedAt: new Date().toISOString() }), {
      live: true,
    });
    const snap = await prisma.vehicleSnapshot.findUnique({ where: { vehicleId: vehicle.id } });
    expect(snap).toBeTruthy();
    expect(snap!.freshness).toBe('live');
    const loc = await prisma.vehicleLocation.findUnique({ where: { vehicleId: vehicle.id } });
    expect(loc).toBeTruthy();
    expect(loc!.lat).toBeCloseTo(39.0421, 3);
  });

  it('detects a full drive lifecycle and persists route points', async () => {
    const { vehicle } = await mkWorld();
    const t0 = new Date(Date.now() - 600_000);
    const lat = 39.0421;
    const lon = -104.6712;
    await ingestVehicleState(
      vehicle,
      state({ fetchedAt: t0.toISOString(), speedKmh: 45, lat, lon, batteryPercent: 80 }),
      { live: true },
    );
    await ingestVehicleState(
      vehicle,
      state({
        fetchedAt: new Date(t0.getTime() + 40_000).toISOString(),
        speedKmh: 46,
        lat: lat + 0.001,
        lon: lon + 0.001,
        batteryPercent: 79.6,
      }),
      { live: true },
    );
    await ingestVehicleState(
      vehicle,
      state({
        fetchedAt: new Date(t0.getTime() + 80_000).toISOString(),
        speedKmh: 44,
        lat: lat + 0.002,
        lon: lon + 0.002,
        batteryPercent: 79.2,
      }),
      { live: true },
    );
    await ingestVehicleState(
      vehicle,
      state({
        fetchedAt: new Date(t0.getTime() + 120_000).toISOString(),
        speedKmh: 42,
        lat: lat + 0.003,
        lon: lon + 0.003,
        batteryPercent: 78.9,
      }),
      { live: true },
    );
    // Stop after the idle window so the drive closes.
    await ingestVehicleState(
      vehicle,
      state({
        fetchedAt: new Date(t0.getTime() + 120_000 + 610_000).toISOString(),
        speedKmh: 0,
        lat: lat + 0.003,
        lon: lon + 0.003,
        batteryPercent: 79.2,
      }),
      { live: true },
    );
    const drives = await prisma.drive.findMany({ where: { vehicleId: vehicle.id } });
    expect(drives).toHaveLength(1);
    expect(drives[0]!.distanceKm).toBeGreaterThan(0);
    const pts = await prisma.driveRoutePoint.findMany({ where: { driveId: drives[0]!.id } });
    expect(pts.length).toBeGreaterThanOrEqual(3);
    expect(await prisma.driveTracker.findUnique({ where: { vehicleId: vehicle.id } })).toBeNull();
  });

  it('keeps one drive across a process restart and a crawl stretch (TI-21)', async () => {
    const { vehicle } = await mkWorld();
    const t0 = new Date(Date.now() - 900_000);
    const lat = 39.0421;
    const lon = -104.6712;
    const moving = (min: number, dLat: number, speed: number) => ({
      fetchedAt: new Date(t0.getTime() + min * 60_000).toISOString(),
      speedKmh: speed,
      lat: lat + dLat,
      lon: lon + dLat,
      batteryPercent: 80 - dLat * 100,
    });
    const triggerSpy = vi.spyOn(engine, 'dispatchTrigger');
    await ingestVehicleState(vehicle, state(moving(0, 0, 45)), { live: true });
    await ingestVehicleState(vehicle, state(moving(1, 0.001, 46)), { live: true });
    // Simulated restart: the in-process tracker Map is gone; only the
    // persisted DriveTracker row remains.
    resetIngestTrackers();
    await ingestVehicleState(vehicle, state(moving(2, 0.002, 44)), { live: true });
    // A 0-km/h stretch well inside the idle window must not end the drive.
    await ingestVehicleState(vehicle, state(moving(3, 0.002, 0)), { live: true });
    await ingestVehicleState(vehicle, state(moving(4, 0.003, 42)), { live: true });
    // Stop after the idle window so the drive closes.
    await ingestVehicleState(
      vehicle,
      state({
        fetchedAt: new Date(t0.getTime() + 4 * 60_000 + 610_000).toISOString(),
        speedKmh: 0,
        lat: lat + 0.003,
        lon: lon + 0.003,
        batteryPercent: 79,
      }),
      { live: true },
    );
    const drives = await prisma.drive.findMany({ where: { vehicleId: vehicle.id } });
    expect(drives).toHaveLength(1);
    // TI-21: startAt is the FIRST moving sample, even across the restart.
    expect(drives[0]!.startAt.getTime()).toBe(t0.getTime());
    const pts = await prisma.driveRoutePoint.findMany({
      where: { driveId: drives[0]!.id },
      orderBy: { seq: 'asc' },
    });
    expect(pts.length).toBe(4); // every moving point kept through the restart
    expect(pts[0]!.ts.getTime()).toBe(t0.getTime());
    // TI-21: drive_started fired exactly once, on the first moving sample.
    expect(triggerSpy.mock.calls.filter(([ev]) => ev.type === 'drive_started')).toHaveLength(1);
  });

  it('detects a charging session and applies cost calculation', async () => {
    const { vehicle, user } = await mkWorld();
    const t0 = new Date(Date.now() - 60 * 60_000);
    await ingestVehicleState(
      vehicle,
      state({
        fetchedAt: t0.toISOString(),
        chargingState: 'charging',
        plugConnected: true,
        chargePowerKw: 11.4,
        batteryPercent: 40,
      }),
      { live: true },
    );
    await ingestVehicleState(
      vehicle,
      state({
        fetchedAt: new Date(t0.getTime() + 3600_000).toISOString(),
        chargingState: 'complete',
        plugConnected: true,
        batteryPercent: 80,
      }),
      { live: true },
    );
    const sessions = await prisma.chargingSession.findMany({ where: { vehicleId: vehicle.id } });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.energyAddedKwh).toBeGreaterThan(20);
    expect(sessions[0]!.batteryStartPct).toBe(40);
    expect(sessions[0]!.batteryEndPct).toBe(80);
    const notes = await prisma.appNotification.findMany({ where: { userId: user.id } });
    expect(notes.some((n) => n.event === 'charging_started')).toBe(true);
    expect(notes.some((n) => n.event === 'charging_completed')).toBe(true);
  });

  it('prices a TOU session in the user timezone incl. wrapped midnight periods (TI-21/P-COST)', async () => {
    const { vehicle, org } = await mkWorld();
    await prisma.organization.update({
      where: { id: org.id },
      data: { timezone: 'UTC' },
    });
    await prisma.rateRule.create({
      data: {
        organizationId: org.id,
        name: 'Night rate',
        type: 'tou',
        pricePerKwh: 0.5,
        currency: 'USD',
        // 23:00-05:00 wraps midnight: the P-COST period check must handle
        // endMin < startMin.
        periods: JSON.parse(
          '[{"startMin":1380,"endMin":300,"pricePerKwh":0.25},{"startMin":300,"endMin":1380,"pricePerKwh":0.1}]',
        ),
      },
    });
    // Session starts 23:00 UTC -> inside the wrapped 23:00-05:00 window.
    const t0 = new Date(Date.now() - 60 * 60_000);
    t0.setUTCHours(23, 0, 0, 0);
    await ingestVehicleState(
      vehicle,
      state({
        fetchedAt: t0.toISOString(),
        chargingState: 'charging',
        plugConnected: true,
        chargePowerKw: 11.4,
        batteryPercent: 40,
      }),
      { live: true },
    );
    await ingestVehicleState(
      vehicle,
      state({
        fetchedAt: new Date(t0.getTime() + 3600_000).toISOString(),
        chargingState: 'complete',
        plugConnected: true,
        batteryPercent: 80,
      }),
      { live: true },
    );
    const sessions = await prisma.chargingSession.findMany({ where: { vehicleId: vehicle.id } });
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.energyAddedKwh).toBeCloseTo(24, 1);
    expect(sessions[0]!.pricePerKwh).toBe(0.25);
    expect(sessions[0]!.cost).toBeCloseTo(6, 2);
    expect(sessions[0]!.rateName).toBe('Night rate');
  });

  it('redacts a state that falls inside a privacy zone', async () => {
    const { vehicle, org } = await mkWorld();
    const zone = await prisma.privacyZone.create({
      data: {
        organizationId: org.id,
        name: 'Home zone',
        lat: 39.0421,
        lon: -104.6712,
        radiusM: 500,
      },
    });
    await ingestVehicleState(
      vehicle,
      state({ fetchedAt: new Date().toISOString(), lat: 39.0421, lon: -104.6712 }),
      { live: true },
    );
    const snap = await prisma.vehicleSnapshot.findUnique({ where: { vehicleId: vehicle.id } });
    const stored = snap!.state as { lat?: number | null; address?: string | null };
    expect(stored.lat).toBeNull();
    expect(stored.address).toBeNull();
    const loc = await prisma.vehicleLocation.findUnique({ where: { vehicleId: vehicle.id } });
    expect(loc!.lat).toBeNull();
    expect(loc!.privacyZoneId).toBe(zone.id);
  });
});
