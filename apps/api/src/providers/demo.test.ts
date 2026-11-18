// Demo provider: simulatedState is pure given a spec + clock. Sweep every
// demo vehicle across every hour (with sub-hour samples so frozen positions
// are visible) and cover the documented Rivermark offset (UTC-7) plus the
// scripted provider rejections.
import { describe, expect, it } from 'vitest';
import { DEMO_HOME, DEMO_VEHICLES, DEMO_WORK, DemoProvider, simulatedState } from './demo';
import type { ProviderContext } from './types';

// TI-47: ONE helper derives every test instant from the documented offset —
// Rivermark hour h == UTC hour (h + 7) mod 24.
const rivermark = (h: number, m = 0) => new Date(Date.UTC(2026, 4, 11, (h + 7) % 24, m));

describe('demo simulatedState', () => {
  it('uses fictional Rivermark coordinates, not real addresses', () => {
    expect(DEMO_HOME.lat).toBe(40.0);
    expect(DEMO_HOME.lon).toBe(-100.0);
    expect(DEMO_WORK.lat).toBe(40.02);
  });

  it('TI-46/TI-47: the Rivermark offset is UTC-7 (sub-hour samples, movement visible)', () => {
    // At Rivermark 02:00 (= UTC 09:00) the home vehicle is charging overnight;
    // at UTC 02:00 (= Rivermark 19:00, the sign-flipped instant) it is not.
    const home = DEMO_VEHICLES.find((v) => v.role === 'home')!;
    expect(simulatedState(home, rivermark(2)).chargingState).toBe('charging');
    expect(simulatedState(home, new Date('2026-05-11T02:00:00Z')).chargingState).not.toBe(
      'charging',
    );
  });

  it('produces a complete state at every hour and sub-hour sample', () => {
    for (const spec of DEMO_VEHICLES) {
      for (let h = 0; h < 24; h++) {
        for (const m of [0, 20, 59]) {
          const now = rivermark(h, m);
          const s = simulatedState(spec, now);
          expect(typeof s.lat).toBe('number');
          expect(typeof s.lon).toBe('number');
          expect(typeof s.batteryRangeKm).toBe('number');
          expect([
            'driving',
            'parked',
            'asleep',
            'charging',
            'offline',
            'unknown',
            'online',
          ]).toContain(s.status);
          expect(spec.role === 'offline' ? 'last_known' : 'live').toBe(s.freshness);
          expect(s.dataSource).toBe('telemetry');
        }
      }
    }
  });

  it('TI-46: driving vehicles MOVE between sub-hour samples (no frozen positions)', () => {
    const home = DEMO_VEHICLES.find((v) => v.role === 'home')!;
    const a = simulatedState(home, rivermark(7, 5)); // commute_morning
    const b = simulatedState(home, rivermark(7, 55));
    expect(a.status).toBe('driving');
    expect(b.status).toBe('driving');
    expect(`${a.lat},${a.lon}`).not.toBe(`${b.lat},${b.lon}`);
  });

  it('marks non-offline vehicles stale when degraded', () => {
    const now = new Date('2026-05-11T15:00:00Z');
    for (const spec of DEMO_VEHICLES) {
      const s = simulatedState(spec, now, true);
      if (spec.role === 'offline') {
        expect(s.freshness).toBe('last_known');
      } else {
        expect(s.freshness).toBe('stale');
        expect(s.dataSource).toBe('estimated');
      }
    }
  });

  it('home vehicle charges overnight and drives the commute', () => {
    const home = DEMO_VEHICLES.find((v) => v.role === 'home')!;
    const night = simulatedState(home, rivermark(2)); // 02:00 Rivermark
    expect(night.chargingState).toBe('charging');
    expect(night.plugConnected).toBe(true);
    const morning = simulatedState(home, rivermark(7, 30)); // 07:30 Rivermark
    expect(morning.status).toBe('driving');
    expect(morning.climateOn).toBe(true);
    expect(morning.speedKmh).toBeGreaterThanOrEqual(0);
  });

  it('driver vehicle loops and the charger reports charging', () => {
    const driver = DEMO_VEHICLES.find((v) => v.role === 'driver')!;
    const inLoop = simulatedState(driver, rivermark(11)); // 11:00 Rivermark
    expect(inLoop.status).toBe('driving');
    const charger = DEMO_VEHICLES.find((v) => v.role === 'charger')!;
    const charging = simulatedState(charger, rivermark(12));
    expect(charging.chargingState).toBe('charging');
    expect(charging.timeToFullChargeMin).toBeGreaterThanOrEqual(0);
  });
});

describe('demo scripted provider results', () => {
  const ctx: ProviderContext = {
    accountId: 'acct',
    userId: 'u1',
    credentials: {},
    meta: { provider: 'demo', label: 'demo', demo: true, scopes: [] },
  };

  it('TI-46: remote_start on Comet is scripted as rejected', async () => {
    const res = await new DemoProvider().sendCommand(ctx, 'demo-comet', 'remote_start', {});
    expect(res.kind).toBe('rejected');
  });

  it('TI-46: window_vent on Bison is scripted as timed_out', async () => {
    const res = await new DemoProvider().sendCommand(ctx, 'demo-bison', 'window_vent', {});
    expect(res.kind).toBe('timed_out');
  });

  it('TI-46: open_trunk on the offline Bison is scripted as rejected', async () => {
    const res = await new DemoProvider().sendCommand(ctx, 'demo-bison', 'open_trunk', {});
    expect(res.kind).toBe('rejected');
  });
});
