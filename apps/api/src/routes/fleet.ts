// Fleet routes: groups, drivers, departments, cost centers, assignments,
// maintenance, and the fleet overview.

import { Router } from 'express';
import { prisma } from '../core/db';
import { requireAuth, requireRole } from '../auth/middleware';
import { listVehiclesForUser } from '../access';

export const fleetRouter = Router();

fleetRouter.use(requireAuth);

// ---- Overview ----

fleetRouter.get('/overview', async (req, res) => {
  const vehicles = await listVehiclesForUser(req.user!.id, req.user!.role);
  const assignments = await prisma.vehicleAssignment.findMany({
    where: { vehicleId: { in: vehicles.map((v) => v.id) } },
    include: {},
  });
  const [drivers, departments, costCenters, groups, maintenance] = await Promise.all([
    prisma.driver.findMany({ where: { ownerId: req.user!.id } }),
    prisma.department.findMany({ where: { ownerId: req.user!.id } }),
    prisma.costCenter.findMany({ where: { ownerId: req.user!.id } }),
    prisma.fleetGroup.findMany({ where: { ownerId: req.user!.id }, include: { vehicles: true } }),
    prisma.maintenanceRecord.findMany({ where: { vehicleId: { in: vehicles.map((v) => v.id) }, completedAt: null } }),
  ]);
  const driverById = new Map(drivers.map((d) => [d.id, d]));
  const deptById = new Map(departments.map((d) => [d.id, d]));
  const ccById = new Map(costCenters.map((c) => [c.id, c]));
  const groupByVehicle = new Map<string, string[]>();
  for (const g of groups) for (const gv of g.vehicles) groupByVehicle.set(gv.vehicleId, [...(groupByVehicle.get(gv.vehicleId) ?? []), g.id]);

  const rows = vehicles.map((v) => {
    const assignment = assignments.find((a) => a.vehicleId === v.id);
    const state = (v.snapshot?.state ?? {}) as { status?: string; batteryPercent?: number; chargingState?: string; odometerKm?: number };
    const attention: string[] = [];
    const maint = maintenance.filter((m) => m.vehicleId === v.id);
    if (maint.some((m) => m.dueAt && m.dueAt < new Date())) attention.push('maintenance overdue');
    if (maint.length > 0 && !attention.length) attention.push(`${maint.length} maintenance item${maint.length > 1 ? 's' : ''}`);
    if (state.chargingState === 'charging') attention.push('charging');
    if (state.status === 'offline') attention.push('offline');
    return {
      vehicle: { id: v.id, name: v.displayName, vehicleClass: v.vehicleClass },
      status: state.status ?? 'unknown',
      batteryPct: state.batteryPercent,
      charging: state.chargingState === 'charging',
      odometerKm: state.odometerKm,
      driver: assignment ? driverById.get(assignment.driverId)?.name : undefined,
      department: assignment?.departmentId ? deptById.get(assignment.departmentId)?.name : undefined,
      costCenter: assignment?.costCenterId ? ccById.get(assignment.costCenterId)?.name : undefined,
      groupIds: groupByVehicle.get(v.id) ?? [],
      lastSeenAt: v.snapshot?.fetchedAt.toISOString(),
      attention,
    };
  });

  const totalBattery = rows.filter((r) => typeof r.batteryPct === 'number');
  res.json({
    data: {
      rows,
      summary: {
        vehicles: rows.length,
        charging: rows.filter((r) => r.charging).length,
        offline: rows.filter((r) => r.status === 'offline').length,
        attention: rows.filter((r) => r.attention.length > 0).length,
        avgBatteryPct: totalBattery.length ? Math.round(totalBattery.reduce((s, r) => s + (r.batteryPct ?? 0), 0) / totalBattery.length) : null,
      },
    },
  });
});

// ---- Groups ----

fleetRouter.get('/groups', async (req, res) => {
  const groups = await prisma.fleetGroup.findMany({ where: { ownerId: req.user!.id }, include: { vehicles: true } });
  res.json({ data: groups.map((g) => ({ id: g.id, name: g.name, description: g.description ?? undefined, vehicleIds: g.vehicles.map((v) => v.vehicleId) })) });
});

