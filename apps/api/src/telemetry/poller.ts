// Provider polling scheduler: sleep-aware, jittered, rate-limited, and
// backoff-aware. Runs in the scheduler process; never ties ingestion to a
// browser session.

import { prisma } from '../core/db';
import { getQueue } from '../core/queue';
import { getProvider } from '../providers/registry';
import { buildContext } from '../providers/registry';
import { seededRng, hashString } from '../providers/types';
import { planNextPoll, DEFAULT_TUNING } from './teslaPollPlanner';

const TICK_MS = 15_000;
const MAX_FETCHES_PER_ACCOUNT_PER_MINUTE = 8;

export class PollingScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastFetches = new Map<string, number[]>(); // accountId -> timestamps
  private failures = new Map<string, { count: number; until: number }>(); // accountId -> backoff
  private pendingCommands = new Map<string, number>(); // vehicleId -> command count

  start(): void {
    if (this.timer) return;
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      try {
        await this.tick();
      } catch (err) {
        console.error('polling tick failed:', (err as Error).message);
      }
      this.timer = setTimeout(loop, TICK_MS + jitterMs());
    };
    this.timer = setTimeout(loop, 3000);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  isRunning(): boolean {
    return this.running;
  }

  async tick(): Promise<number> {
    // P-SLEEP / P-SCHED: DB-driven planning with a compare-and-set lease, so
    // two scheduler leaders can never double-plan a vehicle.
    const now = new Date();
    const due = await prisma.vehiclePollState.findMany({
      where: {
        nextPollAt: { lte: now },
        vehicle: { active: true, providerAccount: { status: 'connected' } },
      },
      select: {
        vehicleId: true,
        nextPollAt: true,
        connectivity: true,
        activity: true,
        lastVehicleDataAt: true,
        lastActivityAt: true,
        pendingCommandUntil: true,
        userActiveUntil: true,
        suspendedUntil: true,
        backoffUntil: true,
        vehicle: {
          select: { id: true, providerAccountId: true, providerVehicleId: true, demo: true },
        },
      },
      orderBy: { nextPollAt: 'asc' },
      take: 200,
    });
    let planned = 0;
    for (const row of due) {
      const accountId = row.vehicle.providerAccountId;
      const fail = this.failures.get(accountId);
      if (fail && Date.now() < fail.until) continue;
      const bucket = (this.lastFetches.get(accountId) ?? []).filter((t) => Date.now() - t < 60_000);
      if (bucket.length >= MAX_FETCHES_PER_ACCOUNT_PER_MINUTE) continue;
      const plan = planNextPoll(
        {
          connectivity: row.connectivity,
          activity: (row.activity ?? {}) as Record<string, unknown>,
          lastVehicleDataAt: row.lastVehicleDataAt?.getTime() ?? null,
          lastActivityAt: row.lastActivityAt?.getTime() ?? null,
          pendingCommandUntil: row.pendingCommandUntil?.getTime() ?? null,
          userActiveUntil: row.userActiveUntil?.getTime() ?? null,
          suspendedUntil: row.suspendedUntil?.getTime() ?? null,
          backoffUntil: row.backoffUntil?.getTime() ?? null,
          now: Date.now(),
        },
        DEFAULT_TUNING,
      );
      if (plan.action === 'none') continue;
      // Lease: only the scheduler that flips nextPollAt plans this vehicle.
      const leased = await prisma.vehiclePollState.updateMany({
        where: { vehicleId: row.vehicleId, nextPollAt: row.nextPollAt },
        data: { nextPollAt: new Date(Date.now() + 120_000) },
      });
      if (leased.count !== 1) continue;
      planned++;
      bucket.push(Date.now());
      await getQueue().enqueue(
        'telemetry',
        {
          accountId,
          vehicleId: row.vehicleId,
          providerVehicleId: row.vehicle.providerVehicleId,
          action: plan.action,
        },
        { dedupeKey: `poll:${row.vehicleId}:${Math.floor(Date.now() / 30_000)}` },
      );
      this.lastFetches.set(accountId, bucket);
    }
    return planned;
  }

  /** Sleep-aware polling decisions. */
  private needsPolling(): boolean {
    return true;
  }

  notePendingCommand(vehicleId: string): void {
    this.pendingCommands.set(vehicleId, Date.now());
  }

  recordFailure(accountId: string, message: string): void {
    const f = this.failures.get(accountId) ?? { count: 0, until: 0 };
    f.count += 1;
    f.until = Date.now() + Math.min(2 ** f.count, 30) * 60_000;
    this.failures.set(accountId, f);
    void prisma.providerAccount
      .update({ where: { id: accountId }, data: { lastError: message.slice(0, 500) } })
      .catch(() => undefined);
  }

  async recordSuccess(accountId: string): Promise<void> {
    this.failures.delete(accountId);
    // N-TRIGGERS: provider_reconnected when a reauth_required account works
    // again.
    const account = await prisma.providerAccount.findUnique({
      where: { id: accountId },
      select: {
        status: true,
        organizationId: true,
        vehicles: { select: { id: true, addedById: true } },
      },
    });
    if (account?.status === 'reauth_required') {
      await prisma.providerAccount.update({
        where: { id: accountId },
        data: { status: 'connected', lastError: null },
      });
      const { dispatchTrigger } = await import('../automations/engine');
      for (const v of account.vehicles) {
        void dispatchTrigger({
          type: 'provider_reconnected',
          userId: v.addedById ?? '',
          vehicleId: v.id,
          data: { accountId },
        });
      }
    }
  }
}

