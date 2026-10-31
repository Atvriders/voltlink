// The central access layer: effective permissions for an actor on a vehicle or
// in an organization, plus assertion helpers used by routes, workers,
// automations and jobs. Replace apps/api/src/access.ts.

import { prisma } from '../core/db';
import {
  GRANT_PERMISSIONS,
  OPERATOR_PERMISSIONS,
  ORG_PERMISSIONS,
  ROLE_PERMISSIONS,
  VEHICLE_PERMISSIONS,
  type OrgPermission,
  type Permission,
  type VehiclePermission,
} from '@voltlink/shared';
import { AccessDenied, notFound } from './errors';
import type { Actor } from './types';

let operatorOrgIdCache: { value: string; at: number } | null = null;

export async function getOperatorOrgId(db = prisma): Promise<string | null> {
  if (operatorOrgIdCache && Date.now() - operatorOrgIdCache.at < 60_000)
    return operatorOrgIdCache.value;
  const row = await db.appSetting.findUnique({ where: { key: 'instance.operatorOrgId' } });
  const value = row?.value ?? null;
  operatorOrgIdCache = { value: value ?? '', at: Date.now() };
  return value;
}

export async function effectiveVehiclePermissions(
  actor: Actor,
  v: { id: string; organizationId: string },
  db = prisma,
): Promise<Set<VehiclePermission>> {
  if (actor.kind === 'system') return new Set<VehiclePermission>(VEHICLE_PERMISSIONS);
  const [m, g] = await Promise.all([
    db.membership.findUnique({
      where: { organizationId_userId: { organizationId: v.organizationId, userId: actor.userId } },
    }),
    db.vehicleGrant.findUnique({
      where: { vehicleId_userId: { vehicleId: v.id, userId: actor.userId } },
    }),
  ]);
  const perms = new Set<VehiclePermission>();
  if (m?.status === 'ACTIVE' && m.vehicleScope === 'ALL') {
    for (const p of ROLE_PERMISSIONS[m.role]) {
      if ((VEHICLE_PERMISSIONS as readonly string[]).includes(p)) perms.add(p as VehiclePermission);
    }
  }
  if (g && (!g.expiresAt || g.expiresAt > new Date())) {
    for (const p of GRANT_PERMISSIONS[g.level]) perms.add(p);
    if (g.allowHighRisk && g.level !== 'VIEWER') perms.add('vehicles.command_high_risk');
  }
  if (actor.kind === 'apiKey') {
    if (actor.organizationId !== v.organizationId) return new Set<VehiclePermission>();
    return new Set([...perms].filter((p) => scopeAllows(actor.scopes, p)));
  }
  if (actor.kind === 'automation' && actor.organizationId !== v.organizationId)
    return new Set<VehiclePermission>();
  return perms;
}

function scopeAllows(scopes: readonly string[], perm: VehiclePermission): boolean {
  const s = new Set(scopes);
  const map: Record<string, readonly string[]> = {
    'vehicles.read': ['vehicles:read', 'fleet:write', 'automations:write', 'commands:write'],
    'vehicles.history_edit': ['history:write', 'fleet:write'],
    'vehicles.command': ['commands:write'],
  };
  const allowed = map[perm];
  if (!allowed) return false; // manage / share / high-risk never for a key
  return allowed.some((scope) => s.has(scope));
}

export async function assertProviderAccountAccess(
  actor: Actor,
  providerAccount: { id: string; organizationId: string } | null,
  need: 'command' | 'manage',
): Promise<void> {
  if (!providerAccount) throw notFound('Provider account not found.');
  if (actor.kind === 'system') return;
  if (actor.kind === 'apiKey' && !actor.scopes.includes('commands:write')) {
    throw new AccessDenied('API_KEY_SCOPE', 'This API key cannot issue commands.', 403);
  }
  if (actor.kind !== 'session' && actor.kind !== 'apiKey')
    throw new AccessDenied('FORBIDDEN', 'This endpoint requires an interactive session.', 403);
  const m = await prisma.membership.findUnique({
    where: {
      organizationId_userId: {
        organizationId: providerAccount.organizationId,
        userId: actor.userId,
      },
    },
  });
  if (m?.status === 'ACTIVE' && m.providerScope === 'ALL') {
    if (need === 'manage') {
      const orgPerms = await orgPermissions(actor, providerAccount.organizationId);
      if (orgPerms.has('providers.manage')) return;
    } else {
      return;
    }
  }
  const grant = await prisma.providerAccountGrant.findFirst({
    where: {
      providerAccountId: providerAccount.id,
      membership: { is: { userId: actor.userId, status: 'ACTIVE' } },
    },
  });
  if (need === 'manage' && grant?.canManage) return;
  if (need === 'command' && (grant?.canCommand ?? false)) return;
  if (need === 'manage')
    throw new AccessDenied('FORBIDDEN', 'Missing providers.manage on this provider account.');
  throw new AccessDenied('FORBIDDEN', 'Missing command access on this provider account.');
}

