// VoltLink role → permission model. Roles are per organization; the
// authorization layer (apps/api/src/authz) enforces this matrix. There is no
// global role rank: authorization always goes through permissions.

export const ORG_ROLES = [
  'OWNER',
  'ADMIN',
  'FLEET_MANAGER',
  'DRIVER',
  'VIEWER',
  'STATUS_MANAGER',
  'SUPPORT',
] as const;
export type OrgRole = (typeof ORG_ROLES)[number];

export const OPERATOR_ONLY_ROLES: readonly OrgRole[] = ['STATUS_MANAGER', 'SUPPORT'];

export const ORG_PERMISSIONS = [
  'org.read',
  'org.manage',
  'org.delete',
  'members.manage',
  'members.assign_owner',
  'providers.read',
  'providers.manage',
  'fleet.read',
  'fleet.manage',
  'automations.read',
  'automations.manage',
  'privacy.manage',
  'exports.read',
  'audit.read',
  'status.manage',
  'incidents.manage',
  'instance.support_read',
] as const;
export type OrgPermission = (typeof ORG_PERMISSIONS)[number];

export const VEHICLE_PERMISSIONS = [
  'vehicles.read',
  'vehicles.history_edit',
  'vehicles.command',
  'vehicles.command_high_risk',
  'vehicles.manage',
  'vehicles.share',
] as const;
export type VehiclePermission = (typeof VEHICLE_PERMISSIONS)[number];

export type Permission = OrgPermission | VehiclePermission;

/** Permissions that only exist in the OPERATOR organization. */
export const OPERATOR_PERMISSIONS: readonly OrgPermission[] = [
  'status.manage',
  'incidents.manage',
  'instance.support_read',
];

const BASE: Permission[] = ['org.read', 'fleet.read', 'automations.read', 'vehicles.read'];

export const ROLE_PERMISSIONS: Record<OrgRole, readonly Permission[]> = {
  OWNER: [...ORG_PERMISSIONS, ...VEHICLE_PERMISSIONS],
  ADMIN: [
    ...ORG_PERMISSIONS.filter((p) => p !== 'org.delete' && p !== 'members.assign_owner'),
    ...VEHICLE_PERMISSIONS,
  ],
  FLEET_MANAGER: [
    ...BASE,
    'providers.read',
    'fleet.manage',
    'automations.manage',
    'exports.read',
    'vehicles.history_edit',
    'vehicles.command',
    'vehicles.manage',
  ],
  DRIVER: [...BASE, 'automations.manage', 'vehicles.history_edit', 'vehicles.command'],
  VIEWER: [...BASE],
  STATUS_MANAGER: ['org.read', 'status.manage', 'incidents.manage'],
  SUPPORT: ['org.read', 'instance.support_read'],
};

export const GRANT_PERMISSIONS = {
  VIEWER: ['vehicles.read'],
  DRIVER: ['vehicles.read', 'vehicles.command', 'vehicles.history_edit'],
  MANAGER: ['vehicles.read', 'vehicles.command', 'vehicles.history_edit', 'vehicles.manage'],
} as const satisfies Record<'VIEWER' | 'DRIVER' | 'MANAGER', readonly VehiclePermission[]>;

/**
 * Scopes for API keys (`vlk_` tokens). A key's permissions are always
 * intersected with the owning user's live permissions in the key's
 * organization, and never include high-risk command, sharing, provider or
 * privacy management.
 */
export const API_SCOPES = [
  'vehicles:read',
  'history:write',
  'commands:write',
  'fleet:write',
  'automations:write',
  'exports:read',
  'status:write',
] as const;
export type ApiScope = (typeof API_SCOPES)[number];
