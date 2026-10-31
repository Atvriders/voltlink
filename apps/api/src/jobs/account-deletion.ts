// Account-deletion job (Z-DELETE, guide 05 §7.5). Idempotent and resumable
// while deletionRequestedAt is set. Purges telemetry of sole-member
// organizations, deletes those organizations (cascades), pseudonymizes
// commands in other organizations, nulls the actor's audit IPs and deletes
// the user row (cascades sessions, keys, grants, notifications, …).

import { prisma } from '../core/db';

export async function runAccountDeletion(
  userId: string,
): Promise<{ soleOrganizations: number; commandsPseudonymized: number }> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, deletionRequestedAt: true },
  });
  if (!user || !user.deletionRequestedAt) return { soleOrganizations: 0, commandsPseudonymized: 0 }; // idempotent gate

  // 1. Telemetry of sole-member organizations (batch, outside the big tx).
  const memberships = await prisma.membership.findMany({
    where: { userId },
    select: { organizationId: true },
  });
  const soleOrgIds: string[] = [];
  for (const m of memberships) {
    const total = await prisma.membership.count({ where: { organizationId: m.organizationId } });
    if (total === 1) soleOrgIds.push(m.organizationId);
  }
  for (const orgId of soleOrgIds) {
    const vehicles = await prisma.vehicle.findMany({
      where: { organizationId: orgId },
      select: { id: true },
    });
    const ids = vehicles.map((v) => v.id);
    if (ids.length > 0) {
      await prisma.$executeRawUnsafe(
        `DELETE FROM telemetry.telemetry_reading WHERE vehicle_id = ANY($1)`,
        ids,
      );
    }
  }

  // 2. One transaction: cascade-delete sole organizations, pseudonymize the
  // user's commands elsewhere, null audit IPs, write the deletion audit row
  // from the system actor, then delete the user.
  const commands = await prisma.$transaction(
    async (tx) => {
      await tx.organization.deleteMany({ where: { id: { in: soleOrgIds } } });
      const c = await tx.vehicleCommand.updateMany({
        where: { userId },
        data: { userId: 'deleted-user' },
      });
      await tx.auditLog.updateMany({ where: { actorId: userId }, data: { ip: null } });
      await tx.auditLog.create({
        data: {
          actorId: null,
          actorKind: 'system',
          action: 'user.deleted',
          entityType: 'user',
          entityId: userId,
        },
      });
      await tx.user.delete({ where: { id: userId } });
      return c.count;
    },
    { timeout: 60_000 },
  );

  return { soleOrganizations: soleOrgIds.length, commandsPseudonymized: commands };
}
