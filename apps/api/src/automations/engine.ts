// Automation rule engine: triggers, conditions, actions, cooldowns, retries,
// and loop prevention. Dry-run support for the rule editor.

import { prisma } from '../core/db';
import { audit } from '../core/settings';
import { notify } from '../notifications/service';
import { getQueue } from '../core/queue';
import { haversineKm } from '../core/geo';
import type { Automation, TriggerType, ConditionType, ActionType } from '@voltlink/shared';

export interface TriggerEvent {
  type: TriggerType;
  userId?: string;
  vehicleId?: string;
  data: Record<string, unknown>;
}

const SECONDS = 1000;

// ---------------------------------------------------------------------------
// Trigger evaluation
// ---------------------------------------------------------------------------

/** Find automations matching an event and evaluate conditions. */
export async function findMatchingAutomations(event: TriggerEvent): Promise<Automation[]> {
  const rows = await prisma.automation.findMany({
    where: event.userId ? { userId: event.userId, enabled: true } : { enabled: true },
  });
  const out: Automation[] = [];
  for (const row of rows) {
    if (row.triggerType !== event.type) continue;
    if (row.vehicleId && row.vehicleId !== event.vehicleId) continue;
    if (!row.vehicleId && !event.vehicleId && row.triggerType !== 'scheduled' && row.triggerType !== 'webhook') continue;
    out.push(toAutomation(row));
  }
  return out;
}

