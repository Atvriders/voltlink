// Tesla provider using the official Tesla Fleet API
// (https://developer.tesla.com). OAuth authorization-code flow with the
// vehicle-device-data, vehicle-cmds, and vehicle-charging-cmds scopes.
// All endpoints are configurable so automated tests can point the adapter at
// a local mock server (no private APIs are used).

import { env } from '../core/env';
import type {
  Capability,
  CommandParams,
  CommandType,
  VehicleState,
  VehicleClass,
} from '@voltlink/shared';
import type {
  CommandDispatchResult,
  FetchStateResult,
  ProviderContext,
  ProviderVehicleDescriptor,
  VehicleProvider,
} from './types';

interface TeslaTokens {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
}

interface TeslaVehicle {
  id: number;
  vehicle_id: number;
  vin: string;
  display_name: string;
  state: string;
}

const TESLA_CAPABILITIES: Capability[] = [
  'wake',
  'lock',
  'unlock',
  'climate_start',
  'climate_stop',
  'set_temperature',
  'defrost',
  'seat_heater',
  'steering_heater',
  'charge_start',
  'charge_stop',
  'set_charge_limit',
  'set_charging_amps',
  'charge_port_open',
  'charge_port_close',
  'open_trunk',
  'open_frunk',
  'window_vent',
  'window_close',
  'sentry_mode',
  'flash_lights',
  'honk_horn',
  'homelink',
  'remote_start',
  'valet_mode',
  'speed_limit',
  'send_navigation',
  'schedule_update',
  'location',
];

const TESLA_SCOPES =
  'openid vehicle_device_data vehicle_cmds vehicle_charging_cmds energy_device_data energy_cmds offline_access';

export function teslaAuthorizeUrl(state: string, codeChallenge: string): string {
  const params = new URLSearchParams({
    client_id: env.TESLA_CLIENT_ID,
    redirect_uri: env.TESLA_REDIRECT_URI,
    response_type: 'code',
    scope: TESLA_SCOPES,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    show_keypair_step: 'true',
  });
  return `https://auth.tesla.com/oauth2/v3/authorize?${params.toString()}`;
}

