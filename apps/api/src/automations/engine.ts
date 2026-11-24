// Automation rule engine: triggers, conditions, actions, cooldowns, retries,
// and loop prevention. Dry-run support for the rule editor.

import { prisma } from '../core/db';
import { audit } from '../core/settings';
import { getOperatorOrgId } from '../authz/access';
import { notify } from '../notifications/service';
import { getQueue } from '../core/queue';
import { haversineKm } from '../core/geo';
import { ssePublish } from '../core/sse';
import { METRICS, metricInc } from '../core/metrics';
import type { Automation, TriggerType, ConditionType, ActionType } from '@voltlink/shared';

export interface TriggerEvent {
  type: TriggerType;
  userId?: string;
  vehicleId?: string;
  organizationId?: string;
  data: Record<string, unknown>;
}

const SECONDS = 1000;

// ---------------------------------------------------------------------------
// Trigger evaluation
// ---------------------------------------------------------------------------

/** Find automations matching an event and evaluate conditions. */
export async function findMatchingAutomations(event: TriggerEvent): Promise<Automation[]> {
  // Z-AUTOXTENANT: a system event (e.g. drive_started from telemetry ingestion)
  // is scoped to the vehicle's organization; a user event to the user. An
  // automation can never fire on another tenant's vehicle.
  const rows = await prisma.automation.findMany({
    where: {
      enabled: true,
      ...(event.userId ? { userId: event.userId } : {}),
      ...(event.organizationId ? { organizationId: event.organizationId } : {}),
    },
  });
  const out: Automation[] = [];
  for (const row of rows) {
    if (row.triggerType !== event.type) continue;
    if (row.vehicleId && row.vehicleId !== event.vehicleId) continue;
    if (
      !row.vehicleId &&
      !event.vehicleId &&
      row.triggerType !== 'scheduled' &&
      row.triggerType !== 'webhook'
    )
      continue;
    out.push(toAutomation(row));
  }
  return out;
}

function toAutomation(row: {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  vehicleId: string | null;
  triggerType: string;
  triggerParams: unknown;
  conditions: unknown;
  actions: unknown;
  cooldownSec: number;
  maxRetries: number;
  lastRunAt: Date | null;
  lastResult: string | null;
  runCount: number;
  failureCount: number;
  createdAt: Date;
}): Automation {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    enabled: row.enabled,
    vehicleId: row.vehicleId,
    trigger: {
      type: row.triggerType as TriggerType,
      params: (row.triggerParams ?? {}) as Record<string, unknown>,
    },
    conditions: (row.conditions ?? []) as {
      type: ConditionType;
      params: Record<string, unknown>;
    }[],
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
  ctx: {
    vehicleId?: string;
    state?: Record<string, unknown> | null;
    now: Date;
    timezone?: string;
    previousResult?: string | null;
  },
): Promise<boolean> {
  for (const c of conditions) {
    const ok = await evaluateCondition(c.type, c.params, ctx);
    if (!ok) return false;
  }
  return true;
}

