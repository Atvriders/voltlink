// Authorization matrix: generated from ROUTE_TABLE, every route × persona,
// plus a hand-pinned golden table so the matrix cannot pass tautologically.
// Includes the four security-review cases (SEC-REVIEW-1..4).

process.env.NODE_ENV = 'test';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildApp } from '../src/app';
import { ROUTE_TABLE, type RoutePolicy } from '../src/authz/policy';
import { prisma } from '../src/core/db';
import { sha256hex, randomId } from '../src/core/crypto';
import { createSession } from '../src/auth/service';
import { GRANT_PERMISSIONS, ROLE_PERMISSIONS, type Permission } from '@voltlink/shared';

const WEBHOOK_TOKEN = 'mx-webhook-token';

let server: Server;
let base: string;

const ids = {
  userOwnerA: '',
  userOwnerB: '',
  userOutsider: '',
  userViewerA: '',
  userDriverA: '',
  userAdminA: '',
  userInstanceAdmin: '',
  orgA: '',
  orgB: '',
  orgOperator: '',
  providerA: '',
  vehicleA1: '',
  vehicleA2: '',
  vehicleB1: '',
  driveA1: '',
  chargeA1: '',
  maintenanceA1: '',
  automationA: '',
  placeA: '',
  passkeyA: '',
  apiKeyReadA: '',
  apiKeyCommandsA: '',
  membershipDriverA: '',
};

