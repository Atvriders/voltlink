// Vehicle command pipeline: validation → queue → provider dispatch →
// guarded transitions → predicate-based confirmation → terminal state
// (guide 04 §4, guide 01 §9-§11). Server-side truth only.

import { prisma } from '../core/db';
import { getQueue } from '../core/queue';
import { enqueue } from '../jobs/queues';
import { producerConnection } from '../core/redis';
import { audit, getSetting } from '../core/settings';
import { ssePublish } from '../core/sse';
import { assertVehicleAccess } from '../authz/access';
import { requireRecentStepUp } from '../authz/policy';
import { AccessDenied } from '../authz/errors';
import type { Actor } from '../authz/types';
import { buildContext, getProvider } from '../providers/registry';
import { randomId, sha256hex } from '../core/crypto';
import { DelayedError } from 'bullmq';
import {
  COMMAND_DEFINITIONS,
  COMMAND_PARAM_SCHEMAS,
  commandStatePredicate,
  HIGH_RISK_COMMANDS,
  NOT_OBSERVABLE_COMMANDS,
  type CommandParams,
  type CommandStatus,
  type CommandType,
  type RiskLevel,
  type VehicleCommand,
} from '@voltlink/shared';

export class CommandError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const CONFIRM_DELAY_MS = 10_000;
const CONFIRM_TIMEOUT_MS = 90_000;

// Per user+vehicle rate limiting (per-process, conservative).
const rateBuckets = new Map<string, number[]>();
const MAX_COMMANDS_PER_HOUR = 30;
const HIGH_RISK_PER_HOUR = 5;

function checkRate(userId: string, vehicleId: string, highRisk: boolean): void {
  const key = `${userId}:${vehicleId}:${highRisk ? 'high' : 'low'}`;
  const now = Date.now();
  const bucket = (rateBuckets.get(key) ?? []).filter((t) => now - t < 3600_000);
  const limit = highRisk ? HIGH_RISK_PER_HOUR : MAX_COMMANDS_PER_HOUR;
  if (bucket.length >= limit) {
    throw new CommandError('RATE_LIMITED', `Command rate limit reached (${limit}/hour for this vehicle).`, 429);
  }
  bucket.push(now);
  rateBuckets.set(key, bucket);
}

const TERMINAL: readonly CommandStatus[] = ['confirmed', 'failed', 'rejected', 'unsupported', 'timed_out', 'canceled'];

// ---------------------------------------------------------------------------
// Guarded transitions (P-TERMINAL): each step is one conditional update so a
// race can never overwrite a terminal state. Terminal states are final.
// ---------------------------------------------------------------------------

export async function transitionStatus(
  commandId: string,
  from: readonly CommandStatus[],
  to: CommandStatus,
  extra: {
    providerResponse?: string;
    responseCategory?: string;
    confirmation?: string;
    errorMessage?: string;
    confirmed?: boolean;
  } = {},
): Promise<boolean> {
  const data: Record<string, unknown> = { status: to };
  if (to === 'submitted') data.submittedAt = new Date();
  if (TERMINAL.includes(to)) data.completedAt = new Date();
  if (extra.providerResponse) data.providerResponse = extra.providerResponse;
  if (extra.responseCategory) data.responseCategory = extra.responseCategory;
  if (extra.confirmation) data.confirmation = extra.confirmation;
  if (extra.errorMessage) data.errorMessage = extra.errorMessage;
  if (extra.confirmed) data.confirmed = true;
  if (to === 'canceled') data.errorMessage = 'Canceled before submission.';
  const res = await prisma.vehicleCommand.updateMany({
    where: { id: commandId, status: { in: [...from] } },
    data: data as never,
  });
  return res.count === 1;
}

