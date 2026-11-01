// Fleet routes: groups, drivers, departments, cost centers, assignments,
// maintenance, and the fleet overview. Everything is organization-scoped;
// a route never trusts a client-supplied id.

import { prisma } from '../core/db';
import { policyRouter, sessionActor, type RoutePolicy } from '../authz/policy';
import { assertOrgPermission, assertVehicleAccess, accessibleVehicleIds } from '../authz/access';
import { AccessDenied } from '../authz/errors';
import type { Actor } from '../authz/types';
import { ROLE_PERMISSIONS } from '@voltlink/shared';

export const fleetRouter = policyRouter('/api/v1/fleet');

async function fleetOrg(
  req: { actor?: Actor; query: { orgId?: unknown } },
  perm: 'fleet.read' | 'fleet.manage',
): Promise<string> {
  const actor = sessionActor(req as never);
  const requested = typeof req.query.orgId === 'string' ? req.query.orgId : undefined;
  if (requested) {
    await assertOrgPermission(actor, requested, perm);
    return requested;
  }
  const memberships = await prisma.membership.findMany({
    where: { userId: actor.userId, status: 'ACTIVE' },
  });
  for (const m of memberships) {
    if ((ROLE_PERMISSIONS[m.role] as readonly string[]).includes(perm)) return m.organizationId;
  }
  throw new AccessDenied('FORBIDDEN', `Missing ${perm} in any organization.`, 403);
}

const fleetRead: RoutePolicy = {
  auth: 'session',
  target: { kind: 'org', own: true, perm: 'fleet.read' },
};
const fleetManage: RoutePolicy = {
  auth: 'session',
  target: { kind: 'org', own: true, perm: 'fleet.manage' },
};

// ---- Overview ----

fleetRouter.get('/overview', fleetRead, async (req, res) => {
  const orgId =
    typeof req.query.orgId === 'string'
      ? await fleetOrg(req, 'fleet.read')
      : req.access!.organizationId!;
  const vehicleIds = await accessibleVehicleIds(sessionActor(req), 'vehicles.read', {
    organizationId: orgId,
  });
  const [vehicles, drivers, departments, costCenters, groups] = await Promise.all([
    prisma.vehicle.findMany({
      where: { organizationId: orgId, id: { in: vehicleIds }, active: true },
      include: { snapshot: true },
      orderBy: { displayName: 'asc' },
    }),
    prisma.driver.findMany({ where: { organizationId: orgId } }),
    prisma.department.findMany({ where: { organizationId: orgId } }),
    prisma.costCenter.findMany({ where: { organizationId: orgId } }),
    prisma.fleetGroup.findMany({ where: { organizationId: orgId }, include: { vehicles: true } }),
  ]);
  const now = Date.now();
  res.json({
    data: {
      vehicles: vehicles.map((v) => {
        const st = v.snapshot?.state as Record<string, unknown> | null;
        return {
          id: v.id,
          displayName: v.displayName,
          make: v.make,
          model: v.model,
          labels: v.labels,
          vehicleClass: v.vehicleClass,
          batteryPct: st?.b ?? null,
          charging: st?.cp === true || st?.charging === true,
          offline: st?.offline === true,
          demo: v.demo,
          fetchedAt: v.snapshot?.fetchedAt?.toISOString(),
        };
      }),
      driverCount: drivers.length,
      departmentCount: departments.length,
      costCenterCount: costCenters.length,
      groupCount: groups.length,
      maintenanceDue: await prisma.maintenanceRecord.count({
        where: { vehicle: { organizationId: orgId }, completedAt: null, dueAt: { not: null } },
      }),
      cachedAt: new Date(now).toISOString(),
    },
  });
});

// ---- Groups ----

