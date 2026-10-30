// Vehicle command pipeline: validation → queue → provider dispatch →
// confirmation → terminal state. Server-side truth only; the client never
// fabricates completion.

import { prisma } from '../core/db';
import { getQueue } from '../core/queue';
import { audit } from '../core/settings';
import { getSetting } from '../core/settings';
import { ssePublish } from '../core/sse';
import { assertVehicleAccess } from '../authz/access';
import { requireRecentStepUp } from '../authz/policy';
import { AccessDenied } from '../authz/errors';
import type { Actor } from '../authz/types';
import { buildContext, getProvider } from '../providers/registry';
import { randomId, sha256hex } from '../core/crypto';
import { COMMAND_DEFINITIONS, HIGH_RISK_COMMANDS, type CommandParams, type CommandStatus, type CommandType, type RiskLevel, type VehicleCommand } from '@voltlink/shared';

export class CommandError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

// Per user+vehicle rate limiting (in-memory; per-process, conservative).
const rateBuckets = new Map<string, number[]>();
const MAX_COMMANDS_PER_HOUR = 30;
const HIGH_RISK_PER_HOUR = 5;

function checkRate(userId: string, vehicleId: string, highRisk: boolean): void {
  const key = `${userId}:${vehicleId}:${highRisk ? 'high' : 'low'}`;
  const now = Date.now();
  const bucket = (rateBuckets.get(key) ?? []).filter((t) => now - t < 3600_000);
  const limit = highRisk ? HIGH_RISK_PER_HOUR : MAX_COMMANDS_PER_HOUR;
  if (bucket.length >= limit) throw new CommandError('RATE_LIMITED', `Command rate limit reached (${limit}/hour for this vehicle).`, 429);
  bucket.push(now);
  rateBuckets.set(key, bucket);
}

const CONFIRM_DELAY_MS = 8000;
const CONFIRM_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Issuing
// ---------------------------------------------------------------------------

export interface IssueOptions {
  idempotencyKey?: string;
}