export async function evaluateCondition(
  type: ConditionType,
  params: Record<string, unknown>,
  ctx: {
    vehicleId?: string;
    state?: Record<string, unknown> | null;
    now: Date;
    timezone?: string;
    previousResult?: string | null;
  },
): Promise<boolean> {
  switch (type) {
    case 'vehicle': {
      if (!ctx.vehicleId) return true;
      return ctx.vehicleId === String(params.vehicleId ?? '');
    }
    case 'day': {
      const days = (params.days as number[]) ?? [0, 1, 2, 3, 4, 5, 6];
      return days.includes(localClock(ctx.now, ctx.timezone ?? 'UTC').day);
    }
    case 'time_range': {
      const start = String(params.start ?? '00:00');
      const end = String(params.end ?? '23:59');
      const mins = localClock(ctx.now, ctx.timezone ?? 'UTC').minutes;
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
      // N-CONDITIONS: compare with the automation's last run result; a first
      // run never matches.
      return ctx.previousResult === String(params.value ?? 'success');
    }
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/** TI-13: 4xx CommandErrors are permanent — retrying cannot succeed. */
function isPermanentError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const e = err as Error & { code?: string; status?: number };
  return typeof e.code === 'string' && typeof e.status === 'number' && e.status < 500;
}

export async function executeActions(
  userId: string,
  actions: { type: ActionType; params: Record<string, unknown> }[],
  ctx: {
    vehicleId?: string;
    vehicleName?: string;
    dryRun: boolean;
    automationId?: string;
    organizationId?: string;
  },
): Promise<{ action: ActionType; ok: boolean; detail: string; permanent?: boolean }[]> {
  const results: { action: ActionType; ok: boolean; detail: string; permanent?: boolean }[] = [];
  for (const a of actions) {
    try {
      const detail = await executeAction(userId, a, ctx);
      results.push({ action: a.type, ok: true, detail });
    } catch (err) {
      results.push({
        action: a.type,
        ok: false,
        // TI-13: VALIDATION / UNSUPPORTED / UNKNOWN_COMMAND and every other
        // 4xx command error is permanent and must not be retried.
        permanent: isPermanentError(err),
        detail: (err as Error).message.slice(0, 200),
      });
    }
  }
  return results;
}

async function executeAction(
  userId: string,
  action: { type: ActionType; params: Record<string, unknown> },
  ctx: {
    vehicleId?: string;
    vehicleName?: string;
    dryRun: boolean;
    automationId?: string;
    organizationId?: string;
  },
): Promise<string> {
  const dry = ctx.dryRun ? ' [dry run]' : '';
  // Dry runs are pure: no notifications, no commands, no rows except the
  // execution record (P-DRYRUN).
  if (ctx.dryRun) return `Skipped (dry run): ${action.type}`;
  switch (action.type) {
    case 'notify_app':
      await notify({
        userId,
        event: 'automation_fired',
        title: 'Automation',
        body: String(action.params.message ?? 'Automation triggered.'),
        vehicleId: ctx.vehicleId,
        vehicleName: ctx.vehicleName,
      });
      return `In-app notification queued${dry}`;
    case 'notify_email':
      await notify({
        userId,
        event: 'automation_fired',
        channels: ['email'],
        title: 'VoltLink automation',
        body: String(action.params.message ?? ''),
        vehicleId: ctx.vehicleId,
      });
      return `Email queued${dry}`;
    case 'notify_push':
      await notify({
        userId,
        event: 'automation_fired',
        channels: ['push'],
        title: 'VoltLink',
        body: String(action.params.message ?? ''),
        vehicleId: ctx.vehicleId,
      });
      return `Push queued${dry}`;
    case 'webhook': {
      await notify({
        userId,
        event: 'automation_fired',
        channels: ['webhook'],
        title: 'Automation webhook',
        body: JSON.stringify(action.params),
        vehicleId: ctx.vehicleId,
      });
      return `Webhook delivered${dry}`;
    }
    case 'create_incident': {
      // Z-INCIDENTPUB: public incidents are operator-only. A self-registered
      // user's automation can still create a private incident, but must never
      // reach the anonymous public status bundle.
      const wantedPublic = action.params.public === true;
      let canPublish = false;
      if (wantedPublic) {
        const operatorId = await getOperatorOrgId();
        if (operatorId) {
          const membership = await prisma.membership.findUnique({
            where: { organizationId_userId: { organizationId: operatorId, userId } },
          });
          canPublish = !!membership && membership.status === 'ACTIVE';
        }
      }
      const isPublic = wantedPublic && canPublish;
      await prisma.incident.create({
        data: {
          title: String(action.params.title ?? 'Automation-created incident'),
          severity: String(action.params.severity ?? 'minor'),
          status: 'investigating',
          phases: JSON.parse(
            JSON.stringify({
              investigating: new Date().toISOString(),
              identified: null,
              monitoring: null,
              resolved: null,
            }),
          ),
          components: JSON.parse(JSON.stringify(['telemetry'])),
          public: isPublic,
          createdById: userId,
          source: 'automation',
        },
      });
      return isPublic
        ? `Incident created${dry}`
        : `Incident created (private: public posting is operator-only)${dry}`;
    }
    case 'tag_drive': {
      if (!ctx.vehicleId) return `Tag drive skipped (no vehicle)${dry}`;
      const drive = await prisma.drive.findFirst({
        where: { vehicleId: ctx.vehicleId },
        orderBy: { endAt: 'desc' },
      });
      if (!drive) return 'No drive found to tag';
      const tag = String(action.params.tag ?? 'automation');
      const existing = Array.isArray(drive.tags)
        ? drive.tags
        : JSON.parse(String(drive.tags ?? '[]'));
      await prisma.drive.update({
        where: { id: drive.id },
        data: { tags: [...existing, tag] },
      });
      return `Drive tagged: ${tag}${dry}`;
    }
    case 'generate_report': {
      await getQueue().enqueue(
        'reports',
        { userId, kind: 'automation_report', params: action.params },
        { dedupeKey: `auto-report:${userId}:${ctx.vehicleId ?? 'all'}` },
      );
      return `Report job queued${dry}`;
    }
    default: {
      // Vehicle commands go through the command pipeline (safe by design).
      if (ctx.dryRun || !ctx.vehicleId) return `Vehicle action skipped${dry}`;
      const { issueCommand } = await import('../commands/service');
      const { command } = await issueCommand(
        {
          kind: 'automation',
          userId,
          automationId: ctx.automationId ?? '',
          organizationId: ctx.organizationId ?? '',
        },
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

export async function runAutomation(
  automationId: string,
  event: TriggerEvent,
  opts: { dryRun?: boolean } = {},
): Promise<{
  result: string;
  actionResults: { action: ActionType; ok: boolean; detail: string }[];
}> {
  const row = await prisma.automation.findUnique({
    where: { id: automationId },
    include: { user: true },
  });
  if (!row || !row.enabled) return { result: 'skipped', actionResults: [] };

  if (
    !opts.dryRun &&
    row.cooldownSec > 0 &&
    row.lastRunAt &&
    Date.now() - row.lastRunAt.getTime() < row.cooldownSec * SECONDS
  ) {
    await prisma.automationExecution.create({
      data: {
        automationId: row.id,
        triggeredAt: new Date(),
        triggerEvent: event.type,
        result: 'cooldown',
        actionResults: JSON.parse('[]'),
      },
    });
    return { result: 'cooldown', actionResults: [] };
  }

  const vehicle = event.vehicleId
    ? await prisma.vehicle.findUnique({
        where: { id: event.vehicleId },
        include: { snapshot: true, organization: { select: { timezone: true } } },
      })
    : null;
  const timezone = vehicle?.organization.timezone ?? row.user?.timezone ?? 'UTC';
  const state = (vehicle?.snapshot?.state ?? null) as Record<string, unknown> | null;
  const conditionsMet = await evaluateConditions(
    (row.conditions ?? []) as { type: ConditionType; params: Record<string, unknown> }[],
    {
      vehicleId: event.vehicleId,
      state,
      now: new Date(),
      timezone,
      previousResult: row.lastResult,
    },
  );
  if (!conditionsMet) {
    await prisma.automationExecution.create({
      data: {
        automationId: row.id,
        triggeredAt: new Date(),
        triggerEvent: event.type,
        conditionsMet: false,
        result: 'skipped',
        actionResults: JSON.parse('[]'),
      },
    });
    return { result: 'skipped', actionResults: [] };
  }

  // Loop prevention: the hourly budget never lets a misbehaving automation
  // run away (N-ACTIONSTUBS).
  if (!opts.dryRun && !(await automationRunBudget(row.id))) {
    await prisma.automationExecution.create({
      data: {
        automationId: row.id,
        triggeredAt: new Date(),
        triggerEvent: event.type,
        result: 'budget_exceeded',
        actionResults: JSON.parse('[]'),
      },
    });
    return { result: 'budget_exceeded', actionResults: [] };
  }

  const actions = (row.actions ?? []) as { type: ActionType; params: Record<string, unknown> }[];
  // maxRetries: TI-13 — the spec is per-ACTION retry. Only the FAILING
  // actions are re-run on each attempt; successful actions execute exactly
  // once, so side effects (notifications, commands) never duplicate.
  // PERMANENT failures (4xx CommandErrors) are recorded once and dropped
  // from the pending set: no retry can succeed.
  const attempts = Math.max(1, (row.maxRetries ?? 0) + 1);
  const finalResults = new Map<
    number,
    { action: ActionType; ok: boolean; detail: string; permanent?: boolean }
  >();
  let pending = actions.map((action, index) => ({ index, action }));
  for (let attempt = 0; attempt < attempts && pending.length > 0; attempt++) {
    const batch = await executeActions(
      row.userId,
      pending.map((p) => p.action),
      {
        vehicleId: event.vehicleId ?? undefined,
        vehicleName: vehicle?.displayName,
        dryRun: !!opts.dryRun,
        automationId: row.id,
        organizationId: row.organizationId,
      },
    );
    pending = pending.filter((p, i) => {
      const result = batch[i]!;
      finalResults.set(p.index, result);
      return !result.ok && !result.permanent;
    });
  }
  const actionResults = actions.map((_a, index) => finalResults.get(index)!);
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
  if (result === 'failed') metricInc(METRICS.automationFailures);
  void ssePublish({
    userId: row.userId,
    type: 'automation.execution',
    data: { automationId: row.id, result, vehicleId: event.vehicleId ?? null },
  });
  await audit({
    actorId: null,
    action: 'automation.run',
    entityType: 'automation',
    entityId: row.id,
    details: { result, trigger: event.type, vehicleId: event.vehicleId ?? null },
  });
  return { result, actionResults };
}

/** Dispatch a trigger event to all matching automations (used by ingest + scheduler). */
/** N-CONDITIONS: local day/time in the user's time zone. */
export function localClock(date: Date, timezone: string): { day: number; minutes: number } {
  let day = date.getUTCDay();
  let minutes = date.getUTCHours() * 60 + date.getUTCMinutes();
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(date);
    const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
    const wd = parts.find((p) => p.type === 'weekday')?.value.toLowerCase();
    if (wd) day = days.indexOf(wd.slice(0, 3));
    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? NaN);
    const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? NaN);
    if (Number.isFinite(hour) && Number.isFinite(minute)) minutes = hour * 60 + minute;
  } catch {
    /* UTC fallback */
  }
  return { day, minutes };
}

export async function dispatchTrigger(event: TriggerEvent): Promise<number> {
  // Events without a user carry the vehicle's organization instead, so
  // 'all vehicles' automations only see the tenant that owns the vehicle.
  const scoped = { ...event };
  if (!scoped.userId && scoped.vehicleId) {
    const vehicle = await prisma.vehicle.findUnique({
      where: { id: scoped.vehicleId },
      select: { organizationId: true },
    });
    scoped.organizationId = vehicle?.organizationId ?? undefined;
  }
  const matches = await findMatchingAutomations(scoped);
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
  const count = await prisma.automationExecution.count({
    where: { automationId, triggeredAt: { gt: hourAgo } },
  });
  return count < maxPerHour;
}