export async function assertVehicleAccess(
  actor: Actor,
  vehicleId: string,
  perm: VehiclePermission,
): Promise<{
  vehicle: {
    id: string;
    organizationId: string;
    providerAccountId: string;
    providerAccount: { id: string; organizationId: string } | null;
    [key: string]: unknown;
  };
  permissions: Set<VehiclePermission>;
}> {
  const vehicle = await prisma.vehicle.findUnique({
    where: { id: vehicleId },
    include: { snapshot: true, providerAccount: true },
  });
  if (!vehicle) throw notFound('Vehicle not found.');
  const permissions = await effectiveVehiclePermissions(actor, vehicle);
  if (!permissions.has('vehicles.read')) throw notFound('Vehicle not found.'); // existence is never disclosed
  if (!permissions.has(perm))
    throw new AccessDenied('FORBIDDEN', `Missing ${perm} on this vehicle.`, 403);
  if (perm === 'vehicles.command' || perm === 'vehicles.command_high_risk') {
    await assertProviderAccountAccess(actor, vehicle.providerAccount, 'command');
  }
  return {
    vehicle: vehicle as unknown as {
      id: string;
      organizationId: string;
      providerAccountId: string;
      providerAccount: { id: string; organizationId: string } | null;
      [key: string]: unknown;
    },
    permissions,
  };
}

export async function orgPermissions(
  actor: Actor,
  organizationId: string,
  db = prisma,
): Promise<Set<Permission>> {
  if (actor.kind === 'system')
    return new Set<Permission>([...ORG_PERMISSIONS, ...VEHICLE_PERMISSIONS]);
  const m = await db.membership.findUnique({
    where: { organizationId_userId: { organizationId, userId: actor.userId } },
  });
  if (!m || m.status !== 'ACTIVE') return new Set<Permission>();
  const perms = new Set<Permission>(ROLE_PERMISSIONS[m.role]);
  if (organizationId !== (await getOperatorOrgId(db))) {
    for (const p of OPERATOR_PERMISSIONS) perms.delete(p);
  }
  if (actor.kind === 'apiKey') {
    if (actor.organizationId !== organizationId) return new Set<Permission>();
    return new Set([...perms].filter((p) => scopeAllowsOrg(actor.scopes, p)));
  }
  if (actor.kind === 'automation' && actor.organizationId !== organizationId)
    return new Set<Permission>();
  return perms;
}

function scopeAllowsOrg(scopes: readonly string[], perm: Permission): boolean {
  const s = new Set(scopes);
  const map: Record<string, readonly string[]> = {
    'org.read': [
      'vehicles:read',
      'fleet:write',
      'automations:write',
      'commands:write',
      'history:write',
      'exports:read',
      'status:write',
    ],
    'fleet.read': ['vehicles:read', 'fleet:write', 'automations:write'],
    'fleet.manage': ['fleet:write'],
    'automations.read': ['vehicles:read', 'automations:write'],
    'automations.manage': ['automations:write'],
    'exports.read': ['exports:read'],
    'incidents.manage': ['status:write'],
    'status.manage': ['status:write'],
  };
  const allowed = map[perm];
  if (!allowed) return false;
  return allowed.some((scope) => s.has(scope));
}

export async function assertOrgPermission(
  actor: Actor,
  organizationId: string,
  perm: OrgPermission,
): Promise<Set<Permission>> {
  const perms = await orgPermissions(actor, organizationId);
  if (!perms.has('org.read')) throw notFound('Organization not found.');
  if (!perms.has(perm))
    throw new AccessDenied('FORBIDDEN', `Missing ${perm} in this organization.`, 403);
  return perms;
}