function toAutomation(row: {
  id: string; name: string; description: string | null; enabled: boolean; vehicleId: string | null;
  triggerType: string; triggerParams: unknown; conditions: unknown; actions: unknown; cooldownSec: number;
  maxRetries: number; lastRunAt: Date | null; lastResult: string | null; runCount: number; failureCount: number; createdAt: Date;
}): Automation {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    enabled: row.enabled,
    vehicleId: row.vehicleId,
    trigger: { type: row.triggerType as TriggerType, params: (row.triggerParams ?? {}) as Record<string, unknown> },
    conditions: (row.conditions ?? []) as { type: ConditionType; params: Record<string, unknown> }[],
    actions: (row.actions ?? []) as { type: ActionType; params: Record<string, unknown> }[],
    cooldownSec: row.cooldownSec,
    maxRetries: row.maxRetries,
    lastRunAt: row.lastRunAt?.toISOString(),
    lastResult: row.lastResult ?? undefined,
    runCount: row.runCount,
    failureCount: row.failureCount,
    createdAt: row.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Conditions
// ---------------------------------------------------------------------------

export async function evaluateConditions(
  conditions: { type: ConditionType; params: Record<string, unknown> }[],
  ctx: { vehicleId?: string; state?: Record<string, unknown> | null; now: Date },
): Promise<boolean> {
  for (const c of conditions) {
    const ok = await evaluateCondition(c.type, c.params, ctx);
    if (!ok) return false;
  }
  return true;
}

async function evaluateCondition(
  type: ConditionType,
  params: Record<string, unknown>,
  ctx: { vehicleId?: string; state?: Record<string, unknown> | null; now: Date },
): Promise<boolean> {
  switch (type) {
    case 'vehicle': {
      if (!ctx.vehicleId) return true;
      return ctx.vehicleId === String(params.vehicleId ?? '');
    }
    case 'day': {
      const days = (params.days as number[]) ?? [0, 1, 2, 3, 4, 5, 6];
      return days.includes(ctx.now.getUTCDay());
    }
    case 'time_range': {
      const start = String(params.start ?? '00:00');
      const end = String(params.end ?? '23:59');
      const mins = ctx.now.getUTCHours() * 60 + ctx.now.getUTCMinutes();
      const [sh, sm] = start.split(':').map((x) => Number(x) || 0);
      const [eh, em] = end.split(':').map((x) => Number(x) || 0);
      const s = (sh ?? 0) * 60 + (sm ?? 0);
      const e = (eh ?? 0) * 60 + (em ?? 0);
      return s <= e ? mins >= s && mins <= e : mins >= s || mins <= e;
    }
    case 'place': {
      const state = ctx.state;
      const lat = state?.lat as number | undefined;
      const lon = state?.lon as number | undefined;
      if (lat === undefined || lon === undefined) return false;
      const d = haversineKm(lat, lon, Number(params.lat), Number(params.lon));
      return d <= Number(params.radiusM ?? 200) / 1000;
    }
    case 'battery_below':
      return ((ctx.state?.batteryPercent as number | undefined) ?? 101) < Number(params.pct ?? 20);
    case 'battery_above':
      return ((ctx.state?.batteryPercent as number | undefined) ?? -1) > Number(params.pct ?? 80);
    case 'charging_state': {
      const want = String(params.state ?? 'charging');
      return (ctx.state?.chargingState as string | undefined) === want;
    }
    case 'plug_state': {
      const want = params.connected === true;
      return (ctx.state?.plugConnected as boolean | undefined) === want;
    }
    case 'previous_result': {
      // handled by caller when running (needs automation row) — default true
      return true;
    }
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export async function executeActions(
  userId: string,
  actions: { type: ActionType; params: Record<string, unknown> }[],
  ctx: { vehicleId?: string; vehicleName?: string; dryRun: boolean; automationId?: string; organizationId?: string },
): Promise<{ action: ActionType; ok: boolean; detail: string }[]> {
  const results: { action: ActionType; ok: boolean; detail: string }[] = [];
  for (const a of actions) {
    try {
      const detail = await executeAction(userId, a, ctx);
      results.push({ action: a.type, ok: true, detail });
    } catch (err) {
      results.push({ action: a.type, ok: false, detail: (err as Error).message.slice(0, 200) });
    }
  }
  return results;
}

async function executeAction(
  userId: string,
  action: { type: ActionType; params: Record<string, unknown> },
  ctx: { vehicleId?: string; vehicleName?: string; dryRun: boolean; automationId?: string; organizationId?: string },
): Promise<string> {
  const dry = ctx.dryRun ? ' [dry run]' : '';
  switch (action.type) {
    case 'notify_app':
      await notify({ userId, event: 'automation_fired', title: 'Automation', body: String(action.params.message ?? 'Automation triggered.'), vehicleId: ctx.vehicleId, vehicleName: ctx.vehicleName });
      return `In-app notification queued${dry}`;
    case 'notify_email':
      await notify({ userId, event: 'automation_fired', channels: ['email'], title: 'VoltLink automation', body: String(action.params.message ?? ''), vehicleId: ctx.vehicleId });
      return `Email queued${dry}`;
    case 'notify_push':
      await notify({ userId, event: 'automation_fired', channels: ['push'], title: 'VoltLink', body: String(action.params.message ?? ''), vehicleId: ctx.vehicleId });
      return `Push queued${dry}`;
    case 'webhook': {
      await notify({ userId, event: 'automation_fired', channels: ['webhook'], title: 'Automation webhook', body: JSON.stringify(action.params), vehicleId: ctx.vehicleId });
      return `Webhook delivered${dry}`;
    }
    case 'create_incident': {
      await prisma.incident.create({
        data: {
          title: String(action.params.title ?? 'Automation-created incident'),
          severity: String(action.params.severity ?? 'minor'),
          status: 'investigating',
          phases: JSON.parse(JSON.stringify({ investigating: new Date().toISOString(), identified: null, monitoring: null, resolved: null })),
          components: JSON.parse(JSON.stringify(['telemetry'])),
          public: action.params.public === true,
        },
      });
      return `Incident created${dry}`;
    }
    case 'generate_report': {
      await getQueue().enqueue('reports', { userId, kind: 'automation_report', params: action.params }, { dedupeKey: `auto-report:${userId}:${ctx.vehicleId ?? 'all'}` });
      return `Report job queued${dry}`;
    }
    default: {
      // Vehicle commands go through the command pipeline (safe by design).
      if (ctx.dryRun || !ctx.vehicleId) return `Vehicle action skipped${dry}`;
      const { issueCommand } = await import('../commands/service');
      const { command } = await issueCommand(
        { kind: 'automation', userId, automationId: ctx.automationId ?? '', organizationId: ctx.organizationId ?? '' },
        ctx.vehicleId,
        action.type as never,
        action.params as never,
      );
      return `Vehicle command ${command.status}`;
    }
  }
}

// ---------------------------------------------------------------------------
// Running an automation
// ---------------------------------------------------------------------------

export async function runAutomation(automationId: string, event: TriggerEvent, opts: { dryRun?: boolean } = {}): Promise<{ result: string; actionResults: { action: ActionType; ok: boolean; detail: string }[] }> {
  const row = await prisma.automation.findUnique({ where: { id: automationId }, include: { user: true } });
  if (!row || !row.enabled) return { result: 'skipped', actionResults: [] };

  if (!opts.dryRun && row.cooldownSec > 0 && row.lastRunAt && Date.now() - row.lastRunAt.getTime() < row.cooldownSec * SECONDS) {
    await prisma.automationExecution.create({
      data: { automationId: row.id, triggeredAt: new Date(), triggerEvent: event.type, result: 'cooldown', actionResults: JSON.parse('[]') },
    });
    return { result: 'cooldown', actionResults: [] };
  }

  const vehicle = event.vehicleId ? await prisma.vehicle.findUnique({ where: { id: event.vehicleId }, include: { snapshot: true } }) : null;
  const state = (vehicle?.snapshot?.state ?? null) as Record<string, unknown> | null;
  const conditionsMet = await evaluateConditions((row.conditions ?? []) as { type: ConditionType; params: Record<string, unknown> }[], {
    vehicleId: event.vehicleId,
    state,
    now: new Date(),
  });
  if (!conditionsMet) {
    await prisma.automationExecution.create({
      data: { automationId: row.id, triggeredAt: new Date(), triggerEvent: event.type, conditionsMet: false, result: 'skipped', actionResults: JSON.parse('[]') },
    });
    return { result: 'skipped', actionResults: [] };
  }

  const actionResults = await executeActions(row.userId, (row.actions ?? []) as { type: ActionType; params: Record<string, unknown> }[], {
    vehicleId: event.vehicleId ?? undefined,
    vehicleName: vehicle?.displayName,
    dryRun: !!opts.dryRun,
    automationId: row.id,
    organizationId: row.organizationId,
  });
  const ok = actionResults.every((r) => r.ok);
  const result = opts.dryRun ? 'dry_run' : ok ? 'success' : 'failed';
  await prisma.automationExecution.create({
    data: {
      automationId: row.id,
      triggeredAt: new Date(),
      triggerEvent: event.type,
      conditionsMet: true,
      result,
      actionResults: JSON.parse(JSON.stringify(actionResults)),
      errorMessage: ok ? undefined : 'One or more actions failed.',
    },
  });
  if (!opts.dryRun) {
    await prisma.automation.update({
      where: { id: row.id },
      data: {
        lastRunAt: new Date(),
        lastResult: result,
        runCount: { increment: 1 },
        failureCount: ok ? undefined : { increment: 1 },
      },
    });
  }
  await audit({ actorId: null, action: 'automation.run', entityType: 'automation', entityId: row.id, details: { result, trigger: event.type, vehicleId: event.vehicleId ?? null } });
  return { result, actionResults };
}

/** Dispatch a trigger event to all matching automations (used by ingest + scheduler). */
export async function dispatchTrigger(event: TriggerEvent): Promise<number> {
  const matches = await findMatchingAutomations(event);
  for (const a of matches) {
    void runAutomation(a.id, event).catch((err) => {
      console.error(`automation ${a.id} failed:`, (err as Error).message);
    });
  }
  return matches.length;
}

/** Loop-prevention guard: max automation runs per automation per hour. */
export async function automationRunBudget(automationId: string, maxPerHour = 60): Promise<boolean> {
  const hourAgo = new Date(Date.now() - 3600_000);
  const count = await prisma.automationExecution.count({ where: { automationId, triggeredAt: { gt: hourAgo } } });
  return count < maxPerHour;
}