fleetRouter.post('/groups', async (req, res) => {
  const { name, description, vehicleIds } = (req.body ?? {}) as { name?: string; description?: string; vehicleIds?: string[] };
  if (!name) {
    res.status(400).json({ error: { code: 'VALIDATION', message: 'Group name required.' } });
    return;
  }
  const group = await prisma.fleetGroup.create({ data: { ownerId: req.user!.id, name: name.slice(0, 60), description: description?.slice(0, 200) } });
  if (Array.isArray(vehicleIds)) {
    await prisma.fleetGroupVehicle.createMany({ data: vehicleIds.map((vehicleId) => ({ fleetGroupId: group.id, vehicleId })) });
  }
  res.status(201).json({ data: { id: group.id } });
});

fleetRouter.put('/groups/:id/vehicles', async (req, res) => {
  const group = await prisma.fleetGroup.findUnique({ where: { id: req.params.id } });
  if (!group || group.ownerId !== req.user!.id) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Group not found.' } });
    return;
  }
  const { vehicleIds } = (req.body ?? {}) as { vehicleIds?: string[] };
  if (!Array.isArray(vehicleIds)) {
    res.status(400).json({ error: { code: 'VALIDATION', message: 'vehicleIds array required.' } });
    return;
  }
  await prisma.fleetGroupVehicle.deleteMany({ where: { fleetGroupId: group.id } });
  await prisma.fleetGroupVehicle.createMany({ data: vehicleIds.map((vehicleId) => ({ fleetGroupId: group.id, vehicleId })) });
  res.json({ data: { ok: true } });
});

fleetRouter.delete('/groups/:id', async (req, res) => {
  const group = await prisma.fleetGroup.findUnique({ where: { id: req.params.id } });
  if (!group || group.ownerId !== req.user!.id) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Group not found.' } });
    return;
  }
  await prisma.fleetGroup.delete({ where: { id: group.id } });
  res.json({ data: { ok: true } });
});

// ---- Drivers / departments / cost centers ----

fleetRouter.get('/drivers', async (req, res) => {
  const rows = await prisma.driver.findMany({ where: { ownerId: req.user!.id }, orderBy: { name: 'asc' } });
  res.json({ data: rows });
});

fleetRouter.post('/drivers', async (req, res) => {
  const { name, email, phone } = (req.body ?? {}) as { name?: string; email?: string; phone?: string };
  if (!name) {
    res.status(400).json({ error: { code: 'VALIDATION', message: 'Driver name required.' } });
    return;
  }
  const d = await prisma.driver.create({ data: { ownerId: req.user!.id, name: name.slice(0, 80), email: email?.slice(0, 120), phone: phone?.slice(0, 40) } });
  res.status(201).json({ data: d });
});

fleetRouter.delete('/drivers/:id', async (req, res) => {
  const d = await prisma.driver.findUnique({ where: { id: req.params.id } });
  if (!d || d.ownerId !== req.user!.id) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Driver not found.' } });
    return;
  }
  await prisma.driver.delete({ where: { id: d.id } });
  res.json({ data: { ok: true } });
});

fleetRouter.get('/departments', async (req, res) => {
  res.json({ data: await prisma.department.findMany({ where: { ownerId: req.user!.id }, orderBy: { name: 'asc' } }) });
});

fleetRouter.post('/departments', async (req, res) => {
  const { name } = (req.body ?? {}) as { name?: string };
  if (!name) {
    res.status(400).json({ error: { code: 'VALIDATION', message: 'Department name required.' } });
    return;
  }
  const d = await prisma.department.create({ data: { ownerId: req.user!.id, name: name.slice(0, 80) } });
  res.status(201).json({ data: d });
});