async function world() {
  const pw = '$argon2id$v=19$m=19456,t=2,p=1$s$s';
  const mkUser = (email: string, isInstanceAdmin = false) =>
    prisma.user.create({
      data: {
        email,
        name: email.split('@')[0]!,
        passwordHash: pw,
        webauthnUserId: randomId(),
        isInstanceAdmin,
        emailVerifiedAt: new Date(),
      },
    });
  const uOwnerA = await mkUser(`mx-ownerA-${Date.now()}@example.test`);
  const uOwnerB = await mkUser(`mx-ownerB-${Date.now()}@example.test`);
  const uOutsider = await mkUser(`mx-outsider-${Date.now()}@example.test`);
  const uViewerA = await mkUser(`mx-viewerA-${Date.now()}@example.test`);
  const uDriverA = await mkUser(`mx-driverA-${Date.now()}@example.test`);
  const uAdminA = await mkUser(`mx-adminA-${Date.now()}@example.test`);
  const uInstanceAdmin = await mkUser(`mx-instanceAdmin-${Date.now()}@example.test`, true);

  const orgA = await prisma.organization.create({
    data: {
      kind: 'TEAM',
      name: 'Org A',
      memberships: {
        create: [
          { userId: uOwnerA.id, role: 'OWNER' },
          { userId: uViewerA.id, role: 'VIEWER' },
          { userId: uDriverA.id, role: 'DRIVER', vehicleScope: 'GRANTED' },
          { userId: uAdminA.id, role: 'ADMIN' },
        ],
      },
    },
  });
  const orgB = await prisma.organization.create({
    data: {
      kind: 'TEAM',
      name: 'Org B',
      memberships: { create: [{ userId: uOwnerB.id, role: 'OWNER' }] },
    },
  });
  const orgOperator = await prisma.organization.create({
    data: {
      kind: 'OPERATOR',
      name: 'Operator',
      memberships: { create: [{ userId: uInstanceAdmin.id, role: 'OWNER' }] },
    },
  });
  await prisma.appSetting.upsert({
    where: { key: 'instance.operatorOrgId' },
    update: { value: orgOperator.id },
    create: { key: 'instance.operatorOrgId', value: orgOperator.id },
  });
  await prisma.appSetting.upsert({
    where: { key: 'instance.bootstrappedAt' },
    update: { value: new Date().toISOString() },
    create: { key: 'instance.bootstrappedAt', value: new Date().toISOString() },
  });

  const providerA = await prisma.providerAccount.create({
    data: {
      organizationId: orgA.id,
      provider: 'demo',
      label: 'demo',
      status: 'connected',
      demo: true,
    },
  });
  const providerB = await prisma.providerAccount.create({
    data: {
      organizationId: orgB.id,
      provider: 'demo',
      label: 'demo',
      status: 'connected',
      demo: true,
    },
  });
  const mkVehicle = (orgId: string, provId: string, name: string) =>
    prisma.vehicle.create({
      data: {
        organizationId: orgId,
        providerAccountId: provId,
        provider: 'demo',
        providerVehicleId: randomId(),
        displayName: name,
        demo: true,
      },
    });
  const vehicleA1 = await mkVehicle(orgA.id, providerA.id, 'A1');
  const vehicleA2 = await mkVehicle(orgA.id, providerA.id, 'A2');
  const vehicleB1 = await mkVehicle(orgB.id, providerB.id, 'B1');
  await prisma.vehicleGrant.create({
    data: {
      vehicleId: vehicleA1.id,
      userId: uDriverA.id,
      level: 'DRIVER',
      grantedById: uOwnerA.id,
    },
  });

  const mkDrive = (vId: string) =>
    prisma.drive.create({
      data: {
        vehicleId: vId,
        startAt: new Date(),
        endAt: new Date(Date.now() + 1000),
        distanceKm: 1,
        durationSec: 60,
        avgSpeedKmh: 60,
        maxSpeedKmh: 60,
        energyKwh: 0.2,
        efficiencyWhPerKm: 200,
      },
    });
  const driveA1 = await mkDrive(vehicleA1.id);
  const driveB1 = await mkDrive(vehicleB1.id);
  const chargeA1 = await prisma.chargingSession.create({
    data: { vehicleId: vehicleA1.id, startAt: new Date(), energyAddedKwh: 1 },
  });
  const chargeB1 = await prisma.chargingSession.create({
    data: { vehicleId: vehicleB1.id, startAt: new Date(), energyAddedKwh: 1 },
  });
  const maintenanceA1 = await prisma.maintenanceRecord.create({
    data: { vehicleId: vehicleA1.id, title: 'M', kind: 'service' },
  });
  const maintenanceB1 = await prisma.maintenanceRecord.create({
    data: { vehicleId: vehicleB1.id, title: 'M', kind: 'service' },
  });
  const maintenanceA2 = await prisma.maintenanceRecord.create({
    data: { vehicleId: vehicleA1.id, title: 'M2', kind: 'service' },
  });
  const commandA1 = await prisma.vehicleCommand.create({
    data: {
      organizationId: orgA.id,
      userId: uOwnerA.id,
      vehicleId: vehicleA1.id,
      vehicleName: 'A1',
      providerAccountId: providerA.id,
      actorKind: 'session',
      type: 'lock',
      params: {},
      status: 'confirmed',
      risk: 'low',
      idempotencyKey: `mx:${randomId()}`,
    },
  });
  const commandB1 = await prisma.vehicleCommand.create({
    data: {
      organizationId: orgB.id,
      userId: uOwnerB.id,
      vehicleId: vehicleB1.id,
      vehicleName: 'B1',
      providerAccountId: providerB.id,
      actorKind: 'session',
      type: 'lock',
      params: {},
      status: 'confirmed',
      risk: 'low',
      idempotencyKey: `mx:${randomId()}`,
    },
  });
  const fleetGroupA = await prisma.fleetGroup.create({
    data: { organizationId: orgA.id, name: 'G' },
  });
  const driverA = await prisma.driver.create({ data: { organizationId: orgA.id, name: 'D' } });
  const departmentA = await prisma.department.create({
    data: { organizationId: orgA.id, name: 'Dept' },
  });
  const costCenterA = await prisma.costCenter.create({
    data: { organizationId: orgA.id, name: 'CC', code: 'CC-1' },
  });
  const assignmentA = await prisma.vehicleAssignment.create({
    data: { organizationId: orgA.id, vehicleId: vehicleA1.id, driverId: driverA.id },
  });
  const automationA = await prisma.automation.create({
    data: {
      organizationId: orgA.id,
      userId: uOwnerA.id,
      name: 'Auto',
      triggerType: 'scheduled',
      triggerParams: {},
      conditions: [],
      actions: [],
    },
  });
  const automationB = await prisma.automation.create({
    data: {
      organizationId: orgB.id,
      userId: uOwnerB.id,
      name: 'AutoB',
      triggerType: 'scheduled',
      triggerParams: {},
      conditions: [],
      actions: [],
    },
  });
  await prisma.automation.create({
    data: {
      organizationId: orgA.id,
      userId: uOwnerA.id,
      name: 'Webhook',
      triggerType: 'webhook',
      triggerParams: { token: WEBHOOK_TOKEN },
      conditions: [],
      actions: [],
    },
  });
  const placeA = await prisma.place.create({
    data: { organizationId: orgA.id, createdById: uOwnerA.id, name: 'Place', lat: 1, lon: 1 },
  });
  const placeB = await prisma.place.create({
    data: { organizationId: orgB.id, createdById: uOwnerB.id, name: 'PlaceB', lat: 1, lon: 1 },
  });
  const privacyZoneA = await prisma.privacyZone.create({
    data: {
      organizationId: orgA.id,
      createdById: uOwnerA.id,
      name: 'Z',
      lat: 1,
      lon: 1,
      radiusM: 100,
    },
  });
  const privacyZoneB = await prisma.privacyZone.create({
    data: {
      organizationId: orgB.id,
      createdById: uOwnerB.id,
      name: 'ZB',
      lat: 1,
      lon: 1,
      radiusM: 100,
    },
  });
  const geofenceA = await prisma.geofence.create({
    data: {
      organizationId: orgA.id,
      createdById: uOwnerA.id,
      name: 'F',
      lat: 1,
      lon: 1,
      radiusM: 100,
      alertOn: 'both',
    },
  });
  const geofenceB = await prisma.geofence.create({
    data: {
      organizationId: orgB.id,
      createdById: uOwnerB.id,
      name: 'FB',
      lat: 1,
      lon: 1,
      radiusM: 100,
      alertOn: 'both',
    },
  });
  const rateRuleA = await prisma.rateRule.create({
    data: {
      organizationId: orgA.id,
      createdById: uOwnerA.id,
      name: 'R',
      type: 'flat',
      pricePerKwh: 0.2,
      currency: 'USD',
    },
  });
  const rateRuleB = await prisma.rateRule.create({
    data: {
      organizationId: orgB.id,
      createdById: uOwnerB.id,
      name: 'RB',
      type: 'flat',
      pricePerKwh: 0.2,
      currency: 'USD',
    },
  });
  const fleetGroupB = await prisma.fleetGroup.create({
    data: { organizationId: orgB.id, name: 'GB' },
  });
  const passkeyA = await prisma.passkeyCredential.create({
    data: {
      userId: uOwnerA.id,
      credentialId: randomId(),
      publicKey: Buffer.alloc(65).toString('base64'),
      counter: 0n,
      transports: [],
      name: 'Key',
    },
  });

  const keyTokenRead = `vlk_${'c'.repeat(12)}_${'d'.repeat(64)}`;
  const keyTokenCommands = `vlk_${'e'.repeat(12)}_${'f'.repeat(64)}`;
  const apiKeyReadA = await prisma.apiKey.create({
    data: {
      userId: uOwnerA.id,
      organizationId: orgA.id,
      name: 'read',
      keyHash: sha256hex(keyTokenRead),
      prefix: `vlk_${'c'.repeat(12)}`,
      scopes: ['vehicles:read'],
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
  const apiKeyCommandsA = await prisma.apiKey.create({
    data: {
      userId: uOwnerA.id,
      organizationId: orgA.id,
      name: 'cmds',
      keyHash: sha256hex(keyTokenCommands),
      prefix: `vlk_${'e'.repeat(12)}`,
      scopes: ['commands:write'],
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });

  ids.userOwnerA = uOwnerA.id;
  ids.userOwnerB = uOwnerB.id;
  ids.userOutsider = uOutsider.id;
  ids.userViewerA = uViewerA.id;
  ids.userDriverA = uDriverA.id;
  ids.userAdminA = uAdminA.id;
  ids.userInstanceAdmin = uInstanceAdmin.id;
  ids.orgA = orgA.id;
  ids.orgB = orgB.id;
  ids.orgOperator = orgOperator.id;
  ids.providerA = providerA.id;
  ids.vehicleA1 = vehicleA1.id;
  ids.vehicleA2 = vehicleA2.id;
  ids.vehicleB1 = vehicleB1.id;
  ids.driveA1 = driveA1.id;
  ids.chargeA1 = chargeA1.id;
  ids.maintenanceA1 = maintenanceA1.id;
  ids.automationA = automationA.id;
  ids.placeA = placeA.id;
  ids.passkeyA = passkeyA.id;
  ids.apiKeyReadA = apiKeyReadA.id;
  ids.apiKeyCommandsA = apiKeyCommandsA.id;
  Object.assign(ids, {
    driveB1: driveB1.id,
    chargeB1: chargeB1.id,
    maintenanceB1: maintenanceB1.id,
    maintenanceA2: maintenanceA2.id,
    automationB: automationB.id,
    placeB: placeB.id,
    commandA1: commandA1.id,
    commandB1: commandB1.id,
    fleetGroupA: fleetGroupA.id,
    driverA: driverA.id,
    departmentA: departmentA.id,
    costCenterA: costCenterA.id,
    assignmentA: assignmentA.id,
    privacyZoneA: privacyZoneA.id,
    privacyZoneB: privacyZoneB.id,
    geofenceA: geofenceA.id,
    geofenceB: geofenceB.id,
    rateRuleA: rateRuleA.id,
    rateRuleB: rateRuleB.id,
    fleetGroupB: fleetGroupB.id,
  });

  return {
    tokens: {
      ownerA: await sessionFor(uOwnerA.id),
      ownerB: await sessionFor(uOwnerB.id),
      outsider: await sessionFor(uOutsider.id),
      viewerA: await sessionFor(uViewerA.id),
      driverA: await sessionFor(uDriverA.id),
      adminA: await sessionFor(uAdminA.id),
      instanceAdmin: await sessionFor(uInstanceAdmin.id),
      apiKeyRead: keyTokenRead,
      apiKeyCommands: keyTokenCommands,
      ownerAUnelevated: await sessionFor(uOwnerA.id, { stepped: false }),
    },
    vehicles: { vehicleA1, vehicleA2, vehicleB1 },
    cleanup: async () => {
      await prisma.organization.deleteMany({
        where: { id: { in: [orgA.id, orgB.id, orgOperator.id] } },
      });
      await prisma.user.deleteMany({
        where: {
          id: {
            in: [
              uOwnerA.id,
              uOwnerB.id,
              uOutsider.id,
              uViewerA.id,
              uDriverA.id,
              uAdminA.id,
              uInstanceAdmin.id,
            ],
          },
        },
      });
    },
  };
}

async function sessionFor(userId: string, opts: { stepped?: boolean } = {}): Promise<string> {
  const { token, sessionId } = await createSession(userId);
  if (opts.stepped !== false) {
    // Matrix cells are authorization cells; step-up requirements are covered by
    // dedicated tests (security-review.test.ts, auth tests). Pre-step so the
    // step-up gate does not mask the permission answer.
    await prisma.userSession.update({
      where: { id: sessionId },
      data: { stepUpAt: new Date(), stepUpMethod: 'totp' },
    });
  }
  return token;
}

let w: Awaited<ReturnType<typeof world>>;

beforeAll(async () => {
  server = buildApp({ serveSpa: false }).listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  w = await world();
}, 60_000);

afterAll(async () => {
  await w.cleanup();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await prisma.$disconnect();
}, 60_000);

type Persona = keyof Awaited<ReturnType<typeof world>>['tokens'];

// The API issues a CSRF cookie on the first mutating request and expects a
// matching x-vl-csrf header on the retry (middleware/core.ts csrf()).
const csrfCache = new WeakMap<object, string>();
async function csrfRequest(
  agent: ReturnType<typeof request.agent>,
  method: 'get' | 'post' | 'put' | 'patch' | 'delete',
  url: string,
  body: unknown = {},
) {
  if (method === 'get') return agent.get(url).send(body);
  let csrf = csrfCache.get(agent);
  let res = csrf
    ? await agent[method](url).set('x-vl-csrf', csrf).send(body)
    : await agent[method](url).send(body);
  if (res.status === 403 && res.body?.error?.code === 'CSRF') {
    const cookies = (res.headers['set-cookie'] ?? []) as unknown as string[];
    csrf =
      cookies
        .map((c) => c.split(';')[0])
        .find((c) => c.startsWith('vl_csrf='))
        ?.split('=')[1] ?? csrf;
    if (!csrf) throw new Error('CSRF cookie was not issued');
    csrfCache.set(agent, csrf);
    res = await agent[method](url).set('x-vl-csrf', csrf).send(body);
  }
  return res;
}

function fill(route: { path: string }, persona: Persona): string | null {
  let path = route.path;
  const b = persona === 'ownerB'; // ownerB resolves their own org's fixtures
  const byKind: Record<string, string> = {
    '/drives': b ? ids.driveB1 : ids.driveA1,
    '/charging/rates': b ? ids.rateRuleB : ids.rateRuleA,
    '/charging': b ? ids.chargeB1 : ids.chargeA1,
    '/automations': b ? ids.automationB : ids.automationA,
    '/vehicles/places': b ? ids.placeB : ids.placeA,
    '/passkeys': ids.passkeyA,
    '/vehicles/privacy-zones': b ? ids.privacyZoneB : ids.privacyZoneA,
    '/vehicles/geofences': b ? ids.geofenceB : ids.geofenceA,
    '/vehicles': b ? ids.vehicleB1 : ids.vehicleA1,
    '/commands': b ? ids.commandB1 : ids.commandA1,
    '/fleet/maintenance': b ? ids.maintenanceB1 : ids.maintenanceA1,
    '/fleet/groups': b ? ids.fleetGroupB : ids.fleetGroupA,
    '/fleet/drivers': ids.driverA,
    '/fleet/departments': ids.departmentA,
    '/fleet/cost-centers': ids.costCenterA,
    '/fleet/assignments': ids.assignmentA,
  };
  const prefix = Object.keys(byKind)
    .filter((k) => path.includes(k))
    .sort((x, y) => y.length - x.length)[0];
  const resourceId = prefix ? byKind[prefix] : undefined;
  path = path.replaceAll(':vehicleId', b ? ids.vehicleB1 : ids.vehicleA1);
  if (resourceId) path = path.replaceAll(':id', resourceId);
  path = path.replaceAll(':orgId', b ? ids.orgB : ids.orgA);
  path = path.replaceAll(':token', WEBHOOK_TOKEN);
  // routes without a known fixture resource cannot be filled reliably
  if (path.includes(':') && prefix === undefined && !path.includes(':orgId')) return null;
  return path;
}

// Auth-flow routes need challenge/ceremony state the matrix does not build;
// their allow paths are covered by dedicated auth tests. Body-required targets
// cannot be exercised without per-route payload fixtures.
const SKIP_ROUTES: ReadonlySet<string> = new Set([
  'POST /api/v1/auth/logout',
  'POST /api/v1/auth/login',
  'POST /api/v1/auth/login/mfa',
  'POST /api/v1/auth/forgot-password',
  'POST /api/v1/auth/reset-password',
  'POST /api/v1/auth/step-up',
  'POST /api/v1/auth/passkey/login/options',
  'POST /api/v1/auth/passkey/login/verify',
  'POST /api/v1/auth/passkeys/options',
  'POST /api/v1/auth/passkeys',
  'POST /api/v1/auth/mfa/totp/setup',
  'POST /api/v1/auth/mfa/totp/confirm',
  'POST /api/v1/auth/mfa/totp/disable',
  'POST /api/v1/auth/mfa/recovery-codes/regenerate',
  'PATCH /api/v1/users/retention', // spec: always 404
  'GET /api/v1/status/subscriptions/confirm/:token',
  'GET /api/v1/status/subscriptions/unsubscribe/:token',
  'GET /api/v1/geocode', // 404 GEOCODER_DISABLED when unconfigured
  'POST /api/v1/invitations/:token/accept',
  'POST /api/v1/automations/webhook/:token', // removed: replaced by inbound hooks
]);

function personaHas(policy: RoutePolicy, persona: Persona): boolean {
  if (policy.auth === 'public') return true;
  const t = policy.target;
  if (persona === 'apiKeyRead' || persona === 'apiKeyCommands') {
    if (!policy.apiScope) return false;
    return (
      (persona === 'apiKeyRead' && policy.apiScope === 'vehicles:read') ||
      (persona === 'apiKeyCommands' && policy.apiScope === 'commands:write')
    );
  }
  if (t.kind === 'instanceAdmin') return persona === 'instanceAdmin';
  if (t.kind === 'operator') return persona === 'instanceAdmin';
  const perm =
    t.kind === 'vehicle' || t.kind === 'resource'
      ? (t.perm as Permission)
      : t.kind === 'org'
        ? t.perm
        : null;
  if (!perm) {
    // none/self: any interactive session (self routes belong to the caller)
    return true;
  }
  if (
    t.kind === 'resource' &&
    ['passkey', 'session', 'apiKey', 'webhookEndpoint'].includes(t.resource)
  ) {
    return persona === 'ownerA'; // owner-scoped fixture (passkeyA etc. belong to ownerA)
  }
  if (persona === 'outsider') return false;
  if (persona === 'instanceAdmin' && !(t.kind === 'org' && t.own)) return false; // instance admin grants no org-A data
  const role = (() => {
    switch (persona) {
      case 'ownerA':
        return 'OWNER';
      case 'ownerB':
        return 'OWNER';
      case 'adminA':
        return 'ADMIN';
      case 'driverA':
        return 'DRIVER';
      case 'viewerA':
        return 'VIEWER';
      case 'outsider':
        return 'VIEWER';
      case 'instanceAdmin':
        return 'OWNER';
      default:
        return 'VIEWER';
    }
  })();
  const rolePerms = new Set(ROLE_PERMISSIONS[role as keyof typeof ROLE_PERMISSIONS]);
  if (persona === 'driverA' && t.kind === 'vehicle') {
    const granted = new Set(GRANT_PERMISSIONS.DRIVER);
    return granted.has(perm as never);
  }
  if (t.kind === 'org' && t.own) {
    // own-org resolution uses the persona's own role; driver grants do not apply
    return rolePerms.has(perm);
  }
  return rolePerms.has(perm);
}

// Cells whose allowed execution would destroy the world (sessions, users,
// fixture rows). Deny cells still run: they can never reach the mutation.
// The allowed paths of these routes are covered by dedicated regression tests.
const DESTRUCTIVE: ReadonlySet<string> = new Set([
  'POST /api/v1/auth/logout',
  'POST /api/v1/users/me/delete',
  'DELETE /api/v1/vehicles/:id',
  'DELETE /api/v1/vehicles/:id/shares/:shareId',
  'DELETE /api/v1/vehicles/privacy-zones/:id',
  'DELETE /api/v1/vehicles/places/all/:id',
  'DELETE /api/v1/vehicles/geofences/all/:id',
  'DELETE /api/v1/charging/rates/list/:id',
  'DELETE /api/v1/drives/:id',
  'DELETE /api/v1/automations/:id',
  'DELETE /api/v1/fleet/assignments/:id',
  'DELETE /api/v1/fleet/cost-centers/:id',
  'DELETE /api/v1/fleet/departments/:id',
  'DELETE /api/v1/fleet/drivers/:id',
  'DELETE /api/v1/fleet/groups/:id',
  'DELETE /api/v1/fleet/maintenance/:id',
  'DELETE /api/v1/auth/passkeys/:id',
  'POST /api/v1/auth/passkeys/:id/delete',
  'POST /api/v1/users/demo-mode',
  'POST /api/v1/providers/demo/connect',
  'DELETE /api/v1/orgs/:orgId',
]);

// Hand-pinned golden cells (guide 05 §10 plus the security-review cases).
describe('authorization golden cells', () => {
  it('hold (ids resolved after the world is built)', async () => {
    const cases: {
      method: 'get' | 'post' | 'patch' | 'delete';
      path: string;
      persona: Persona;
      status: number;
      code?: string;
      body?: unknown;
    }[] = [
      {
        method: 'get',
        path: `/api/v1/vehicles/${ids.vehicleA1}`,
        persona: 'outsider',
        status: 404,
      },
      { method: 'get', path: `/api/v1/vehicles/${ids.vehicleA1}`, persona: 'viewerA', status: 200 },
      { method: 'get', path: `/api/v1/vehicles/${ids.vehicleA1}`, persona: 'ownerB', status: 404 },
      {
        method: 'get',
        path: `/api/v1/vehicles/${ids.vehicleA1}`,
        persona: 'apiKeyRead',
        status: 200,
      },
      {
        method: 'get',
        path: `/api/v1/vehicles/${ids.vehicleA1}`,
        persona: 'instanceAdmin',
        status: 404,
      },
      {
        method: 'get',
        path: `/api/v1/drives?vehicleId=${ids.vehicleA1}`,
        persona: 'apiKeyRead',
        status: 200,
      },
      { method: 'patch', path: `/api/v1/drives/${ids.driveA1}`, persona: 'viewerA', status: 403 },
      {
        method: 'patch',
        path: `/api/v1/drives/${ids.driveA1}`,
        persona: 'apiKeyRead',
        status: 403,
      },
      {
        method: 'post',
        path: '/api/v1/commands',
        persona: 'viewerA',
        status: 403,
        body: { vehicleId: ids.vehicleA1, type: 'lock', params: {} },
      },
      {
        method: 'delete',
        path: `/api/v1/fleet/maintenance/${ids.maintenanceA1}`,
        persona: 'viewerA',
        status: 403,
      },
      {
        method: 'delete',
        path: `/api/v1/fleet/maintenance/${ids.maintenanceA2}`,
        persona: 'adminA',
        status: 200,
      },
      { method: 'post', path: '/api/v1/status/incidents', persona: 'viewerA', status: 404 },
      // SEC-REVIEW-4: the passkey delete alias requires possession step-up.
      {
        method: 'post',
        path: `/api/v1/auth/passkeys/${ids.passkeyA}/delete`,
        persona: 'ownerAUnelevated',
        status: 403,
        code: 'STEP_UP_REQUIRED',
      },
      // SEC-REVIEW-1: step-up is session-bound; an API key can never step up.
      { method: 'post', path: '/api/v1/auth/step-up', persona: 'apiKeyRead', status: 403 },
      // SEC-REVIEW-3: a scoped key is limited by its scope.
      {
        method: 'get',
        path: `/api/v1/vehicles/${ids.vehicleA1}`,
        persona: 'apiKeyCommands',
        status: 403,
      },
    ];
    for (const c of cases) {
      const agent = request.agent(base);
      if (c.persona.startsWith('apiKey'))
        agent.set('Authorization', `Bearer ${w.tokens[c.persona]}`);
      else agent.set('Cookie', `vl_session=${w.tokens[c.persona]}`);
      const res = await csrfRequest(agent, c.method, c.path, c.body);
      expect(res.status, `${c.method.toUpperCase()} ${c.path} as ${c.persona}`).toBe(c.status);
      if (c.code) expect(res.body.error.code).toBe(c.code);
    }
  });
});

describe('authorization matrix', () => {
  it('covers every registered route', () => {
    expect(ROUTE_TABLE.length).toBeGreaterThanOrEqual(20);
  });

  describe.each(ROUTE_TABLE.map((r) => [`${r.method} ${r.path}`, r] as const))(
    '%s',
    (_name, route) => {
      const personas: Persona[] = [
        'outsider',
        'ownerA',
        'ownerB',
        'viewerA',
        'driverA',
        'adminA',
        'instanceAdmin',
        'apiKeyRead',
        'apiKeyCommands',
      ];
      it.each(personas)('%s', async (persona) => {
        const expected = personaHas(route.policy, persona);
        if (SKIP_ROUTES.has(`${route.method} ${route.path}`)) return; // needs ceremony/body fixtures
        if (expected && DESTRUCTIVE.has(`${route.method} ${route.path}`)) return; // allowed execution would destroy fixtures
        if (route.policy.target.kind !== 'none' && route.policy.target.from?.startsWith('body:'))
          return; // body fixtures unavailable
        const url = fill(route, persona);
        if (!url) return; // no known fixture for this route kind
        const agent = request.agent(base);
        if (persona.startsWith('apiKey')) {
          agent.set('Authorization', `Bearer ${w.tokens[persona]}`);
        } else {
          agent.set('Cookie', `vl_session=${w.tokens[persona]}`);
        }
        const method = route.method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete';
        const res = await csrfRequest(agent, method, url);
        if (expected) {
          expect([401, 403, 404]).not.toContain(res.status);
        } else {
          expect([401, 403, 404]).toContain(res.status);
        }
      });
    },
  );
});