fleetRouter.get('/groups', fleetRead, async (req, res) => {
  const orgId =
    typeof req.query.orgId === 'string'
      ? await fleetOrg(req, 'fleet.read')
      : req.access!.organizationId!;
  const groups = await prisma.fleetGroup.findMany({
    where: { organizationId: orgId },
    include: { vehicles: true },
  });
  res.json({
    data: groups.map((g) => ({
      id: g.id,
      name: g.name,
      description: g.description ?? undefined,
      vehicleIds: g.vehicles.map((v) => v.vehicleId),
    })),
  });
});

fleetRouter.post('/groups', fleetManage, async (req, res) => {
  const orgId =
    typeof req.query.orgId === 'string'
      ? await fleetOrg(req, 'fleet.manage')
      : req.access!.organizationId!;
  const { name, description, vehicleIds } = (req.body ?? {}) as {
    name?: string;
    description?: string;
    vehicleIds?: string[];
  };
  if (!name) {
    res.status(400).json({ error: { code: 'VALIDATION', message: 'Group name required.' } });
    return;
  }
  if (Array.isArray(vehicleIds)) {
    const rows = await prisma.vehicle.findMany({
      where: { id: { in: vehicleIds }, organizationId: orgId },
      select: { id: true },
    });
    if (rows.length !== vehicleIds.length) {
      res.status(400).json({
        error: { code: 'VALIDATION', message: 'Every vehicleId must be in this organization.' },
      });
      return;
    }
  }
  const group = await prisma.fleetGroup.create({
    data: {
      organizationId: orgId,
      createdById: sessionActor(req).userId,
      name: name.slice(0, 60),
      description: description?.slice(0, 200),
    },
  });
  if (Array.isArray(vehicleIds)) {
    await prisma.fleetGroupVehicle.createMany({
      data: vehicleIds.map((vehicleId) => ({ fleetGroupId: group.id, vehicleId })),
    });
  }
  res.status(201).json({ data: { id: group.id } });
});

fleetRouter.put(
  '/groups/:id/vehicles',
  {
    auth: 'session',
    target: { kind: 'resource', resource: 'fleetGroup', from: 'param:id', perm: 'fleet.manage' },
  },
  async (req, res) => {
    const group = req.access!.resource!;
    const { vehicleIds } = (req.body ?? {}) as { vehicleIds?: string[] };
    if (!Array.isArray(vehicleIds)) {
      res
        .status(400)
        .json({ error: { code: 'VALIDATION', message: 'vehicleIds array required.' } });
      return;
    }
    const rows = await prisma.vehicle.findMany({
      where: { id: { in: vehicleIds }, organizationId: group.organizationId },
      select: { id: true },
    });
    if (rows.length !== vehicleIds.length) {
      res.status(400).json({
        error: { code: 'VALIDATION', message: 'Every vehicleId must be in this organization.' },
      });
      return;
    }
    await prisma.fleetGroupVehicle.deleteMany({ where: { fleetGroupId: group.id } });
    await prisma.fleetGroupVehicle.createMany({
      data: vehicleIds.map((vehicleId) => ({ fleetGroupId: group.id, vehicleId })),
    });
    res.json({ data: { ok: true } });
  },
);

fleetRouter.delete(
  '/groups/:id',
  {
    auth: 'session',
    target: { kind: 'resource', resource: 'fleetGroup', from: 'param:id', perm: 'fleet.manage' },
  },
  async (req, res) => {
    await prisma.fleetGroup.delete({ where: { id: req.access!.resource!.id } });
    res.json({ data: { ok: true } });
  },
);

// ---- Drivers / departments / cost centers ----

fleetRouter.get('/drivers', fleetRead, async (req, res) => {
  const orgId =
    typeof req.query.orgId === 'string'
      ? await fleetOrg(req, 'fleet.read')
      : req.access!.organizationId!;
  res.json({
    data: await prisma.driver.findMany({
      where: { organizationId: orgId },
      orderBy: { name: 'asc' },
    }),
  });
});

