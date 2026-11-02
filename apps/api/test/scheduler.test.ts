// test/scheduler.test.ts — polling planner decisions (guide 08 §7 scheduler
// minimum): sleep-aware planning, activity-driven urgency, backoff.
import { describe, expect, it } from 'vitest';
import { planNextPoll, DEFAULT_TUNING } from '../src/telemetry/teslaPollPlanner';

const base = {
  connectivity: 'online',
  activity: {},
  lastVehicleDataAt: Date.now() - 60_000,
  lastActivityAt: Date.now() - 120_000,
  pendingCommandUntil: null,
  userActiveUntil: null,
  suspendedUntil: null,
  backoffUntil: null,
  now: Date.now(),
};

describe('scheduler polling plan', () => {
  it('only plans free state checks for a suspended vehicle', () => {
    const plan = planNextPoll(
      { ...base, suspendedUntil: Date.now() + 60_000 },
      DEFAULT_TUNING,
    );
    expect(plan.action).toBe('state');
    expect(plan.mode).toBe('suspended');
  });

  it('honours provider backoff', () => {
    const plan = planNextPoll(
      { ...base, backoffUntil: Date.now() + 60_000 },
      DEFAULT_TUNING,
    );
    expect(plan.action).toBe('none');
  });

  it('plans a vehicle_data fetch for an online idle vehicle', () => {
    const plan = planNextPoll(base, DEFAULT_TUNING);
    expect(plan.action).toBe('vehicle_data');
    expect(plan.nextAt).toBeGreaterThan(base.now);
  });

  it('polls driving vehicles sooner than idle ones', () => {
    const driving = planNextPoll(
      { ...base, activity: { shift_state: 'D', speedKmh: 40 } },
      DEFAULT_TUNING,
    );
    const idle = planNextPoll(base, DEFAULT_TUNING);
    expect(driving.mode).toBe('driving');
    expect(idle.nextAt).toBeGreaterThan(driving.nextAt);
  });
});
