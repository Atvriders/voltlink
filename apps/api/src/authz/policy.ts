// Route policies: one table drives enforcement and the authorization matrix
// test. Handlers use req.actor and req.access and never re-query by a
// client-supplied id.

import { Router, type RequestHandler, type Request } from 'express';
import { prisma } from '../core/db';
import { env } from '../core/env';
import { authenticate } from './authenticate';
import {
  accessibleVehicleIds,
  assertInstanceAdmin,
  assertOperator,
  assertOrgPermission,
  assertVehicleAccess,
  orgPermissions,
} from './access';
import { AccessDenied } from './errors';
import type { Actor, AccessContext } from './types';
import type { ApiScope, OrgPermission, Permission, VehiclePermission } from '@voltlink/shared';

export type Source = `param:${string}` | `query:${string}` | `body:${string}`;

export type ResourceKind =
  | 'drive'
  | 'chargingSession'
  | 'maintenanceRecord'
  | 'command'
  | 'automation'
  | 'place'
  | 'geofence'
  | 'privacyZone'
  | 'rateRule'
  | 'fleetGroup'
  | 'driver'
  | 'department'
  | 'costCenter'
  | 'assignment'
  | 'providerAccount'
  | 'membership'
  | 'invitation'
  | 'vehicleGrant'
  | 'session'
  | 'passkey'
  | 'apiKey'
  | 'webhookEndpoint';

export interface RoutePolicy {
  auth: 'public' | 'session' | 'any';
  apiScope?: ApiScope;
  verifiedEmail?: boolean;
  stepUp?: { maxAgeSec?: number; possession?: boolean };
  target:
    | { kind: 'none' }
    | { kind: 'self' }
    | { kind: 'instanceAdmin' }
    | { kind: 'operator'; perm: 'status.manage' | 'incidents.manage' | 'instance.support_read' }
    | {
        kind: 'org';
        from?: Source;
        perm: OrgPermission | VehiclePermission;
        optional?: boolean;
        own?: boolean;
      }
    | { kind: 'vehicle'; from: Source; perm: VehiclePermission; optional?: boolean }
    | { kind: 'resource'; resource: ResourceKind; from: Source; perm: Permission };
}

export const ROUTE_TABLE: {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  policy: RoutePolicy;
}[] = [];

function sourceValue(req: Request, src: Source): string | undefined {
  const [where, name] = src.split(':') as [string, string];
  if (where === 'param') return typeof req.params[name] === 'string' ? req.params[name] : undefined;
  if (where === 'query') {
    const q = req.query[name];
    return typeof q === 'string' ? q : undefined;
  }
  if (where === 'body') {
    const b = req.body as Record<string, unknown> | undefined;
    const v = b?.[name];
    return typeof v === 'string' ? v : undefined;
  }
  return undefined;
}

const RESOURCE_LOADERS: Record<
  ResourceKind,
  (id: string) => Promise<{
    id: string;
    vehicleId?: string;
    organizationId?: string;
    ownerUserId?: string;
  } | null>
