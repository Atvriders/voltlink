// Data retention: telemetry partitions, route points, and status history
// pruning driven by user-configured retention days. Run by the scheduler.

import { prisma, query } from '../core/db';
import { getSetting } from '../core/settings';

export async function runRetention(): Promise<{ telemetryRows: number; routePoints: number; checks: number; detail: string }> {
  const telemetryDays = Number((await getSetting('telemetryRetentionDays')) || '365');
  const locationDays = Number((await getSetting('locationRetentionDays')) || '90');

  const telemetryCutoff = new Date(Date.now() - telemetryDays * 86400000);
  const locationCutoff = new Date(Date.now() - locationDays * 86400000);
  const checksCutoff = new Date(Date.now() - 90 * 86400000);

  let telemetryRows = 0;
  // Drop whole monthly partitions older than the cutoff. List partitions through
  // pg_inherits (the parent lives in the telemetry schema, which Prisma never
  // diffs) and drop them schema-qualified.
  const parts = await query<{ part: string }>(`
    SELECT c.relname AS part
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE i.inhparent = 'telemetry.telemetry_reading'::regclass AND n.nspname = 'telemetry'
  `);
  for (const { part } of parts.rows) {
    const m = part.match(/^telemetry_(\d{4})_(\d{2})$/);
    if (!m) continue;
    const end = new Date(Date.UTC(Number(m[1]), Number(m[2]), 1));
    if (end < telemetryCutoff) {
      await query(`DROP TABLE IF EXISTS telemetry.${part}`);
      telemetryRows += 1;
    }
  }
  // And prune rows inside current partitions.
  const kept = await query<{ n: string }>(
    `DELETE FROM telemetry.telemetry_reading WHERE ts < $1 RETURNING 1`,
    [telemetryCutoff],
  );
  telemetryRows += kept.rowCount;

  // Route points: location retention.
  const driveIds = await prisma.drive.findMany({
    where: { startAt: { lt: locationCutoff } },
    select: { id: true },
  });
  const rp = await prisma.driveRoutePoint.deleteMany({
    where: { driveId: { in: driveIds.map((d) => d.id) } },
  });

  // Status checks older than 90 days.
  const checks = await prisma.statusCheck.deleteMany({ where: { at: { lt: checksCutoff } } });

  await prisma.dataRetentionJob.create({
    data: {
      kind: 'retention',
      rowsDeleted: telemetryRows + rp.count + checks.count,
      detail: `telemetry>${telemetryDays}d, locations>${locationDays}d, checks>90d`,
    },
  });
  return { telemetryRows, routePoints: rp.count, checks: checks.count, detail: 'retention complete' };
}
