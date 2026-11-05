// Data retention: telemetry partitions, route points, and status history
// pruning driven by user-configured retention days. Run by the scheduler.

import { prisma, query } from '../core/db';
import { getSetting } from '../core/settings';

export async function runRetention(): Promise<{
  telemetryRows: number;
  routePoints: number;
  checks: number;
  detail: string;
}> {
  // Z-RETENTION: retention is per organization. Each organization's own
  // telemetryRetentionDays / locationRetentionDays win; organizations without
  // their own values fall back to the instance defaults.
  const globalTelemetryDays = Number((await getSetting('telemetryRetentionDays')) || '365');
  const globalLocationDays = Number((await getSetting('locationRetentionDays')) || '90');
  const checksCutoff = new Date(Date.now() - 90 * 86400000);

  const orgs = await prisma.organization.findMany({
    select: {
      id: true,
      telemetryRetentionDays: true,
      locationRetentionDays: true,
    },
  });

  let telemetryRows = 0;
  let routePoints = 0;
  for (const org of orgs) {
    const telemetryDays = org.telemetryRetentionDays ?? globalTelemetryDays;
    const locationDays = org.locationRetentionDays ?? globalLocationDays;
    const telemetryCutoff = new Date(Date.now() - telemetryDays * 86400000);
    const locationCutoff = new Date(Date.now() - locationDays * 86400000);

    const kept = await query(
      `DELETE FROM telemetry.telemetry_reading t
       USING "Vehicle" v
       WHERE t.vehicle_id = v.id
         AND v."organizationId" = $1
         AND t.ts < $2
       RETURNING 1`,
      [org.id, telemetryCutoff],
    );
    telemetryRows += kept.rowCount;

    const orgVehicleIds = (
      await prisma.vehicle.findMany({
        where: { organizationId: org.id },
        select: { id: true },
      })
    ).map((v) => v.id);
    const driveIds = orgVehicleIds.length
      ? await prisma.drive.findMany({
          where: { vehicleId: { in: orgVehicleIds }, startAt: { lt: locationCutoff } },
          select: { id: true },
        })
      : [];
    if (driveIds.length > 0) {
      const rp = await prisma.driveRoutePoint.deleteMany({
        where: { driveId: { in: driveIds.map((d) => d.id) } },
      });
      routePoints += rp.count;
    }
  }

  // Status checks older than 90 days.
  const checks = await prisma.statusCheck.deleteMany({ where: { at: { lt: checksCutoff } } });

  await prisma.dataRetentionJob.create({
    data: {
      kind: 'retention',
      rowsDeleted: telemetryRows + routePoints + checks.count,
      detail: `per-org retention run: telemetry ${telemetryRows} rows, route points ${routePoints}, checks ${checks.count}`,
    },
  });
  return {
    telemetryRows,
    routePoints,
    checks: checks.count,
    detail: 'retention complete',
  };
}
