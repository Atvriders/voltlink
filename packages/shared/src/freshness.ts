// Freshness decay (guide 07 §2.7, F-FRESH): thresholds mirror the ingest side,
// and the client recomputes the label between refetches so "Live" ages visibly.

import type { Freshness, VehicleStatus } from './vehicles';

export const FRESH_LIMIT_SEC: Record<VehicleStatus, number> = {
  online: 120,
  charging: 120,
  driving: 120,
  asleep: 900,
  offline: 600,
  parked: 600,
  unknown: 600,
};

export function computeFreshness(
  s: { status?: VehicleStatus; fetchedAt?: string; liveAtIngest?: boolean },
  nowMs: number,
): Freshness {
  const fetched = s.fetchedAt ? Date.parse(s.fetchedAt) : NaN;
  const age = Number.isFinite(fetched) ? Math.max(0, (nowMs - fetched) / 1000) : Infinity;
  const limit = FRESH_LIMIT_SEC[s.status ?? 'unknown'] ?? 600;
  if (age <= limit && s.liveAtIngest !== false) return 'live';
  if (age <= limit * 3) return 'recent';
  if (age <= limit * 12) return 'stale';
  return 'last_known';
}