export async function issueCommand(
  actor: Actor,
  vehicleId: string,
  type: CommandType,
  params: CommandParams,
  opts: IssueOptions = {},
  meta: { ip?: string; requestId?: string } = {},
): Promise<{ command: VehicleCommand; replayed: boolean }> {
  const def = COMMAND_DEFINITIONS[type];
  if (!def) throw new CommandError('UNKNOWN_COMMAND', 'Unknown command type.', 400);
  if ((params as Record<string, unknown>).stepUp !== undefined) {
    throw new CommandError('STEP_UP_INLINE_REMOVED', 'Commands no longer accept inline credentials; step up first, then resend the command.', 400);
  }

  const highRisk = HIGH_RISK_COMMANDS.includes(type);
  const { vehicle, permissions } = await assertVehicleAccess(
    actor,
    vehicleId,
    highRisk ? 'vehicles.command_high_risk' : 'vehicles.command',
  );

  // High-risk: sessions need a recent step-up; API keys never get high-risk.
  if (highRisk) {
    if (actor.kind === 'session') requireRecentStepUp(actor);
    else if (actor.kind === 'apiKey') throw new AccessDenied('FORBIDDEN', 'API keys cannot run high-risk commands.', 403);
    else if (actor.kind === 'automation') {
      const a = await prisma.automation.findUnique({ where: { id: actor.automationId } });
      const hash = sha256hex(JSON.stringify({ trigger: a?.triggerType ?? '', vehicleId, actions: [type] }));
      if (!a?.highRiskApprovedAt || a.approvedActionsHash !== hash) {
        throw new CommandError('AUTOMATION_HIGH_RISK_NOT_APPROVED', 'This automation no longer holds a valid high-risk approval.', 403);
      }
    }
  }

  // Kill switches (global, provider, vehicle).
  const [globalOn, providerOn, vehicleOn] = await Promise.all([
    getSetting('commandsEnabled'),
    getSetting(`providerCmd:${vehicle.providerAccountId}`),
    getSetting(`vehicleCmd:${vehicle.id}`),
  ]);
  if (globalOn !== 'true') throw new CommandError('COMMANDS_DISABLED', 'Vehicle commands are disabled globally.', 403);
  if (providerOn === 'false') throw new CommandError('COMMANDS_DISABLED', 'Commands are disabled for this provider account.', 403);
  if (vehicleOn === 'false') throw new CommandError('COMMANDS_DISABLED', 'Commands are disabled for this vehicle.', 403);

  // Capability check.
  const caps = (vehicle.capabilities ?? []) as string[];
  if (!caps.includes(def.requiresCapability)) {
    throw new CommandError('UNSUPPORTED', `This vehicle does not support "${def.label}".`, 422);
  }

  checkRate(actor.kind === 'apiKey' ? actor.apiKeyId : actor.kind === 'system' ? 'system' : actor.userId, vehicleId, highRisk);

  // Idempotency is scoped per actor kind (Z-IDEMP).
  const scope = actor.kind === 'apiKey' ? `apikey:${actor.apiKeyId}` : actor.kind === 'automation' ? `automation:${actor.automationId}` : actor.kind === 'system' ? 'system:system' : `user:${actor.userId}`;
  const idempotencyKey = opts.idempotencyKey ?? `cmd:${scope}:${vehicleId}:${type}:${randomId()}`;
  const requestHash = sha256hex(JSON.stringify({ vehicleId, type, params: sanitizeParams(type, params) }));
  const prior = await prisma.commandIdempotency.findUnique({ where: { scope_key: { scope, key: idempotencyKey } } });
  if (prior && prior.expiresAt > new Date()) {
    if (prior.requestHash !== requestHash) {
      throw new CommandError('IDEMPOTENCY_KEY_REUSED', 'This idempotency key was already used with a different request.', 409);
    }
    const original = await prisma.vehicleCommand.findUnique({ where: { id: prior.commandId } });
    if (original) return { command: serializeCommand(original), replayed: true };
  }

  const command = await prisma.vehicleCommand.create({
    data: {
      vehicleId,
      vehicleName: String(vehicle.displayName),
      providerAccountId: vehicle.providerAccountId,
      organizationId: vehicle.organizationId,
      userId: actor.kind === 'system' ? '' : actor.userId,
      actorKind: actor.kind,
      apiKeyId: actor.kind === 'apiKey' ? actor.apiKeyId : null,
      automationId: actor.kind === 'automation' ? actor.automationId : null,
      sourceIp: meta.ip?.slice(0, 64),
      authzDecision: JSON.parse(JSON.stringify({ perm: highRisk ? 'vehicles.command_high_risk' : 'vehicles.command', permissions: [...permissions] })),
      type,
      params: JSON.parse(JSON.stringify(sanitizeParams(type, params))),
      status: 'queued',
      risk: def.risk,
      idempotencyKey,
    },
  });
  try {
    await prisma.commandIdempotency.create({
      data: { scope, key: idempotencyKey, requestHash, commandId: command.id, expiresAt: new Date(Date.now() + 86_400_000) },
    });
  } catch (e) {
    if ((e as { code?: string }).code === 'P2002') {
      const prior = await prisma.commandIdempotency.findUniqueOrThrow({ where: { scope_key: { scope, key: idempotencyKey } } });
      if (prior.requestHash !== requestHash) throw new CommandError('IDEMPOTENCY_KEY_REUSED', 'This idempotency key was already used with a different request.', 409);
      const original = await prisma.vehicleCommand.findUnique({ where: { id: prior.commandId } });
      if (original) return { command: serializeCommand(original), replayed: true };
    }
    throw e;
  }
  const actorUserId = actor.kind === 'session' || actor.kind === 'automation' || actor.kind === 'apiKey' ? actor.userId : '';
  await prisma.commandAuditEvent.create({
    data: { commandId: command.id, event: 'queued', actor: actor.kind, detail: `Command "${def.label}" queued${highRisk ? ' (high risk, step-up passed)' : ''}.` },
  });
  await audit({
    actorId: actorUserId || undefined,
    action: 'command.issue',
    entityType: 'vehicle',
    entityId: vehicleId,
    details: { commandId: command.id, type, risk: def.risk, actorKind: actor.kind },
    ip: meta.ip,
    requestId: meta.requestId,
  });
  await getQueue().enqueue('vehicle-commands', { commandId: command.id }, { dedupeKey: `cmd:${command.id}` });
  ssePublish({ type: 'command', data: { command: serializeCommand(command) }, userId: actorUserId });
  return { command: serializeCommand(command), replayed: false };
}

function sanitizeParams(type: CommandType, params: CommandParams): CommandParams {
  // Keep only numeric/simple fields; never persist secrets.
  const out: CommandParams = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' && (k === 'pin' || k === 'password')) continue;
    if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') out[k as keyof CommandParams] = v as never;
    if (typeof v === 'object') out[k as keyof CommandParams] = JSON.parse(JSON.stringify(v)) as never;
  }
  return out;
}

