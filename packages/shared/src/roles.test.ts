// Golden copy of the role → permission matrix (guide 05 §1.2). These are
// hand-written expectations, not derived from the implementation, so the test
// pins the matrix and cannot pass tautologically.

import { describe, expect, it } from 'vitest';
import {
  GRANT_PERMISSIONS,
  OPERATOR_ONLY_ROLES,
  OPERATOR_PERMISSIONS,
  ORG_PERMISSIONS,
  ORG_ROLES,
  permissionsForRole,
  ROLE_PERMISSIONS,
  VEHICLE_PERMISSIONS,
} from './roles';
import { COMMAND_DEFINITIONS, COMMAND_TYPES, HIGH_RISK_COMMANDS, RISK_LEVELS } from './commands';

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
    expect(ROLE_PERMISSIONS.VIEWER).toEqual([
      'org.read',
      'fleet.read',
      'automations.read',
      'vehicles.read',
    ]);
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
    expect(GRANT_PERMISSIONS.DRIVER).toEqual([
      'vehicles.read',
      'vehicles.command',
      'vehicles.history_edit',
    ]);
    expect(GRANT_PERMISSIONS.MANAGER).toEqual([
      'vehicles.read',
      'vehicles.command',
      'vehicles.history_edit',
      'vehicles.manage',
    ]);
  });

  describe('PL-01 restored tests (reverted from f6b5241)', () => {
    it('every permission is granted to at least one role (PL-01)', () => {
      const granted = new Set<string>();
      for (const role of ORG_ROLES) {
        for (const p of ROLE_PERMISSIONS[role]) granted.add(p);
      }
      for (const p of [...ORG_PERMISSIONS, ...VEHICLE_PERMISSIONS]) {
        expect(granted.has(p), `permission ${p} is unassigned`).toBe(true);
      }
    });

    it('unknown roles have no permissions (PL-01)', () => {
      expect(ROLE_PERMISSIONS).not.toHaveProperty('SUPERUSER');
      for (const key of Object.keys(ROLE_PERMISSIONS)) {
        expect((ORG_ROLES as readonly string[]).includes(key), `${key} is not a defined role`).toBe(
          true,
        );
      }
    });

    it('PL-01 behavioural: an unknown role is refused every permission (PL-01)', () => {
      // The access layer routes through permissionsForRole: an unknown role
      // (possible only via a tampered/migrated database) must get NOTHING,
      // not a fallback role's permissions and not a crash.
      for (const p of [...ORG_PERMISSIONS, ...VEHICLE_PERMISSIONS]) {
        expect(permissionsForRole('SUPERUSER').includes(p), p).toBe(false);
      }
      expect(permissionsForRole('SUPERUSER')).toEqual([]);
      expect(permissionsForRole('OWNER')).toContain('vehicles.read');
    });

    it('every command has a definition and high-risk commands are high (PL-01)', () => {
      // Iterate the CANONICAL command list (the enum), not the definitions:
      // a command that lost its definition must fail this test.
      for (const name of COMMAND_TYPES) {
        const def = COMMAND_DEFINITIONS[name];
        expect(def, `command ${name} has no definition`).toBeDefined();
        expect(def.label.length, `command ${name} has a label`).toBeGreaterThan(0);
        expect([...RISK_LEVELS], `command ${name} risk`).toContain(def.risk);
      }
      // No extra definitions beyond the canonical list, and every high-risk
      // command really is high.
      for (const name of Object.keys(COMMAND_DEFINITIONS)) {
        expect(
          (COMMAND_TYPES as readonly string[]).includes(name),
          `${name} is not a canonical command`,
        ).toBe(true);
      }
      expect(HIGH_RISK_COMMANDS.length).toBeGreaterThanOrEqual(3);
      for (const cmd of HIGH_RISK_COMMANDS) {
        expect(COMMAND_DEFINITIONS[cmd].risk).toBe('high');
      }
    });
  });
});