fleetRouter.delete('/departments/:id', async (req, res) => {
  const d = await prisma.department.findUnique({ where: { id: req.params.id } });
  if (!d || d.ownerId !== req.user!.id) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Department not found.' } });
    return;
  }
  await prisma.department.delete({ where: { id: d.id } });
  res.json({ data: { ok: true } });
});

fleetRouter.get('/cost-centers', async (req, res) => {
  res.json({ data: await prisma.costCenter.findMany({ where: { ownerId: req.user!.id }, orderBy: { name: 'asc' } }) });
});

fleetRouter.post('/cost-centers', async (req, res) => {
  const { name, code } = (req.body ?? {}) as { name?: string; code?: string };
  if (!name) {
    res.status(400).json({ error: { code: 'VALIDATION', message: 'Cost center name required.' } });
    return;
  }
  const c = await prisma.costCenter.create({ data: { ownerId: req.user!.id, name: name.slice(0, 80), code: code?.slice(0, 20) ?? '' } });
  res.status(201).json({ data: c });
});

fleetRouter.delete('/cost-centers/:id', async (req, res) => {
  const c = await prisma.costCenter.findUnique({ where: { id: req.params.id } });
  if (!c || c.ownerId !== req.user!.id) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Cost center not found.' } });
    return;
  }
  await prisma.costCenter.delete({ where: { id: c.id } });
  res.json({ data: { ok: true } });
});

// ---- Assignments ----

fleetRouter.get('/assignments', async (req, res) => {
  const rows = await prisma.vehicleAssignment.findMany({ where: { ownerId: req.user!.id } });
  const [drivers, vehicles] = await Promise.all([
    prisma.driver.findMany({ where: { ownerId: req.user!.id } }),
    prisma.vehicle.findMany({ where: { ownerId: req.user!.id }, select: { id: true, displayName: true } }),
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

fleetRouter.post('/assignments', async (req, res) => {
  const { vehicleId, driverId, departmentId, costCenterId } = (req.body ?? {}) as Record<string, string | undefined>;
  if (!vehicleId || !driverId) {
    res.status(400).json({ error: { code: 'VALIDATION', message: 'vehicleId and driverId required.' } });
    return;
  }
  const vehicle = await prisma.vehicle.findUnique({ where: { id: vehicleId } });
  if (!vehicle || vehicle.ownerId !== req.user!.id) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Vehicle not found.' } });
    return;
  }
  const a = await prisma.vehicleAssignment.create({
    data: { ownerId: req.user!.id, vehicleId, driverId, departmentId: departmentId || null, costCenterId: costCenterId || null, fromAt: new Date() },
  });
  res.status(201).json({ data: { id: a.id } });
});

fleetRouter.delete('/assignments/:id', async (req, res) => {
  const a = await prisma.vehicleAssignment.findUnique({ where: { id: req.params.id } });
  if (!a || a.ownerId !== req.user!.id) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Assignment not found.' } });
    return;
  }
  await prisma.vehicleAssignment.delete({ where: { id: a.id } });
  res.json({ data: { ok: true } });
});

// ---- Maintenance ----

fleetRouter.get('/maintenance', async (req, res) => {
  const vehicles = await listVehiclesForUser(req.user!.id, req.user!.role);
  const rows = await prisma.maintenanceRecord.findMany({ where: { vehicleId: { in: vehicles.map((v) => v.id) } }, orderBy: { dueAt: 'asc' } });
  const vById = new Map(vehicles.map((v) => [v.id, v.displayName]));
  res.json({
    data: rows.map((m) => ({
      id: m.id,
      vehicleId: m.vehicleId,
      vehicleName: vById.get(m.vehicleId) ?? m.vehicleId,
      title: m.title,
      kind: m.kind,
      dueAt: m.dueAt?.toISOString(),
      dueOdometerKm: m.dueOdometerKm ?? undefined,
      completedAt: m.completedAt?.toISOString(),
      cost: m.cost ?? undefined,
      currency: m.currency,
      notes: m.notes ?? undefined,
    })),
  });
});

fleetRouter.post('/maintenance', async (req, res) => {
  const { vehicleId, title, kind, dueAt, dueOdometerKm, cost, notes } = (req.body ?? {}) as Record<string, unknown>;
  if (!vehicleId || !title) {
    res.status(400).json({ error: { code: 'VALIDATION', message: 'vehicleId and title required.' } });
    return;
  }
  const vehicle = await prisma.vehicle.findUnique({ where: { id: String(vehicleId) } });
  if (!vehicle || vehicle.ownerId !== req.user!.id) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Vehicle not found.' } });
    return;
  }
  const m = await prisma.maintenanceRecord.create({
    data: {
      vehicleId: String(vehicleId),
      title: String(title).slice(0, 120),
      kind: ['service', 'registration', 'insurance', 'tires', 'inspection', 'other'].includes(String(kind ?? 'service')) ? String(kind) : 'service',
      dueAt: typeof dueAt === 'string' ? new Date(dueAt) : null,
      dueOdometerKm: typeof dueOdometerKm === 'number' ? dueOdometerKm : null,
      cost: typeof cost === 'number' ? cost : null,
      notes: typeof notes === 'string' ? notes.slice(0, 1000) : null,
    },
  });
  res.status(201).json({ data: { id: m.id } });
});

fleetRouter.patch('/maintenance/:id', async (req, res) => {
  const m = await prisma.maintenanceRecord.findUnique({ where: { id: req.params.id } });
  if (!m) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Maintenance record not found.' } });
    return;
  }
  const vehicle = await prisma.vehicle.findUnique({ where: { id: m.vehicleId } });
  if (!vehicle || vehicle.ownerId !== req.user!.id) {
    res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Not your vehicle.' } });
    return;
  }
  const body = (req.body ?? {}) as { completedAt?: string | null; dueAt?: string | null };
  const data: Record<string, unknown> = {};
  if ('completedAt' in body) data.completedAt = body.completedAt ? new Date(body.completedAt) : null;
  if ('dueAt' in body) data.dueAt = body.dueAt ? new Date(body.dueAt) : null;
  await prisma.maintenanceRecord.update({ where: { id: m.id }, data });
  res.json({ data: { ok: true } });
});