export const poller = new PollingScheduler();

function jitterMs(): number {
  const rng = seededRng(hashString(String(Date.now())));
  return Math.floor(rng() * 10_000);
}

/** Process a queued telemetry job: fetch one vehicle's state and ingest. */
export async function processTelemetryJob(payload: {
  accountId: string;
  vehicleId: string;
  providerVehicleId: string;
  action?: 'state' | 'vehicle_data';
}): Promise<void> {
  const vehicle = await prisma.vehicle.findUnique({
    where: { id: payload.vehicleId },
    include: { providerAccount: true, snapshot: true },
  });
  if (!vehicle) return;
  const account = vehicle.providerAccount;
  if (account.status !== 'connected' && account.status !== 'reauth_required') return;
  // P-SLEEP: record the vehicle_data time BEFORE the call, so 408s count.
  if (payload.action !== 'state') {
    await prisma.vehiclePollState.upsert({
      where: { vehicleId: vehicle.id },
      update: { lastVehicleDataAt: new Date() },
      create: { vehicleId: vehicle.id, lastVehicleDataAt: new Date() },
    });
  }
  try {
    const ctx = await buildContext(account);
    const provider = getProvider(account.provider);
    const result = await provider.fetchState(ctx, payload.providerVehicleId);
    const { ingestVehicleState } = await import('./ingest');
    await ingestVehicleState(
      vehicle,
      {
        ...(result.state as Record<string, unknown>),
        vehicleId: vehicle.id,
        provider: account.provider,
        providerVehicleId: payload.providerVehicleId,
        fetchedAt: new Date().toISOString(),
      } as never,
      { live: result.live },
    );
    poller.recordSuccess(account.id);
    await prisma.providerAccount.update({
      where: { id: account.id },
      data: { lastSyncAt: new Date(), lastError: null },
    });
    const st = (result.state as { status?: string }) ?? {};
    const connectivity =
      st.status === 'asleep'
        ? 'asleep'
        : st.status === 'offline'
          ? 'offline'
          : st.status === 'unknown' || !st.status
            ? 'unknown'
            : 'online';
    const plan = planNextPoll(
      {
        connectivity,
        activity: ((st as Record<string, unknown>).activity ?? st) as Record<string, unknown>,
        lastVehicleDataAt: Date.now(),
        lastActivityAt: Date.now(),
        pendingCommandUntil: null,
        userActiveUntil: null,
        suspendedUntil: null,
        backoffUntil: null,
        now: Date.now(),
      },
      DEFAULT_TUNING,
    );
    await prisma.vehiclePollState.upsert({
      where: { vehicleId: vehicle.id },
      update: {
        connectivity,
        nextPollAt: new Date(plan.nextAt),
        nextAction: plan.action,
        mode: plan.mode,
      },
      create: {
        vehicleId: vehicle.id,
        connectivity,
        nextPollAt: new Date(plan.nextAt),
        nextAction: plan.action,
        mode: plan.mode,
      },
    });
  } catch (err) {
    const msg = (err as Error).message;
    if (msg === 'vehicle_asleep') {
      // Mark last-known without an error.
      const snap = vehicle.snapshot?.state as { freshness?: string } | null;
      if (snap) {
        await prisma.vehicleSnapshot.update({
          where: { vehicleId: vehicle.id },
          data: { freshness: 'stale', state: { ...snap, freshness: 'stale', status: 'asleep' } },
        });
      }
      return;
    }
    poller.recordFailure(account.id, msg);
  }
}