> = {
  drive: async (id) => {
    const r = await prisma.drive.findUnique({
      where: { id },
      select: { id: true, vehicleId: true },
    });
    return r;
  },
  chargingSession: async (id) => {
    const r = await prisma.chargingSession.findUnique({
      where: { id },
      select: { id: true, vehicleId: true },
    });
    return r;
  },
  maintenanceRecord: async (id) => {
    const r = await prisma.maintenanceRecord.findUnique({
      where: { id },
      select: { id: true, vehicleId: true },
    });
    return r;
  },
  command: async (id) => {
    const r = await prisma.vehicleCommand.findUnique({
      where: { id },
      select: { id: true, vehicleId: true },
    });
    return r;
  },
  automation: async (id) => {
    const r = await prisma.automation.findUnique({
      where: { id },
      select: { id: true, organizationId: true },
    });
    return r;
  },
  place: async (id) => {
    const r = await prisma.place.findUnique({
      where: { id },
      select: { id: true, organizationId: true },
    });
    return r;
  },
  geofence: async (id) => {
    const r = await prisma.geofence.findUnique({
      where: { id },
      select: { id: true, organizationId: true },
    });
    return r;
  },
  privacyZone: async (id) => {
    const r = await prisma.privacyZone.findUnique({
      where: { id },
      select: { id: true, organizationId: true },
    });
    return r;
  },
  rateRule: async (id) => {
    const r = await prisma.rateRule.findUnique({
      where: { id },
      select: { id: true, organizationId: true },
    });
    return r;
  },
  fleetGroup: async (id) => {
    const r = await prisma.fleetGroup.findUnique({
      where: { id },
      select: { id: true, organizationId: true },
    });
    return r;
  },
  driver: async (id) => {
    const r = await prisma.driver.findUnique({
      where: { id },
      select: { id: true, organizationId: true },
    });
    return r;
  },
  department: async (id) => {
    const r = await prisma.department.findUnique({
      where: { id },
      select: { id: true, organizationId: true },
    });
    return r;
  },
  costCenter: async (id) => {
    const r = await prisma.costCenter.findUnique({
      where: { id },
      select: { id: true, organizationId: true },
    });
    return r;
  },
  assignment: async (id) => {
    const r = await prisma.vehicleAssignment.findUnique({
      where: { id },
      select: { id: true, vehicleId: true, organizationId: true },
    });
    return r;
  },
  providerAccount: async (id) => {
    const r = await prisma.providerAccount.findUnique({
      where: { id },
      select: { id: true, organizationId: true },
    });
    return r;
  },
  membership: async (id) => {
    const r = await prisma.membership.findUnique({
      where: { id },
      select: { id: true, organizationId: true, userId: true },
    });
    return r ? { id: r.id, organizationId: r.organizationId, ownerUserId: r.userId } : null;
  },
  invitation: async (id) => {
    const r = await prisma.invitation.findUnique({
      where: { id },
      select: { id: true, organizationId: true },
    });
    return r;
  },
  vehicleGrant: async (id) => {
    const r = await prisma.vehicleGrant.findUnique({
      where: { id },
      select: { id: true, vehicleId: true },
    });
    return r;
  },
  session: async (id) => {
    const r = await prisma.userSession.findUnique({
      where: { id },
      select: { id: true, userId: true },
    });
    return r ? { id: r.id, ownerUserId: r.userId } : null;
  },
  passkey: async (id) => {
    const r = await prisma.passkeyCredential.findUnique({
      where: { id },
      select: { id: true, userId: true },
    });
    return r ? { id: r.id, ownerUserId: r.userId } : null;
  },
  apiKey: async (id) => {
    const r = await prisma.apiKey.findUnique({ where: { id }, select: { id: true, userId: true } });
    return r ? { id: r.id, ownerUserId: r.userId } : null;
  },
  webhookEndpoint: async (id) => {
    const r = await prisma.webhookEndpoint.findUnique({
      where: { id },
      select: { id: true, userId: true },
    });
    return r ? { id: r.id, ownerUserId: r.userId } : null;
  },
};

async function resolveTarget(
  req: Request,
  actor: Actor,
  target: RoutePolicy['target'],
): Promise<AccessContext> {
  switch (target.kind) {
    case 'none':
      return {};
    case 'self':
      return { organizationId: undefined, vehicleIds: [] };
    case 'instanceAdmin':
      assertInstanceAdmin(actor);
      return {};
    case 'operator':
      await assertOperator(actor, target.perm);
      return {};
    case 'org': {
      const id = target.from ? sourceValue(req, target.from) : undefined;
      if (!id) {
        if (target.optional) return {};
        if (target.own) {
          const memberships = await prisma.membership.findMany({
            where: { userId: actor.kind === 'system' ? '' : actor.userId, status: 'ACTIVE' },
          });
          for (const m of memberships) {
            const perms = await orgPermissions(actor, m.organizationId);
            if (perms.has(target.perm))
              return { organizationId: m.organizationId, permissions: perms };
          }
          throw new AccessDenied('FORBIDDEN', `Missing ${target.perm} in any organization.`, 403);
        }
        throw new AccessDenied('BAD_REQUEST', `Missing ${target.from}.`, 400);
      }
      const perms = await assertOrgPermission(actor, id, target.perm as OrgPermission);
      return { organizationId: id, permissions: perms };
    }
    case 'vehicle': {
      const id = sourceValue(req, target.from);
      if (!id) {
        if (target.optional) {
          return { vehicleIds: await accessibleVehicleIds(actor, target.perm) };
        }
        throw new AccessDenied('BAD_REQUEST', `Missing ${target.from}.`, 400);
      }
      const { vehicle, permissions } = await assertVehicleAccess(actor, id, target.perm);
      return { vehicle: vehicle as AccessContext['vehicle'], permissions };
    }
    case 'resource': {
      const id = sourceValue(req, target.from);
      if (!id) throw new AccessDenied('BAD_REQUEST', `Missing ${target.from}.`, 400);
      const resource = await RESOURCE_LOADERS[target.resource](id);
      if (!resource) throw new AccessDenied('NOT_FOUND', 'Not found.', 404);
      if (resource.ownerUserId !== undefined) {
        if (actor.kind === 'system' || resource.ownerUserId !== actor.userId)
          throw new AccessDenied('NOT_FOUND', 'Not found.', 404);
        return { resource: resource as AccessContext['resource'] };
      }
      if (resource.vehicleId) {
        const { vehicle, permissions } = await assertVehicleAccess(
          actor,
          resource.vehicleId,
          target.perm as VehiclePermission,
        );
        return { resource, vehicle: vehicle as AccessContext['vehicle'], permissions };
      }
      if (resource.organizationId) {
        const perms = await assertOrgPermission(
          actor,
          resource.organizationId,
          target.perm as OrgPermission,
        );
        return { resource, organizationId: resource.organizationId, permissions: perms };
      }
      return { resource: resource as AccessContext['resource'] };
    }
  }
}

