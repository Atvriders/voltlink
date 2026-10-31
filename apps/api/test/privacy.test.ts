// Privacy-zone redaction tests (Z-PRIVZONE, guide 05 §7.1/§7.2) and real
// account deletion (Z-DELETE, §7.5). Each test builds and cleans its own rows.

process.env.NODE_ENV = 'test';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import type { Server } from 'node:http';
import { prisma, ensureTelemetryPartition } from '../src/core/db';
import { randomId } from '../src/core/crypto';
import { ingestVehicleState } from '../src/telemetry/ingest';
import { zonesForOrg, invalidateZonesForOrg } from '../src/privacy/zones';
import { runPrivacyRedaction } from '../src/jobs/privacy-redaction';
import { runAccountDeletion } from '../src/jobs/account-deletion';

let server: Server;

beforeAll(async () => {
  server = buildApp({ serveSpa: false }).listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
});

const ZONE_POINT = { lat: 35.0, lon: -90.0 }; // inside the zone below
const OUT_POINT = { lat: 35.5, lon: -90.5 }; // outside

async function makeOrgWithVehicle(prefix: string) {
  const stamp = Date.now();
  const user = await prisma.user.create({
    data: { email: `${prefix}-${stamp}@example.test`, name: 'P', passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$s$s', webauthnUserId: randomId() },
  });
  const org = await prisma.organization.create({
    data: { kind: 'PERSONAL', name: 'P', createdById: user.id, memberships: { create: { userId: user.id, role: 'OWNER' } } },
  });
  const provider = await prisma.providerAccount.create({ data: { organizationId: org.id, provider: 'mock', label: 'm', status: 'connected', demo: false } });
  const vehicle = await prisma.vehicle.create({
    data: { organizationId: org.id, providerAccountId: provider.id, provider: 'mock', providerVehicleId: randomId(), displayName: 'V', demo: false },
  });
  return { user, org, vehicle, cleanup: async () => { await prisma.organization.deleteMany({ where: { id: org.id } }).catch(() => undefined); await prisma.user.deleteMany({ where: { id: user.id } }).catch(() => undefined); } };
}

function state(lat: number, lon: number) {
  return {
    vehicleId: 'x',
    provider: 'mock',
    providerVehicleId: 'y',
    fetchedAt: new Date().toISOString(),
    lat,
    lon,
    address: '123 Example St',
    batteryPercent: 60,
    chargingState: 'stopped' as const,
    status: 'online' as const,
  };
}

describe('Z-PRIVZONE: redaction at ingest', () => {
  it('nulls in-zone coordinates in snapshot, telemetry and location', async () => {
    const { vehicle, cleanup } = await makeOrgWithVehicle('priv-ingest');
    const zone = await prisma.privacyZone.create({
      data: { organizationId: vehicle.organizationId, name: 'Home', lat: 35.0, lon: -90.0, radiusM: 500, enabled: true },
    });
    invalidateZonesForOrg(vehicle.organizationId);

    await ingestVehicleState({ id: vehicle.id, organizationId: vehicle.organizationId, displayName: 'V', demo: false, addedById: null }, state(ZONE_POINT.lat, ZONE_POINT.lon) as never, { live: true });

    const snap = await prisma.vehicleSnapshot.findUniqueOrThrow({ where: { vehicleId: vehicle.id } });
    const sState = snap.state as Record<string, unknown>;
    expect(sState.lat).toBeNull();
    expect(sState.lon).toBeNull();
    expect(sState.address).toBeNull();
    expect(sState.privacyZoneId).toBe(zone.id);

    const telemetry = await prisma.$queryRawUnsafe<{ data: Record<string, unknown> }[]>(
      `SELECT data FROM telemetry.telemetry_reading WHERE vehicle_id = $1 ORDER BY ts DESC LIMIT 1`,
      vehicle.id,
    );
    expect(telemetry[0]!.data.lt).toBeNull();
    expect(telemetry[0]!.data.ln).toBeNull();
    expect(telemetry[0]!.data.pz).toBe(zone.id);

    const location = await prisma.vehicleLocation.findUniqueOrThrow({ where: { vehicleId: vehicle.id } });
    expect(location.lat).toBeNull();
    expect(location.lon).toBeNull();
    expect(location.privacyZoneId).toBe(zone.id);

    // Outside the zone, raw coordinates are stored.
    await ingestVehicleState({ id: vehicle.id, organizationId: vehicle.organizationId, displayName: 'V', demo: false, addedById: null }, state(OUT_POINT.lat, OUT_POINT.lon) as never, { live: true });
    const outside = await prisma.vehicleLocation.findUniqueOrThrow({ where: { vehicleId: vehicle.id } });
    expect(outside.lat).toBe(OUT_POINT.lat);
    expect(outside.lon).toBe(OUT_POINT.lon);
    expect(outside.privacyZoneId).toBeNull();

    await cleanup();
  });
});

describe('Z-PRIVZONE: retroactive redaction job', () => {
  it('redacts drives, route points, charging, location, telemetry and snapshots', async () => {
    const { vehicle, cleanup } = await makeOrgWithVehicle('priv-retro');
    const zone = await prisma.privacyZone.create({
      data: { organizationId: vehicle.organizationId, name: 'Retro', lat: 35.0, lon: -90.0, radiusM: 500, enabled: true },
    });

    const drive = await prisma.drive.create({
      data: { vehicleId: vehicle.id, startAt: new Date(), endAt: new Date(Date.now() + 1000), startLat: 35.0, startLon: -90.0, endLat: 35.5, endLon: -90.5, distanceKm: 60, durationSec: 3600, avgSpeedKmh: 60, maxSpeedKmh: 90, energyKwh: 10, efficiencyWhPerKm: 166 },
    });
    await prisma.driveRoutePoint.createMany({ data: [
      { driveId: drive.id, seq: 0, ts: new Date(), lat: 35.0, lon: -90.0, speedKmh: 50, headingDeg: 0 },
      { driveId: drive.id, seq: 1, ts: new Date(Date.now() + 1000), lat: 35.5, lon: -90.5, speedKmh: 60, headingDeg: 90 },
    ] });
    await prisma.chargingSession.create({ data: { vehicleId: vehicle.id, startAt: new Date(), lat: 35.0, lon: -90.0, locationName: 'Home', energyAddedKwh: 1 } });
    await prisma.vehicleLocation.create({ data: { vehicleId: vehicle.id, ts: new Date(), lat: 35.0, lon: -90.0, address: 'Secret' } });
    const ts = new Date();
    await ensureTelemetryPartition(ts);
    await prisma.$executeRawUnsafe(
      `INSERT INTO telemetry.telemetry_reading (vehicle_id, ts, data) VALUES ($1, $2, $3::jsonb)`,
      vehicle.id, ts, JSON.stringify({ lt: 35.0, ln: -90.0, b: 60 }),
    );
    await prisma.vehicleSnapshot.create({ data: { vehicleId: vehicle.id, state: { lat: 35.0, lon: -90.0, address: 'Secret' } as unknown as object, fetchedAt: new Date(), freshness: 'live' } });

    const counts = await runPrivacyRedaction(zone.id);

    expect(counts.drives).toBe(1);
    expect(counts.routePoints).toBe(1);
    expect(counts.chargingSessions).toBe(1);
    expect(counts.locations).toBe(1);
    expect(counts.telemetry).toBe(1);
    expect(counts.snapshots).toBe(1);

    const d = await prisma.drive.findUniqueOrThrow({ where: { id: drive.id } });
    expect(d.startLat).toBeNull();
    expect(d.startPrivacyZoneId).toBe(zone.id);
    expect(d.endLat).toBe(35.5); // outside endpoint untouched
    const points = await prisma.driveRoutePoint.findMany({ where: { driveId: drive.id } });
    expect(points).toHaveLength(1);
    expect(points[0]!.lat).toBe(35.5);
    const cs = await prisma.chargingSession.findFirstOrThrow({ where: { vehicleId: vehicle.id } });
    expect(cs.lat).toBeNull();
    expect(cs.privacyZoneId).toBe(zone.id);
    const loc = await prisma.vehicleLocation.findUniqueOrThrow({ where: { vehicleId: vehicle.id } });
    expect(loc.lat).toBeNull();
    expect(loc.privacyZoneId).toBe(zone.id);
    const tel = await prisma.$queryRawUnsafe<{ data: Record<string, unknown> }[]>(`SELECT data FROM telemetry.telemetry_reading WHERE vehicle_id = $1`, vehicle.id);
    expect(tel[0]!.data.lt).toBeNull();
    expect(tel[0]!.data.pz).toBe(zone.id);
    const snap = await prisma.vehicleSnapshot.findUniqueOrThrow({ where: { vehicleId: vehicle.id } });
    expect((snap.state as Record<string, unknown>).lat).toBeNull();

    const after = await prisma.privacyZone.findUniqueOrThrow({ where: { id: zone.id } });
    expect(after.redactedThrough).not.toBeNull();

    // Disabled zones are a no-op.
    await prisma.privacyZone.update({ where: { id: zone.id }, data: { enabled: false } });
    const again = await runPrivacyRedaction(zone.id);
    expect(again.drives).toBe(0);

    await cleanup();
  });
});

describe('Z-PRIVZONE: zone cache', () => {
  it('invalidates on zone writes', async () => {
    const { vehicle, cleanup } = await makeOrgWithVehicle('priv-cache');
    const zonesBefore = await zonesForOrg(vehicle.organizationId);
    expect(zonesBefore).toHaveLength(0);
    const zone = await prisma.privacyZone.create({ data: { organizationId: vehicle.organizationId, name: 'C', lat: 1, lon: 1, radiusM: 100, enabled: true } });
    invalidateZonesForOrg(vehicle.organizationId);
    const zonesAfter = await zonesForOrg(vehicle.organizationId);
    expect(zonesAfter.map((z) => z.id)).toContain(zone.id);
    await cleanup();
  });
});

describe('Z-DELETE: account-deletion job', () => {
  it('deletes sole-member organizations and pseudonymizes commands elsewhere', async () => {
    const { user, org, vehicle, cleanup } = await makeOrgWithVehicle('deletion');
    // Second org where the user is NOT the only member.
    const other = await prisma.user.create({ data: { email: `deletion-other-${Date.now()}@example.test`, name: 'O', passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$s$s', webauthnUserId: randomId() } });
    const sharedOrg = await prisma.organization.create({ data: { kind: 'TEAM', name: 'S', createdById: user.id, memberships: { create: [{ userId: user.id, role: 'OWNER' }, { userId: other.id, role: 'VIEWER' }] } } });
    const sharedProvider = await prisma.providerAccount.create({ data: { organizationId: sharedOrg.id, provider: 'mock', label: 'm', status: 'connected', demo: false } });
    const sharedVehicle = await prisma.vehicle.create({ data: { organizationId: sharedOrg.id, providerAccountId: sharedProvider.id, provider: 'mock', providerVehicleId: randomId(), displayName: 'S', demo: false } });
    const command = await prisma.vehicleCommand.create({ data: { organizationId: sharedOrg.id, userId: user.id, vehicleId: sharedVehicle.id, vehicleName: 'S', providerAccountId: sharedProvider.id, actorKind: 'session', type: 'lock', params: {}, status: 'confirmed', risk: 'low', idempotencyKey: randomId() } });
    await prisma.auditLog.create({ data: { actorId: user.id, ip: '1.2.3.4', action: 'x', organizationId: sharedOrg.id } });
    const ts = new Date();
    await ensureTelemetryPartition(ts);
    await prisma.$executeRawUnsafe(`INSERT INTO telemetry.telemetry_reading (vehicle_id, ts, data) VALUES ($1, $2, $3::jsonb)`, vehicle.id, ts, JSON.stringify({ b: 1 }));
    await prisma.user.update({ where: { id: user.id }, data: { deletionRequestedAt: new Date() } });

    const result = await runAccountDeletion(user.id);

    expect(result.soleOrganizations).toBe(1);
    expect(await prisma.organization.count({ where: { id: org.id } })).toBe(0); // sole org gone (cascade)
    expect(await prisma.user.count({ where: { id: user.id } })).toBe(0);
    // Shared org survives; the user's command is pseudonymized; audit IP nulled.
    expect(await prisma.organization.count({ where: { id: sharedOrg.id } })).toBe(1);
    const cmd = await prisma.vehicleCommand.findUniqueOrThrow({ where: { id: command.id } });
    expect(cmd.userId).toBe('deleted-user');
    // User deletion sets audit actorId to NULL (SetNull) and nulls the IP.
    const log = await prisma.auditLog.findFirstOrThrow({ where: { organizationId: sharedOrg.id, action: 'x' } });
    expect(log.actorId).toBeNull();
    expect(log.ip).toBeNull();
    const tel = await prisma.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM telemetry.telemetry_reading WHERE vehicle_id = $1`, vehicle.id);
    expect(tel[0]!.n).toBe(0);

    await prisma.organization.deleteMany({ where: { id: sharedOrg.id } }).catch(() => undefined);
    await prisma.user.deleteMany({ where: { id: other.id } }).catch(() => undefined);
    await cleanup().catch(() => undefined);
  });

  it('is idempotent and no-ops without deletionRequestedAt', async () => {
    const { user, cleanup } = await makeOrgWithVehicle('deletion-idem');
    const result = await runAccountDeletion(user.id);
    expect(result.soleOrganizations).toBe(0);
    expect(await prisma.user.count({ where: { id: user.id } })).toBe(1);
    await cleanup();
  });
});
