// Organization routes: org CRUD, members, invitations, ownership transfer,
// retention settings and audit. Every route is organization-scoped; a handler
// never trusts a client-supplied id (Z-OWNER, Z-ROLERANK, Z-RETENTION).

import { policyRouter, sessionActor, requireRecentStepUp } from '../authz/policy';
import { AccessDenied } from '../authz/errors';
import { prisma } from '../core/db';
import { getSetting, audit } from '../core/settings';
import { sha256hex, randomToken } from '../core/crypto';
import { sendMail } from '../auth/service';
import { OPERATOR_ONLY_ROLES, ORG_ROLES, type OrgRole } from '@voltlink/shared';

export const orgsRouter = policyRouter('/api/v1/orgs');
export const invitationsRouter = policyRouter('/api/v1/invitations');

const RETENTION_MIN = 7;
const RETENTION_DEFAULT_CEILING = 365;
const RETENTION_MAX_CEILING = 3650;

async function retentionCeiling(kind: 'telemetry' | 'location'): Promise<number> {
  const raw = await getSetting(kind === 'telemetry' ? 'retention.telemetryMaxDays' : 'retention.locationMaxDays');
  const n = Number(raw);
  if (Number.isFinite(n) && n >= RETENTION_MIN && n <= RETENTION_MAX_CEILING) return n;
  return RETENTION_DEFAULT_CEILING;
}

function clampRetention(value: unknown, ceiling: number): number {
  const n = value === null || value === undefined ? ceiling : Number(value);
  if (!Number.isFinite(n)) return ceiling;
  return Math.min(ceiling, Math.max(RETENTION_MIN, Math.round(n)));
}

function orgDto(o: {
  id: string; kind: string; name: string; telemetryRetentionDays: number | null;
  locationRetentionDays: number | null; createdAt: Date; createdById: string | null;
}) {
  return {
    id: o.id,
    kind: o.kind,
    name: o.name,
    telemetryRetentionDays: o.telemetryRetentionDays,
    locationRetentionDays: o.locationRetentionDays,
    createdAt: o.createdAt.toISOString(),
  };
}

// ---- Organizations ----

orgsRouter.get('/', { auth: 'session', target: { kind: 'none' } }, async (req, res) => {
  const actor = sessionActor(req);
  const memberships = await prisma.membership.findMany({
    where: { userId: actor.userId, status: 'ACTIVE' },
    include: { organization: true },
    orderBy: { createdAt: 'asc' },
  });
  res.json({ data: memberships.map((m) => ({ ...orgDto(m.organization), role: m.role })) });
});

orgsRouter.post('/', { auth: 'session', target: { kind: 'none' } }, async (req, res) => {
  const actor = sessionActor(req);
  const allow = await getSetting('instance.allowOrgCreation');
  if (allow === 'false') {
    res.status(403).json({ error: { code: 'ORG_CREATION_DISABLED', message: 'Creating organizations is disabled by the instance administrator.' } });
    return;
  }
  const body = (req.body ?? {}) as { name?: string; kind?: string };
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : '';
  const kind = body.kind === 'TEAM' ? 'TEAM' : 'PERSONAL';
  if (name.length < 1) {
    res.status(400).json({ error: { code: 'VALIDATION', message: 'Organization name is required.' } });
    return;
  }
  const org = await prisma.organization.create({
    data: {
      kind,
      name,
      createdById: actor.userId,
      memberships: { create: { userId: actor.userId, role: 'OWNER' } },
    },
  });
  await audit({ actorId: actor.userId, organizationId: org.id, action: 'org.created', entityType: 'organization', entityId: org.id, ip: req.ip });
  res.status(201).json({ data: orgDto(org) });
});

orgsRouter.get('/:orgId', { auth: 'session', target: { kind: 'org', from: 'param:orgId', perm: 'org.read' } }, async (req, res) => {
  const orgId = req.access!.organizationId!;
  const org = await prisma.organization.findUnique({ where: { id: orgId } });
  if (!org) throw new AccessDenied('NOT_FOUND', 'Organization not found.', 404);
  res.json({ data: orgDto(org) });
});

