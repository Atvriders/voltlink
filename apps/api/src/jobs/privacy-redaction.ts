// Retroactive privacy-zone redaction job (Z-PRIVZONE, guide 05 §7.2). Runs as
// the system actor: nulls in-zone coordinates in drives, charging sessions,
// locations and telemetry, re-redacts stored snapshots, records redactedThrough
// and audits counts — never the coordinates themselves.

import { prisma } from '../core/db';
import { audit } from '../core/settings';

const H = `2*6371000*asin(sqrt(power(sin(radians((lat-$2)/2)),2) + cos(radians($2))*cos(radians(lat))*power(sin(radians((lon-$3)/2)),2)))`;

const PARTITION_NAME_RE = /^telemetry_\d{4}_\d{2}$/;

export interface RedactionCounts {
  drives: number;
  routePoints: number;
  chargingSessions: number;
  locations: number;
  telemetry: number;
  snapshots: number;
}

async function listTelemetryPartitions(): Promise<string[]> {
  const rows = await prisma.$queryRawUnsafe<{ relname: string }[]>(
    `SELECT c.relname FROM pg_inherits i
      JOIN pg_class c ON c.oid = i.inhrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE i.inhparent = 'telemetry.telemetry_reading'::regclass AND n.nspname = 'telemetry'`,
  );
  return rows.map((r) => r.relname).filter((n) => PARTITION_NAME_RE.test(n));
}

export async function runPrivacyRedaction(zoneId: string): Promise<RedactionCounts> {
  const zone = await prisma.privacyZone.findUnique({ where: { id: zoneId } });
  const counts: RedactionCounts = {
    drives: 0,
    routePoints: 0,
    chargingSessions: 0,
    locations: 0,
    telemetry: 0,
    snapshots: 0,
  };
  if (!zone || !zone.enabled) return counts;

  const vehicles = await prisma.vehicle.findMany({
    where: { organizationId: zone.organizationId },
    select: { id: true },
  });
  const ids = vehicles.map((v) => v.id);
  if (ids.length === 0) {
    await prisma.privacyZone.update({
      where: { id: zoneId },
      data: { redactedThrough: new Date() },
    });
    return counts;
  }

  // Drives: null redacted endpoints (start and end separately).
  const driveUpdate = (col: string, zoneCol: string) =>
    prisma.$executeRawUnsafe(
      `UPDATE "Drive" SET "${col}Lat"=NULL, "${col}Lon"=NULL, "${col}Address"=NULL, "${zoneCol}"=$5
      WHERE "vehicleId" = ANY($1) AND "${col}Lat" IS NOT NULL AND ${H.replaceAll('lat', `"${col}Lat"`).replaceAll('lon', `"${col}Lon"`)} <= $4`,
      ids,
      zone.lat,
      zone.lon,
      zone.radiusM,
      zoneId,
    );
  const [start, end] = await Promise.all([
    driveUpdate('start', 'startPrivacyZoneId'),
    driveUpdate('end', 'endPrivacyZoneId'),
  ]);
  counts.drives = start + end;

  counts.routePoints = await prisma.$executeRawUnsafe(
    `DELETE FROM "DriveRoutePoint" rp USING "Drive" d
      WHERE rp."driveId" = d.id AND d."vehicleId" = ANY($1) AND ${H} <= $4`,
    ids,
    zone.lat,
    zone.lon,
    zone.radiusM,
  );

  counts.chargingSessions = await prisma.$executeRawUnsafe(
    `UPDATE "ChargingSession" SET lat=NULL, lon=NULL, "locationName"=NULL, "privacyZoneId"=$5
      WHERE "vehicleId" = ANY($1) AND lat IS NOT NULL AND ${H} <= $4`,
    ids,
    zone.lat,
    zone.lon,
    zone.radiusM,
    zoneId,
  );

  counts.locations = await prisma.$executeRawUnsafe(
    `UPDATE "VehicleLocation" SET lat=NULL, lon=NULL, address=NULL, "privacyZoneId"=$5
      WHERE "vehicleId" = ANY($1) AND lat IS NOT NULL AND ${H} <= $4`,
    ids,
    zone.lat,
    zone.lon,
    zone.radiusM,
    zoneId,
  );

  // Telemetry: one UPDATE per partition (short locks; names validated).
  const telemetryExpr = H.replaceAll('lat', `(data->>'lt')::float8`).replaceAll(
    'lon',
    `(data->>'ln')::float8`,
  );
  for (const part of await listTelemetryPartitions()) {
    counts.telemetry += await prisma.$executeRawUnsafe(
      `UPDATE telemetry."${part}" SET data = data || jsonb_build_object('lt', NULL, 'ln', NULL, 'pz', $5::text)
        WHERE vehicle_id = ANY($1) AND jsonb_typeof(data->'lt') = 'number' AND ${telemetryExpr} <= $4`,
      ids,
      zone.lat,
      zone.lon,
      zone.radiusM,
      zoneId,
    );
  }

  // Snapshots: re-run redactState on the stored JSON in TypeScript.
  const snapshots = await prisma.vehicleSnapshot.findMany({ where: { vehicleId: { in: ids } } });
  for (const snap of snapshots) {
    const state = (snap.state ?? {}) as Record<string, unknown>;
    const lat = typeof state.lat === 'number' ? state.lat : null;
    const lon = typeof state.lon === 'number' ? state.lon : null;
    if (lat === null || lon === null) continue;
    const km =
      2 *
      6371 *
      Math.asin(
        Math.sqrt(
          Math.sin(((lat - zone.lat) * Math.PI) / 360) ** 2 +
            Math.cos((zone.lat * Math.PI) / 180) *
              Math.cos((lat * Math.PI) / 180) *
              Math.sin(((lon - zone.lon) * Math.PI) / 360) ** 2,
        ),
      );
    if (km * 1000 > zone.radiusM) continue;
    await prisma.vehicleSnapshot.update({
      where: { vehicleId: snap.vehicleId },
      data: {
        state: {
          ...state,
          lat: null,
          lon: null,
          address: null,
          privacyZoneId: zone.id,
          privacyZoneName: zone.name,
        } as unknown as object,
      },
    });
    counts.snapshots += 1;
  }

  await prisma.privacyZone.update({ where: { id: zoneId }, data: { redactedThrough: new Date() } });
  await audit({
    actorId: null,
    organizationId: zone.organizationId,
    action: 'privacy.zone_redacted',
    entityType: 'privacyZone',
    entityId: zoneId,
    details: { counts, redactedThrough: new Date().toISOString() },
  });
  return counts;
}