fleetRouter.post('/drivers', fleetManage, async (req, res) => {
  const orgId =
    typeof req.query.orgId === 'string'
      ? await fleetOrg(req, 'fleet.manage')
      : req.access!.organizationId!;
  const { name, email, phone } = (req.body ?? {}) as {
    name?: string;
    email?: string;
    phone?: string;
  };
  if (!name) {
    res.status(400).json({ error: { code: 'VALIDATION', message: 'Driver name required.' } });
    return;
  }
  const d = await prisma.driver.create({
    data: {
      organizationId: orgId,
      createdById: sessionActor(req).userId,
      name: name.slice(0, 80),
      email: email?.slice(0, 120),
      phone: phone?.slice(0, 40),
    },
  });
  res.status(201).json({ data: d });
});

fleetRouter.delete(
  '/drivers/:id',
  {
    auth: 'session',
    target: { kind: 'resource', resource: 'driver', from: 'param:id', perm: 'fleet.manage' },
  },
  async (req, res) => {
    await prisma.driver.delete({ where: { id: req.access!.resource!.id } });
    res.json({ data: { ok: true } });
  },
);

fleetRouter.get('/departments', fleetRead, async (req, res) => {
  const orgId =
    typeof req.query.orgId === 'string'
      ? await fleetOrg(req, 'fleet.read')
      : req.access!.organizationId!;
  res.json({
    data: await prisma.department.findMany({
      where: { organizationId: orgId },
      orderBy: { name: 'asc' },
    }),
  });
});

fleetRouter.post('/departments', fleetManage, async (req, res) => {
  const orgId =
    typeof req.query.orgId === 'string'
      ? await fleetOrg(req, 'fleet.manage')
      : req.access!.organizationId!;
  const { name } = (req.body ?? {}) as { name?: string };
  if (!name) {
    res.status(400).json({ error: { code: 'VALIDATION', message: 'Department name required.' } });
    return;
  }
  const d = await prisma.department.create({
    data: { organizationId: orgId, createdById: sessionActor(req).userId, name: name.slice(0, 80) },
  });
  res.status(201).json({ data: d });
});

fleetRouter.delete(
  '/departments/:id',
  {
    auth: 'session',
    target: { kind: 'resource', resource: 'department', from: 'param:id', perm: 'fleet.manage' },
  },
  async (req, res) => {
    await prisma.department.delete({ where: { id: req.access!.resource!.id } });
    res.json({ data: { ok: true } });
  },
);

fleetRouter.get('/cost-centers', fleetRead, async (req, res) => {
  const orgId =
    typeof req.query.orgId === 'string'
      ? await fleetOrg(req, 'fleet.read')
      : req.access!.organizationId!;
  res.json({
    data: await prisma.costCenter.findMany({
      where: { organizationId: orgId },
      orderBy: { name: 'asc' },
    }),
  });
});

fleetRouter.post('/cost-centers', fleetManage, async (req, res) => {
  const orgId =
    typeof req.query.orgId === 'string'
      ? await fleetOrg(req, 'fleet.manage')
      : req.access!.organizationId!;
  const { name, code } = (req.body ?? {}) as { name?: string; code?: string };
  if (!name) {
    res.status(400).json({ error: { code: 'VALIDATION', message: 'Cost center name required.' } });
    return;
  }
  const c = await prisma.costCenter.create({
    data: {
      organizationId: orgId,
      createdById: sessionActor(req).userId,
      name: name.slice(0, 80),
      code: code?.slice(0, 20) ?? '',
    },
  });
  res.status(201).json({ data: c });
});

fleetRouter.delete(
  '/cost-centers/:id',
  {
    auth: 'session',
    target: { kind: 'resource', resource: 'costCenter', from: 'param:id', perm: 'fleet.manage' },
  },
  async (req, res) => {
    await prisma.costCenter.delete({ where: { id: req.access!.resource!.id } });
    res.json({ data: { ok: true } });
  },
);

// ---- Assignments ----