orgsRouter.patch('/:orgId', { auth: 'session', target: { kind: 'org', from: 'param:orgId', perm: 'org.manage' } }, async (req, res) => {
  const orgId = req.access!.organizationId!;
  const body = (req.body ?? {}) as { name?: string; kind?: string };
  const data: Record<string, unknown> = {};
  if (typeof body.name === 'string' && body.name.trim()) data.name = body.name.trim().slice(0, 80);
  if (body.kind === 'PERSONAL' || body.kind === 'TEAM') data.kind = body.kind;
  const org = await prisma.organization.update({ where: { id: orgId }, data });
  await audit({ actorId: sessionActor(req).userId, organizationId: orgId, action: 'org.updated', entityType: 'organization', entityId: orgId, ip: req.ip });
  res.json({ data: orgDto(org) });
});

orgsRouter.delete('/:orgId', { auth: 'session', target: { kind: 'org', from: 'param:orgId', perm: 'org.delete' } }, async (req, res) => {
  const orgId = req.access!.organizationId!;
  const org = await prisma.organization.findUnique({ where: { id: orgId } });
  if (org?.kind === 'OPERATOR') {
    res.status(400).json({ error: { code: 'OPERATOR_ORG', message: 'Operator organizations cannot be deleted.' } });
    return;
  }
  await prisma.organization.delete({ where: { id: orgId } });
  await audit({ actorId: sessionActor(req).userId, action: 'org.deleted', entityType: 'organization', entityId: orgId, ip: req.ip });
  res.json({ data: { ok: true } });
});

// ---- Members ----

orgsRouter.get('/:orgId/members', { auth: 'session', target: { kind: 'org', from: 'param:orgId', perm: 'org.read' } }, async (req, res) => {
  const orgId = req.access!.organizationId!;
  const members = await prisma.membership.findMany({
    where: { organizationId: orgId, status: 'ACTIVE' },
    include: { user: { select: { id: true, email: true, name: true, emailVerifiedAt: true, suspendedAt: true } } },
    orderBy: { createdAt: 'asc' },
  });
  res.json({
    data: members.map((m) => ({
      userId: m.userId,
      email: m.user.email,
      name: m.user.name,
      role: m.role,
      vehicleScope: m.vehicleScope,
      providerScope: m.providerScope,
      suspended: !!m.user.suspendedAt,
      joinedAt: m.createdAt.toISOString(),
    })),
  });
});

orgsRouter.patch('/:orgId/members/:userId', { auth: 'session', target: { kind: 'org', from: 'param:orgId', perm: 'members.manage' } }, async (req, res) => {
  const orgId = req.access!.organizationId!;
  const actor = sessionActor(req);
  const userId = String(req.params.userId);
  const body = (req.body ?? {}) as { role?: string; vehicleScope?: string; providerScope?: string };
  const org = await prisma.organization.findUniqueOrThrow({ where: { id: orgId } });
  const member = await prisma.membership.findUnique({ where: { organizationId_userId: { organizationId: orgId, userId } } });
  if (!member) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Member not found.' } });
    return;
  }
  const role = typeof body.role === 'string' ? (ORG_ROLES as readonly string[]).includes(body.role) ? (body.role as OrgRole) : null : null;
  if (role === null && !body.vehicleScope && !body.providerScope) {
    res.status(400).json({ error: { code: 'VALIDATION', message: 'role, vehicleScope or providerScope required.' } });
    return;
  }
  if (role !== null) {
    // Operator-only roles exist only inside an OPERATOR organization.
    if ((OPERATOR_ONLY_ROLES as readonly string[]).includes(role) && org.kind !== 'OPERATOR') {
      res.status(400).json({ error: { code: 'ROLE_NOT_ASSIGNABLE', message: 'This role only exists in operator organizations.' } });
      return;
    }
    if (role === 'OWNER' || member.role === 'OWNER') {
      // Promoting or demoting an owner is an ownership decision (assign_owner).
      const { orgPermissions } = await import('../authz/access');
      const perms = await orgPermissions(actor, orgId);
      if (!perms.has('members.assign_owner')) {
        res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Missing members.assign_owner in this organization.' } });
        return;
      }
      // The last OWNER can never be demoted.
      if (member.role === 'OWNER' && role !== 'OWNER') {
        const owners = await prisma.membership.count({ where: { organizationId: orgId, role: 'OWNER', status: 'ACTIVE' } });
        if (owners <= 1) {
          res.status(409).json({ error: { code: 'LAST_OWNER', message: 'The last owner cannot be demoted.' } });
          return;
        }
      }
    }
  }
  const data: Record<string, unknown> = {};
  if (role !== null) data.role = role;
  if (body.vehicleScope === 'ALL' || body.vehicleScope === 'GRANTED') data.vehicleScope = body.vehicleScope;
  if (body.providerScope === 'ALL' || body.providerScope === 'GRANTED') data.providerScope = body.providerScope;
  await prisma.membership.update({ where: { id: member.id }, data });
  await audit({ actorId: actor.userId, organizationId: orgId, action: 'org.member_updated', entityType: 'membership', entityId: member.id, details: { role }, ip: req.ip });
  res.json({ data: { ok: true } });
});