fleetRouter.delete('/maintenance/:id', async (req, res) => {
  const m = await prisma.maintenanceRecord.findUnique({ where: { id: req.params.id } });
  if (!m) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Maintenance record not found.' } });
    return;
  }
  await prisma.maintenanceRecord.delete({ where: { id: m.id } });
  res.json({ data: { ok: true } });
});

// ---- Reports (JSON export) ----

fleetRouter.get('/report', requireRole('FLEET_MANAGER'), async (req, res) => {
  const vehicles = await listVehiclesForUser(req.user!.id, req.user!.role);
  const ids = vehicles.map((v) => v.id);
  const [drives, charges, maintenance] = await Promise.all([
    prisma.drive.findMany({ where: { vehicleId: { in: ids } }, select: { vehicleId: true, distanceKm: true, energyKwh: true, startAt: true } }),
    prisma.chargingSession.findMany({ where: { vehicleId: { in: ids } }, select: { vehicleId: true, energyAddedKwh: true, cost: true, startAt: true } }),
    prisma.maintenanceRecord.findMany({ where: { vehicleId: { in: ids } } }),
  ]);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', 'attachment; filename="voltlink-fleet-report.json"');
  res.send(JSON.stringify({
    generatedAt: new Date().toISOString(),
    vehicles: vehicles.map((v) => ({ id: v.id, name: v.displayName, odometerKm: (v.snapshot?.state as { odometerKm?: number } | null)?.odometerKm ?? null })),
    drives: drives.map((d) => ({ vehicleId: d.vehicleId, distanceKm: d.distanceKm, energyKwh: d.energyKwh, startAt: d.startAt.toISOString() })),
    charging: charges.map((c) => ({ vehicleId: c.vehicleId, energyKwh: c.energyAddedKwh, cost: c.cost, startAt: c.startAt.toISOString() })),
    maintenance,
  }, null, 2));
});