export async function accessibleVehicleIds(
  actor: Actor,
  perm: VehiclePermission,
  opts: { organizationId?: string } = {},
): Promise<string[]> {
  if (actor.kind === 'system') {
    const rows = await prisma.vehicle.findMany({
      where: opts.organizationId
        ? { organizationId: opts.organizationId, active: true }
        : { active: true },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }
  if (actor.kind === 'apiKey' || actor.kind === 'automation') {
    // Compute the same way as for a session actor: the owning user's ACTIVE
    // membership in actor.organizationId (vehicleScope + role matrix) plus
    // non-expired grants, limited to that organization and — for API keys —
    // intersected with the key's scopes. Automations carry their creator's
    // userId on the actor, so they follow the creator's permissions.
    const rows = await prisma.vehicle.findMany({
      where: { organizationId: actor.organizationId, active: true },
      select: { id: true, organizationId: true },
    });
    const ids: string[] = [];
    for (const r of rows) {
      const perms = await effectiveVehiclePermissions(actor, r);
      if (perms.has(perm)) ids.push(r.id);
    }
    return ids;
  }
  const orgMemberships = await prisma.membership.findMany({
    where: { userId: actor.userId, status: 'ACTIVE' },
    select: { organizationId: true, vehicleScope: true, role: true },
  });
  const rolePermitted: string[] = [];
  for (const m of orgMemberships) {
    if (m.vehicleScope === 'ALL' && (ROLE_PERMISSIONS[m.role] as readonly string[]).includes(perm))
      rolePermitted.push(m.organizationId);
  }
  const [byRole, byGrant] = await Promise.all([
    rolePermitted.length
      ? prisma.vehicle.findMany({
          where: { organizationId: { in: rolePermitted }, active: true },
          select: { id: true },
        })
      : Promise.resolve([] as { id: string }[]),
    prisma.vehicleGrant.findMany({
      where: {
        userId: actor.userId,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      select: { vehicleId: true, level: true, allowHighRisk: true },
    }),
  ]);
  const ids = new Set<string>(byRole.map((r) => r.id));
  for (const g of byGrant) {
    const granted = new Set<string>(GRANT_PERMISSIONS[g.level]);
    if (g.allowHighRisk && g.level !== 'VIEWER') granted.add('vehicles.command_high_risk');
    if (granted.has(perm)) ids.add(g.vehicleId);
  }
  if (opts.organizationId) {
    const rows = await prisma.vehicle.findMany({
      where: { id: { in: [...ids] }, organizationId: opts.organizationId, active: true },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  }
  return [...ids];
}

export async function assertOperator(
  actor: Actor,
  perm: 'status.manage' | 'incidents.manage' | 'instance.support_read',
): Promise<void> {
  if (actor.kind === 'session' && actor.isInstanceAdmin) return;
  if (actor.kind === 'system') return;
  const operatorId = await getOperatorOrgId();
  if (!operatorId) throw new AccessDenied('FORBIDDEN', 'No operator organization exists.', 403);
  await assertOrgPermission(actor, operatorId, perm);
}

export function assertInstanceAdmin(actor: Actor): void {
  if (actor.kind === 'session' && actor.isInstanceAdmin) return;
  throw new AccessDenied('FORBIDDEN', 'Instance administrator required.', 403);
}

/** Users allowed to read a vehicle (for SSE audiences, notifications, …). */
export async function vehicleReaderIds(vehicleId: string): Promise<string[]> {
  const vehicle = await prisma.vehicle.findUnique({
    where: { id: vehicleId },
    select: { organizationId: true },
  });
  if (!vehicle) return [];
  const members = await prisma.membership.findMany({
    where: { organizationId: vehicle.organizationId, status: 'ACTIVE', vehicleScope: 'ALL' },
    select: { userId: true, role: true },
  });
  const ids = new Set<string>(
    members
      .filter((m) => (ROLE_PERMISSIONS[m.role] as readonly string[]).includes('vehicles.read'))
      .map((m) => m.userId),
  );
  const grants = await prisma.vehicleGrant.findMany({
    where: { vehicleId, OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
    select: { userId: true },
  });
  for (const g of grants) ids.add(g.userId);
  return [...ids];
}