orgsRouter.delete('/:orgId/members/:userId', { auth: 'session', target: { kind: 'org', from: 'param:orgId', perm: 'members.manage' } }, async (req, res) => {
  const orgId = req.access!.organizationId!;
  const actor = sessionActor(req);
  const userId = String(req.params.userId);
  const member = await prisma.membership.findUnique({ where: { organizationId_userId: { organizationId: orgId, userId } } });
  if (!member) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Member not found.' } });
    return;
  }
  if (member.role === 'OWNER') {
    const { orgPermissions } = await import('../authz/access');
    const perms = await orgPermissions(actor, orgId);
    if (!perms.has('members.assign_owner')) {
      res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Missing members.assign_owner in this organization.' } });
      return;
    }
    const owners = await prisma.membership.count({ where: { organizationId: orgId, role: 'OWNER', status: 'ACTIVE' } });
    if (owners <= 1) {
      res.status(409).json({ error: { code: 'LAST_OWNER', message: 'The last owner cannot be removed.' } });
      return;
    }
  }
  await prisma.membership.delete({ where: { id: member.id } });
  await audit({ actorId: actor.userId, organizationId: orgId, action: 'org.member_removed', entityType: 'membership', entityId: member.id, ip: req.ip });
  res.json({ data: { ok: true } });
});

// ---- Invitations (membership and vehicle shares) ----

orgsRouter.post('/:orgId/invitations', { auth: 'session', verifiedEmail: true, target: { kind: 'org', from: 'param:orgId', perm: 'members.manage' } }, async (req, res) => {
  const orgId = req.access!.organizationId!;
  const actor = sessionActor(req);
  const body = (req.body ?? {}) as { email?: string; role?: string; vehicleId?: string; grantLevel?: string; allowHighRisk?: boolean };
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ error: { code: 'VALIDATION', message: 'A valid email is required.' } });
    return;
  }
  const role = (ORG_ROLES as readonly string[]).includes(body.role ?? '') ? (body.role as OrgRole) : null;
  const vehicleId = typeof body.vehicleId === 'string' ? body.vehicleId : undefined;
  const kind = vehicleId ? 'vehicle_share' : 'membership';
  if (vehicleId) {
    const vehicle = await prisma.vehicle.findUnique({ where: { id: vehicleId }, select: { organizationId: true } });
    if (!vehicle || vehicle.organizationId !== orgId) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Vehicle not found in this organization.' } });
      return;
    }
  }
  const token = randomToken(32);
  const invitation = await prisma.invitation.create({
    data: {
      organizationId: orgId,
      kind,
      email,
      role: kind === 'membership' ? role : null,
      vehicleId,
      grantLevel: vehicleId ? (body.grantLevel === 'DRIVER' || body.grantLevel === 'MANAGER' ? body.grantLevel : 'VIEWER') : null,
      allowHighRisk: vehicleId ? body.allowHighRisk === true : false,
      tokenHash: sha256hex(token),
      invitedById: actor.userId,
      expiresAt: new Date(Date.now() + 7 * 86_400_000),
    },
  });
  await sendMail({
    to: email,
    subject: kind === 'membership' ? 'You are invited to a VoltLink organization' : 'A vehicle was shared with you on VoltLink',
    text: `Accept your invitation: ${process.env.PUBLIC_URL ?? 'https://voltlink.local'}/invitations/${token}`,
    html: `<p>Accept your invitation: <a href="${process.env.PUBLIC_URL ?? 'https://voltlink.local'}/invitations/${token}">open VoltLink</a></p>`,
  }).catch(() => undefined);
  await audit({ actorId: actor.userId, organizationId: orgId, action: kind === 'membership' ? 'org.member_invited' : 'vehicle.share_invited', entityType: 'invitation', entityId: invitation.id, details: { email }, ip: req.ip });
  // A-ENUM: always answer the same way so account existence is never disclosed.
  res.status(202).json({ data: { status: 'invited' } });
});

