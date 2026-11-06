// R4: authz/access.ts coverage — direct unit tests for the central access
// layer. Runs against the per-worker DB (template has a bootstrap user but no
// operator organization, which the operator-scoped branches need; those live
// in round2-access-operator.test.ts).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/core/db';
import { initRedis } from '../src/core/redis';
import { hashPassword, randomId } from '../src/core/crypto';
import {
  accessibleVehicleIds,
  assertInstanceAdmin,
  assertOperator,
  assertOrgPermission,
  assertProviderAccountAccess,
  assertVehicleAccess,
  effectiveVehiclePermissions,
  getOperatorOrgId,
  orgPermissions,
  vehicleReaderIds,
} from '../src/authz/access';
import type { Actor } from '../src/authz/types';

beforeAll(async () => {
  await initRedis();
}, 30_000);

afterAll(async () => {
  await prisma.$disconnect();
});

const mkUser = async (email: string) =>
  prisma.user.create({
    data: {
      email,
      name: email.split('@')[0]!,
      passwordHash: await hashPassword('long-enough-123'),
      webauthnUserId: randomId(),
    },
  });

const mkOrg = (name: string, kind: 'PERSONAL' | 'OPERATOR' = 'PERSONAL') =>
  prisma.organization.create({ data: { name, kind } });

const mkProvider = (organizationId: string) =>
  prisma.providerAccount.create({
    data: {
      organizationId,
      provider: 'demo',
      label: 'Demo',
      status: 'connected',
      demo: true,
    },
  });

const mkVehicle = (organizationId: string, providerAccountId: string) =>
  prisma.vehicle.create({
    data: {
      organizationId,
      providerAccountId,
      provider: 'demo',
      providerVehicleId: randomId(),
      displayName: 'V',
    },
  });

const sessionActor = (userId: string, isInstanceAdmin = false): Actor => ({
  kind: 'session',
  userId,
  sessionId: randomId(),
  isInstanceAdmin,
  emailVerified: true,
  mfaEnrolled: true,
  stepUpAt: null,
  stepUpMethod: null,
});

const apiKeyActor = (userId: string, organizationId: string, scopes: string[]) =>
  ({
    kind: 'apiKey',
    userId,
    apiKeyId: randomId(),
    organizationId,
    scopes,
    isInstanceAdmin: false,
    emailVerified: true,
  }) as Actor;

const automationActor = (userId: string, organizationId: string): Actor => ({
  kind: 'automation',
  userId,
  automationId: randomId(),
  organizationId,
});

const systemActor: Actor = { kind: 'system', job: 'retention' };