async function auditEvent(commandId: string, event: string, actor: string, detail: string): Promise<void> {
  await prisma.commandAuditEvent.create({ data: { commandId, event, actor, detail } });
}

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
    throw new CommandError(
      'STEP_UP_INLINE_REMOVED',
      'Commands no longer accept inline credentials; step up first, then resend the command.',
      400,
    );
  }
  // G-02: per-command types and ranges, rejected before a row is created.
  const schema = COMMAND_PARAM_SCHEMAS[type];
  const raw = params ?? {};
  const parsed = schema.safeParse(Object.keys(raw).length === 0 ? undefined : raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new CommandError('INVALID_PARAMS', `Invalid ${def.label} parameters: ${first?.message ?? 'invalid'}.`, 422);
  }
  const cleanParams = (parsed.data ?? {}) as CommandParams;

  const highRisk = HIGH_RISK_COMMANDS.includes(type);
  const { vehicle, permissions } = await assertVehicleAccess(
    actor,
    vehicleId,
    highRisk ? 'vehicles.command_high_risk' : 'vehicles.command',
  );

  if (highRisk) {
    if (actor.kind === 'session') requireRecentStepUp(actor);
    else if (actor.kind === 'apiKey') throw new AccessDenied('FORBIDDEN', 'API keys cannot run high-risk commands.', 403);
    else if (actor.kind === 'automation') {
      const a = await prisma.automation.findUnique({ where: { id: actor.automationId } });
      const hash = sha256hex(JSON.stringify({ trigger: a?.triggerType ?? '', vehicleId, actions: [type] }));
      if (!a?.highRiskApprovedAt || a.approvedActionsHash !== hash) {
        throw new CommandError(
          'AUTOMATION_HIGH_RISK_NOT_APPROVED',
          'This automation no longer holds a valid high-risk approval.',
          403,
        );
      }
    }
  }

  await assertKillSwitches(vehicle.providerAccountId, vehicle.id);

  const caps = (vehicle.capabilities ?? []) as string[];
  if (!caps.includes(def.requiresCapability)) {
    throw new CommandError('UNSUPPORTED', `This vehicle does not support "${def.label}".`, 422);
  }

  checkRate(
    actor.kind === 'apiKey' ? actor.apiKeyId : actor.kind === 'system' ? 'system' : actor.userId,
    vehicleId,
    highRisk,
  );

  const scope =
    actor.kind === 'apiKey'
      ? `apikey:${actor.apiKeyId}`
      : actor.kind === 'automation'
        ? `automation:${actor.automationId}`
        : actor.kind === 'system'
          ? 'system:system'
          : `user:${actor.userId}`;
  const idempotencyKey = opts.idempotencyKey ?? `cmd:${scope}:${vehicleId}:${type}:${randomId()}`;
  const requestHash = sha256hex(JSON.stringify({ vehicleId, type, params: sanitizeParams(type, cleanParams) }));
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
      authzDecision: JSON.parse(
        JSON.stringify({
          perm: highRisk ? 'vehicles.command_high_risk' : 'vehicles.command',
          permissions: [...permissions],
        }),
      ),
      type,
      params: JSON.parse(JSON.stringify(sanitizeParams(type, cleanParams))),
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
      const existing = await prisma.commandIdempotency.findUniqueOrThrow({
        where: { scope_key: { scope, key: idempotencyKey } },
      });
      if (existing.requestHash !== requestHash) {
        throw new CommandError('IDEMPOTENCY_KEY_REUSED', 'This idempotency key was already used with a different request.', 409);
      }
      const original = await prisma.vehicleCommand.findUnique({ where: { id: existing.commandId } });
      if (original) return { command: serializeCommand(original), replayed: true };
    }
    throw e;
  }
  const actorUserId =
    actor.kind === 'session' || actor.kind === 'automation' || actor.kind === 'apiKey' ? actor.userId : '';
  await prisma.commandAuditEvent.create({
    data: {
      commandId: command.id,
      event: 'queued',
      actor: actor.kind,
      detail: `Command "${def.label}" queued${highRisk ? ' (high risk, step-up passed)' : ''}.`,
    },
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
  await getQueue().enqueue('vehicle-commands', { commandId: command.id, stage: 'dispatch' }, { dedupeKey: `cmd:${command.id}` });
  ssePublish({ type: 'command', data: { command: serializeCommand(command) }, userId: actorUserId });
  return { command: serializeCommand(command), replayed: false };
}

async function assertKillSwitches(providerAccountId: string, vehicleId: string): Promise<void> {
  const [maintenance, globalOn, emergency, providerOn, vehicleOn] = await Promise.all([
    getSetting('instance.maintenanceMode'),
    getSetting('commandsEnabled'),
    getSetting('commandsEmergencyOff'),
    getSetting(`providerCmd:${providerAccountId}`),
    getSetting(`vehicleCmd:${vehicleId}`),
  ]);
  if (maintenance === 'true') {
    throw new CommandError('MAINTENANCE_MODE', 'The instance is in read-only maintenance mode.', 403);
  }
  if (emergency === 'true') {
    throw new CommandError('COMMANDS_DISABLED', 'Vehicle commands are disabled by the emergency switch.', 403);
  }
  if (globalOn !== 'true') {
    throw new CommandError('COMMANDS_DISABLED', 'Vehicle commands are disabled globally.', 403);
  }
  if (providerOn === 'false') {
    throw new CommandError('COMMANDS_DISABLED', 'Commands are disabled for this provider account.', 403);
  }
  if (vehicleOn === 'false') {
    throw new CommandError('COMMANDS_DISABLED', 'Commands are disabled for this vehicle.', 403);
  }
}

function sanitizeParams(type: CommandType, params: CommandParams): CommandParams {
  const out: CommandParams = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'string' && (k === 'pin' || k === 'password' || k === 'token')) continue;
    if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') {
      out[k as keyof CommandParams] = v as never;
    }
    if (typeof v === 'object') out[k as keyof CommandParams] = JSON.parse(JSON.stringify(v)) as never;
  }
  return out;
}