/** Narrow req.actor to a session actor; API keys are never accepted here. */
export function sessionActor(req: Request): Extract<Actor, { kind: 'session' }> {
  const a = req.actor;
  if (!a || a.kind !== 'session')
    throw new AccessDenied(
      'API_KEY_NOT_ALLOWED',
      'This endpoint requires an interactive session.',
      403,
    );
  return a;
}

export function requireRecentStepUp(
  actor: Actor,
  opts: { maxAgeSec?: number; possession?: boolean } = {},
): void {
  const methods = ['password', 'totp', 'recovery_code', 'passkey'];
  if (actor.kind !== 'session')
    throw new AccessDenied('STEP_UP_REQUIRED', 'Requires an interactive session.', 403, {
      methods,
    });
  const fresh =
    !!actor.stepUpAt &&
    Date.now() - actor.stepUpAt.getTime() <= (opts.maxAgeSec ?? env.STEPUP_WINDOW_SEC) * 1000;
  const factorOk =
    !opts.possession ||
    !actor.mfaEnrolled ||
    (actor.stepUpMethod !== null && actor.stepUpMethod !== 'password');
  if (!fresh || !factorOk) {
    throw new AccessDenied('STEP_UP_REQUIRED', 'Confirm it is you to continue.', 403, {
      methods:
        opts.possession && actor.mfaEnrolled ? methods.filter((m) => m !== 'password') : methods,
    });
  }
}

export function enforce(policy: RoutePolicy): RequestHandler {
  return async (req, _res, next) => {
    try {
      if (policy.auth !== 'public') {
        const actor = (req.actor = await authenticate(req, policy.auth));
        if (actor.kind === 'apiKey') {
          if (!policy.apiScope || !actor.scopes.includes(policy.apiScope)) {
            throw new AccessDenied(
              policy.apiScope ? 'API_KEY_SCOPE' : 'API_KEY_NOT_ALLOWED',
              'API key not permitted here.',
              403,
            );
          }
        }
        if (policy.verifiedEmail && !actor.emailVerified) {
          throw new AccessDenied('EMAIL_UNVERIFIED', 'Verify your email address first.', 403);
        }
        req.access = await resolveTarget(req, actor, policy.target);
        if (policy.stepUp) requireRecentStepUp(req.actor!, policy.stepUp);
      } else if (policy.target.kind !== 'none') {
        // Public routes never carry a target; callers use none only.
        throw new Error('public policy with a target is not supported');
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

export function policyRouter(prefix: string) {
  const router = Router();
  const add =
    (method: 'get' | 'post' | 'put' | 'patch' | 'delete') =>
    (path: string, policy: RoutePolicy, ...handlers: RequestHandler[]) => {
      ROUTE_TABLE.push({
        method: method.toUpperCase() as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
        path: prefix + (path === '/' ? '' : path),
        policy,
      });
      router[method](path, enforce(policy), ...handlers);
    };
  return {
    prefix,
    router,
    get: add('get'),
    post: add('post'),
    put: add('put'),
    patch: add('patch'),
    delete: add('delete'),
  };
}

export function publicRoute(
  path: string,
  policy: RoutePolicy,
  ..._handlers: RequestHandler[]
): RequestHandler[] {
  void path;
  void policy;
  return [];
}