/** Exchange the authorization code for tokens via the official endpoint. */
export async function teslaExchangeCode(
  code: string,
  codeVerifier?: string,
): Promise<TeslaTokens & { region?: string }> {
  const res = await fetch('https://auth.tesla.com/oauth2/v3/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: env.TESLA_CLIENT_ID,
      client_secret: env.TESLA_CLIENT_SECRET,
      code,
      redirect_uri: env.TESLA_REDIRECT_URI,
      audience: env.TESLA_BASE_URL,
      ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Tesla token exchange failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return (await res.json()) as TeslaTokens;
}

function parseClass(body: Record<string, unknown>): VehicleClass {
  const config = (body.vehicle_config ?? {}) as Record<string, unknown>;
  const type = String(config.car_type ?? '').toLowerCase();
  const bodyType = String(config.body_type ?? '').toLowerCase();
  if (type.includes('cybertruck') || bodyType.includes('truck')) return 'pickup';
  if (type.includes('modelx') || type.includes('modely')) return 'suv';
  if (type.includes('model3')) return 'compact_sedan';
  if (type.includes('models')) return 'sport_sedan';
  return 'fallback';
}

function mapState(
  body: Record<string, unknown>,
): Omit<VehicleState, 'vehicleId' | 'provider' | 'providerVehicleId'> {
  const charge = (body.charge_state ?? {}) as Record<string, unknown>;
  const climate = (body.climate_state ?? {}) as Record<string, unknown>;
  const drive = (body.drive_state ?? {}) as Record<string, unknown>;
  const vehicle = (body.vehicle_state ?? {}) as Record<string, unknown>;
  const gui = (body.gui_settings ?? {}) as Record<string, unknown>;
  const config = (body.vehicle_config ?? {}) as Record<string, unknown>;

  const chargingState = String(charge.charging_state ?? 'unknown') as VehicleState['chargingState'];
  const batteryPct = typeof charge.battery_level === 'number' ? charge.battery_level : undefined;
  const rangeKm = typeof charge.battery_range_km === 'number' ? charge.battery_range_km : undefined;
  const lat = typeof drive.latitude === 'number' ? drive.latitude : undefined;
  const lon = typeof drive.longitude === 'number' ? drive.longitude : undefined;
  const locked = typeof vehicle.locked === 'boolean' ? vehicle.locked : undefined;
  const df = (drive as Record<string, unknown>).df as number | undefined;
  const pf = (drive as Record<string, unknown>).pf as number | undefined;
  const pr = (drive as Record<string, unknown>).pr as number | undefined;
  const dr = (drive as Record<string, unknown>).dr as number | undefined;
  const ft = (drive as Record<string, unknown>).ft as number | undefined;
  const rt = (drive as Record<string, unknown>).rt as number | undefined;

  const status =
    vehicle.state === 'asleep'
      ? 'asleep'
      : chargingState === 'charging'
        ? 'charging'
        : typeof drive.speed === 'number' && drive.speed > 1
          ? 'driving'
          : 'online';

  return {
    fetchedAt: new Date().toISOString(),
    freshness: 'live',
    dataSource: 'telemetry',
    status: status as VehicleState['status'],
    batteryPercent: batteryPct,
    batteryRangeKm: rangeKm,
    batteryCapacityKwh:
      typeof config.usable_battery_level === 'number'
        ? Number(config.usable_battery_level)
        : undefined,
    chargingState,
    chargePowerKw: typeof charge.charger_power === 'number' ? charge.charger_power : undefined,
    chargeCurrentA:
      typeof charge.charge_current_request === 'number' ? charge.charge_current_request : undefined,
    chargeVoltageV: typeof charge.charger_voltage === 'number' ? charge.charger_voltage : undefined,
    chargerPhases: typeof charge.charger_phases === 'number' ? charge.charger_phases : undefined,
    timeToFullChargeMin:
      typeof charge.time_to_full_charge === 'number' ? charge.time_to_full_charge * 60 : undefined,
    chargePortOpen:
      typeof charge.charge_port_door_open === 'boolean' ? charge.charge_port_door_open : undefined,
    plugConnected:
      typeof charge.charge_port_latch === 'string'
        ? charge.charge_port_latch === 'Engaged'
        : undefined,
    climateOn: typeof climate.is_climate_on === 'boolean' ? climate.is_climate_on : undefined,
    insideTempC: typeof climate.inside_temp === 'number' ? climate.inside_temp : undefined,
    outsideTempC: typeof climate.outside_temp === 'number' ? climate.outside_temp : undefined,
    driverTempSettingC:
      typeof climate.driver_temp_setting === 'number' ? climate.driver_temp_setting : undefined,
    fanLevel: typeof climate.fan_status === 'number' ? climate.fan_status : undefined,
    defrostOn: typeof climate.defrost_mode === 'number' ? climate.defrost_mode !== 0 : undefined,
    isPreconditioning:
      typeof climate.is_preconditioning === 'boolean' ? climate.is_preconditioning : undefined,
    seatHeaterLevel:
      typeof climate.seat_heater_left === 'number' ? climate.seat_heater_left : undefined,
    steeringHeaterOn:
      typeof climate.steering_wheel_heater === 'boolean'
        ? climate.steering_wheel_heater
        : undefined,
    locked,
    doors: { frontLeft: !!df, frontRight: !!pf, rearLeft: !!pr, rearRight: !!dr },
    trunkOpen: typeof vehicle.rt === 'boolean' ? vehicle.rt : false,
    frunkOpen: typeof vehicle.ft === 'boolean' ? vehicle.ft : false,
    windowsOpen: false,
    sentryMode: typeof vehicle.sentry_mode === 'boolean' ? vehicle.sentry_mode : undefined,
    alarmState:
      vehicle.alarm_state === 'armed'
        ? 'armed'
        : vehicle.alarm_state === 'triggered'
          ? 'triggered'
          : 'off',
    valetMode: typeof vehicle.valet_mode === 'boolean' ? vehicle.valet_mode : undefined,
    speedLimitMode:
      typeof vehicle.speed_limit_mode === 'object' && vehicle.speed_limit_mode
        ? {
            active: (vehicle.speed_limit_mode as Record<string, unknown>).active === true,
            limitKmh:
              typeof (vehicle.speed_limit_mode as Record<string, unknown>).current_limit_mph ===
              'number'
                ? Number((vehicle.speed_limit_mode as Record<string, unknown>).current_limit_mph) *
                  1.60934
                : undefined,
          }
        : undefined,
    lat,
    lon,
    headingDeg: typeof drive.heading === 'number' ? drive.heading : undefined,
    speedKmh: typeof drive.speed === 'number' ? drive.speed : undefined,
    odometerKm: typeof vehicle.odometer === 'number' ? vehicle.odometer * 1.60934 : undefined,
    softwareVersion: typeof vehicle.car_version === 'string' ? vehicle.car_version : undefined,
    tirePressureKpa: [ft, rt].every((v) => typeof v === 'number')
      ? {
          frontLeft: Math.round((ft as number) * 6.89476),
          frontRight: Math.round((ft as number) * 6.89476),
          rearLeft: Math.round((rt as number) * 6.89476),
          rearRight: Math.round((rt as number) * 6.89476),
        }
      : undefined,
    chargeLimitPct: typeof gui.charge_limit_soc === 'number' ? gui.charge_limit_soc : undefined,
  };
}
const COMMAND_ENDPOINTS: Record<
  string,
  { path: string; body?: (p: CommandParams) => Record<string, unknown> }
> = {
  wake: { path: 'wake_up' },
  lock: { path: 'door_lock' },
  unlock: { path: 'door_unlock' },
  climate_start: { path: 'auto_conditioning_start' },
  climate_stop: { path: 'auto_conditioning_stop' },
  set_temperature: {
    path: 'set_temps',
    body: (p) => ({ driver_temp: p.temperatureC ?? 21, passenger_temp: p.temperatureC ?? 21 }),
  },
  defrost: { path: 'set_preconditioning_max', body: () => ({ on: true, manual_override: true }) },
  seat_heater: {
    path: 'remote_seat_heater_request',
    body: (p) => ({ heater: 0, level: p.seatLevel ?? 1 }),
  },
  steering_heater: {
    path: 'remote_steering_wheel_heater_request',
    body: (p) => ({ on: p.steeringOn ?? true }),
  },
  charge_start: { path: 'charge_start' },
  charge_stop: { path: 'charge_stop' },
  set_charge_limit: {
    path: 'set_charge_limit',
    body: (p) => ({ percent: p.chargeLimitPct ?? 80 }),
  },
  set_charging_amps: {
    path: 'set_charging_amps',
    body: (p) => ({ charging_amps: p.chargingAmps ?? 32 }),
  },
  charge_port_open: { path: 'charge_port_door_open' },
  charge_port_close: { path: 'charge_port_door_close' },
  open_trunk: { path: 'actuate_trunk', body: () => ({ which_trunk: 'rear' }) },
  open_frunk: { path: 'actuate_trunk', body: () => ({ which_trunk: 'front' }) },
  window_vent: { path: 'window_control', body: () => ({ command: 'vent', lat: 0, lon: 0 }) },
  window_close: { path: 'window_control', body: () => ({ command: 'close', lat: 0, lon: 0 }) },
  sentry_mode: { path: 'set_sentry_mode', body: (p) => ({ on: p.sentryOn ?? true }) },
  flash_lights: { path: 'flash_lights' },
  honk_horn: { path: 'honk_horn' },
  homelink: {
    path: 'trigger_homelink',
    body: (p) => ({ lat: 0, lon: 0, token: p.homelinkName ?? '' }),
  },
  remote_start: { path: 'remote_start_drive' },
  valet_mode: {
    path: 'set_valet_mode',
    body: (p) => ({ on: p.valetOn ?? false, password: p.pin ?? '0000' }),
  },
  speed_limit: {
    path: 'speed_limit_set_limit',
    body: (p) => ({ limit_mph: Math.round((p.speedLimitKmh ?? 110) / 1.60934) }),
  },
  send_navigation: {
    path: 'navigation_request',
    body: (p) => ({
      type: 'share_ext_content_raw',
      value: { 'android.intent.extra.TEXT': p.destination?.name ?? '' },
    }),
  },
  schedule_update: {
    path: 'schedule_software_update',
    body: (p) => ({ offset_sec: p.updateDelaySec ?? 30 }),
  },
};

class TeslaProviderImpl implements VehicleProvider {
  id = 'tesla' as const;

  async readiness(): Promise<{
    ok: boolean;
    checks: { name: string; ok: boolean; detail: string }[];
  }> {
    const checks = [
      {
        name: 'Client ID',
        ok: !!env.TESLA_CLIENT_ID,
        detail: env.TESLA_CLIENT_ID
          ? 'OAuth client configured.'
          : 'Set TESLA_CLIENT_ID from your developer.tesla.com application.',
      },
      {
        name: 'Client secret',
        ok: !!env.TESLA_CLIENT_SECRET,
        detail: env.TESLA_CLIENT_SECRET ? 'Client secret configured.' : 'Set TESLA_CLIENT_SECRET.',
      },
      {
        name: 'Redirect URI',
        ok: env.TESLA_REDIRECT_URI.startsWith('https://') || env.NODE_ENV !== 'production',
        detail: `Configured redirect: ${env.TESLA_REDIRECT_URI}. Register this exact URI with the Tesla app.`,
      },
      {
        name: 'Scopes',
        ok: true,
        detail: 'Requests vehicle_device_data, vehicle_cmds, vehicle_charging_cmds.',
      },
      {
        name: 'Regional availability',
        ok: true,
        detail:
          'Fleet API is available where Tesla operates; command availability varies by market.',
      },
    ];
    return { ok: checks.every((c) => c.ok), checks };
  }

  async listVehicles(ctx: ProviderContext): Promise<ProviderVehicleDescriptor[]> {
    const creds = ctx.credentials as { accessToken?: string };
    if (!creds.accessToken) throw new Error('Tesla account has no stored access token.');
    const res = await this.request(ctx, 'GET', '/api/1/vehicles');
    if (!res.ok) throw new Error(`Tesla vehicle list failed (${res.status}).`);
    const body = (await res.json()) as { response?: TeslaVehicle[] };
    const rows = body.response ?? [];
    const out: ProviderVehicleDescriptor[] = [];
    for (const v of rows) {
      let detail: Record<string, unknown> = {};
      try {
        const r2 = await this.request(ctx, 'GET', `/api/1/vehicles/${v.id}/vehicle_data`);
        if (r2.ok)
          detail = ((await r2.json()) as { response?: Record<string, unknown> }).response ?? {};
      } catch {
        /* capability discovery is best-effort */
      }
      out.push({
        providerVehicleId: String(v.id),
        displayName: v.display_name || `Vehicle ${v.vehicle_id}`,
        make: 'Tesla',
        model: String((detail.vehicle_config as Record<string, unknown>)?.car_type ?? ''),
        year: Number(
          (detail.vehicle_config as Record<string, unknown>)?.car_year ?? new Date().getFullYear(),
        ),
        vehicleClass: parseClass(detail),
        exteriorColor: undefined,
        wheelStyle: undefined,
        vinLast4: v.vin.slice(-4),
        capabilities: TESLA_CAPABILITIES,
      });
    }
    return out;
  }

  async fetchState(ctx: ProviderContext, providerVehicleId: string): Promise<FetchStateResult> {
    const res = await this.request(ctx, 'GET', `/api/1/vehicles/${providerVehicleId}/vehicle_data`);
    if (!res.ok) {
      if (res.status === 408) {
        // Vehicle asleep — return last-known sentinel handled by caller.
        throw new Error('vehicle_asleep');
      }
      throw new Error(`Tesla state fetch failed (${res.status}).`);
    }
    const body = (await res.json()) as { response?: Record<string, unknown> };
    const mapped = mapState(body.response ?? {});
    return {
      state: { ...mapped, vehicleId: undefined } as never,
      live: true,
      freshForSec: mapped.status === 'asleep' ? 900 : 60,
    };
  }

  async sendCommand(
    ctx: ProviderContext,
    providerVehicleId: string,
    type: CommandType,
    params: CommandParams,
  ): Promise<CommandDispatchResult> {
    const def = COMMAND_ENDPOINTS[type];
    if (!def)
      return { kind: 'unsupported', errorMessage: `Command ${type} is not mapped for Tesla.` };
    const res = await this.request(
      ctx,
      'POST',
      `/api/1/vehicles/${providerVehicleId}/command/${def.path}`,
      def.body?.(params),
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return {
        kind: 'rejected',
        errorMessage: `Tesla rejected ${type} (${res.status}): ${text.slice(0, 200)}`,
      };
    }
    const body = (await res.json().catch(() => ({}))) as {
      response?: { result?: boolean; reason?: string };
    };
    const result = body.response?.result;
    if (result === false)
      return {
        kind: 'rejected',
        errorMessage: body.response?.reason ?? 'Command refused by vehicle.',
      };
    return { kind: 'accepted', response: 'Command accepted by Tesla Fleet API.' };
  }

  async health(ctx: ProviderContext): Promise<{ ok: boolean; detail: string }> {
    try {
      const res = await this.request(ctx, 'GET', '/api/1/vehicles');
      return { ok: res.ok, detail: `Fleet API reachable (${res.status}).` };
    } catch (e) {
      return { ok: false, detail: `Fleet API unreachable: ${(e as Error).message.slice(0, 120)}` };
    }
  }

  private async request(
    ctx: ProviderContext,
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<Response> {
    const creds = ctx.credentials as { accessToken?: string; region?: string };
    if (!creds.accessToken) throw new Error('Missing Tesla access token.');
    const base = ctx.credentials?.regionBase ?? env.TESLA_BASE_URL;
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${creds.accessToken}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return res;
  }
}

export const TeslaProvider = TeslaProviderImpl;