fleetRouter.get('/assignments', fleetRead, async (req, res) => {
  const orgId =
    typeof req.query.orgId === 'string'
      ? await fleetOrg(req, 'fleet.read')
      : req.access!.organizationId!;
  const rows = await prisma.vehicleAssignment.findMany({ where: { organizationId: orgId } });
  const [drivers, vehicles] = await Promise.all([
    prisma.driver.findMany({ where: { organizationId: orgId } }),
    prisma.vehicle.findMany({
      where: { organizationId: orgId },
      select: { id: true, displayName: true },
    }),
  ]);
  const dById = new Map(drivers.map((d) => [d.id, d.name]));
  const vById = new Map(vehicles.map((v) => [v.id, v.displayName]));
  res.json({
    data: rows.map((a) => ({
      id: a.id,
      vehicleId: a.vehicleId,
      vehicleName: vById.get(a.vehicleId) ?? a.vehicleId,
      driverId: a.driverId,
      driverName: dById.get(a.driverId) ?? a.driverId,
      departmentId: a.departmentId ?? undefined,
      costCenterId: a.costCenterId ?? undefined,
      fromAt: a.fromAt?.toISOString(),
      toAt: a.toAt?.toISOString(),
    })),
  });
});

fleetRouter.post('/assignments', fleetManage, async (req, res) => {
  const orgId =
    typeof req.query.orgId === 'string'
      ? await fleetOrg(req, 'fleet.manage')
      : req.access!.organizationId!;
  const { vehicleId, driverId, departmentId, costCenterId } = (req.body ?? {}) as Record<
    string,
    string | undefined
  >;
  if (!vehicleId || !driverId) {
    res
      .status(400)
      .json({ error: { code: 'VALIDATION', message: 'vehicleId and driverId required.' } });
    return;
  }
  const vehicle = await prisma.vehicle.findUnique({ where: { id: vehicleId } });
  if (!vehicle || vehicle.organizationId !== orgId) {
    res
      .status(400)
      .json({ error: { code: 'VALIDATION', message: 'Vehicle must be in this organization.' } });
    return;
  }
  const driver = await prisma.driver.findUnique({ where: { id: driverId } });
  if (!driver || driver.organizationId !== orgId) {
    res
      .status(400)
      .json({ error: { code: 'VALIDATION', message: 'Driver must be in this organization.' } });
    return;
  }
  const a = await prisma.vehicleAssignment.create({
    data: {
      organizationId: orgId,
      vehicleId,
      driverId,
      departmentId: departmentId || null,
      costCenterId: costCenterId || null,
      fromAt: new Date(),
    },
  });
  res.status(201).json({ data: { id: a.id } });
});

fleetRouter.delete(
  '/assignments/:id',
  {
    auth: 'session',
    target: { kind: 'resource', resource: 'assignment', from: 'param:id', perm: 'fleet.manage' },
  },
  async (req, res) => {
    await prisma.vehicleAssignment.delete({ where: { id: req.access!.resource!.id } });
    res.json({ data: { ok: true } });
  },
);

// ---- Maintenance (Z-FLEETDEL: deletes use the resource policy) ----

fleetRouter.get('/maintenance', fleetRead, async (req, res) => {
  const orgId =
    typeof req.query.orgId === 'string'
      ? await fleetOrg(req, 'fleet.read')
      : req.access!.organizationId!;
  const vehicleId = typeof req.query.vehicleId === 'string' ? req.query.vehicleId : undefined;
  if (vehicleId) {
    const { vehicle } = await assertVehicleAccess(sessionActor(req), vehicleId, 'vehicles.read');
    const rows = await prisma.maintenanceRecord.findMany({
      where: { vehicleId: vehicle.id },
      orderBy: { dueAt: 'asc' },
    });
    res.json({ data: rows.map(maintenanceDto) });
    return;
  }
  const rows = await prisma.maintenanceRecord.findMany({
    where: { vehicle: { organizationId: orgId } },
    orderBy: { dueAt: 'asc' },
  });
  res.json({ data: rows.map(maintenanceDto) });
});

