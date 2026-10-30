// Golden copy of the role → permission matrix (guide 05 §1.2). These are
// hand-written expectations, not derived from the implementation, so the test
// pins the matrix and cannot pass tautologically.

import { describe, expect, it } from 'vitest';
import {
  GRANT_PERMISSIONS,
  OPERATOR_ONLY_ROLES,
  OPERATOR_PERMISSIONS,
  ORG_PERMISSIONS,
  ROLE_PERMISSIONS,
  VEHICLE_PERMISSIONS,
} from './roles';

describe('role → permission matrix (golden)', () => {
  it('STATUS_MANAGER and SUPPORT have no vehicle permissions', () => {
    for (const role of ['STATUS_MANAGER', 'SUPPORT'] as const) {
      for (const p of ROLE_PERMISSIONS[role]) {
        expect((VEHICLE_PERMISSIONS as readonly string[]).includes(p)).toBe(false);
      }
    }
  });

  it('DRIVER lacks command_high_risk', () => {
    expect(ROLE_PERMISSIONS.DRIVER).not.toContain('vehicles.command_high_risk');
    expect(ROLE_PERMISSIONS.DRIVER).toContain('vehicles.command');
  });

  it('ADMIN lacks org.delete and members.assign_owner', () => {
    expect(ROLE_PERMISSIONS.ADMIN).not.toContain('org.delete');
    expect(ROLE_PERMISSIONS.ADMIN).not.toContain('members.assign_owner');
  });

  it('OWNER has every permission', () => {
    for (const p of [...ORG_PERMISSIONS, ...VEHICLE_PERMISSIONS]) {
      expect(ROLE_PERMISSIONS.OWNER).toContain(p);
    }
  });

  it('VIEWER has read permissions only', () => {
    expect(ROLE_PERMISSIONS.VIEWER).toEqual(['org.read', 'fleet.read', 'automations.read', 'vehicles.read']);
  });

  it('operator-only permissions exist only in operator roles', () => {
    for (const p of OPERATOR_PERMISSIONS) {
      // They exist in the matrix…
      expect(ROLE_PERMISSIONS.OWNER).toContain(p);
      if (p !== 'instance.support_read') expect(ROLE_PERMISSIONS.STATUS_MANAGER).toContain(p);
      if (p === 'instance.support_read') expect(ROLE_PERMISSIONS.SUPPORT).toContain(p);
      // …and none of them is a vehicle permission.
      expect((VEHICLE_PERMISSIONS as readonly string[]).includes(p)).toBe(false);
    }
  });

  it('STATUS_MANAGER and SUPPORT are operator-only roles', () => {
    expect(OPERATOR_ONLY_ROLES).toEqual(['STATUS_MANAGER', 'SUPPORT']);
  });

  it('FLEET_MANAGER can manage vehicles but not share or command high-risk', () => {
    expect(ROLE_PERMISSIONS.FLEET_MANAGER).toContain('vehicles.manage');
    expect(ROLE_PERMISSIONS.FLEET_MANAGER).not.toContain('vehicles.share');
    expect(ROLE_PERMISSIONS.FLEET_MANAGER).not.toContain('vehicles.command_high_risk');
  });

  it('grants define the exact per-level permissions', () => {
    expect(GRANT_PERMISSIONS.VIEWER).toEqual(['vehicles.read']);
    expect(GRANT_PERMISSIONS.DRIVER).toEqual(['vehicles.read', 'vehicles.command', 'vehicles.history_edit']);
    expect(GRANT_PERMISSIONS.MANAGER).toEqual(['vehicles.read', 'vehicles.command', 'vehicles.history_edit', 'vehicles.manage']);
  });
});
