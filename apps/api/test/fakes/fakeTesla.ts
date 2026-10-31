// Fake Tesla Fleet API + command proxy (guide 01 §14). Used by the adapter
// contract tests; scenario controls + a request log with meter categories.

import express from 'express';
import type { Server } from 'node:http';
import crypto from 'node:crypto';

export interface FakeTesla {
  server: Server;
  base: string;
  proxy: string;
  requests: { method: string; path: string; body?: unknown }[];
  setConnectivity(vin: string, state: 'online' | 'asleep' | 'offline'): void;
  pairKey(vin: string): void;
  failNext(path: string, status: number, body: string, headers?: Record<string, string>): void;
  close(): Promise<void>;
}

export function startFakeTesla(port = 0): Promise<FakeTesla> {
  return new Promise((resolve) => {
    const app = express();
    app.use(express.json());
    const requests: FakeTesla['requests'] = [];
    const states = new Map<string, 'online' | 'asleep' | 'offline'>();
    const paired = new Set<string>();
    const failures: Array<{
      path: string;
      status: number;
      body: string;
      headers?: Record<string, string>;
    }> = [];

    // auth token endpoint (code exchange + refresh + client_credentials)
    app.post('/oauth2/v3/token', (req, res) => {
      requests.push({ method: 'POST', path: '/oauth2/v3/token', body: req.body });
      const grant = String(req.body?.grant_type ?? '');
      if (grant === 'refresh_token') {
        res.json({
          access_token: `at-${crypto.randomBytes(6).toString('hex')}`,
          refresh_token: `rt-${crypto.randomBytes(6).toString('hex')}`,
          expires_in: 28800,
          scope:
            'openid offline_access vehicle_device_data vehicle_location vehicle_cmds vehicle_charging_cmds',
        });
        return;
      }
      if (grant === 'client_credentials') {
        res.json({ access_token: 'partner-token', expires_in: 3600 });
        return;
      }
      res.json({
        access_token: 'access-abc',
        refresh_token: 'refresh-abc',
        expires_in: 28800,
        scope:
          'openid offline_access vehicle_device_data vehicle_location vehicle_cmds vehicle_charging_cmds',
      });
    });

    app.get('/api/1/users/region', (_req, res) => {
      requests.push({ method: 'GET', path: '/api/1/users/region' });
      res.status(421).json({ error: 'Incorrect region' });
    });

    app.get('/api/1/vehicles', (_req, res) => {
      requests.push({ method: 'GET', path: '/api/1/vehicles' });
      res.json({
        response: [
          {
            id: 1,
            vin: '5YJ3000000NEXUS01',
            display_name: 'Nexus One',
            state: 'online',
            access_type: 'OWNER',
            granular_access: { hide_private: false },
          },
        ],
        pagination: { next: null },
      });
    });

    app.get('/api/1/vehicles/:vin', (req, res) => {
      requests.push({ method: 'GET', path: `/api/1/vehicles/${req.params.vin}` });
      const state = states.get(String(req.params.vin)) ?? 'online';
      res.json({
        response: {
          state,
          in_service: false,
          vehicle_config: {
            car_type: 'model3',
            rhd: false,
            can_actuate_trunks: true,
            motorized_charge_port: true,
            can_accept_navigation_requests: true,
          },
        },
      });
    });

    app.post('/api/1/vehicles/fleet_status', (req, res) => {
      requests.push({ method: 'POST', path: '/api/1/vehicles/fleet_status', body: req.body });
      const vins = (req.body?.vins ?? []) as string[];
      const response: Record<string, unknown> = {};
      for (const vin of vins) {
        response[vin] = {
          vehicle_command_protocol_required: true,
          key_paired_vins: paired.has(vin) ? [vin] : [],
          total_number_of_keys: 1,
          vehicle_info: { firmware_version: '2025.45.1' },
        };
      }
      res.json({ response });
    });

    app.get('/api/1/vehicles/:vin/vehicle_data', (req, res) => {
      requests.push({ method: 'GET', path: `/api/1/vehicles/${req.params.vin}/vehicle_data` });
      const state = states.get(String(req.params.vin)) ?? 'online';
      if (state !== 'online') {
        res.status(408).json({ error: 'vehicle is offline or asleep' });
        return;
      }
      const eps = String(req.query.endpoints ?? '');
      const response: Record<string, unknown> = {
        charge_state: {
          charging_state: 'Disconnected',
          battery_level: 60,
          battery_range: 133.99,
          charge_limit_soc: 80,
          charge_port_latch: 'Engaged',
          charge_current_request_max: 48,
          timestamp: 1700000000000,
        },
        climate_state: {
          is_climate_on: false,
          inside_temp: 21.5,
          outside_temp: 18,
          driver_temp_setting: 21,
          fan_status: 0,
          defrost_mode: 0,
          is_preconditioning: false,
          seat_heater_left: 0,
          steering_wheel_heater: false,
          min_avail_temp: 15,
          max_avail_temp: 28,
          timestamp: 1700000000000,
        },
        drive_state: {
          shift_state: 'P',
          speed: 0,
          latitude: 37.77,
          longitude: -122.41,
          heading: 90,
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
          fd_window: 0,
          fp_window: 0,
          rd_window: 0,
          rp_window: 0,
          sentry_mode: false,
          sentry_mode_available: true,
          valet_mode: false,
          odometer: 1000,
          car_version: '2025.45.1 abc',
          tpms_pressure_fl: 3.0,
          tpms_pressure_fr: 3.0,
          tpms_pressure_rl: 3.1,
          tpms_pressure_rr: 3.1,
          speed_limit_mode: {
            active: false,
            current_limit_mph: 85,
            min_limit_mph: 50,
            max_limit_mph: 90,
          },
          remote_start_supported: true,
          homelink_device_count: 1,
          software_update: { status: 'available', version: '2025.45.1' },
          timestamp: 1700000000000,
        },
        vehicle_config: {
          car_type: 'model3',
          rhd: false,
          can_actuate_trunks: true,
          motorized_charge_port: true,
          can_accept_navigation_requests: true,
        },
        gui_settings: { charge_limit_soc: 80 },
      };
      if (eps.includes('location_data'))
        response.location_data = { latitude: 37.77, longitude: -122.41, heading: 90 };
      res.json({ response });
    });

    app.get('/api/1/vehicles/:vin/vehicle_data_cached', (_req, res) => {
      res.status(404).json({ error: 'no cached data' });
    });

    app.post('/api/1/vehicles/:vin/wake_up', (_req, res) => {
      requests.push({ method: 'POST', path: `/api/1/vehicles/${_req.params.vin}/wake_up` });
      res.json({ response: { state: 'online' } });
    });

    // command proxy
    app.post('/api/1/vehicles/:vin/command/:name', (req, res) => {
      requests.push({
        method: 'POST',
        path: `/api/1/vehicles/${req.params.vin}/command/${req.params.name}`,
        body: req.body,
      });
      const vin = String(req.params.vin);
      if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) {
        res.status(404).json({ error: 'expected 17-character VIN' });
        return;
      }
      const f = failures.find((x) => x.path === req.path);
      if (f) {
        failures.splice(failures.indexOf(f), 1);
        if (f.headers) for (const [k, v] of Object.entries(f.headers)) res.setHeader(k, v);
        res.status(f.status).send(f.body);
        return;
      }
      if (states.get(vin) === 'asleep') {
        res.status(500).send('vehicle is offline or asleep');
        return;
      }
      if (!paired.has(vin)) {
        res.status(500).send('public key has not been paired');
        return;
      }
      res.json({ response: { result: true, reason: '' } });
    });

    app.get('/health', (_req, res) => {
      res.send('OK');
    });

    app.get('/status', (_req, res) => {
      res.json({ status: 'ok' });
    });

    app.get('/api/1/partner_accounts/public_key', (_req, res) => {
      res.json({ response: { public_key: '' } });
    });

    const server = app.listen(port, () => {
      const addr = server.address() as { port: number };
      resolve({
        server,
        base: `http://127.0.0.1:${addr.port}`,
        proxy: `http://127.0.0.1:${addr.port}`,
        requests,
        setConnectivity: (vin, state) => void states.set(vin, state),
        pairKey: (vin) => void paired.add(vin),
        failNext: (path, status, body, headers) =>
          void failures.push({ path, status, body, headers }),
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}
