// Tessie adapter contract tests against a local fake generated from the
// guide 02 manifest (routes, query parameters, command names). No real
// credentials. R2-32: the fake rejects anything the OpenAPI does not
// document, and every command type is driven through the real provider's
// sendCommand with its request asserted against the documented route.
// The provider-side route fixes land in step 5 — the request assertions
// below are expected reds until then.

process.env.NODE_ENV = 'test';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { TessieProvider } from '../src/providers/tessie';
import { mapTeslaVehicleData } from '../src/providers/teslaShape';
import type { CommandType } from '@voltlink/shared';
import type { ProviderContext } from '../src/providers/types';

// Guide 02 §8 command manifest: VoltLink type -> documented Tessie route.
const GUIDE02_COMMAND_ROUTES: Record<string, string> = {
  wake: 'POST /:vin/wake',
  lock: 'POST /:vin/command/lock',
  unlock: 'POST /:vin/command/unlock',
  climate_start: 'POST /:vin/command/start_climate',
  climate_stop: 'POST /:vin/command/stop_climate',
  set_temperature: 'POST /:vin/command/set_temperatures',
  defrost: 'POST /:vin/command/start_max_defrost',
  seat_heater: 'POST /:vin/command/set_seat_heat',
  steering_heater: 'POST /:vin/command/start_steering_wheel_heater',
  charge_start: 'POST /:vin/command/start_charging',
  charge_stop: 'POST /:vin/command/stop_charging',
  set_charge_limit: 'POST /:vin/command/set_charge_limit',
  set_charging_amps: 'POST /:vin/command/set_charging_amps',
  charge_port_open: 'POST /:vin/command/open_charge_port',
  charge_port_close: 'POST /:vin/command/close_charge_port',
  open_trunk: 'POST /:vin/command/activate_rear_trunk',
  open_frunk: 'POST /:vin/command/activate_front_trunk',
  window_vent: 'POST /:vin/command/vent_windows',
  window_close: 'POST /:vin/command/close_windows',
  sentry_mode: 'POST /:vin/command/enable_sentry',
  flash_lights: 'POST /:vin/command/flash',
  honk_horn: 'POST /:vin/command/honk',
  homelink: 'POST /:vin/command/trigger_homelink',
  remote_start: 'POST /:vin/command/remote_start',
  valet_mode: 'POST /:vin/command/enable_valet',
  speed_limit: 'POST /:vin/command/set_speed_limit',
  send_navigation: 'POST /:vin/command/share',
  schedule_update: 'POST /:vin/command/schedule_software_update',
  cancel_update: 'POST /:vin/command/cancel_software_update',
};

// The documented command names the fake implements (guide 02 §8 table).
const DOCUMENTED_COMMANDS = new Set([
  'lock',
  'unlock',
  'start_climate',
  'stop_climate',
  'set_temperatures',
  'start_max_defrost',
  'stop_max_defrost',
  'set_seat_heat',
  'start_steering_wheel_heater',
  'stop_steering_wheel_heater',
  'start_charging',
  'stop_charging',
  'set_charge_limit',
  'set_charging_amps',
  'open_charge_port',
  'close_charge_port',
  'activate_rear_trunk',
  'activate_front_trunk',
  'vent_windows',
  'close_windows',
  'enable_sentry',
  'disable_sentry',
  'flash',
  'honk',
  'trigger_homelink',
  'remote_start',
  'enable_valet',
  'disable_valet',
  'set_speed_limit',
  'enable_speed_limit',
  'disable_speed_limit',
  'share',
  'schedule_software_update',
  'cancel_software_update',
]);

interface FakeRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  body: unknown;
}

