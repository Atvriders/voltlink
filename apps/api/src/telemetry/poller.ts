// Provider polling scheduler: sleep-aware, jittered, rate-limited, and
// backoff-aware. Runs in the scheduler process; never ties ingestion to a
// browser session.

import { prisma } from '../core/db';
import { getQueue } from '../core/queue';
import { getProvider } from '../providers/registry';
import { buildContext } from '../providers/registry';
import { seededRng, hashString } from '../providers/types';

const TICK_MS = 45_000;
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
    const now = Date.now();
    const accounts = await prisma.providerAccount.findMany({
      where: { status: { not: 'revoked' } },
      include: {
        vehicles: {
          where: { active: true },
          select: { id: true, providerVehicleId: true, snapshot: true, demo: true },
        },
      },
    });
    let planned = 0;
    for (const account of accounts) {
      // Backoff after provider failures.
      const fail = this.failures.get(account.id);
      if (fail && now < fail.until) continue;

      // Per-account rate limiting (1 fetch ~ 1s of provider quota).
      const bucket = (this.lastFetches.get(account.id) ?? []).filter((t) => now - t < 60_000);
      if (bucket.length >= MAX_FETCHES_PER_ACCOUNT_PER_MINUTE) continue;

      const vehicles = account.vehicles.filter((v) => this.needsPolling(v, now));
      if (vehicles.length === 0) continue;

      const chosen = vehicles.slice(
        0,
        Math.max(1, MAX_FETCHES_PER_ACCOUNT_PER_MINUTE - bucket.length),
      );
      for (const v of chosen) {
        planned++;
        bucket.push(now);
        await getQueue().enqueue(
          'telemetry',
          { accountId: account.id, vehicleId: v.id, providerVehicleId: v.providerVehicleId },
          { dedupeKey: `poll:${v.id}:${Math.floor(now / 30_000)}` },
        );
      }
      this.lastFetches.set(account.id, bucket);
    }
    return planned;
  }

  /** Sleep-aware polling decisions. */
  private needsPolling(
    vehicle: {
      id: string;
      snapshot: { fetchedAt: Date; state: unknown; freshness: string } | null;
      demo: boolean;
    },
    now: number,
  ): boolean {
    // Always poll when a command is pending for this vehicle.
    if ((this.pendingCommands.get(vehicle.id) ?? 0) > 0) return true;

    const snap = vehicle.snapshot;
    if (!snap) return true; // first fetch
    const state = (snap.state ?? {}) as { status?: string };
    const ageSec = (now - snap.fetchedAt.getTime()) / 1000;

    if (state.status === 'asleep') return ageSec > 25 * 60; // don't wake sleeping vehicles
    if (state.status === 'offline' || state.status === 'unknown') return ageSec > 12 * 60;
    if (state.status === 'driving' || state.status === 'charging') return ageSec > 60;
    return ageSec > 5 * 60; // online but idle
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

  recordSuccess(accountId: string): void {
    this.failures.delete(accountId);
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
}): Promise<void> {
  const vehicle = await prisma.vehicle.findUnique({
    where: { id: payload.vehicleId },
    include: { providerAccount: true, snapshot: true },
  });
  if (!vehicle) return;
  const account = vehicle.providerAccount;
  if (account.status === 'revoked') return;
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