function maintenanceDto(m: {
  id: string;
  vehicleId: string;
  title: string;
  kind: string;
  dueAt: Date | null;
  dueOdometerKm: number | null;
  completedAt: Date | null;
  cost: number | null;
  currency: string;
  notes: string | null;
}) {
  return {
    id: m.id,
    vehicleId: m.vehicleId,
    title: m.title,
    kind: m.kind,
    dueAt: m.dueAt?.toISOString(),
    dueOdometerKm: m.dueOdometerKm ?? undefined,
    completedAt: m.completedAt?.toISOString(),
    cost: m.cost ?? undefined,
    currency: m.currency,
    notes: m.notes ?? undefined,
  };
}

fleetRouter.post(
  '/maintenance',
  { auth: 'session', target: { kind: 'vehicle', from: 'body:vehicleId', perm: 'vehicles.manage' } },
  async (req, res) => {
    const vehicle = req.access!.vehicle!;
    const { title, kind, dueAt, dueOdometerKm, cost, notes } = (req.body ?? {}) as Record<
      string,
      unknown
    >;
    if (!title) {
      res.status(400).json({ error: { code: 'VALIDATION', message: 'title required.' } });
      return;
    }
    // NEW-09: a maintenance record needs a due date or a due odometer, and
    // an unparseable due date is a 400 — never a 500 from `new Date('x')`.
    const parsedDueAt = typeof dueAt === 'string' && dueAt ? new Date(dueAt) : null;
    if (
      (parsedDueAt && Number.isNaN(parsedDueAt.getTime())) ||
      (typeof dueAt === 'string' && dueAt && Number.isNaN(new Date(dueAt).getTime()))
    ) {
      res.status(400).json({
        error: { code: 'INVALID_DATE', message: 'dueAt must be a valid date.' },
      });
      return;
    }
    if (!parsedDueAt && !(typeof dueOdometerKm === 'number' && Number.isFinite(dueOdometerKm))) {
      res.status(400).json({
        error: { code: 'VALIDATION', message: 'dueAt or dueOdometerKm required.' },
      });
      return;
    }
    const m = await prisma.maintenanceRecord.create({
      data: {
        vehicleId: vehicle.id,
        title: String(title).slice(0, 120),
        kind: ['service', 'registration', 'insurance', 'tires', 'inspection', 'other'].includes(
          String(kind ?? 'service'),
        )
          ? String(kind)
          : 'service',
        dueAt: parsedDueAt,
        dueOdometerKm: typeof dueOdometerKm === 'number' ? dueOdometerKm : null,
        cost: typeof cost === 'number' ? cost : null,
        notes: typeof notes === 'string' ? notes.slice(0, 500) : null,
      },
    });
    res.status(201).json({ data: { id: m.id } });
  },
);

fleetRouter.patch(
  '/maintenance/:id',
  {
    auth: 'session',
    target: {
      kind: 'resource',
      resource: 'maintenanceRecord',
      from: 'param:id',
      perm: 'vehicles.manage',
    },
  },
  async (req, res) => {
    const rec = req.access!.resource!;
    const { title, kind, dueAt, dueOdometerKm, completedAt, cost, notes } = (req.body ??
      {}) as Record<string, unknown>;
    // NEW-09: same date validation on PATCH.
    if (typeof dueAt === 'string' && dueAt && Number.isNaN(new Date(dueAt).getTime())) {
      res
        .status(400)
        .json({ error: { code: 'INVALID_DATE', message: 'dueAt must be a valid date.' } });
      return;
    }
    if (
      typeof completedAt === 'string' &&
      completedAt &&
      Number.isNaN(new Date(completedAt).getTime())
    ) {
      res
        .status(400)
        .json({ error: { code: 'INVALID_DATE', message: 'completedAt must be a valid date.' } });
      return;
    }
    await prisma.maintenanceRecord.update({
      where: { id: rec.id },
      data: {
        ...(typeof title === 'string' ? { title: title.slice(0, 120) } : {}),
        ...(typeof kind === 'string' ? { kind: kind.slice(0, 40) } : {}),
        ...(typeof dueAt === 'string' ? { dueAt: dueAt ? new Date(dueAt) : null } : {}),
        ...(typeof dueOdometerKm === 'number' ? { dueOdometerKm } : {}),
        ...(typeof completedAt === 'string'
          ? { completedAt: completedAt ? new Date(completedAt) : null }
          : {}),
        ...(typeof cost === 'number' ? { cost } : {}),
        ...(typeof notes === 'string' ? { notes: notes.slice(0, 500) } : {}),
      },
    });
    res.json({ data: { ok: true } });
  },
);