orgsRouter.get('/:orgId/invitations', { auth: 'session', target: { kind: 'org', from: 'param:orgId', perm: 'members.manage' } }, async (req, res) => {
  const orgId = req.access!.organizationId!;
  const rows = await prisma.invitation.findMany({
    where: { organizationId: orgId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  });
  res.json({
    data: rows.map((i) => ({
      id: i.id,
      kind: i.kind,
      email: i.email,
      role: i.role,
      vehicleId: i.vehicleId,
      grantLevel: i.grantLevel,
      expiresAt: i.expiresAt.toISOString(),
      createdAt: i.createdAt.toISOString(),
    })),
  });
});

orgsRouter.delete('/:orgId/invitations/:id', { auth: 'session', target: { kind: 'org', from: 'param:orgId', perm: 'members.manage' } }, async (req, res) => {
  const orgId = req.access!.organizationId!;
  const id = String(req.params.id);
  const invitation = await prisma.invitation.findUnique({ where: { id } });
  if (!invitation || invitation.organizationId !== orgId) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Invitation not found.' } });
    return;
  }
  await prisma.invitation.update({ where: { id }, data: { revokedAt: new Date() } });
  await audit({ actorId: sessionActor(req).userId, organizationId: orgId, action: 'org.invitation_revoked', entityType: 'invitation', entityId: id, ip: req.ip });
  res.json({ data: { ok: true } });
});

// ---- Ownership transfer ----

orgsRouter.post('/:orgId/transfer-ownership', { auth: 'session', stepUp: {}, target: { kind: 'org', from: 'param:orgId', perm: 'members.assign_owner' } }, async (req, res) => {
  const orgId = req.access!.organizationId!;
  const actor = sessionActor(req);
  const toUserId = typeof (req.body as { toUserId?: unknown } | undefined)?.toUserId === 'string' ? ((req.body as { toUserId: string }).toUserId) : '';
  if (!toUserId) {
    res.status(400).json({ error: { code: 'VALIDATION', message: 'toUserId is required.' } });
    return;
  }
  const [from, to] = await Promise.all([
    prisma.membership.findUnique({ where: { organizationId_userId: { organizationId: orgId, userId: actor.userId } } }),
    prisma.membership.findUnique({ where: { organizationId_userId: { organizationId: orgId, userId: toUserId } } }),
  ]);
  if (!from || from.role !== 'OWNER' || !to || to.status !== 'ACTIVE') {
    res.status(400).json({ error: { code: 'INVALID_TRANSFER', message: 'Ownership can only transfer from the current owner to an active member.' } });
    return;
  }
  await prisma.$transaction([
    prisma.membership.update({ where: { id: to.id }, data: { role: 'OWNER' } }),
    prisma.membership.update({ where: { id: from.id }, data: { role: 'ADMIN' } }),
  ]);
  await audit({ actorId: actor.userId, organizationId: orgId, action: 'org.ownership_transferred', entityType: 'organization', entityId: orgId, details: { toUserId }, ip: req.ip });
  res.json({ data: { ok: true, ownerUserId: toUserId } });
});

// ---- Retention settings (Z-RETENTION) ----

