// Demo provider: simulatedState is pure given a spec + clock. Sweep every
// demo vehicle across every hour so all schedule branches (home charge,
// commutes, work, sleep, active, loop driving, charger, office, offline)
// execute deterministically.
import { describe, expect, it } from 'vitest';
import { DEMO_VEHICLES, simulatedState } from './demo';

describe('demo simulatedState', () => {
  it('produces a complete state for every demo vehicle at every hour', () => {
    for (const spec of DEMO_VEHICLES) {
      for (let h = 0; h < 24; h++) {
        const now = new Date(Date.UTC(2026, 4, 11, h + 7, 0, 0)); // Rivermark hour h = UTC h+7
        const s = simulatedState(spec, now);
        expect(s.providerVehicleId).toBe(spec.id);
        expect(typeof s.lat).toBe('number');
        expect(typeof s.lon).toBe('number');
        expect(typeof s.batteryRangeKm).toBe('number');
        expect(['driving', 'parked', 'asleep', 'charging', 'offline', 'unknown', 'online']).toContain(
          s.status,
        );
        expect(spec.role === 'offline' ? 'last_known' : 'live').toBe(s.freshness);
        expect(s.dataSource).toBe('telemetry');
      }
    }
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
    const night = simulatedState(home, new Date('2026-05-10T19:00:00Z')); // 02:00 Rivermark
    expect(night.chargingState).toBe('charging');
    expect(night.plugConnected).toBe(true);
    const morning = simulatedState(home, new Date('2026-05-11T00:30:00Z')); // 7:30 Rivermark
    expect(morning.status).toBe('driving');
    expect(morning.climateOn).toBe(true);
    expect(morning.speedKmh).toBeGreaterThanOrEqual(0);
  });

  it('driver vehicle loops and the charger reports charging', () => {
    const driver = DEMO_VEHICLES.find((v) => v.role === 'driver')!;
    const inLoop = simulatedState(driver, new Date('2026-05-11T04:00:00Z')); // 11:00 Rivermark
    expect(inLoop.status).toBe('driving');
    const charger = DEMO_VEHICLES.find((v) => v.role === 'charger')!;
    const charging = simulatedState(charger, new Date('2026-05-11T12:00:00Z'));
    expect(charging.chargingState).toBe('charging');
    expect(charging.timeToFullChargeMin).toBeGreaterThanOrEqual(0);
  });
});
