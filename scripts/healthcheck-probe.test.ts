// scripts/healthcheck-probe.test.ts — I-HEALTH: the worker/scheduler
// healthcheck must check the role's REAL heartbeat (workerBeat/schedulerBeat
// recorded by the roles for /admin/health) with a freshness bound, and must
// fail when REDIS_URL is missing. The probe logic lives in
// scripts/healthcheck-probe.mjs, which docker/healthcheck.sh runs for the
// worker/scheduler roles.
import { describe, expect, it } from 'vitest';
import {
  BEAT_BOUNDS,
  beatFresh,
  beatValueMs,
  configProblems,
} from './healthcheck-probe.mjs';

describe('healthcheck probe (I-HEALTH)', () => {
  it('bounds worker beats to 90 s', () => {
    expect(BEAT_BOUNDS.worker).toBe(90_000);
    expect(beatFresh('worker', String(Date.now()), Date.now())).toBe(true);
    expect(beatFresh('worker', String(Date.now() - 89_999), Date.now())).toBe(true);
    expect(beatFresh('worker', String(Date.now() - 90_001), Date.now())).toBe(false);
  });

  it('bounds scheduler beats to 5 minutes', () => {
    expect(BEAT_BOUNDS.scheduler).toBe(5 * 60_000);
    expect(beatFresh('scheduler', String(Date.now() - 4 * 60_000), Date.now())).toBe(true);
    expect(beatFresh('scheduler', String(Date.now() - 5 * 60_000 - 1), Date.now())).toBe(false);
  });

  it('accepts epoch-ms and ISO strings, rejects missing or future beats', () => {
    expect(beatValueMs('1750000000000')).toBe(1750000000000);
    expect(beatValueMs(new Date(1750000000000).toISOString())).toBe(1750000000000);
    expect(beatFresh('worker', '', Date.now())).toBe(false);
    expect(beatFresh('worker', 'not-a-date', Date.now())).toBe(false);
    expect(beatFresh('worker', String(Date.now() + 10_000), Date.now())).toBe(false);
  });

  it('fails when REDIS_URL is missing', () => {
    const problems = configProblems({ role: 'worker', redisUrl: '', databaseUrl: 'x' });
    expect(problems).toContain('REDIS_URL is required');
    const sched = configProblems({ role: 'scheduler', redisUrl: undefined, databaseUrl: 'x' });
    expect(sched).toContain('REDIS_URL is required');
  });

  it('passes when REDIS_URL is set', () => {
    const problems = configProblems({ role: 'worker', redisUrl: 'redis://x:1', databaseUrl: 'x' });
    expect(problems).toEqual([]);
  });
});
