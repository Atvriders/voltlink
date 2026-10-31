// Sleep-aware poll planner (P-SLEEP, guide 01 §11): a pure function that
// decides the next action and time from VehiclePollState + the last snapshot.

export interface PlannerInput {
  connectivity: string; // unknown | online | asleep | offline
  activity: Record<string, unknown> | null;
  lastVehicleDataAt: number | null;
  lastActivityAt: number | null;
  pendingCommandUntil: number | null;
  userActiveUntil: number | null;
  suspendedUntil: number | null;
  backoffUntil: number | null;
  now: number;
}

export interface PlannerOutput {
  action: 'none' | 'state' | 'vehicle_data';
  nextAt: number;
  mode: string;
  jitterSec: number;
}

export interface PollTuning {
  asleepSec: number;
  offlineSec: number;
  pendingSec: number;
  drivingSec: number;
  chargingSec: number;
  sentrySec: number;
  idleSec: number;
  viewingSec: number;
  idleSleepWindowMin: number;
  suspendMin: number;
}

export const DEFAULT_TUNING: PollTuning = {
  asleepSec: 120,
  offlineSec: 300,
  pendingSec: 15,
  drivingSec: 60,
  chargingSec: 180,
  sentrySec: 1800,
  idleSec: 300,
  viewingSec: 60,
  idleSleepWindowMin: 15,
  suspendMin: 21,
};

function jitter(sec: number): number {
  return sec + Math.round(sec * 0.1 * (Math.random() * 2 - 1));
}

export function planNextPoll(input: PlannerInput, tuning: PollTuning = DEFAULT_TUNING): PlannerOutput {
  const { now } = input;
  const out = (action: PlannerOutput['action'], nextAt: number, mode: string, jitterSec = 0): PlannerOutput => ({
    action,
    nextAt,
    mode,
    jitterSec,
  });
  if (input.backoffUntil && now < input.backoffUntil) return out('none', input.backoffUntil, 'backoff');
  if (input.connectivity === 'asleep') return out('state', now + jitter(tuning.asleepSec), 'asleep');
  if (input.connectivity === 'offline' || input.connectivity === 'unknown') {
    return out('state', now + jitter(tuning.offlineSec), input.connectivity);
  }
  if (input.pendingCommandUntil && now < input.pendingCommandUntil) {
    return out('vehicle_data', now + jitter(tuning.pendingSec), 'pending_command');
  }
  const activity = input.activity ?? {};
  if (!input.lastActivityAt) return out('vehicle_data', now, 'first_fetch');
  if (input.suspendedUntil && now < input.suspendedUntil) {
    return out('state', now + jitter(tuning.asleepSec), 'suspended');
  }
  if (input.suspendedUntil && now >= input.suspendedUntil) {
    // One vehicle_data re-check after a suspension, then clear it.
    return out('vehicle_data', now, 'suspend_recheck');
  }
  if (activity.shift_state === 'D' || activity.shift_state === 'R' || activity.shift_state === 'N' || Number(activity.speedKmh ?? 0) > 0) {
    return out('vehicle_data', now + jitter(tuning.drivingSec), 'driving');
  }
  if (activity.chargingState === 'Charging' || activity.chargingState === 'Starting') {
    return out('vehicle_data', now + jitter(tuning.chargingSec), 'charging');
  }
  if (activity.sentryMode === true) return out('vehicle_data', now + jitter(tuning.sentrySec), 'sentry');
  const idleFor = (now - input.lastActivityAt) / 60_000;
  if (idleFor >= tuning.idleSleepWindowMin) {
    return out('state', now + jitter(60), 'sleeping_window'); // keep state checks; suspend after re-check
  }
  if (input.userActiveUntil && now < input.userActiveUntil) {
    return out('vehicle_data', now + jitter(tuning.viewingSec), 'viewing');
  }
  return out('vehicle_data', now + jitter(tuning.idleSec), 'idle');
}
