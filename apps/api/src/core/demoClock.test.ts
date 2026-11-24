import { afterEach, describe, expect, it, vi } from 'vitest';
import { assertDemoClockEnv, demoClockNow } from './demoClock';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('demoClock (guide 08 §11.1)', () => {
  it('honours VL_TEST_FROZEN_NOW only when NODE_ENV=test', () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('VL_TEST_FROZEN_NOW', '2026-06-15T15:30:00Z');
    expect(demoClockNow().toISOString()).toBe('2026-06-15T15:30:00.000Z');
  });

  it('returns the wall clock when the switch is absent', () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('VL_TEST_FROZEN_NOW', '');
    const before = Date.now() - 1000;
    const now = demoClockNow().getTime();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('a malformed frozen value fails hard in test', () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('VL_TEST_FROZEN_NOW', 'not-a-date');
    expect(() => demoClockNow()).toThrow(/VL_TEST_FROZEN_NOW must be a valid date/);
  });

  it('a production boot with the test-only switch fails hard', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('VL_TEST_FROZEN_NOW', '2026-06-15T15:30:00Z');
    expect(() => assertDemoClockEnv()).toThrow(/test-only/);
    expect(() => demoClockNow()).toThrow(/must not be set in production/);
  });

  it('production without the switch boots normally', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('VL_TEST_FROZEN_NOW', '');
    expect(() => assertDemoClockEnv()).not.toThrow();
  });
});
