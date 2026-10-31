// Tessie adapter contract tests against a local fake (guide 02 §14, Gate 6).

process.env.NODE_ENV = 'test';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { TessieProvider } from '../src/providers/tessie';
import { mapTeslaVehicleData } from '../src/providers/teslaShape';
import type { ProviderContext } from '../src/providers/types';

let server: Server;
let base = '';

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  const state: Record<string, unknown> = {
    state: 'awake',
    charge_state: {
      charging_state: 'Charging',
      battery_level: 42,
      battery_range: 200.5,
      charge_limit_soc: 90,
      charger_power: 11,
      charger_actual_current: 32,
      charge_current_request: 32,
      charge_current_request_max: 48,
      charge_port_door_open: true,
      minutes_to_full_charge: 95,
      timestamp: 1700000000000,
    },
    climate_state: {
      is_climate_on: true,
      inside_temp: 22.5,
      outside_temp: 14,
      timestamp: 1700000000000,
    },
    drive_state: {
      shift_state: 'P',
      latitude: 37.77,
      longitude: -122.41,
      timestamp: 1700000000000,
    },
    vehicle_state: {
      locked: true,
      df: 0,
      pf: 0,
      dr: 0,
      pr: 0,
      ft: 0,
      rt: 0,
      odometer: 5000,
      sentry_mode: false,
      sentry_mode_available: true,
      speed_limit_mode: { active: false, current_limit_mph: 85 },
      car_version: '2025.44.1 xyz',
      software_update: { status: 'available' },
      timestamp: 1700000000000,
    },
    vehicle_config: {
      car_type: 'model3',
      rhd: false,
      can_actuate_trunks: true,
      motorized_charge_port: true,
      can_accept_navigation_requests: true,
    },
    display_name: 'Tessie Test Car',
  };
  app.get('/:vin/state', (_req, res) => res.json(state));
  app.get('/vins', (_req, res) => res.json({ results: ['5YJ3000000NEXUS02'] }));
  app.post('/:vin/wake', (_req, res) => res.json({ result: true }));
  app.post('/:vin/command/:name', (req, res) => {
    if (req.params.name === 'lock') return res.json({ result: true });
    if (req.params.name === 'set_charging_amps')
      return res.json({ result: false, reason: 'no cable' });
    return res.json({ result: true });
  });
  server = app.listen(0, () => {
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  await new Promise<void>((r) => server.once('listening', r));
  process.env.TESSIE_BASE_URL = base;
  process.env.TESSIE_API_KEY = 'test-key';
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

const ctx: ProviderContext = {
  accountId: 'fake',
  userId: 'u1',
  credentials: { token: 'test-token' },
  meta: { provider: 'tessie', label: 'Tessie', demo: false, scopes: [] },
};

describe('Tessie mapping (P-TESSIE)', () => {
  it('maps the documented state schema', () => {
    const out = mapTeslaVehicleData(
      {
        state: 'awake',
        charge_state: {
          charging_state: 'Charging',
          battery_level: 42,
          battery_range: 200.5,
          charge_limit_soc: 90,
          charge_current_request: 32,
          timestamp: 1700000000000,
        },
        drive_state: { shift_state: 'P', timestamp: 1700000000000 },
        vehicle_state: { locked: true, timestamp: 1700000000000 },
      },
      {},
    );
    expect(out.chargingState).toBe('charging');
    expect(out.status).toBe('charging');
    expect(out.batteryPercent).toBe(42);
    expect(out.batteryRangeKm).toBeCloseTo(322.7, 1);
    expect(out.chargeAmpsRequest).toBe(32);
  });

  it('maps Charging → charging and computes km from miles', () => {
    const out = mapTeslaVehicleData(
      {
        vehicle_state: { odometer: 10, timestamp: 1 },
        drive_state: { shift_state: 'D', speed: 60, timestamp: 1 },
      },
      {},
    );
    expect(out.speedKmh).toBeCloseTo(96.6, 1);
    expect(out.status).toBe('driving');
  });
});

describe('Tessie provider commands + readiness (NEW-08)', () => {
  it('accepts lock and rejects set_charging_amps with the friendly reason', async () => {
    const p = new TessieProvider();
    const lock = await p.sendCommand(ctx, '5YJ3000000NEXUS02', 'lock', {});
    expect(lock.kind).toBe('accepted');
    const amps = await p.sendCommand(ctx, '5YJ3000000NEXUS02', 'set_charging_amps', {
      chargingAmps: 48,
    });
    expect(amps.kind).toBe('rejected');
    expect(amps.errorMessage).toContain('No charge cable');
  });

  it('reports readiness from real checks, never hard-coded', async () => {
    const p = new TessieProvider();
    const r = await p.readiness();
    expect(r.checks.some((c) => c.name.includes('Token verification'))).toBe(true);
    // With TESSIE_BASE_URL pointed at the fake, token verification passes.
    const verify = r.checks.find((c) => c.name === 'Token verification');
    expect(verify?.ok).toBe(true);
  });

  it('lists vehicles with VIN-derived fields and hardware capabilities', async () => {
    const p = new TessieProvider();
    const list = await p.listVehicles(ctx);
    expect(list).toHaveLength(1);
    expect(list[0]!.providerVehicleId).toBe('5YJ3000000NEXUS02');
    expect(list[0]!.model).toBe('Model 3');
    expect(list[0]!.capabilities).toContain('open_trunk');
    expect(list[0]!.capabilities).toContain('set_charging_amps');
  });
});
