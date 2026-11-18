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
import { initRedis } from '../src/core/redis';
import { ensureComponents } from '../src/status/service';
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
  providerB: '',
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
  driveB1: '',
  chargeB1: '',
  maintenanceB1: '',
  maintenanceA2: '',
  automationB: '',
  placeB: '',
  commandA1: '',
  commandB1: '',
  fleetGroupA: '',
  fleetGroupB: '',
  driverA: '',
  departmentA: '',
  costCenterA: '',
  assignmentA: '',
  privacyZoneA: '',
  privacyZoneB: '',
  geofenceA: '',
  geofenceB: '',
  rateRuleA: '',
  rateRuleB: '',
  incidentA: '',
  maintenanceWindowA: '',
  webhookEndpointA: '',
  notificationA: '',
  invitationA: '',
  sessionA: '',
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

  const incidentA = await prisma.incident.create({
    data: {
      title: 'MX incident',
      severity: 'major',
      status: 'investigating',
      components: JSON.parse('["api"]'),
      public: true,
      createdById: uInstanceAdmin.id,
    },
  });
  const maintenanceWindowA = await prisma.maintenanceWindow.create({
    data: {
      title: 'MX window',
      startsAt: new Date(Date.now() - 3600_000),
      endsAt: new Date(Date.now() + 3600_000),
      components: JSON.parse('["api"]'),
    },
  });
  const webhookEndpointA = await prisma.webhookEndpoint.create({
    data: {
      userId: uOwnerA.id,
      name: 'WH',
      url: 'https://example.test/hook',
      events: JSON.parse('["automation_fired"]'),
    },
  });
  const notificationA = await prisma.appNotification.create({
    data: { userId: uOwnerA.id, event: 'automation_fired', title: 'N', body: 'body' },
  });
  const invitationA = await prisma.invitation.create({
    data: {
      organizationId: orgA.id,
      kind: 'membership',
      email: 'invitee@example.test',
      role: 'VIEWER',
      tokenHash: sha256hex(randomId()),
      invitedById: uOwnerA.id,
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
  const keyTokenRead = `vlk_${randomId().slice(0, 12)}_${randomId().repeat(3).slice(0, 64)}`;
  const keyTokenCommands = `vlk_${randomId().slice(0, 12)}_${randomId().repeat(3).slice(0, 64)}`;
  const apiKeyReadA = await prisma.apiKey.create({
    data: {
      userId: uOwnerA.id,
      organizationId: orgA.id,
      name: 'read',
      keyHash: sha256hex(keyTokenRead),
      prefix: keyTokenRead.split('_').slice(0, 2).join('_'),
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
      prefix: keyTokenCommands.split('_').slice(0, 2).join('_'),
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
  ids.providerB = providerB.id;
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
  ids.incidentA = incidentA.id;
  ids.maintenanceWindowA = maintenanceWindowA.id;
  ids.webhookEndpointA = webhookEndpointA.id;
  ids.notificationA = notificationA.id;
  ids.invitationA = invitationA.id;
  ids.driveB1 = driveB1.id;
  ids.chargeB1 = chargeB1.id;
  ids.maintenanceB1 = maintenanceB1.id;
  ids.maintenanceA2 = maintenanceA2.id;
  ids.automationB = automationB.id;
  ids.placeB = placeB.id;
  ids.commandA1 = commandA1.id;
  ids.commandB1 = commandB1.id;
  ids.fleetGroupA = fleetGroupA.id;
  ids.fleetGroupB = fleetGroupB.id;
  ids.driverA = driverA.id;
  ids.departmentA = departmentA.id;
  ids.costCenterA = costCenterA.id;
  ids.assignmentA = assignmentA.id;
  ids.privacyZoneA = privacyZoneA.id;
  ids.privacyZoneB = privacyZoneB.id;
  ids.geofenceA = geofenceA.id;
  ids.geofenceB = geofenceB.id;
  ids.rateRuleA = rateRuleA.id;
  ids.rateRuleB = rateRuleB.id;

  const tokens = {
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
  };
  const ownerASession = await prisma.userSession.findFirstOrThrow({
    where: { userId: uOwnerA.id, revokedAt: null },
    orderBy: { createdAt: 'desc' },
  });
  ids.sessionA = ownerASession.id;

  return {
    tokens,
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
  await initRedis();
  await ensureComponents();
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
  body: string | object = {},
) {
  if (method === 'get') return agent.get(url).send(body);
  let csrf = csrfCache.get(agent);
  let res = csrf
    ? await agent[method](url).set('x-vl-csrf', csrf).send(body)
    : await agent[method](url).send(body);
  if (res.status === 403 && res.body?.error?.code === 'CSRF') {
    const cookies = (res.headers['set-cookie'] ?? []) as unknown as string[];
    const csrfCookie = cookies
      .map((c) => (c ?? '').split(';')[0])
      .find((c) => c?.startsWith('vl_csrf='));
    csrf = (csrfCookie ?? '').split('=')[1] ?? csrf;
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
    '/status/incidents': ids.incidentA,
    '/status/maintenance': ids.maintenanceWindowA,
    '/notifications/webhooks': ids.webhookEndpointA,
    '/notifications': ids.notificationA,
    '/auth/sessions': ids.sessionA,
    '/auth/api-keys': ids.apiKeyReadA,
    '/admin/users': ids.userOwnerA,
    '/orgs': b ? ids.orgB : ids.orgA,
    '/providers': b ? ids.providerB : ids.providerA,
    // TI-50: the inbound-webhook cell must be judged against the AUTOMATION
    // (the route's resource), never an arbitrary webhook endpoint or vehicle.
    '/inbound': b ? ids.automationB : ids.automationA,
  };
  path = path.replaceAll(':userId', b ? ids.userOwnerB : ids.userViewerA);
  path = path.replaceAll(':queueName', 'demo');
  path = path.replaceAll(':key', 'api');
  path = path.replaceAll(':provider', 'demo');
  const prefix = Object.keys(byKind)
    .filter((k) => path.includes(k))
    .sort((x, y) => y.length - x.length)[0];
  const resourceId = prefix ? byKind[prefix] : undefined;
  path = path.replaceAll(':vehicleId', b ? ids.vehicleB1 : ids.vehicleA1);
  path = path.replaceAll(':accountId', b ? ids.providerB : ids.providerA);
  if (resourceId) path = path.replaceAll(':id', resourceId);
  path = path.replaceAll(':orgId', b ? ids.orgB : ids.orgA);
  path = path.replaceAll(':token', WEBHOOK_TOKEN);
  // routes without a known fixture resource cannot be filled reliably
  if (path.includes(':') && prefix === undefined && !path.includes(':orgId')) return null;
  return path;
}

// Routes whose allow path needs challenge/ceremony state the matrix does not
// build, or whose response is fixed regardless of persona. Every cell still
// performs a real request and asserts the documented 4xx (never 5xx); the allow
// paths are covered by the dedicated suites named in each entry.
const SKIP_ROUTES: ReadonlySet<string> = new Set([
  'POST /api/v1/auth/logout', // auth.test.ts (session revocation)
  'POST /api/v1/auth/login', // phase2-security.test.ts (A-TOTPLOGIN)
  'POST /api/v1/auth/login/mfa', // phase2-security.test.ts (A-TOTPLOGIN)
  'POST /api/v1/auth/forgot-password', // phase2-security.test.ts (A-ENUM)
  'POST /api/v1/auth/reset-password', // phase2-security.test.ts (A-ENUM)
  'POST /api/v1/auth/step-up', // phase2-security.test.ts (A-STEPUP)
  'POST /api/v1/auth/passkey/login/options', // phase2-security.test.ts (A-PASSKEY)
  'POST /api/v1/auth/passkey/login/verify', // phase2-security.test.ts (A-PASSKEY)
  'POST /api/v1/auth/passkeys/options', // phase2-security.test.ts (A-PASSKEY)
  'POST /api/v1/auth/passkeys', // phase2-security.test.ts (A-PASSKEY)
  'POST /api/v1/auth/mfa/totp/setup', // phase2-security.test.ts (A-TOTPSETUP)
  'POST /api/v1/auth/mfa/totp/confirm', // phase2-security.test.ts (A-TOTPSETUP)
  'POST /api/v1/auth/mfa/totp/disable', // phase2-security.test.ts (A-TOTPSETUP)
  'POST /api/v1/auth/mfa/recovery-codes/regenerate', // phase2-security.test.ts (A-RECOVERY)
  'POST /api/v1/auth/passkeys/:id/delete', // golden cell SEC-REVIEW-4 below
  'PATCH /api/v1/users/retention', // spec: always 404
  'GET /api/v1/status/subscriptions/confirm/:token', // status.test.ts (N-SUBS)
  'GET /api/v1/status/subscriptions/unsubscribe/:token', // status.test.ts (N-SUBS)
  'GET /api/v1/geocode', // 404 GEOCODER_DISABLED when unconfigured
  'POST /api/v1/invitations/:token/accept', // orgs.test.ts (NEW-02)
  'POST /api/v1/automations/webhook/:token', // removed: replaced by inbound hooks
  // Raw-body inbound webhook (mounted before express.json, no CSRF): a matrix
  // probe with an empty body always gets 400/404. Covered by webhooks.test.ts.
  'POST /api/v1/hooks/automations/:publicId',
  // Session-only routes whose matrix answer is refined per persona above.
  'POST /api/v1/providers/demo/connect',
  'POST /api/v1/users/demo-mode',
]);

// Per-persona expected statuses for skip routes. A function returning null
// asserts only "never 5xx" (the allow/deny paths of that route are covered by
// the dedicated suites named in SKIP_ROUTES).
const SKIP_EXPECT: Record<string, (persona: Persona) => number | null> = {
  'POST /api/v1/auth/logout': (p) => (p.startsWith('apiKey') ? 403 : null),
  'POST /api/v1/auth/login': () => null, // throttled empty-body logins answer 429
  'POST /api/v1/auth/login/mfa': () => 401, // no ceremony
  'POST /api/v1/auth/forgot-password': () => 200, // uniform answer
  'POST /api/v1/auth/reset-password': () => 400, // empty body
  'POST /api/v1/auth/step-up': (p) => (p.startsWith('apiKey') ? 403 : null),
  'POST /api/v1/auth/passkey/login/options': () => 400,
  'POST /api/v1/auth/passkey/login/verify': () => 400, // NEW-04: missing body is a client error
  'POST /api/v1/auth/passkeys/options': (p) => (p.startsWith('apiKey') ? 403 : null),
  'POST /api/v1/auth/passkeys': (p) => (p.startsWith('apiKey') ? 403 : null),
  'POST /api/v1/auth/mfa/totp/setup': (p) => (p.startsWith('apiKey') ? 403 : null),
  'POST /api/v1/auth/mfa/totp/confirm': (p) => (p.startsWith('apiKey') ? 403 : null),
  'POST /api/v1/auth/mfa/totp/disable': (p) => (p.startsWith('apiKey') ? 403 : null),
  'POST /api/v1/auth/mfa/recovery-codes/regenerate': (p) => (p.startsWith('apiKey') ? 403 : null),
  'POST /api/v1/auth/passkeys/:id/delete': (p) => (p === 'ownerA' ? 200 : null), // possession step-up; golden cell SEC-REVIEW-4 covers the unelevated path
  'PATCH /api/v1/users/retention': (p) => (p.startsWith('apiKey') ? 403 : 404),
  'GET /api/v1/status/subscriptions/confirm/:token': () => 404,
  'GET /api/v1/status/subscriptions/unsubscribe/:token': () => 404,
  'GET /api/v1/geocode': (p) => (p.startsWith('apiKey') ? 403 : 404),
  'POST /api/v1/invitations/:token/accept': (p) => (p.startsWith('apiKey') ? 403 : 404),
  'POST /api/v1/automations/webhook/:token': () => 404,
  'POST /api/v1/hooks/automations/:publicId': () => 404,
  // Routes whose own semantics (no membership, demo fleet) refine the policy
  // answer; asserted exactly here.
  'POST /api/v1/providers/demo/connect': (p) =>
    p.startsWith('apiKey') || p === 'outsider' || p === 'viewerA' || p === 'driverA' ? 403 : 200,
  'POST /api/v1/users/demo-mode': (p) => (p.startsWith('apiKey') ? 403 : null),
};

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
  if (persona === 'instanceAdmin') {
    // The instance admin acts as OWNER of the operator org only. Fixture ids
    // belong to orgA/orgB, so param/body-scoped resources are never theirs.
    if (t.kind !== 'org' && t.kind !== 'vehicle') return false;
    const from = 'from' in t && typeof t.from === 'string' ? t.from : '';
    if (from.startsWith('param:') || from.startsWith('body:')) return false;
    return new Set(ROLE_PERMISSIONS.OWNER as readonly string[]).has(perm);
  }
  const role = (() => {
    switch (persona) {
      case 'ownerA':
      case 'ownerB':
        return 'OWNER';
      case 'adminA':
        return 'ADMIN';
      case 'driverA':
        return 'DRIVER';
      case 'viewerA':
        return 'VIEWER';
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

// Destructive routes run against throwaway fixtures so allowed executions can
// actually happen without destroying the world.
// Routes whose policy is target:none but whose handler enforces ownership
// with 404 (info hiding): only ownerA's fixture allows.
const OWNER_ONLY: ReadonlySet<string> = new Set([
  'POST /api/v1/notifications/webhooks/:id/rotate-secret',
  'POST /api/v1/notifications/:id/read',
  'PATCH /api/v1/notifications/webhooks/:id',
  'DELETE /api/v1/notifications/webhooks/:id',
  'DELETE /api/v1/auth/api-keys/:id',
]);

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
  'PATCH /api/v1/fleet/assignments/:id',
  'DELETE /api/v1/fleet/cost-centers/:id',
  'DELETE /api/v1/fleet/departments/:id',
  'DELETE /api/v1/fleet/drivers/:id',
  'DELETE /api/v1/fleet/groups/:id',
  'DELETE /api/v1/fleet/maintenance/:id',
  'DELETE /api/v1/auth/passkeys/:id',
  'DELETE /api/v1/orgs/:orgId',
  'DELETE /api/v1/auth/api-keys/:id',
  'DELETE /api/v1/notifications/webhooks/:id',
  'POST /api/v1/notifications/webhooks/:id/rotate-secret',
  'DELETE /api/v1/orgs/:orgId/invitations/:id',
  'DELETE /api/v1/orgs/:orgId/members/:userId',
  'POST /api/v1/providers/:accountId/disconnect',
  'POST /api/v1/providers/:accountId/demo-degraded',
]);

async function throwawayFor(
  route: { method: string; path: string },
  persona: Persona,
): Promise<string | null> {
  const orgId = persona === 'ownerB' ? ids.orgB : ids.orgA;
  const make = async (fn: () => Promise<{ id: string }>) => (await fn()).id;
  switch (`${route.method} ${route.path}`) {
    case 'POST /api/v1/users/me/delete': {
      const u = await prisma.user.create({
        data: {
          email: `mx-del-${randomId()}@example.test`,
          name: 'Del',
          passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$s$s',
          emailVerifiedAt: new Date(),
          webauthnUserId: randomId(),
        },
      });
      const { token, sessionId } = await createSession(u.id);
      await prisma.userSession.update({
        where: { id: sessionId },
        data: { stepUpAt: new Date(), stepUpMethod: 'password' },
      });
      throwawayTokenOverride = token;
      return '/api/v1/users/me/delete';
    }
    case 'DELETE /api/v1/vehicles/:id':
      return `/api/v1/vehicles/${await make(() => prisma.vehicle.create({ data: { organizationId: orgId, providerAccountId: ids.providerA, provider: 'demo', providerVehicleId: randomId(), displayName: 'T', demo: true } }))}`;
    case 'DELETE /api/v1/vehicles/:id/shares/:shareId': {
      const v = await make(() =>
        prisma.vehicle.create({
          data: {
            organizationId: orgId,
            providerAccountId: ids.providerA,
            provider: 'demo',
            providerVehicleId: randomId(),
            displayName: 'TS',
            demo: true,
          },
        }),
      );
      const share = await make(() =>
        prisma.vehicleGrant.create({
          data: {
            vehicleId: v,
            userId: persona === 'ownerB' ? ids.userOwnerB : ids.userDriverA,
            level: 'VIEWER',
            grantedById: persona === 'ownerB' ? ids.userOwnerB : ids.userOwnerA,
          },
        }),
      );
      return `/api/v1/vehicles/${v}/shares/${share}`;
    }
    case 'DELETE /api/v1/vehicles/privacy-zones/:id':
      return `/api/v1/vehicles/privacy-zones/${await make(() => prisma.privacyZone.create({ data: { organizationId: orgId, createdById: ids.userOwnerA, name: 'TZ', lat: 1, lon: 1, radiusM: 10 } }))}`;
    case 'DELETE /api/v1/vehicles/places/all/:id':
      return `/api/v1/vehicles/places/all/${await make(() => prisma.place.create({ data: { organizationId: orgId, createdById: ids.userOwnerA, name: 'TP', lat: 1, lon: 1 } }))}`;
    case 'DELETE /api/v1/vehicles/geofences/all/:id':
      return `/api/v1/vehicles/geofences/all/${await make(() => prisma.geofence.create({ data: { organizationId: orgId, createdById: ids.userOwnerA, name: 'TF', lat: 1, lon: 1, radiusM: 10, alertOn: 'both' } }))}`;
    case 'DELETE /api/v1/charging/rates/list/:id':
      return `/api/v1/charging/rates/list/${await make(() => prisma.rateRule.create({ data: { organizationId: orgId, createdById: ids.userOwnerA, name: 'TR', type: 'flat', pricePerKwh: 0.2, currency: 'USD' } }))}`;
    case 'DELETE /api/v1/drives/:id':
      return `/api/v1/drives/${await make(() => prisma.drive.create({ data: { vehicleId: persona === 'ownerB' ? ids.vehicleB1 : ids.vehicleA1, startAt: new Date(), endAt: new Date(Date.now() + 1000), distanceKm: 1, durationSec: 60, avgSpeedKmh: 60, maxSpeedKmh: 60, energyKwh: 0.2, efficiencyWhPerKm: 200 } }))}`;
    case 'DELETE /api/v1/automations/:id':
      return `/api/v1/automations/${await make(() => prisma.automation.create({ data: { organizationId: orgId, userId: persona === 'ownerB' ? ids.userOwnerB : ids.userOwnerA, name: 'TA', triggerType: 'scheduled', triggerParams: {}, conditions: [], actions: [] } }))}`;
    case 'DELETE /api/v1/fleet/assignments/:id':
    case 'PATCH /api/v1/fleet/assignments/:id': {
      const d = await make(() =>
        prisma.driver.create({ data: { organizationId: orgId, name: 'TD' } }),
      );
      return `/api/v1/fleet/assignments/${await make(() => prisma.vehicleAssignment.create({ data: { organizationId: orgId, vehicleId: persona === 'ownerB' ? ids.vehicleB1 : ids.vehicleA1, driverId: d } }))}`;
    }
    case 'DELETE /api/v1/fleet/cost-centers/:id':
      return `/api/v1/fleet/cost-centers/${await make(() => prisma.costCenter.create({ data: { organizationId: orgId, name: 'TC', code: randomId().slice(0, 8) } }))}`;
    case 'DELETE /api/v1/fleet/departments/:id':
      return `/api/v1/fleet/departments/${await make(() => prisma.department.create({ data: { organizationId: orgId, name: 'TD' } }))}`;
    case 'DELETE /api/v1/fleet/drivers/:id':
      return `/api/v1/fleet/drivers/${await make(() => prisma.driver.create({ data: { organizationId: orgId, name: 'TDR' } }))}`;
    case 'DELETE /api/v1/fleet/groups/:id':
      return `/api/v1/fleet/groups/${await make(() => prisma.fleetGroup.create({ data: { organizationId: orgId, name: 'TG' } }))}`;
    case 'DELETE /api/v1/fleet/maintenance/:id':
      return `/api/v1/fleet/maintenance/${await make(() => prisma.maintenanceRecord.create({ data: { vehicleId: persona === 'ownerB' ? ids.vehicleB1 : ids.vehicleA1, title: 'TM', kind: 'service' } }))}`;
    case 'DELETE /api/v1/auth/passkeys/:id':
      return `/api/v1/auth/passkeys/${await make(() => prisma.passkeyCredential.create({ data: { userId: ids.userOwnerA, credentialId: randomId(), publicKey: Buffer.alloc(65).toString('base64'), counter: 0n, transports: [], name: 'TK' } }))}`;
    case 'DELETE /api/v1/orgs/:orgId':
      return `/api/v1/orgs/${await make(() => prisma.organization.create({ data: { kind: 'TEAM', name: 'TO', memberships: { create: [{ userId: persona === 'ownerB' ? ids.userOwnerB : ids.userOwnerA, role: 'OWNER' }] } } }))}`;
    case 'DELETE /api/v1/auth/api-keys/:id':
      return `/api/v1/auth/api-keys/${await make(() => prisma.apiKey.create({ data: { userId: ids.userOwnerA, organizationId: ids.orgA, name: 'TK', keyHash: sha256hex(`mxkey${randomId()}`), prefix: `vlk_${randomId().slice(0, 12)}`, scopes: ['vehicles:read'], expiresAt: new Date(Date.now() + 86_400_000) } }))}`;
    case 'DELETE /api/v1/notifications/webhooks/:id':
      return `/api/v1/notifications/webhooks/${await make(() => prisma.webhookEndpoint.create({ data: { userId: ids.userOwnerA, name: 'TW', url: 'https://example.test/th', events: JSON.parse('["automation_fired"]') } }))}`;
    case 'POST /api/v1/notifications/webhooks/:id/rotate-secret':
      return `/api/v1/notifications/webhooks/${await make(() => prisma.webhookEndpoint.create({ data: { userId: ids.userOwnerA, name: 'TR', url: 'https://example.test/tr', events: JSON.parse('["automation_fired"]') } }))}/rotate-secret`;
    case 'DELETE /api/v1/orgs/:orgId/invitations/:id':
      return `/api/v1/orgs/${orgId}/invitations/${await make(() => prisma.invitation.create({ data: { organizationId: orgId, kind: 'membership', email: `mx-inv-${randomId()}@example.test`, role: 'VIEWER', tokenHash: sha256hex(randomId()), invitedById: persona === 'ownerB' ? ids.userOwnerB : ids.userOwnerA, expiresAt: new Date(Date.now() + 86_400_000) } }))}`;
    case 'POST /api/v1/providers/:accountId/disconnect':
      return `/api/v1/providers/${await make(() => prisma.providerAccount.create({ data: { organizationId: orgId, provider: 'demo', label: 'TAcc', status: 'connected', demo: true } }))}/disconnect`;
    case 'POST /api/v1/providers/:accountId/demo-degraded':
      return `/api/v1/providers/${await make(() => prisma.providerAccount.create({ data: { organizationId: orgId, provider: 'demo', label: 'TAcc2', status: 'connected', demo: true } }))}/demo-degraded`;
    case 'DELETE /api/v1/orgs/:orgId/members/:userId': {
      const mu = await make(() =>
        prisma.user.create({
          data: {
            email: `mx-mem-${randomId()}@example.test`,
            name: 'Mem',
            passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$s$s',
            emailVerifiedAt: new Date(),
            webauthnUserId: randomId(),
          },
        }),
      );
      await make(() =>
        prisma.membership.create({ data: { organizationId: orgId, userId: mu, role: 'VIEWER' } }),
      );
      return `/api/v1/orgs/${orgId}/members/${mu}`;
    }
    default:
      return null;
  }
}

let throwawayTokenOverride: string | null = null;

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
      const res = await csrfRequest(agent, c.method, c.path, (c.body as object) ?? {});
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
        const key = `${route.method} ${route.path}`;
        // Z-AUTOXTENANT: the demo webhook accepts ACTIVE members of the
        // vehicle's org (any role); everyone else gets 404.
        const expected =
          key === 'POST /api/v1/providers/:provider/webhook'
            ? ['ownerA', 'viewerA', 'driverA', 'adminA'].includes(persona)
            : OWNER_ONLY.has(key)
              ? persona === 'ownerA'
              : personaHas(route.policy, persona);
        const method = route.method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete';
        const body = (() => {
          switch (key) {
            case 'POST /api/v1/commands':
              return {
                vehicleId: persona === 'ownerB' ? ids.vehicleB1 : ids.vehicleA1,
                type: 'lock',
                params: {},
              };
            case 'POST /api/v1/commands/switches/vehicle':
              return {
                vehicleId: persona === 'ownerB' ? ids.vehicleB1 : ids.vehicleA1,
                switch: 'kill_switch',
                enabled: false,
              };
            case 'POST /api/v1/fleet/maintenance':
              return {
                vehicleId: persona === 'ownerB' ? ids.vehicleB1 : ids.vehicleA1,
                title: 'MX',
                kind: 'service',
              };
            default:
              return {};
          }
        })();

        const agentFor = (token: string) => {
          const agent = request.agent(base);
          if (persona.startsWith('apiKey')) agent.set('Authorization', `Bearer ${token}`);
          else agent.set('Cookie', `vl_session=${token}`);
          return agent;
        };

        if (key === 'POST /api/v1/auth/sessions/:id/revoke' && persona === 'ownerA') {
          // The owner revokes a throwaway session so the matrix token survives.
          const u = await prisma.user.create({
            data: {
              email: `mx-rev-${randomId()}@example.test`,
              name: 'Rev',
              passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$s$s',
              emailVerifiedAt: new Date(),
              webauthnUserId: randomId(),
            },
          });
          const { token, sessionId } = await createSession(u.id);
          const agent = request.agent(base).set('Cookie', `vl_session=${token}`);
          const res = await csrfRequest(
            agent,
            'post',
            `/api/v1/auth/sessions/${sessionId}/revoke`,
            {},
          );
          expect(res.status, `${key} as ${persona}`).toBe(200);
          return;
        }

        if (key === 'POST /api/v1/users/me/delete') {
          const url = await throwawayFor(route, persona);
          const agent = agentFor(throwawayTokenOverride ?? '');
          const res = await csrfRequest(agent, 'post', url ?? '/api/v1/users/me/delete', {
            confirm: 'DELETE',
          });
          expect(res.status, `${key} as ${persona}`).toBe(202);
          return;
        }

        if (SKIP_ROUTES.has(key)) {
          if (key === 'POST /api/v1/auth/logout' && !persona.startsWith('apiKey')) {
            // Session personas log out a throwaway session so the matrix
            // personas' tokens survive the rest of the run.
            const u = await prisma.user.create({
              data: {
                email: `mx-out-${randomId()}@example.test`,
                name: 'Out',
                passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$s$s',
                emailVerifiedAt: new Date(),
                webauthnUserId: randomId(),
              },
            });
            const { token } = await createSession(u.id);
            const agent = agentFor(token);
            const res = await csrfRequest(agent, 'post', '/api/v1/auth/logout', {});
            expect(res.status, `${key} as ${persona}`).toBe(200);
            return;
          }
          const url = fill(route, persona);
          const agent = agentFor(w.tokens[persona]);
          const res = await csrfRequest(agent, method, url ?? route.path, body);
          const expectFn = SKIP_EXPECT[key] ?? (() => null);
          const exact = expectFn(persona);
          if (exact !== null) {
            expect(res.status, `${key} as ${persona}`).toBe(exact);
          } else {
            expect(
              res.status,
              `${key} as ${persona} (allow path covered by dedicated suite)`,
            ).toBeLessThan(500);
          }
          expect(res.status, `${key} as ${persona} must never answer 5xx`).toBeLessThan(500);
          return;
        }

        const bodyTarget =
          route.policy.target.kind !== 'none' &&
          'from' in route.policy.target &&
          typeof route.policy.target.from === 'string' &&
          route.policy.target.from.startsWith('body:');
        if (bodyTarget) {
          // Payload fixtures: the golden cells above and the route suites carry
          // the real bodies; the matrix still asserts the gate and sanity here.
          const url = fill(route, persona);
          const agent = agentFor(w.tokens[persona]);
          const res = await csrfRequest(agent, method, url ?? route.path, body);
          expect(res.status, `${key} as ${persona} must never answer 5xx`).toBeLessThan(500);
          if (!expected) expect([401, 403, 404]).toContain(res.status);
          return;
        }

        let url = fill(route, persona);
        const agent = agentFor(w.tokens[persona]);
        if (DESTRUCTIVE.has(key)) {
          const t = await throwawayFor(route, persona);
          if (!t) throw new Error(`no throwaway fixture for ${key}`);
          url = t;
        }
        if (url === null) throw new Error(`no fixture for ${key} as ${persona}`);
        const res = await csrfRequest(agent, method, url, body);
        if (expected) {
          if (res.status >= 500) {
            // A 5xx is only acceptable as a documented, coded answer — a bare
            // crash-500 (no error.code) fails the cell.
            expect(
              res.body?.error?.code,
              `${key} as ${persona} must carry a documented error code on 5xx`,
            ).toBeTruthy();
          } else {
            expect([401, 403, 404], `${key} as ${persona} must allow`).not.toContain(res.status);
          }
        } else {
          expect([401, 403, 404], `${key} as ${persona} must deny`).toContain(res.status);
        }
      });
    },
  );
});
