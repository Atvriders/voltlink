// scripts/healthcheck-probe.test.ts — I-HEALTH: the worker/scheduler
// healthcheck must check the role's REAL heartbeat (workerBeat/schedulerBeat
// recorded by the roles for /admin/health) with a freshness bound, and must
// fail when REDIS_URL is missing. The probe logic lives in
// scripts/healthcheck-probe.mjs, which docker/healthcheck.sh runs for the
// worker/scheduler roles.
import { describe, expect, it } from 'vitest';
import { BEAT_BOUNDS, beatFresh, beatValueMs, configProblems } from './healthcheck-probe.mjs';

describe('healthcheck probe (I-HEALTH)', () => {
  it('bounds worker beats to 90 s', () => {
    // One clock read per assertion: two Date.now() calls drift by a millisecond
    // or two under load, which is enough to push the 89_999 case past the
    // bound and fail this test at random.
    const now = Date.now();
    expect(BEAT_BOUNDS.worker).toBe(90_000);
    expect(beatFresh('worker', String(now), now)).toBe(true);
    expect(beatFresh('worker', String(now - 89_999), now)).toBe(true);
    expect(beatFresh('worker', String(now - 90_001), now)).toBe(false);
  });

  it('bounds scheduler beats to 5 minutes', () => {
    const now = Date.now();
    expect(BEAT_BOUNDS.scheduler).toBe(5 * 60_000);
    expect(beatFresh('scheduler', String(now - 4 * 60_000), now)).toBe(true);
    expect(beatFresh('scheduler', String(now - 5 * 60_000 - 1), now)).toBe(false);
  });

  it('accepts epoch-ms and ISO strings, rejects missing or future beats', () => {
    const now = Date.now();
    expect(beatValueMs('1750000000000')).toBe(1750000000000);
    expect(beatValueMs(new Date(1750000000000).toISOString())).toBe(1750000000000);
    expect(beatFresh('worker', '', now)).toBe(false);
    expect(beatFresh('worker', 'not-a-date', now)).toBe(false);
    expect(beatFresh('worker', String(now + 10_000), now)).toBe(false);
  });

  it('fails when REDIS_URL is missing', () => {
    const problems = configProblems({ role: 'worker', redisUrl: '' });
    expect(problems).toContain('REDIS_URL is required');
    const sched = configProblems({ role: 'scheduler', redisUrl: undefined });
    expect(sched).toContain('REDIS_URL is required');
  });

  it('passes when REDIS_URL is set', () => {
    const problems = configProblems({ role: 'worker', redisUrl: 'redis://x:1' });
    expect(problems).toEqual([]);
  });
});
