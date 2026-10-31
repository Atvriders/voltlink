import { describe, expect, it } from 'vitest';
import { computeFreshness } from './freshness';

const now = 1_800_000_000_000; // fixed epoch

describe('computeFreshness (F-FRESH)', () => {
  it('is live within the status limit when ingested live', () => {
    expect(
      computeFreshness(
        { status: 'online', fetchedAt: new Date(now - 60_000).toISOString(), liveAtIngest: true },
        now,
      ),
    ).toBe('live');
  });
  it('never shows live for a snapshot ingested stale', () => {
    expect(
      computeFreshness(
        { status: 'online', fetchedAt: new Date(now - 10_000).toISOString(), liveAtIngest: false },
        now,
      ),
    ).toBe('recent');
  });
  it('decays live → recent → stale → last_known', () => {
    expect(
      computeFreshness(
        { status: 'charging', fetchedAt: new Date(now - 125_000).toISOString() },
        now,
      ),
    ).toBe('recent');
    expect(
      computeFreshness(
        { status: 'charging', fetchedAt: new Date(now - 370_000).toISOString() },
        now,
      ),
    ).toBe('stale');
    expect(
      computeFreshness(
        { status: 'charging', fetchedAt: new Date(now - 1_450_000).toISOString() },
        now,
      ),
    ).toBe('last_known');
  });
  it('uses the longer asleep limit', () => {
    expect(
      computeFreshness({ status: 'asleep', fetchedAt: new Date(now - 600_000).toISOString() }, now),
    ).toBe('live');
  });
});
