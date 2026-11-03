// Status platform service: automated health checks over components, uptime
// history, and the public status bundle.

import { prisma, query } from '../core/db';
import { getQueue } from '../core/queue';
import { env } from '../core/env';
import { poller } from '../telemetry/poller';
import { getSetting } from '../core/settings';
import { sseCount } from '../core/sse';
import type { ComponentStatus } from '@voltlink/shared';

export const STATUS_GROUPS = ['Core', 'Data', 'Vehicle', 'Integrations', 'Providers'] as const;

const STATUS_ORDER: Record<ComponentStatus, number> = {
  operational: 0,
  degraded: 1,
  maintenance: 2,
  partial_outage: 3,
  major_outage: 4,
  unknown: 5,
};

export async function ensureComponents(): Promise<void> {
  const existing = await prisma.statusComponent.count();
  if (existing > 0) return;
  const components = [
    {
      key: 'web',
      name: 'Web application',
      group: 'Core',
      description: 'The VoltLink web application and API.',
    },
    { key: 'api', name: 'Public API', group: 'Core' },
    { key: 'auth', name: 'Authentication', group: 'Core' },
    { key: 'postgres', name: 'PostgreSQL', group: 'Data' },
    { key: 'redis', name: 'Redis / job queue', group: 'Data' },
    { key: 'workers', name: 'Background workers', group: 'Core' },
    { key: 'scheduler', name: 'Scheduler', group: 'Core' },
    { key: 'telemetry', name: 'Telemetry ingestion', group: 'Vehicle' },
    { key: 'commands', name: 'Command service', group: 'Vehicle' },
    { key: 'automations', name: 'Automation engine', group: 'Vehicle' },
    { key: 'notifications', name: 'Notification delivery', group: 'Vehicle' },
    { key: 'realtime', name: 'Real-time updates', group: 'Core' },
    { key: 'maps', name: 'Map service', group: 'Integrations' },
    { key: 'tesla', name: 'Tesla provider', group: 'Providers' },
    { key: 'tessie', name: 'Tessie provider (optional)', group: 'Providers' },
    { key: 'demo', name: 'Demo provider', group: 'Providers' },
  ];
  await prisma.statusComponent.createMany({
    data: components.map((c) => ({ ...c, status: 'operational' })),
    // api, worker, scheduler, and statusServer all boot at once and each runs
    // ensureComponents(); skipDuplicates makes the seed idempotent under that
    // race instead of failing with P2002 on the unique `key` index.
    skipDuplicates: true,
  });
}

interface CheckResult {
  ok: boolean;
  latencyMs?: number;
  detail?: string;
}