orgsRouter.patch('/:orgId/settings/retention', { auth: 'session', target: { kind: 'org', from: 'param:orgId', perm: 'privacy.manage' } }, async (req, res) => {
  const orgId = req.access!.organizationId!;
  const actor = sessionActor(req);
  const body = (req.body ?? {}) as { telemetryRetentionDays?: number | null; locationRetentionDays?: number | null };
  const org = await prisma.organization.findUnique({ where: { id: orgId } });
  if (!org) throw new AccessDenied('NOT_FOUND', 'Organization not found.', 404);
  const [tCeil, lCeil] = await Promise.all([retentionCeiling('telemetry'), retentionCeiling('location')]);
  const data: Record<string, number> = {};
  if ('telemetryRetentionDays' in body) data.telemetryRetentionDays = clampRetention(body.telemetryRetentionDays, tCeil);
  if ('locationRetentionDays' in body) data.locationRetentionDays = clampRetention(body.locationRetentionDays, lCeil);
  const current = {
    telemetry: org.telemetryRetentionDays ?? tCeil,
    location: org.locationRetentionDays ?? lCeil,
  };
  const next = {
    telemetry: data.telemetryRetentionDays ?? current.telemetry,
    location: data.locationRetentionDays ?? current.location,
  };
  // Lowering retention is a destructive decision: require recent step-up.
  if (next.telemetry < current.telemetry || next.location < current.location) {
    requireRecentStepUp(actor);
  }
  const updated = await prisma.organization.update({ where: { id: orgId }, data });
  await audit({ actorId: actor.userId, organizationId: orgId, action: 'org.retention_changed', entityType: 'organization', entityId: orgId, details: data, ip: req.ip });
  res.json({ data: orgDto(updated) });
});

// ---- Audit ----

orgsRouter.get('/:orgId/audit', { auth: 'session', target: { kind: 'org', from: 'param:orgId', perm: 'audit.read' } }, async (req, res) => {
  const orgId = req.access!.organizationId!;
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(req.query.pageSize) || 50));
  const [items, total] = await Promise.all([
    prisma.auditLog.findMany({
      where: { organizationId: orgId },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.auditLog.count({ where: { organizationId: orgId } }),
  ]);
  res.json({
    data: {
      items: items.map((e) => ({
        id: e.id,
        actorId: e.actorId,
        actorKind: e.actorKind,
        action: e.action,
        entityType: e.entityType,
        entityId: e.entityId,
        details: e.details,
        ip: e.ip,
        createdAt: e.createdAt.toISOString(),
      })),
      page,
      pageSize,
      total,
    },
  });
});

// ---- Invitation acceptance (existing, signed-in users) ----

invitationsRouter.post('/:token/accept', { auth: 'session', target: { kind: 'none' } }, async (req, res) => {
  const actor = sessionActor(req);
  const token = String(req.params.token);
  const invitation = await prisma.invitation.findUnique({ where: { tokenHash: sha256hex(token) } });
  if (!invitation || invitation.revokedAt || invitation.acceptedAt || invitation.expiresAt <= new Date()) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Invitation not found or expired.' } });
    return;
  }
  const user = await prisma.user.findUnique({ where: { id: actor.userId } });
  if (!user || user.email.toLowerCase() !== invitation.email.toLowerCase()) {
    res.status(403).json({ error: { code: 'EMAIL_MISMATCH', message: 'This invitation belongs to another email address.' } });
    return;
  }
  if (invitation.kind === 'vehicle_share' && invitation.vehicleId) {
    await prisma.vehicleGrant.upsert({
      where: { vehicleId_userId: { vehicleId: invitation.vehicleId, userId: actor.userId } },
      update: { level: invitation.grantLevel ?? 'VIEWER', allowHighRisk: invitation.allowHighRisk },
      create: { vehicleId: invitation.vehicleId, userId: actor.userId, level: invitation.grantLevel ?? 'VIEWER', allowHighRisk: invitation.allowHighRisk, grantedById: invitation.invitedById },
    });
    await audit({ actorId: actor.userId, organizationId: invitation.organizationId, action: 'share_granted', entityType: 'vehicleGrant', entityId: invitation.vehicleId, details: { invitationId: invitation.id }, ip: req.ip });
  } else {
    const existing = await prisma.membership.findUnique({ where: { organizationId_userId: { organizationId: invitation.organizationId, userId: actor.userId } } });
    if (!existing) {
      await prisma.membership.create({ data: { organizationId: invitation.organizationId, userId: actor.userId, role: invitation.role ?? 'VIEWER', invitedById: invitation.invitedById } });
    }
    await audit({ actorId: actor.userId, organizationId: invitation.organizationId, action: 'org.invitation_accepted', entityType: 'membership', entityId: invitation.organizationId, details: { invitationId: invitation.id }, ip: req.ip });
  }
  await prisma.invitation.update({ where: { id: invitation.id }, data: { acceptedAt: new Date() } });
  res.json({ data: { ok: true, organizationId: invitation.organizationId } });
});