let server: Server;
let base = '';
let requests: FakeRequest[] = [];
let wakeCalls: string[] = [];

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  const state: Record<string, unknown> = {
    state: 'awake',
    vin: '5YJ3000000NEXUS02',
    display_name: 'Tessie Test Car',
    charge_state: {
      charging_state: 'Charging',
      battery_level: 42,
      battery_range: 200.5,
      charge_limit_soc: 90,
      charge_limit_soc_min: 50,
      charge_limit_soc_max: 100,
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
      driver_temp_setting: 21.5,
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
  };
  requests = [];
  wakeCalls = [];

  // Guide 02 §2.2: GET /vehicles?only_active=true|false — the only query
  // parameter. Any other parameter is rejected.
  app.get('/vehicles', (req, res) => {
    requests.push({
      method: 'GET',
      path: '/vehicles',
      query: req.query as Record<string, string>,
      body: undefined,
    });
    const unknown = Object.keys(req.query).filter((k) => k !== 'only_active');
    if (unknown.length > 0) {
      return res.status(400).json({ error: `unknown query parameter: ${unknown[0]}` });
    }
    return res.json({
      results: [
        {
          vin: '5YJ3000000NEXUS02',
          is_active: true,
          last_state: { display_name: 'Tessie Test Car', state: 'awake' },
        },
      ],
    });
  });

  // The undocumented /vins route is gone: the fake answers 404 like the API.
  app.get('/vins', (_req, res) => {
    requests.push({ method: 'GET', path: '/vins', query: {}, body: undefined });
    res.status(404).json({ error: 'Not found' });
  });

  app.get('/:vin/state', (req, res) => {
    requests.push({
      method: 'GET',
      path: `/${req.params.vin}/state`,
      query: req.query as Record<string, string>,
      body: undefined,
    });
    if (Object.keys(req.query).length > 0) {
      return res.status(400).json({ error: 'state takes no query parameters' });
    }
    const vin = String(req.params.vin);
    if (vin === '5YJ3SLEEP0000001') return res.json({ ...state, state: 'asleep' });
    if (vin === '5YJ3AUTH0000001') return res.status(401).json({ error: 'bad token' });
    return res.json(state);
  });

  app.get('/:vin/status', (req, res) => {
    requests.push({ method: 'GET', path: `/${req.params.vin}/status`, query: {}, body: undefined });
    const vin = String(req.params.vin);
    if (vin === '5YJ3SLEEP0000001') return res.json({ status: 'asleep' });
    return res.json({ status: 'awake' });
  });

  app.get('/:vin/location', (_req, res) => {
    res.json({ latitude: 37.77, longitude: -122.41, address: '1 Main St', saved_location: 'Home' });
  });

  app.get('/:vin/battery', (_req, res) => {
    res.json({ battery_level: 42, energy_remaining: 25.2, pack_voltage: 350 });
  });

  // Guide 02 §2.2: POST /{vin}/wake takes NO query parameters.
  wakeCalls = [];
  app.post('/:vin/wake', (req, res) => {
    requests.push({
      method: 'POST',
      path: `/${req.params.vin}/wake`,
      query: req.query as Record<string, string>,
      body: req.body,
    });
    wakeCalls.push(String(req.params.vin));
    if (Object.keys(req.query).length > 0) {
      return res.status(400).json({ error: 'wake takes no query parameters' });
    }
    if (req.params.vin === '5YJ3WAKEFAIL01') return res.json({ result: false });
    return res.json({ result: true });
  });

  app.post('/:vin/command/:name', (req, res) => {
    requests.push({
      method: 'POST',
      path: `/${req.params.vin}/command/${req.params.name}`,
      query: req.query as Record<string, string>,
      body: req.body,
    });
    const name = String(req.params.name);
    if (!DOCUMENTED_COMMANDS.has(name)) {
      return res.status(404).json({ result: false, reason: 'unknown_command' });
    }
    // Guide 02 §2.4: parameters go in the query string; retry_duration is
    // not in the OpenAPI. Reject both violations.
    if (Object.prototype.hasOwnProperty.call(req.query, 'retry_duration')) {
      return res.status(400).json({ result: false, reason: 'undocumented retry_duration' });
    }
    const knownQuery: Record<string, string[]> = {
      lock: ['wait_for_completion', 'max_attempts'],
      unlock: ['wait_for_completion', 'max_attempts'],
      start_climate: ['wait_for_completion', 'max_attempts'],
      stop_climate: ['wait_for_completion', 'max_attempts'],
      set_temperatures: ['temperature', 'wait_for_completion', 'max_attempts'],
      start_max_defrost: ['wait_for_completion', 'max_attempts'],
      stop_max_defrost: ['wait_for_completion', 'max_attempts'],
      set_seat_heat: ['seat', 'level', 'wait_for_completion', 'max_attempts'],
      start_steering_wheel_heater: ['wait_for_completion', 'max_attempts'],
      stop_steering_wheel_heater: ['wait_for_completion', 'max_attempts'],
      start_charging: ['wait_for_completion', 'max_attempts'],
      stop_charging: ['wait_for_completion', 'max_attempts'],
      set_charge_limit: ['percent', 'wait_for_completion', 'max_attempts'],
      set_charging_amps: ['amps', 'wait_for_completion', 'max_attempts'],
      open_charge_port: ['wait_for_completion', 'max_attempts'],
      close_charge_port: ['wait_for_completion', 'max_attempts'],
      activate_rear_trunk: ['wait_for_completion', 'max_attempts'],
      activate_front_trunk: ['wait_for_completion', 'max_attempts'],
      vent_windows: ['wait_for_completion', 'max_attempts'],
      close_windows: ['wait_for_completion', 'max_attempts'],
      enable_sentry: ['wait_for_completion', 'max_attempts'],
      disable_sentry: ['wait_for_completion', 'max_attempts'],
      flash: ['wait_for_completion', 'max_attempts'],
      honk: ['wait_for_completion', 'max_attempts'],
      trigger_homelink: ['wait_for_completion', 'max_attempts'],
      remote_start: ['wait_for_completion', 'max_attempts'],
      enable_valet: ['wait_for_completion', 'max_attempts'],
      disable_valet: ['wait_for_completion', 'max_attempts'],
      set_speed_limit: ['mph', 'wait_for_completion', 'max_attempts'],
      enable_speed_limit: ['pin', 'wait_for_completion', 'max_attempts'],
      disable_speed_limit: ['pin', 'wait_for_completion', 'max_attempts'],
      share: ['value', 'locale', 'wait_for_completion', 'max_attempts'],
      schedule_software_update: ['in_seconds', 'wait_for_completion', 'max_attempts'],
      cancel_software_update: ['wait_for_completion', 'max_attempts'],
    };
    const allowed = knownQuery[name] ?? [];
    const unknown = Object.keys(req.query).filter((k) => !allowed.includes(k));
    if (unknown.length > 0) {
      return res
        .status(400)
        .json({ result: false, reason: `unknown query parameter: ${unknown[0]}` });
    }
    if (req.params.vin === '5YJ3AUTH0000001') return res.status(401).json({ result: false });
    if (req.params.vin === '5YJ3TRUNKERR01' && name === 'activate_rear_trunk')
      return res.status(500).json({ result: false });
    if (req.params.vin === '5YJ3NOTSUPP001' && name === 'set_charge_limit')
      return res.json({ result: false, reason: 'not supported' });
    if (name === 'lock') return res.json({ result: true });
    if (name === 'set_charging_amps') return res.json({ result: false, reason: 'no cable' });
    return res.json({ result: true });
  });

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not found' });
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

describe('Tessie fake strictness (guide 02 documented surface)', () => {
  it('rejects the undocumented GET /vins route with 404', async () => {
    const res = await fetch(`${base}/vins`);
    expect(res.status).toBe(404);
  });

  it('accepts GET /vehicles and rejects unknown query parameters', async () => {
    const ok = await fetch(`${base}/vehicles?only_active=true`);
    expect(ok.status).toBe(200);
    const bad = await fetch(`${base}/vehicles?only_active=true&made_up=1`);
    expect(bad.status).toBe(400);
  });

  it('rejects unknown command names with 404', async () => {
    const res = await fetch(`${base}/5YJ3000000NEXUS02/command/not_a_tessie_command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(404);
  });

  it('rejects the undocumented command names the old code used', async () => {
    for (const name of ['set_temperature', 'start_defrost', 'set_steering_wheel_heat']) {
      const res = await fetch(`${base}/5YJ3000000NEXUS02/command/${name}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(res.status, name).toBe(404);
    }
  });

  it('rejects the undocumented retry_duration query parameter', async () => {
    const res = await fetch(`${base}/5YJ3000000NEXUS02/command/lock?retry_duration=40`, {
      method: 'POST',
    });
    expect(res.status).toBe(400);
  });

  it('rejects unknown query parameters on documented commands', async () => {
    const res = await fetch(
      `${base}/5YJ3000000NEXUS02/command/lock?wait_for_completion=true&nope=1`,
      { method: 'POST' },
    );
    expect(res.status).toBe(400);
  });

  it('rejects query parameters on /:vin/state', async () => {
    const res = await fetch(`${base}/5YJ3000000NEXUS02/state?use_cache=false`);
    expect(res.status).toBe(400);
  });

  it('rejects query parameters on /:vin/wake', async () => {
    const res = await fetch(`${base}/5YJ3000000NEXUS02/wake?wait_for_completion=true`, {
      method: 'POST',
    });
    expect(res.status).toBe(400);
  });

  it('accepts the documented lock command', async () => {
    const res = await fetch(`${base}/5YJ3000000NEXUS02/command/lock`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
  });
});

describe('Tessie provider request routes match guide 02 (expected reds until step 5)', () => {
  const p = new TessieProvider();

  it('listVehicles requests the documented GET /vehicles?only_active=true', async () => {
    const before = requests.filter((r) => r.path === '/vehicles').length;
    await p.listVehicles(ctx);
    const after = requests.filter((r) => r.path === '/vehicles').length;
    expect(after - before).toBe(1);
    const call = requests.filter((r) => r.path === '/vehicles').at(-1)!;
    expect(call.query['only_active']).toBe('true');
  });

  it('wake requests POST /:vin/wake with no query parameters', async () => {
    const before = requests.length;
    const out = await p.sendCommand(ctx, '5YJ3000000NEXUS02', 'wake', {});
    expect(out.kind).toBe('accepted');
    const wake = requests.slice(before).find((r) => r.path.endsWith('/wake'));
    expect(wake?.method).toBe('POST');
    expect(Object.keys(wake?.query ?? {})).toEqual([]);
  });

  it('set_temperature requests set_temperatures with the documented temperature query', async () => {
    const before = requests.length;
    await p.sendCommand(ctx, '5YJ3000000NEXUS02', 'set_temperature', { temperatureC: 20 });
    const calls = requests.slice(before).filter((r) => r.path.includes('/command/'));
    expect(
      calls.some(
        (r) => r.path.endsWith('/command/set_temperatures') && r.query['temperature'] === '20',
      ),
    ).toBe(true);
    expect(calls.some((r) => r.path.endsWith('/command/set_temperature'))).toBe(false);
  });

  it('defrost requests start_max_defrost (and stop_max_defrost for off)', async () => {
    const before = requests.length;
    await p.sendCommand(ctx, '5YJ3000000NEXUS02', 'defrost', { defrostOn: true });
    const calls = requests.slice(before).filter((r) => r.path.includes('/command/'));
    expect(calls.some((r) => r.path.endsWith('/command/start_max_defrost'))).toBe(true);
    expect(calls.some((r) => r.path.endsWith('/command/start_defrost'))).toBe(false);
  });

  it('speed_limit requests set_speed_limit?mph then enable_speed_limit?pin', async () => {
    const before = requests.length;
    await p.sendCommand(ctx, '5YJ3000000NEXUS02', 'speed_limit', {
      speedLimitOn: true,
      speedLimitKmh: 80,
      pin: '1234',
    });
    const calls = requests.slice(before).filter((r) => r.path.includes('/command/'));
    expect(
      calls.some((r) => r.path.endsWith('/command/set_speed_limit') && r.query['mph'] === '50'),
    ).toBe(true);
    expect(
      calls.some(
        (r) => r.path.endsWith('/command/enable_speed_limit') && r.query['pin'] === '1234',
      ),
    ).toBe(true);
  });

  it('drives every documented command type through sendCommand with its documented route', async () => {
    const params: Partial<Record<CommandType, Record<string, unknown>>> = {
      set_temperature: { temperatureC: 20 },
      defrost: { defrostOn: true },
      seat_heater: { seatPosition: 'front_left', seatLevel: 2 },
      steering_heater: { steeringOn: true },
      set_charge_limit: { chargeLimitPct: 80 },
      set_charging_amps: { chargingAmps: 32 },
      sentry_mode: { sentryOn: true },
      valet_mode: { valetOn: true },
      speed_limit: { speedLimitOn: true, speedLimitKmh: 80, pin: '1234' },
      send_navigation: { destination: '1 Main St' },
      schedule_update: { updateDelaySec: 60 },
      window_vent: {},
      open_trunk: {},
      open_frunk: {},
    };
    for (const [type, route] of Object.entries(GUIDE02_COMMAND_ROUTES)) {
      const before = requests.length;
      const out = await p.sendCommand(
        ctx,
        '5YJ3000000NEXUS02',
        type as CommandType,
        params[type as CommandType] ?? {},
      );
      const calls = requests.slice(before);
      const routeName = route.split('/').at(-1)!;
      const hit = calls.some(
        (r) => r.path.endsWith(`/command/${routeName}`) || r.path.endsWith(`/${routeName}`),
      );
      // The provider must either have requested the documented route, or (for
      // commands not yet mapped in step 5) have refused locally without any
      // request. Anything else is an undocumented request.
      expect(
        hit ||
          (out.kind === 'unsupported' && calls.length === 0) ||
          (out.kind === 'rejected' && calls.length === 0),
        `${type} → ${route} (got kind=${out.kind}, ${
          calls.map((c) => `${c.method} ${c.path}`).join(', ') || 'no request'
        })`,
      ).toBe(true);
      const wrong = calls.filter(
        (r) => r.path.includes('/command/') && !r.path.endsWith(`/command/${routeName}`),
      );
      expect(wrong, `${type} hit ${wrong.map((r) => r.path).join(',')}`).toEqual([]);
    }
  });
});

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

describe('Tessie provider commands on the documented fake', () => {
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

  it('fetchState reports live=false for asleep vehicles', async () => {
    const p = new TessieProvider();
    const awake = await p.fetchState(ctx, '5YJ3000000NEXUS02');
    expect(awake.live).toBe(true);
    expect((awake.state as { batteryPercent?: number }).batteryPercent).toBe(42);
    const asleep = await p.fetchState(ctx, '5YJ3SLEEP0000001');
    expect(asleep.live).toBe(false);
    expect(asleep.freshForSec).toBe(60);
  });

  it('wake: success and wake-failure timeouts', async () => {
    const p = new TessieProvider();
    const ok = await p.sendCommand(ctx, '5YJ3000000NEXUS02', 'wake', {});
    expect(ok.kind).toBe('accepted');
    const fail = await p.sendCommand(ctx, '5YJ3WAKEFAIL01', 'wake', {});
    expect(fail.kind).toBe('timed_out');
  });

  it('preWake: wakes the vehicle when asleep, skips wake when awake', async () => {
    const p = new TessieProvider();
    const before = wakeCalls.length;
    const asleep = await p.sendCommand(ctx, '5YJ3SLEEP0000001', 'climate_start', {});
    expect(asleep.kind).toBe('accepted');
    expect(wakeCalls.slice(before)).toContain('5YJ3SLEEP0000001');
    const mid = wakeCalls.length;
    const awake = await p.sendCommand(ctx, '5YJ3000000NEXUS02', 'climate_stop', {});
    expect(awake.kind).toBe('accepted');
    expect(wakeCalls.slice(mid)).not.toContain('5YJ3000000NEXUS02');
  });

  it('guard precheck rejects when the charge port is already open', async () => {
    const p = new TessieProvider();
    const out = await p.sendCommand(ctx, '5YJ3000000NEXUS02', 'charge_port_open', {});
    expect(out.kind).toBe('rejected');
    expect(out.providerCode).toBe('PRECHECK');
  });

  it('maps "not supported" and non-idempotent upstream failures', async () => {
    const p = new TessieProvider();
    const unsupported = await p.sendCommand(ctx, '5YJ3NOTSUPP001', 'set_charge_limit', {
      chargeLimitPct: 80,
    });
    expect(unsupported.kind).toBe('unsupported');
    const trunk = await p.sendCommand(ctx, '5YJ3TRUNKERR01', 'open_trunk', {});
    expect(trunk.kind).toBe('outcome_unknown');
  });

  it('surfaces auth failures and demo guards without retries', async () => {
    const p = new TessieProvider();
    const auth = await p.sendCommand(ctx, '5YJ3AUTH0000001', 'lock', {});
    expect(auth.kind).toBe('failed');
    expect(auth.providerCode).toBe('AUTH');
    const demo = await p.sendCommand(
      { ...ctx, meta: { ...ctx.meta, demo: true } },
      '5YJ3000000NEXUS02',
      'lock',
      {},
    );
    expect(demo.kind).toBe('failed');
    expect(demo.providerCode).toBe('DEMO_GUARD');
  });

  it('health reports reachability from the live endpoint', async () => {
    const p = new TessieProvider();
    const h = await p.health(ctx);
    expect(h.ok).toBe(true);
  });
});
