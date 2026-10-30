// Command routes: issue, list, detail, cancel, and safety switches.

import { policyRouter, sessionActor } from '../authz/policy';
import { accessibleVehicleIds } from '../authz/access';
import { z } from 'zod';
import { issueCommand, listCommands, getCommand, cancelCommand, CommandError } from '../commands/service';
import { setSetting, getSetting } from '../core/settings';
import { prisma } from '../core/db';
import { COMMAND_TYPES } from '@voltlink/shared';

export const commandsRouter = policyRouter('/api/v1/commands');

const issueSchema = z.object({
  type: z.enum(COMMAND_TYPES as unknown as [string, ...string[]]),
  params: z.record(z.string(), z.unknown()).optional().default({}),
  idempotencyKey: z.string().max(120).optional(),
  stepUp: z.object({ password: z.string().optional(), totp: z.string().optional() }).optional(),
});

commandsRouter.post('/', { auth: 'any', apiScope: 'commands:write', verifiedEmail: true, target: { kind: 'vehicle', from: 'body:vehicleId', perm: 'vehicles.command' } }, async (req, res) => {
  const parsed = issueSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: 'VALIDATION', message: 'Valid command type required.' } });
    return;
  }
  const { vehicleId } = (req.body ?? {}) as { vehicleId?: string };
  if (!vehicleId) {
    res.status(400).json({ error: { code: 'VALIDATION', message: 'vehicleId is required.' } });
    return;
  }
  try {
    const result = await issueCommand(
      req.actor!,
      vehicleId,
      parsed.data.type as never,
      parsed.data.params as never,
      { idempotencyKey: typeof parsed.data.idempotencyKey === 'string' ? parsed.data.idempotencyKey : undefined },
      { ip: req.ip, requestId: (req as never as { id?: string }).id },
    );
    if (result.replayed) res.setHeader('Idempotent-Replayed', 'true');
    res.status(result.replayed ? 200 : 201).json({ data: result.command });
  } catch (err) {
    if (err instanceof CommandError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message } });
      return;
    }
    throw err;
  }
});

commandsRouter.get('/', { auth: 'any', apiScope: 'vehicles:read', target: { kind: 'vehicle', from: 'query:vehicleId', perm: 'vehicles.read', optional: true } }, async (req, res) => {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
  const vehicleId = typeof req.query.vehicleId === 'string' ? req.query.vehicleId : undefined;
  const ids = vehicleId ? [vehicleId] : req.access!.vehicleIds!;
  if (ids.length === 0) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No vehicles accessible.' } });
    return;
  }
  const result = await listCommands(ids, page, pageSize);
  res.json({ data: { items: result.items, page, pageSize, total: result.total } });
});

commandsRouter.get('/:id', { auth: 'any', apiScope: 'vehicles:read', target: { kind: 'resource', resource: 'command', from: 'param:id', perm: 'vehicles.read' } }, async (req, res) => {
  try {
    const result = await getCommand(String(req.params.id));
    res.json({ data: result });
  } catch (err) {
    if (err instanceof CommandError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message } });
      return;
    }
    throw err;
  }
});

commandsRouter.post('/:id/cancel', { auth: 'any', apiScope: 'commands:write', target: { kind: 'resource', resource: 'command', from: 'param:id', perm: 'vehicles.command' } }, async (req, res) => {
  try {
    const command = await cancelCommand(String(req.params.id));
    res.json({ data: command });
  } catch (err) {
    if (err instanceof CommandError) {
      res.status(err.status).json({ error: { code: err.code, message: err.message } });
      return;
    }
    throw err;
  }
});

// ---- Safety switches (owner/admin only) ----

commandsRouter.get('/switches/status', { auth: 'session', target: { kind: 'none' } }, async (req, res) => {
  const [globalReadOnly, commandsEnabled, providerCommandsEnabled, vehicleCommandsEnabled] = await Promise.all([
    getSetting('globalReadOnly'),
    getSetting('commandsEnabled'),
    getSetting('providerCommandsEnabled'),
    getSetting('vehicleCommandsEnabled'),
  ]);
  const ids = await accessibleVehicleIds(sessionActor(req), 'vehicles.manage');
  const vehicleSwitches = await prisma.vehicle.findMany({
    where: { id: { in: ids } },
    select: { id: true, displayName: true },
  });
  const perVehicle = await Promise.all(
    vehicleSwitches.map(async (v) => ({ id: v.id, name: v.displayName, disabled: (await getSetting(`vehicleCmd:${v.id}`)) === 'false' })),
  );
  res.json({
    data: {
      globalReadOnly: globalReadOnly === 'true',
      commandsEnabled: commandsEnabled === 'true',
      providerCommandsEnabled: providerCommandsEnabled === 'true',
      vehicleCommandsEnabled: vehicleCommandsEnabled === 'true',
      perVehicle,
    },
  });
});

commandsRouter.post('/switches', { auth: 'session', stepUp: {}, target: { kind: 'instanceAdmin' } }, async (req, res) => {
  const body = (req.body ?? {}) as { globalReadOnly?: boolean; commandsEnabled?: boolean; providerCommandsEnabled?: boolean; vehicleCommandsEnabled?: boolean };
  if (typeof body.globalReadOnly === 'boolean') await setSetting('globalReadOnly', String(body.globalReadOnly));
  if (typeof body.commandsEnabled === 'boolean') await setSetting('commandsEnabled', String(body.commandsEnabled));
  if (typeof body.providerCommandsEnabled === 'boolean') await setSetting('providerCommandsEnabled', String(body.providerCommandsEnabled));
  if (typeof body.vehicleCommandsEnabled === 'boolean') await setSetting('vehicleCommandsEnabled', String(body.vehicleCommandsEnabled));
  res.json({ data: { ok: true } });
});

commandsRouter.post('/switches/vehicle', { auth: 'session', target: { kind: 'vehicle', from: 'body:vehicleId', perm: 'vehicles.manage' } }, async (req, res) => {
  const { vehicleId, disabled } = (req.body ?? {}) as { vehicleId?: string; disabled?: boolean };
  if (!vehicleId || typeof disabled !== 'boolean') {
    res.status(400).json({ error: { code: 'VALIDATION', message: 'vehicleId and disabled required.' } });
    return;
  }
  const vehicle = req.access!.vehicle!;
  await setSetting(`vehicleCmd:${vehicle.id}`, String(!disabled));
  res.json({ data: { ok: true } });
});