function serializeCommand(c: {
  id: string;
  vehicleId: string;
  vehicleName: string;
  providerAccountId: string;
  type: string;
  params: unknown;
  status: string;
  risk: string;
  idempotencyKey: string | null;
  userId: string;
  createdAt: Date;
  submittedAt: Date | null;
  completedAt: Date | null;
  providerResponse: string | null;
  responseCategory: string | null;
  confirmation: string | null;
  errorMessage: string | null;
  confirmed: boolean;
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
    responseCategory: (c.responseCategory ?? undefined) as VehicleCommand['responseCategory'],
    confirmation: (c.confirmation ?? undefined) as VehicleCommand['confirmation'],
    errorMessage: c.errorMessage ?? undefined,
    confirmed: c.confirmed,
  };
}

// ---------------------------------------------------------------------------
// Worker processing
// ---------------------------------------------------------------------------

async function setPendingCommandUntil(vehicleId: string, ms = 90_000): Promise<void> {
  await prisma.vehiclePollState.upsert({
    where: { vehicleId },
    update: { pendingCommandUntil: new Date(Date.now() + ms) },
    create: { vehicleId, pendingCommandUntil: new Date(Date.now() + ms) },
  });
}

export async function processCommandJob(payload: {
  commandId: string;
  stage?: 'dispatch' | 'confirm';
  n?: number;
}): Promise<void> {
  const stage = payload.stage ?? 'dispatch';
  const command = await prisma.vehicleCommand.findUnique({ where: { id: payload.commandId } });
  if (!command) return;

  if (stage === 'dispatch') {
    // Per-vehicle lock: delivery is at-least-once, so never send twice.
    const lockKey = `voltlink:lock:vehicle-cmd:${command.vehicleId}`;
    const lock = await producerConnection().set(lockKey, command.id, 'PX', 60_000, 'NX');
    if (!lock) {
      throw new DelayedError();
    }
    try {
      const claimed = await transitionStatus(command.id, ['queued'], 'submitted');
      if (!claimed) return; // terminal or another worker claimed it
      await auditEvent(command.id, 'submitted', 'worker', 'Command submitted to provider.');
      const vehicle = await prisma.vehicle.findUnique({
        where: { id: command.vehicleId },
        include: { providerAccount: true },
      });
      if (!vehicle) {
        await transitionStatus(command.id, ['submitted'], 'failed', { errorMessage: 'Vehicle no longer exists.' });
        return;
      }
      // P-KILLSW: re-check every kill switch in the worker.
      const switched = await Promise.allSettled([
        getSetting('instance.maintenanceMode'),
        getSetting('commandsEmergencyOff'),
        getSetting('commandsEnabled'),
        getSetting(`providerCmd:${vehicle.providerAccountId}`),
        getSetting(`vehicleCmd:${vehicle.id}`),
      ]);
      const off =
        (switched[0].status === 'fulfilled' && switched[0].value === 'true') ||
        (switched[1].status === 'fulfilled' && switched[1].value === 'true') ||
        (switched[2].status === 'fulfilled' && switched[2].value !== 'true') ||
        (switched[3].status === 'fulfilled' && switched[3].value === 'false') ||
        (switched[4].status === 'fulfilled' && switched[4].value === 'false');
      if (off) {
        await transitionStatus(command.id, ['submitted'], 'rejected', {
          responseCategory: 'kill_switch',
          errorMessage: 'A kill switch disabled commands after this command was queued.',
        });
        await notifyCommandFinished(command, 'failed');
        return;
      }

      const observable = !NOT_OBSERVABLE_COMMANDS.includes(command.type as CommandType);
      let result: {
        kind: 'accepted' | 'rejected' | 'unsupported' | 'timed_out' | 'failed';
        response?: string;
        category?: string;
        errorMessage?: string;
      };
      try {
        const ctx = await buildContext(vehicle.providerAccount);
        const provider = getProvider(vehicle.provider);
        const sent = await provider.sendCommand(
          ctx,
          vehicle.providerVehicleId,
          command.type as CommandType,
          (command.params ?? {}) as CommandParams,
        );
        if (sent.kind === 'accepted') {
          result = { kind: 'accepted', response: sent.response };
        } else if (sent.kind === 'rejected') {
          result = { kind: 'rejected', response: sent.response, category: sent.category, errorMessage: sent.errorMessage };
        } else if (sent.kind === 'unsupported') {
          result = { kind: 'unsupported', errorMessage: sent.errorMessage };
        } else if (sent.kind === 'timed_out') {
          result = { kind: 'timed_out', errorMessage: sent.errorMessage };
        } else if (sent.kind === 'failed') {
          result = { kind: 'failed', errorMessage: sent.errorMessage ?? 'Provider reported an error.' };
        } else {
          result = { kind: 'failed', errorMessage: sent.errorMessage ?? 'Unknown provider result.' };
        }
      } catch (err) {
        result = { kind: 'failed', errorMessage: `Provider error: ${(err as Error).message.slice(0, 200)}` };
      }

      switch (result.kind) {
        case 'unsupported': {
          await transitionStatus(command.id, ['submitted'], 'unsupported', {
            responseCategory: 'vehicle_unsupported',
            errorMessage: result.errorMessage,
          });
          await auditEvent(command.id, 'unsupported', 'provider', result.errorMessage ?? '');
          await notifyCommandFinished(command, 'failed');
          return;
        }
        case 'rejected': {
          await transitionStatus(command.id, ['submitted'], 'rejected', {
            providerResponse: result.response,
            responseCategory: result.category ?? 'vehicle_refused',
            errorMessage: result.errorMessage,
          });
          await auditEvent(command.id, 'rejected', 'provider', result.errorMessage ?? 'Provider rejected the command.');
          await notifyCommandFinished(command, 'failed');
          return;
        }
        case 'failed': {
          await transitionStatus(command.id, ['submitted'], 'failed', {
            providerResponse: result.response,
            responseCategory: result.category ?? 'invalid_request',
            errorMessage: result.errorMessage,
          });
          await auditEvent(command.id, 'failed', 'provider', result.errorMessage ?? 'Provider error.');
          await notifyCommandFinished(command, 'failed');
          return;
        }
        case 'timed_out': {
          await transitionStatus(command.id, ['submitted'], 'timed_out', {
            responseCategory: 'outcome_unknown',
            errorMessage: result.errorMessage,
          });
          await auditEvent(command.id, 'timed_out', 'provider', result.errorMessage ?? 'Provider timed out.');
          await notifyCommandFinished(command, 'failed');
          return;
        }
        case 'accepted': {
          const accepted = await transitionStatus(command.id, ['submitted'], 'accepted', {
            providerResponse: result.response,
            responseCategory: result.category ?? 'ok',
          });
          if (!accepted) return;
          await auditEvent(command.id, 'accepted', 'provider', result.response ?? 'Provider accepted.');
          if (!observable) {
            // P-CONFIRM: not_observable commands end at accepted, never confirmed.
            await prisma.vehicleCommand.update({
              where: { id: command.id },
              data: { confirmation: 'not_observable' },
            });
            await notifyCommandFinished(command, 'success');
            return;
          }
          await setPendingCommandUntil(command.vehicleId, CONFIRM_TIMEOUT_MS);
          await enqueue(
            'vehicle-commands',
            { commandId: command.id, stage: 'confirm', n: 1 },
            { jobId: `confirm-${command.id}-1`, delayMs: CONFIRM_DELAY_MS },
          );
          return;
        }
      }
    } finally {
      await producerConnection()
        .eval(
          "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
          1,
          `voltlink:lock:vehicle-cmd:${command.vehicleId}`,
          command.id,
        )
        .catch(() => undefined);
    }
  }

  if (stage === 'confirm') {
    // G-03 / P-CONFIRM: evaluate the predicate against the INGESTED snapshot —
    // no second provider call and no separate polling budget.
    if (command.status !== 'accepted') return;
    const ageMs = command.completedAt ? Date.now() - command.completedAt.getTime() : 0;
    if (ageMs > CONFIRM_TIMEOUT_MS) {
      await transitionStatus(command.id, ['accepted'], 'timed_out', {
        confirmation: 'timeout',
        errorMessage: 'Vehicle did not confirm the command within the timeout.',
      });
      await auditEvent(command.id, 'timed_out', 'worker', 'Confirmation timeout.');
      await notifyCommandFinished(command, 'failed');
      return;
    }
    const snapshot = await prisma.vehicleSnapshot.findUnique({ where: { vehicleId: command.vehicleId } });
    const state = ((snapshot?.state ?? {}) as Record<string, unknown>) ?? {};
    const params = (command.params ?? {}) as Record<string, unknown>;
    if (
      state.status !== 'offline' &&
      state.status !== 'unknown' &&
      commandStatePredicate(command.type as CommandType, params, state)
    ) {
      const confirmed = await transitionStatus(command.id, ['accepted'], 'confirmed', {
        confirmed: true,
        confirmation: 'state_match',
      });
      if (confirmed) {
        await auditEvent(command.id, 'confirmed', 'worker', 'Ingested vehicle state satisfies the expected-state predicate.');
        await notifyCommandFinished(command, 'success');
      }
      return;
    }
    const n = (payload.n ?? 0) + 1;
    await enqueue(
      'vehicle-commands',
      { commandId: command.id, stage: 'confirm', n },
      { jobId: `confirm-${command.id}-${n}`, delayMs: CONFIRM_DELAY_MS },
    );
  }
}