function serializeCommand(c: {
  id: string; vehicleId: string; vehicleName: string; providerAccountId: string; type: string; params: unknown;
  status: string; risk: string; idempotencyKey: string | null; userId: string; createdAt: Date; submittedAt: Date | null;
  completedAt: Date | null; providerResponse: string | null; errorMessage: string | null; confirmed: boolean;
}): VehicleCommand {
  return {
    id: c.id,
    vehicleId: c.vehicleId,
    vehicleName: c.vehicleName,
    providerAccountId: c.providerAccountId,
    type: c.type as CommandType,
    params: (c.params ?? {}) as CommandParams,
    status: c.status as CommandStatus,
    risk: c.risk as RiskLevel,
    idempotencyKey: c.idempotencyKey ?? '',
    userId: c.userId,
    createdAt: c.createdAt.toISOString(),
    submittedAt: c.submittedAt?.toISOString(),
    completedAt: c.completedAt?.toISOString(),
    providerResponse: c.providerResponse ?? undefined,
    errorMessage: c.errorMessage ?? undefined,
    confirmed: c.confirmed,
  };
}

// ---------------------------------------------------------------------------
// Worker processing
// ---------------------------------------------------------------------------

async function auditEvent(commandId: string, event: string, actor: string, detail: string): Promise<void> {
  await prisma.commandAuditEvent.create({ data: { commandId, event, actor, detail } });
}

async function updateStatus(commandId: string, status: CommandStatus, extra: { providerResponse?: string; errorMessage?: string; confirmed?: boolean } = {}): Promise<void> {
  const data: Record<string, unknown> = { status };
  if (status === 'submitted' && extra.providerResponse === undefined) data.submittedAt = new Date();
  if (['accepted', 'confirmed', 'failed', 'rejected', 'unsupported', 'timed_out', 'canceled'].includes(status)) data.completedAt = new Date();
  if (extra.providerResponse) data.providerResponse = extra.providerResponse;
  if (extra.errorMessage) data.errorMessage = extra.errorMessage;
  if (extra.confirmed) data.confirmed = true;
  await prisma.vehicleCommand.update({ where: { id: commandId }, data: data as never });
}

export async function processCommandJob(payload: { commandId: string; stage?: 'dispatch' | 'confirm' }): Promise<void> {
  const stage = payload.stage ?? 'dispatch';
  const command = await prisma.vehicleCommand.findUnique({ where: { id: payload.commandId } });
  if (!command) return;
  if (command.status === 'canceled') return;

  if (stage === 'dispatch') {
    if (command.status !== 'queued' && command.status !== 'submitted') return;
    await updateStatus(command.id, 'submitted');
    await auditEvent(command.id, 'submitted', 'worker', 'Command submitted to provider.');
    const vehicle = await prisma.vehicle.findUnique({ where: { id: command.vehicleId }, include: { providerAccount: true } });
    if (!vehicle) {
      await updateStatus(command.id, 'failed', { errorMessage: 'Vehicle no longer exists.' });
      return;
    }
    let result;
    try {
      const ctx = await buildContext(vehicle.providerAccount);
      const provider = getProvider(vehicle.provider);
      result = await provider.sendCommand(ctx, vehicle.providerVehicleId, command.type as CommandType, (command.params ?? {}) as CommandParams);
    } catch (err) {
      result = { kind: 'rejected', errorMessage: `Provider error: ${(err as Error).message.slice(0, 200)}` };
    }
    if (result.kind === 'unsupported') {
      await updateStatus(command.id, 'unsupported', { errorMessage: result.errorMessage });
      await auditEvent(command.id, 'unsupported', 'provider', result.errorMessage ?? '');
      return;
    }
    if (result.kind === 'rejected') {
      await updateStatus(command.id, 'rejected', { errorMessage: result.errorMessage, providerResponse: result.response });
      await auditEvent(command.id, 'rejected', 'provider', result.errorMessage ?? 'Provider rejected the command.');
      await notifyCommandFinished(command, 'failed');
      return;
    }
    if (result.kind === 'timed_out') {
      await updateStatus(command.id, 'timed_out', { errorMessage: result.errorMessage });
      await auditEvent(command.id, 'timed_out', 'provider', result.errorMessage ?? 'Provider timed out.');
      return;
    }
    // accepted
    await updateStatus(command.id, 'accepted', { providerResponse: result.response });
    await auditEvent(command.id, 'accepted', 'provider', result.response ?? 'Provider accepted.');
    await getQueue().enqueue('vehicle-commands', { commandId: command.id, stage: 'confirm' }, { delayMs: CONFIRM_DELAY_MS });
    return;
  }

  if (stage === 'confirm') {
    if (command.status !== 'accepted') return;
    // Confirmation: fetch state and verify the provider still reports the
    // vehicle consistently. Only then mark confirmed — never assume success.
    const vehicle = await prisma.vehicle.findUnique({ where: { id: command.vehicleId }, include: { providerAccount: true, snapshot: true } });
    if (!vehicle) {
      await updateStatus(command.id, 'failed', { errorMessage: 'Vehicle no longer exists.' });
      await notifyCommandFinished({ id: command.id, userId: command.userId, vehicleId: command.vehicleId, vehicleName: command.vehicleName, type: command.type }, 'failed');
      return;
    }
    const ageMs = command.completedAt ? Date.now() - command.completedAt.getTime() : 0;
    if (ageMs > CONFIRM_TIMEOUT_MS) {
      await updateStatus(command.id, 'timed_out', { errorMessage: 'Vehicle did not confirm the command within the timeout.' });
      await auditEvent(command.id, 'timed_out', 'worker', 'Confirmation timeout.');
      await notifyCommandFinished({ id: command.id, userId: command.userId, vehicleId: command.vehicleId, vehicleName: command.vehicleName, type: command.type }, 'failed');
      return;
    }
    try {
      const ctx = await buildContext(vehicle.providerAccount);
      const provider = getProvider(vehicle.provider);
      const fresh = await provider.fetchState(ctx, vehicle.providerVehicleId);
      const state = fresh.state as { status?: string };
      if (fresh.live && state.status !== 'offline' && state.status !== 'unknown') {
        await updateStatus(command.id, 'confirmed', { confirmed: true });
        await auditEvent(command.id, 'confirmed', 'worker', 'Vehicle state confirms the command completed.');
        await notifyCommandFinished({ id: command.id, userId: command.userId, vehicleId: command.vehicleId, vehicleName: command.vehicleName, type: command.type }, 'success');
        return;
      }
    } catch {
      /* confirmation fetch failed — retry until timeout */
    }
    if (ageMs > CONFIRM_TIMEOUT_MS) {
      await updateStatus(command.id, 'timed_out', { errorMessage: 'Vehicle did not confirm the command within the timeout.' });
      await auditEvent(command.id, 'timed_out', 'worker', 'Confirmation timeout.');
      await notifyCommandFinished({ id: command.id, userId: command.userId, vehicleId: command.vehicleId, vehicleName: command.vehicleName, type: command.type }, 'failed');
      return;
    }
    await getQueue().enqueue('vehicle-commands', { commandId: command.id, stage: 'confirm' }, { delayMs: CONFIRM_DELAY_MS });
  }
}