describe('access: operator org lookup and instance admin', () => {
  it('returns null without an operator org and denies operator-only checks', async () => {
    expect(await getOperatorOrgId()).toBeNull();
    await expect(assertOperator(systemActor, 'status.manage')).resolves.toBeUndefined();
    await expect(
      assertOperator(sessionActor('nobody'), 'status.manage'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(() => assertInstanceAdmin(sessionActor('nobody'))).toThrow(/Instance administrator/);
    expect(() => assertInstanceAdmin(apiKeyActor('nobody', 'o', []))).toThrow(
      /Instance administrator/,
    );
    expect(() => assertInstanceAdmin(sessionActor('nobody', true))).not.toThrow();
  });
});

describe('access: effective vehicle permissions', () => {
  it('system actors get every vehicle permission', async () => {
    const perms = await effectiveVehiclePermissions(systemActor, { id: 'v', organizationId: 'o' });
    expect(perms.has('vehicles.command_high_risk')).toBe(true);
    expect(perms.has('vehicles.share')).toBe(true);
  });

  it('membership role, vehicle scope, grants, expiry and key scopes', async () => {
    const u1 = await mkUser(`a1.${Date.now()}@t.dev`);
    const u2 = await mkUser(`a2.${Date.now()}@t.dev`);
    const org = await mkOrg('OrgA');
    const pa = await mkProvider(org.id);
    const veh = await mkVehicle(org.id, pa.id);
    await prisma.membership.create({
      data: { organizationId: org.id, userId: u1.id, role: 'OWNER' },
    });

    const ownerPerms = await effectiveVehiclePermissions(sessionActor(u1.id), veh);
    expect(ownerPerms.has('vehicles.read')).toBe(true);
    expect(ownerPerms.has('vehicles.command_high_risk')).toBe(true);

    // vehicleScope GRANTED: the role contributes nothing.
    const u3 = await mkUser(`a3.${Date.now()}@t.dev`);
    await prisma.membership.create({
      data: { organizationId: org.id, userId: u3.id, role: 'OWNER', vehicleScope: 'GRANTED' },
    });
    expect(await effectiveVehiclePermissions(sessionActor(u3.id), veh)).toEqual(new Set());

    // Grant: DRIVER + allowHighRisk covers high-risk commands.
    await prisma.vehicleGrant.create({
      data: { vehicleId: veh.id, userId: u3.id, level: 'DRIVER', allowHighRisk: true },
    });
    const grantPerms = await effectiveVehiclePermissions(sessionActor(u3.id), veh);
    expect(grantPerms.has('vehicles.command')).toBe(true);
    expect(grantPerms.has('vehicles.command_high_risk')).toBe(true);

    // Expired grant contributes nothing.
    const u4 = await mkUser(`a4.${Date.now()}@t.dev`);
    await prisma.vehicleGrant.create({
      data: {
        vehicleId: veh.id,
        userId: u4.id,
        level: 'DRIVER',
        expiresAt: new Date(Date.now() - 1000),
      },
    });
    expect(await effectiveVehiclePermissions(sessionActor(u4.id), veh)).toEqual(new Set());

    // API key: wrong organization -> nothing.
    const keyOther = apiKeyActor(u1.id, 'other-org', ['vehicles:read']);
    expect(await effectiveVehiclePermissions(keyOther, veh)).toEqual(new Set());
    // API key: right org, read scope only.
    const keyRead = apiKeyActor(u1.id, org.id, ['vehicles:read']);
    const keyPerms = await effectiveVehiclePermissions(keyRead, veh);
    expect(keyPerms.has('vehicles.read')).toBe(true);
    expect(keyPerms.has('vehicles.manage')).toBe(false);
    expect(keyPerms.has('vehicles.command')).toBe(false);
    // API key: command scope covers command, not manage.
    const keyCmd = apiKeyActor(u1.id, org.id, ['commands:write']);
    const cmdPerms = await effectiveVehiclePermissions(keyCmd, veh);
    expect(cmdPerms.has('vehicles.command')).toBe(true);
    expect(cmdPerms.has('vehicles.manage')).toBe(false);
    // API key: history_edit via history:write.
    const keyHist = apiKeyActor(u1.id, org.id, ['history:write']);
    expect((await effectiveVehiclePermissions(keyHist, veh)).has('vehicles.history_edit')).toBe(true);

    // Automation outside its org -> nothing.
    const autoOther = automationActor(u1.id, 'other-org');
    expect(await effectiveVehiclePermissions(autoOther, veh)).toEqual(new Set());
    // Automation inside its org follows the creator.
    const autoOwn = automationActor(u1.id, org.id);
    expect((await effectiveVehiclePermissions(autoOwn, veh)).has('vehicles.read')).toBe(true);
  });
});

describe('access: provider account access', () => {
  it('not found, system, key scope guard', async () => {
    const u = await mkUser(`p1.${Date.now()}@t.dev`);
    await expect(assertProviderAccountAccess(sessionActor(u.id), null, 'command')).rejects.toThrow(
      /Provider account not found/,
    );
    const org = await mkOrg('OrgP');
    const pa = await mkProvider(org.id);
    await expect(assertProviderAccountAccess(systemActor, pa, 'command')).resolves.toBeUndefined();
    const keyNoCmd = apiKeyActor(u.id, org.id, ['vehicles:read']);
    await expect(assertProviderAccountAccess(keyNoCmd, pa, 'command')).rejects.toMatchObject({
      code: 'API_KEY_SCOPE',
    });
    // Defensive guard: an actor of a kind the union does not include.
    await expect(
      assertProviderAccountAccess({ kind: 'webhook' } as unknown as Actor, pa, 'command'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('session and key with ACTIVE all-scope membership, and grant fallbacks', async () => {
    const u = await mkUser(`p2.${Date.now()}@t.dev`);
    const v = await mkUser(`p3.${Date.now()}@t.dev`);
    const org = await mkOrg('OrgP2');
    const pa = await mkProvider(org.id);
    await prisma.membership.create({
      data: { organizationId: org.id, userId: u.id, role: 'OWNER' },
    });

    await expect(
      assertProviderAccountAccess(sessionActor(u.id), pa, 'command'),
    ).resolves.toBeUndefined();
    await expect(assertProviderAccountAccess(sessionActor(u.id), pa, 'manage')).resolves.toBeUndefined();
    const keyCmd = apiKeyActor(u.id, org.id, ['commands:write']);
    await expect(assertProviderAccountAccess(keyCmd, pa, 'command')).resolves.toBeUndefined();

    // Non-ALL providerScope falls through to grants.
    await prisma.membership.create({
      data: {
        organizationId: org.id,
        userId: v.id,
        role: 'VIEWER',
        providerScope: 'GRANTED',
      },
    });
    await expect(
      assertProviderAccountAccess(sessionActor(v.id), pa, 'command'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await prisma.providerAccountGrant.create({
      data: { providerAccountId: pa.id, membershipId: (await prisma.membership.findUniqueOrThrow({
        where: { organizationId_userId: { organizationId: org.id, userId: v.id } },
      })).id, canCommand: true },
    });
    await expect(
      assertProviderAccountAccess(sessionActor(v.id), pa, 'command'),
    ).resolves.toBeUndefined();
    await expect(
      assertProviderAccountAccess(sessionActor(v.id), pa, 'manage'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('automation paths: org mismatch, manage via org permission, grant manage', async () => {
    const u = await mkUser(`p4.${Date.now()}@t.dev`);
    const v = await mkUser(`p5.${Date.now()}@t.dev`);
    const org = await mkOrg('OrgP3');
    const pa = await mkProvider(org.id);

    await expect(
      assertProviderAccountAccess(automationActor(u.id, 'elsewhere'), pa, 'command'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    // Active all-scope member without providers.manage: manage falls to grants.
    await prisma.membership.create({
      data: { organizationId: org.id, userId: u.id, role: 'FLEET_MANAGER' },
    });
    await expect(
      assertProviderAccountAccess(automationActor(u.id, org.id), pa, 'manage'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      assertProviderAccountAccess(automationActor(u.id, org.id), pa, 'command'),
    ).resolves.toBeUndefined();

    // Manage via grant.
    await prisma.membership.create({
      data: { organizationId: org.id, userId: v.id, role: 'VIEWER' },
    });
    const vm = await prisma.membership.findUniqueOrThrow({
      where: { organizationId_userId: { organizationId: org.id, userId: v.id } },
    });
    await prisma.providerAccountGrant.create({
      data: { providerAccountId: pa.id, membershipId: vm.id, canManage: true },
    });
    await expect(
      assertProviderAccountAccess(sessionActor(v.id), pa, 'manage'),
    ).resolves.toBeUndefined();

    // Owner in org manages via org permission.
    const w = await mkUser(`p6.${Date.now()}@t.dev`);
    await prisma.membership.create({
      data: { organizationId: org.id, userId: w.id, role: 'OWNER' },
    });
    await expect(
      assertProviderAccountAccess(automationActor(w.id, org.id), pa, 'manage'),
    ).resolves.toBeUndefined();
  });
});

describe('access: vehicle access assertions', () => {
  it('not found, hidden existence, and permission gaps', async () => {
    const u = await mkUser(`v1.${Date.now()}@t.dev`);
    const stranger = await mkUser(`v2.${Date.now()}@t.dev`);
    const org = await mkOrg('OrgV');
    const pa = await mkProvider(org.id);
    const veh = await mkVehicle(org.id, pa.id);
    await prisma.membership.create({
      data: { organizationId: org.id, userId: u.id, role: 'VIEWER' },
    });

    await expect(assertVehicleAccess(sessionActor(u.id), 'missing', 'vehicles.read')).rejects.toThrow(
      /Vehicle not found/,
    );
    // Non-member: existence is never disclosed.
    await expect(
      assertVehicleAccess(sessionActor(stranger.id), veh.id, 'vehicles.read'),
    ).rejects.toThrow(/Vehicle not found/);
    // Viewer can read but not command.
    const read = await assertVehicleAccess(sessionActor(u.id), veh.id, 'vehicles.read');
    expect(read.permissions.has('vehicles.read')).toBe(true);
    await expect(
      assertVehicleAccess(sessionActor(u.id), veh.id, 'vehicles.command'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('owner commands pass the provider gate', async () => {
    const u = await mkUser(`v3.${Date.now()}@t.dev`);
    const org = await mkOrg('OrgV2');
    const pa = await mkProvider(org.id);
    const veh = await mkVehicle(org.id, pa.id);
    await prisma.membership.create({
      data: { organizationId: org.id, userId: u.id, role: 'OWNER' },
    });
    const res = await assertVehicleAccess(sessionActor(u.id), veh.id, 'vehicles.command');
    expect(res.permissions.has('vehicles.command')).toBe(true);
    expect(res.vehicle.id).toBe(veh.id);
  });
});

describe('access: org permissions', () => {
  it('system, missing/inactive membership, operator stripping, key and automation scoping', async () => {
    const sys = await orgPermissions(systemActor, 'any');
    expect(sys.has('vehicles.share')).toBe(true);
    expect(sys.has('status.manage')).toBe(true);

    const u = await mkUser(`o1.${Date.now()}@t.dev`);
    const org = await mkOrg('OrgO');
    expect(await orgPermissions(sessionActor(u.id), org.id)).toEqual(new Set());

    // Suspended membership: no permissions.
    await prisma.membership.create({
      data: { organizationId: org.id, userId: u.id, role: 'OWNER', status: 'SUSPENDED' },
    });
    expect(await orgPermissions(sessionActor(u.id), org.id)).toEqual(new Set());

    // Active owner in a non-operator org: operator-only perms stripped.
    await prisma.membership.update({
      where: { organizationId_userId: { organizationId: org.id, userId: u.id } },
      data: { status: 'ACTIVE' },
    });
    const owner = await orgPermissions(sessionActor(u.id), org.id);
    expect(owner.has('org.manage')).toBe(true);
    expect(owner.has('status.manage')).toBe(false);
    expect(owner.has('incidents.manage')).toBe(false);

    // API key in another org -> empty; in own org -> scope-intersected.
    const key = apiKeyActor(u.id, 'other-org', ['fleet:write']);
    expect(await orgPermissions(key, org.id)).toEqual(new Set());
    const keyOwn = apiKeyActor(u.id, org.id, ['fleet:write']);
    const keyPerms = await orgPermissions(keyOwn, org.id);
    expect(keyPerms.has('fleet.manage')).toBe(true);
    expect(keyPerms.has('org.manage')).toBe(false);
    expect(keyPerms.has('org.delete')).toBe(false);

    // Automation in another org -> empty.
    const auto = automationActor(u.id, 'other-org');
    expect(await orgPermissions(auto, org.id)).toEqual(new Set());
    const autoOwn = automationActor(u.id, org.id);
    expect((await orgPermissions(autoOwn, org.id)).has('org.manage')).toBe(true);
  });

  it('assertOrgPermission: hidden org, forbidden perm, success', async () => {
    const u = await mkUser(`o2.${Date.now()}@t.dev`);
    const org = await mkOrg('OrgO2');
    await expect(assertOrgPermission(sessionActor(u.id), org.id, 'org.manage')).rejects.toThrow(
      /Organization not found/,
    );
    await prisma.membership.create({
      data: { organizationId: org.id, userId: u.id, role: 'VIEWER' },
    });
    await expect(
      assertOrgPermission(sessionActor(u.id), org.id, 'org.manage'),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const perms = await assertOrgPermission(sessionActor(u.id), org.id, 'org.read');
    expect(perms.has('org.read')).toBe(true);
  });
});

describe('access: accessible vehicle ids', () => {
  it('system, key, session role/scope/grant and org filter', async () => {
    const u = await mkUser(`av1.${Date.now()}@t.dev`);
    const org = await mkOrg('OrgAV');
    const pa = await mkProvider(org.id);
    const v1 = await mkVehicle(org.id, pa.id);
    const v2 = await mkVehicle(org.id, pa.id);

    const sysAll = await accessibleVehicleIds(systemActor, 'vehicles.read');
    expect(sysAll).toEqual(expect.arrayContaining([v1.id, v2.id]));
    const sysOrg = await accessibleVehicleIds(systemActor, 'vehicles.read', {
      organizationId: org.id,
    });
    expect(sysOrg).toEqual(expect.arrayContaining([v1.id, v2.id]));

    // API key path (per-vehicle loop in its own org).
    await prisma.membership.create({
      data: { organizationId: org.id, userId: u.id, role: 'OWNER' },
    });
    const key = apiKeyActor(u.id, org.id, ['vehicles:read']);
    const keyIds = await accessibleVehicleIds(key, 'vehicles.read');
    expect(keyIds).toEqual(expect.arrayContaining([v1.id, v2.id]));

    // Session: vehicleScope GRANTED only -> role contributes nothing.
    await prisma.membership.update({
      where: { organizationId_userId: { organizationId: org.id, userId: u.id } },
      data: { vehicleScope: 'GRANTED' },
    });
    expect(await accessibleVehicleIds(sessionActor(u.id), 'vehicles.read')).toEqual([]);
    // Grant on v1 gives read; high-risk grant gives high-risk only for non-VIEWER.
    await prisma.vehicleGrant.create({
      data: { vehicleId: v1.id, userId: u.id, level: 'DRIVER', allowHighRisk: true },
    });
    expect(await accessibleVehicleIds(sessionActor(u.id), 'vehicles.read')).toEqual([v1.id]);
    expect(await accessibleVehicleIds(sessionActor(u.id), 'vehicles.command_high_risk')).toEqual([
      v1.id,
    ]);
    // Org filter branch.
    expect(
      await accessibleVehicleIds(sessionActor(u.id), 'vehicles.read', { organizationId: org.id }),
    ).toEqual([v1.id]);
    expect(
      await accessibleVehicleIds(sessionActor(u.id), 'vehicles.read', { organizationId: 'other' }),
    ).toEqual([]);
    // VIEWER grants never carry high-risk.
    await prisma.vehicleGrant.create({
      data: { vehicleId: v2.id, userId: u.id, level: 'VIEWER', allowHighRisk: true },
    });
    expect(await accessibleVehicleIds(sessionActor(u.id), 'vehicles.command_high_risk')).toEqual([
      v1.id,
    ]);
  });
});

describe('access: vehicle reader ids', () => {
  it('missing vehicle, role readers, grant readers', async () => {
    expect(await vehicleReaderIds('missing')).toEqual([]);
    const u = await mkUser(`vr1.${Date.now()}@t.dev`);
    const g = await mkUser(`vr2.${Date.now()}@t.dev`);
    const org = await mkOrg('OrgVR');
    const pa = await mkProvider(org.id);
    const veh = await mkVehicle(org.id, pa.id);
    await prisma.membership.create({
      data: { organizationId: org.id, userId: u.id, role: 'VIEWER' },
    });
    await prisma.vehicleGrant.create({ data: { vehicleId: veh.id, userId: g.id, level: 'VIEWER' } });
    const readers = await vehicleReaderIds(veh.id);
    expect(readers).toEqual(expect.arrayContaining([u.id, g.id]));
  });
});