// ---------------------------------------------------------------------------
// Stuck-command sweeper (P-STUCK)
// ---------------------------------------------------------------------------

export async function sweepStuckCommands(): Promise<number> {
  const rows = await prisma.$queryRaw<
    { id: string; userId: string; vehicleId: string; vehicleName: string; status: string; type: string }[]
  >`
    UPDATE "VehicleCommand" SET status = 'timed_out', "completedAt" = now(), "errorMessage" = 'No provider result in time',
      "confirmation" = 'sweep'
     WHERE (status IN ('submitted','accepted') AND COALESCE("submittedAt","createdAt") < now() - interval '3 minutes')
        OR (status = 'queued' AND "createdAt" < now() - interval '15 minutes')
    RETURNING id, "userId", "vehicleId", "vehicleName", status, type`;
  for (const row of rows) {
    await auditEvent(row.id, 'timed_out', 'sweeper', 'No provider result in time.');
    await notifyCommandFinished(row, 'failed');
  }
  return rows.length;
}

/** P-STUCK: commands stuck in submitted/accepted are recovered on worker start. */
export async function recoverStuckCommands(): Promise<number> {
  const rows = await prisma.vehicleCommand.findMany({
    where: { status: { in: ['submitted', 'accepted'] } },
    select: { id: true },
  });
  for (const row of rows) {
    await enqueue('vehicle-commands', { commandId: row.id, stage: 'confirm', n: 1 }, { jobId: `confirm-${row.id}-1` });
  }
  return rows.length;
}