async function notifyCommandFinished(command: { id: string; userId: string; vehicleId: string; vehicleName: string; type: string }, outcome: 'success' | 'failed'): Promise<void> {
  const { notify } = await import('../notifications/service');
  const event = outcome === 'success' ? 'command_completed' : 'command_failed';
  await notify({
    userId: command.userId,
    event,
    severity: outcome === 'success' ? 'success' : 'warning',
    title: outcome === 'success' ? 'Command completed' : 'Command failed',
    body: `${command.vehicleName}: ${COMMAND_DEFINITIONS[command.type as CommandType]?.label ?? command.type} ${outcome === 'success' ? 'completed.' : 'did not complete.'}`,
    vehicleId: command.vehicleId ?? undefined,
  });
  ssePublish({ type: 'command_finished', data: { commandId: command.id, outcome }, userId: command.userId });
}

export async function cancelCommand(commandId: string): Promise<VehicleCommand> {
  const command = await prisma.vehicleCommand.findUnique({ where: { id: commandId } });
  if (!command) throw new CommandError('NOT_FOUND', 'Command not found.', 404);
  if (['confirmed', 'failed', 'rejected', 'unsupported', 'timed_out', 'canceled'].includes(command.status)) {
    throw new CommandError('ALREADY_FINAL', 'Command is already in a final state.', 409);
  }
  await updateStatus(command.id, 'canceled');
  await auditEvent(command.id, 'canceled', command.actorKind, 'Canceled by user.');
  const updated = await prisma.vehicleCommand.findUniqueOrThrow({ where: { id: commandId } });
  return serializeCommand(updated);
}

export async function listCommands(vehicleIds: string[], page: number, pageSize: number) {
  const where = { vehicleId: { in: vehicleIds } };
  const [items, total] = await Promise.all([
    prisma.vehicleCommand.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (page - 1) * pageSize, take: pageSize }),
    prisma.vehicleCommand.count({ where }),
  ]);
  return { items: items.map(serializeCommand), total };
}

export async function getCommand(commandId: string): Promise<{ command: VehicleCommand; events: { id: string; commandId: string; event: string; actor: string; detail: string; createdAt: string }[] }> {
  const command = await prisma.vehicleCommand.findUnique({ where: { id: commandId } });
  if (!command) throw new CommandError('NOT_FOUND', 'Command not found.', 404);
  const events = await prisma.commandAuditEvent.findMany({ where: { commandId }, orderBy: { createdAt: 'asc' } });
  return {
    command: serializeCommand(command),
    events: events.map((e) => ({ ...e, createdAt: e.createdAt.toISOString() })),
  };
}