fleetRouter.delete(
  '/maintenance/:id',
  {
    auth: 'session',
    target: {
      kind: 'resource',
      resource: 'maintenanceRecord',
      from: 'param:id',
      perm: 'vehicles.manage',
    },
  },
  async (req, res) => {
    await prisma.maintenanceRecord.delete({ where: { id: req.access!.resource!.id } });
    res.json({ data: { ok: true } });
  },
);

fleetRouter.get('/report', fleetManage, async (req, res) => {
  const orgId =
    typeof req.query.orgId === 'string'
      ? await fleetOrg(req, 'fleet.manage')
      : req.access!.organizationId!;
  const vehicleIds = await accessibleVehicleIds(sessionActor(req), 'vehicles.read', {
    organizationId: orgId,
  });
  const [vehicles, drives, charging, assignments] = await Promise.all([
    prisma.vehicle.findMany({
      where: { organizationId: orgId, id: { in: vehicleIds }, active: true },
      select: { id: true, displayName: true, demo: true },
    }),
    prisma.drive.findMany({
      where: { vehicleId: { in: vehicleIds } },
      select: { vehicleId: true, distanceKm: true, energyKwh: true, estCost: true, startAt: true },
    }),
    prisma.chargingSession.findMany({
      where: { vehicleId: { in: vehicleIds } },
      select: { vehicleId: true, energyAddedKwh: true, cost: true, startAt: true },
    }),
    prisma.vehicleAssignment.findMany({
      where: { organizationId: orgId },
      include: { vehicle: { select: { displayName: true } } },
    }),
  ]);
  const per = new Map<
    string,
    {
      distanceKm: number;
      energyKwh: number;
      driveCost: number;
      chargeEnergyKwh: number;
      chargeCost: number;
    }
  >();
  for (const v of vehicles)
    per.set(v.id, { distanceKm: 0, energyKwh: 0, driveCost: 0, chargeEnergyKwh: 0, chargeCost: 0 });
  for (const d of drives) {
    const e = per.get(d.vehicleId);
    if (e) {
      e.distanceKm += d.distanceKm;
      e.energyKwh += d.energyKwh;
      e.driveCost += d.estCost ?? 0;
    }
  }
  for (const c of charging) {
    const e = per.get(c.vehicleId);
    if (e) {
      e.chargeEnergyKwh += c.energyAddedKwh;
      e.chargeCost += c.cost;
    }
  }
  res.json({
    data: {
      generatedAt: new Date().toISOString(),
      organizationId: orgId,
      vehicles: vehicles.map((v) => ({
        id: v.id,
        displayName: v.displayName,
        demo: v.demo,
        ...(per.get(v.id) ?? {
          distanceKm: 0,
          energyKwh: 0,
          driveCost: 0,
          chargeEnergyKwh: 0,
          chargeCost: 0,
        }),
      })),
      assignments: assignments.map((a) => ({
        id: a.id,
        vehicleId: a.vehicleId,
        vehicleName: a.vehicle.displayName,
        driverId: a.driverId,
        fromAt: a.fromAt?.toISOString(),
        toAt: a.toAt?.toISOString(),
      })),
    },
  });
});