async function notifyCommandFinished(
  command: { id: string; userId: string; vehicleId: string; vehicleName: string; type: string },
  outcome: 'success' | 'failed',
): Promise<void> {
  const { notify } = await import('../notifications/service');
  const event = outcome === 'success' ? 'command_completed' : 'command_failed';
  await notify({
    userId: command.userId,
    event,
    severity: outcome === 'success' ? 'success' : 'warning',
    title: outcome === 'success' ? 'Command completed' : 'Command failed',
    body: `${command.vehicleName}: ${COMMAND_DEFINITIONS[command.type as CommandType]?.label ?? command.type} ${
      outcome === 'success' ? 'completed.' : 'did not complete.'
    }`,
    vehicleId: command.vehicleId ?? undefined,
  });
  ssePublish({
    type: 'command_finished',
    data: { commandId: command.id, outcome },
    userId: command.userId,
  });
}

export async function cancelCommand(commandId: string): Promise<VehicleCommand> {
  const command = await prisma.vehicleCommand.findUnique({ where: { id: commandId } });
  if (!command) throw new CommandError('NOT_FOUND', 'Command not found.', 404);
  if (TERMINAL.includes(command.status as CommandStatus)) {
    throw new CommandError('ALREADY_FINAL', 'Command is already in a final state.', 409);
  }
  // P-TERMINAL: queued → canceled before submission; after submission it is a
  // recorded cancel request, honestly labelled.
  const canceled = await transitionStatus(command.id, ['queued'], 'canceled');
  if (!canceled) {
    await auditEvent(command.id, 'cancel_requested', command.actorKind, 'Cancel requested after submission.');
    ssePublish({ type: 'command_finished', data: { commandId: command.id, outcome: 'cancel_requested' }, userId: command.userId });
  } else {
    await auditEvent(command.id, 'canceled', command.actorKind, 'Canceled by user.');
  }
  const updated = await prisma.vehicleCommand.findUniqueOrThrow({ where: { id: commandId } });
  return serializeCommand(updated);
}

export async function listCommands(vehicleIds: string[], page: number, pageSize: number) {
  const where = { vehicleId: { in: vehicleIds } };
  const [items, total] = await Promise.all([
    prisma.vehicleCommand.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.vehicleCommand.count({ where }),
  ]);
  return { items: items.map(serializeCommand), total };
}

export async function getCommand(commandId: string): Promise<{
  command: VehicleCommand;
  events: { id: string; commandId: string; event: string; actor: string; detail: string; createdAt: string }[];
}> {
  const command = await prisma.vehicleCommand.findUnique({ where: { id: commandId } });
  if (!command) throw new CommandError('NOT_FOUND', 'Command not found.', 404);
  const events = await prisma.commandAuditEvent.findMany({ where: { commandId }, orderBy: { createdAt: 'asc' } });
  return {
    command: serializeCommand(command),
    events: events.map((e) => ({ ...e, createdAt: e.createdAt.toISOString() })),
  };
}