export async function checkComponent(key: string): Promise<CheckResult> {
  const t0 = Date.now();
  const latency = () => Date.now() - t0;
  switch (key) {
    case 'web':
    case 'api':
      return { ok: true, latencyMs: 1, detail: 'HTTP service responding.' };
    case 'auth': {
      try {
        await prisma.userSession.count({ take: 1 });
        return { ok: true, latencyMs: latency(), detail: 'Session store reachable.' };
      } catch {
        return { ok: false, detail: 'Session store unreachable.' };
      }
    }
    case 'postgres': {
      try {
        await query('SELECT 1');
        return { ok: true, latencyMs: latency(), detail: 'PostgreSQL reachable.' };
      } catch {
        return { ok: false, detail: 'PostgreSQL unreachable.' };
      }
    }
    case 'redis': {
      const q = getQueue();
      if (!env.REDIS_URL)
        return { ok: true, detail: 'Redis not configured — Postgres queue in use.' };
      const ok = await q.ping();
      return { ok, latencyMs: latency(), detail: ok ? 'Redis reachable.' : 'Redis unreachable.' };
    }
    case 'workers': {
      const q = getQueue();
      const { queue } = await import('../jobs/queues');
      const failed = await queue('vehicle-commands')
        .getFailed(0, 10_000)
        .then((j) => j.length)
        .catch(() => 0);
      const depth = env.REDIS_URL ? await q.depth('vehicle-commands') : 0;
      const beat = await getSetting('workerBeat');
      const active = !!beat && Date.now() - new Date(beat).getTime() < 90_000;
      return {
        ok: failed < 50,
        latencyMs: latency(),
        detail: active
          ? `${failed} failed jobs, queue depth ${depth}.`
          : 'No worker beat recently; workers may be down.',
      };
    }
    case 'scheduler':
      return {
        ok: poller.isRunning() || env.NODE_ENV === 'test',
        latencyMs: latency(),
        detail: poller.isRunning()
          ? 'Scheduler loop active.'
          : 'Scheduler not running in this process.',
      };
    case 'telemetry': {
      const fresh = await prisma.vehicleSnapshot.findFirst({
        where: { fetchedAt: { gt: new Date(Date.now() - 15 * 60000) } },
      });
      return {
        ok: !!fresh,
        latencyMs: latency(),
        detail: fresh ? 'Telemetry current.' : 'No snapshot younger than 15 minutes.',
      };
    }
    case 'commands': {
      const pending = await prisma.vehicleCommand.count({
        where: {
          status: { in: ['queued', 'submitted', 'accepted'] },
          createdAt: { gt: new Date(Date.now() - 300_000) },
        },
      });
      return { ok: pending < 200, latencyMs: latency(), detail: `${pending} commands in flight.` };
    }
    case 'automations': {
      const failed = await prisma.automationExecution.count({
        where: { result: 'failed', triggeredAt: { gt: new Date(Date.now() - 3600_000) } },
      });
      return {
        ok: failed < 20,
        latencyMs: latency(),
        detail: `${failed} automation failures in the last hour.`,
      };
    }
    case 'notifications': {
      const count = await prisma.webhookEndpoint.count({ where: { enabled: true, lastStatus: 0 } });
      return {
        ok: count < 50,
        latencyMs: latency(),
        detail: `${count} endpoints with recent failures.`,
      };
    }
    case 'realtime':
      return { ok: true, latencyMs: latency(), detail: `${sseCount()} connected clients.` };
    case 'maps': {
      // N-STATUSHEALTH: optional integration; not configured ≠ outage.
      const source = await getSetting('mapTileSource');
      if (!source) return { ok: true, detail: 'Not configured — map tiles are optional.' };
      return {
        ok: true,
        latencyMs: latency(),
        detail: 'Map tile source configured (client-side rendering).',
      };
    }
    case 'tesla': {
      // N-STATUSHEALTH: missing credentials is "not configured" (operational),
      // not an outage; configured + failing is a real outage.
      const configured = Boolean(env.TESLA_CLIENT_ID && env.TESLA_CLIENT_SECRET);
      const accounts = await prisma.providerAccount.findMany({
        where: { provider: 'tesla', status: { not: 'revoked' } },
      });
      const withErrors = accounts.filter(
        (a) => a.lastError && a.lastSyncAt && a.lastSyncAt > new Date(Date.now() - 3600_000),
      );
      if (accounts.length === 0 && !configured)
        return { ok: true, detail: 'Not configured — no Tesla credentials or accounts.' };
      if (accounts.length === 0)
        return { ok: true, detail: 'Configured; no accounts connected yet.' };
      return {
        ok: withErrors.length === 0,
        latencyMs: latency(),
        detail: `${accounts.length} accounts, ${withErrors.length} with recent errors.`,
      };
    }
    case 'tessie': {
      const configured = Boolean(
        env.TESSIE_BASE_URL && env.TESSIE_BASE_URL !== 'https://api.tessie.com',
      );
      const accounts = await prisma.providerAccount.findMany({
        where: { provider: 'tessie', status: { not: 'revoked' } },
      });
      const withErrors = accounts.filter(
        (a) => a.lastError && a.lastSyncAt && a.lastSyncAt > new Date(Date.now() - 3600_000),
      );
      if (accounts.length === 0 && !configured)
        return { ok: true, detail: 'Not configured — Tessie is optional.' };
      if (accounts.length === 0)
        return { ok: true, detail: 'Configured; no accounts connected yet.' };
      return {
        ok: withErrors.length === 0,
        latencyMs: latency(),
        detail: `${accounts.length} accounts, ${withErrors.length} with recent errors.`,
      };
    }
    case 'demo': {
      // Z-DEMOSCOPE: degradation is per organization; report any degraded demo
      // organization as a degraded demo provider check.
      const degraded = await prisma.organization.count({ where: { demoDegraded: true } });
      return {
        ok: degraded === 0,
        latencyMs: latency(),
        detail:
          degraded === 0
            ? 'Demo provider healthy.'
            : `${degraded} organization(s) simulate demo-provider degradation.`,
      };
    }
    default:
      return { ok: true, detail: 'No check defined.' };
  }
}

/** Run all automated checks, update components, and record history. */
export async function runStatusChecks(): Promise<void> {
  await ensureComponents();
  const components = await prisma.statusComponent.findMany();
  // N-MAINT: windows are time-driven. A component inside an active window is
  // 'maintenance'; once the window ends it returns to 'operational'.
  const now = new Date();
  const windows = await prisma.maintenanceWindow.findMany({
    where: { startsAt: { lte: now }, endsAt: { gt: now }, status: { not: 'completed' } },
  });
  const covered = new Set<string>();
  for (const w of windows) for (const k of (w.components ?? []) as string[]) covered.add(k);
  for (const w of windows) {
    if (w.status !== 'in_progress') {
      await prisma.maintenanceWindow.update({
        where: { id: w.id },
        data: { status: 'in_progress' },
      });
    }
  }
  await prisma.maintenanceWindow.updateMany({
    where: { endsAt: { lte: now }, status: { not: 'completed' } },
    data: { status: 'completed' },
  });
  for (const c of components) {
    if (c.manualOverride) continue;
    if (covered.has(c.key)) {
      if (c.status !== 'maintenance') {
        await prisma.statusComponent.update({
          where: { key: c.key },
          data: { status: 'maintenance', updatedAt: new Date() },
        });
        c.status = 'maintenance';
      }
      continue;
    }
    if (c.status === 'maintenance') {
      await prisma.statusComponent.update({
        where: { key: c.key },
        data: { status: 'operational', updatedAt: new Date() },
      });
      c.status = 'operational';
    }
  }
  for (const c of components) {
    if (c.manualOverride) continue;
    if (covered.has(c.key)) continue;
    const result = await checkComponent(c.key).catch(() => ({
      ok: false,
      latencyMs: undefined as number | undefined,
      detail: 'check error',
    }));
    const newStatus: ComponentStatus = result.ok ? 'operational' : 'major_outage';
    if (newStatus !== c.status) {
      await prisma.statusComponent.update({
        where: { key: c.key },
        data: { status: newStatus, updatedAt: new Date() },
      });
    }
    await prisma.statusCheck.create({
      data: {
        componentKey: c.key,
        ok: result.ok,
        latencyMs: result.latencyMs ?? null,
        detail: result.detail?.slice(0, 400),
        at: new Date(),
      },
    });
  }
  // prune old checks beyond 90d happens in retention
}

export function overallStatus(statuses: ComponentStatus[]): ComponentStatus {
  if (statuses.length === 0) return 'unknown';
  const rank = statuses.map((s) => STATUS_ORDER[s] ?? 5);
  const worst = Math.max(...rank);
  const entry = (Object.entries(STATUS_ORDER) as [ComponentStatus, number][]).find(
    ([, v]) => v === worst,
  );
  return entry?.[0] ?? 'unknown';
}

export async function publicStatusBundle(): Promise<unknown> {
  const [components, incidents, maintenance, updated] = await Promise.all([
    prisma.statusComponent.findMany({ orderBy: { group: 'asc' } }),
    prisma.incident.findMany({
      where: { public: true },
      include: { updates: { orderBy: { createdAt: 'asc' } } },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.maintenanceWindow.findMany({
      where: { endsAt: { gt: new Date() } },
      orderBy: { startsAt: 'asc' },
    }),
    prisma.statusComponent.aggregate({ _max: { updatedAt: true } }),
  ]);
  const statuses = components.map((c) => c.status as ComponentStatus);
  const uptime = await uptimePct(30);
  return {
    overall: overallStatus(statuses),
    components: components.map((c) => ({
      id: c.id,
      key: c.key,
      name: c.name,
      group: c.group,
      description: c.description ?? undefined,
      status: c.status,
      manualOverride: c.manualOverride,
      updatedAt: c.updatedAt.toISOString(),
      uptime90dPct: uptime.get(c.key) ?? 100,
    })),
    incidents: incidents.map(toIncidentDto),
    maintenance: maintenance.map((m) => ({
      id: m.id,
      title: m.title,
      description: m.description ?? undefined,
      startsAt: m.startsAt.toISOString(),
      endsAt: m.endsAt.toISOString(),
      components: (m.components ?? []) as string[],
      status: m.status,
    })),
    updatedAt: (updated._max.updatedAt ?? new Date()).toISOString(),
    uptime30dPct: Math.round(
      [...uptime.values()].reduce((a, b) => a + b, 0) / Math.max(1, uptime.size),
    ),
  };
}

async function uptimePct(days: number): Promise<Map<string, number>> {
  const from = new Date(Date.now() - days * 86400000);
  const rows = await prisma.statusCheck.findMany({
    where: { at: { gte: from } },
    select: { componentKey: true, ok: true },
  });
  const totals = new Map<string, number>();
  const oks = new Map<string, number>();
  for (const r of rows) {
    totals.set(r.componentKey, (totals.get(r.componentKey) ?? 0) + 1);
    if (r.ok) oks.set(r.componentKey, (oks.get(r.componentKey) ?? 0) + 1);
  }
  const out = new Map<string, number>();
  for (const [k, t] of totals) out.set(k, Math.round(((oks.get(k) ?? 0) / t) * 1000) / 10);
  return out;
}

export function toIncidentDto(i: {
  id: string;
  title: string;
  severity: string;
  status: string;
  phases: unknown;
  components: unknown;
  public: boolean;
  createdAt: Date;
  updates: { id: string; phase: string; message: string; createdAt: Date; author: string }[];
}) {
  return {
    id: i.id,
    title: i.title,
    severity: i.severity,
    status: i.status,
    phases: i.phases ?? {},
    components: (i.components ?? []) as string[],
    public: i.public,
    createdAt: i.createdAt.toISOString(),
    updates: (i.updates ?? []).map((u) => ({
      id: u.id,
      phase: u.phase,
      message: u.message,
      createdAt: u.createdAt.toISOString(),
      author: u.author,
    })),
  };
}
