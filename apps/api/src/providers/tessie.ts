// Optional Tessie provider adapter. Uses the public Tessie API with a
// user-supplied Tessie API token (https://tessie.com — see
// docs/OPTIONAL_TESSIE_PROVIDER.md). Disabled by default; requires the user's
// own valid Tessie credentials. Base URL is configurable for tests.

import { env } from '../core/env';
import type { Capability, CommandParams, CommandType, VehicleState } from '@voltlink/shared';
import type {
  CommandDispatchResult,
  FetchStateResult,
  ProviderContext,
  ProviderVehicleDescriptor,
  VehicleProvider,
} from './types';

const TESSIE_CAPABILITIES: Capability[] = [
  'wake',
  'lock',
  'unlock',
  'climate_start',
  'climate_stop',
  'set_temperature',
  'defrost',
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
  'valet_mode',
  'speed_limit',
  'send_navigation',
  'location',
];

const TESSIE_COMMANDS: Record<string, string> = {
  wake: 'wake',
  lock: 'lock',
  unlock: 'unlock',
  climate_start: 'start_climate',
  climate_stop: 'stop_climate',
  set_temperature: 'set_temperature',
  defrost: 'start_defrost',
  charge_start: 'start_charging',
  charge_stop: 'stop_charging',
  set_charge_limit: 'set_charge_limit',
  set_charging_amps: 'set_charging_amps',
  charge_port_open: 'open_charge_port',
  charge_port_close: 'close_charge_port',
  open_trunk: 'open_rear_trunk',
  open_frunk: 'open_front_trunk',
  window_vent: 'vent_windows',
  window_close: 'close_windows',
  sentry_mode: 'enable_sentry',
  flash_lights: 'flash_lights',
  honk_horn: 'honk',
  homelink: 'trigger_homelink',
  valet_mode: 'enable_valet_mode',
  speed_limit: 'set_speed_limit',
  send_navigation: 'navigation',
};

function mapTessieState(
  raw: Record<string, unknown>,
): Omit<VehicleState, 'vehicleId' | 'provider' | 'providerVehicleId'> {
  const batteryPct = typeof raw.battery === 'number' ? raw.battery : undefined;
  const chargingStateRaw = String(raw.charging_state ?? 'unknown');
  const chargingState =
    chargingStateRaw === 'Complete'
      ? 'complete'
      : chargingStateRaw === 'Charging'
        ? 'charging'
        : chargingStateRaw === 'Disconnected'
          ? 'disconnected'
          : chargingStateRaw === 'Stopped'
            ? 'stopped'
            : 'unknown';
  return {
    fetchedAt: new Date().toISOString(),
    freshness: 'live',
    dataSource: 'telemetry',
    status: chargingState === 'charging' ? 'charging' : raw.in_service ? 'online' : 'online',
    batteryPercent: batteryPct,
    batteryRangeKm: typeof raw.range === 'number' ? raw.range * 1.60934 : undefined,
    chargeLimitPct: typeof raw.charge_limit === 'number' ? raw.charge_limit : undefined,
    chargingState,
    chargePowerKw: typeof raw.charge_power === 'number' ? raw.charge_power : undefined,
    chargeCurrentA: typeof raw.charge_current === 'number' ? raw.charge_current : undefined,
    chargeVoltageV: typeof raw.charge_voltage === 'number' ? raw.charge_voltage : undefined,
    timeToFullChargeMin:
      typeof raw.minutes_to_full_charge === 'number' ? raw.minutes_to_full_charge : undefined,
    climateOn: raw.climate_active === true,
    insideTempC: typeof raw.inside_temp === 'number' ? raw.inside_temp : undefined,
    outsideTempC: typeof raw.outside_temp === 'number' ? raw.outside_temp : undefined,
    driverTempSettingC: typeof raw.driver_temp === 'number' ? raw.driver_temp : undefined,
    defrostOn: raw.defrost_active === true,
    locked: typeof raw.locked === 'boolean' ? raw.locked : undefined,
    trunkOpen: raw.trunk_open === true,
    frunkOpen: raw.frunk_open === true,
    windowsOpen: raw.windows_open === true,
    sentryMode: raw.sentry_enabled === true,
    lat: typeof raw.latitude === 'number' ? raw.latitude : undefined,
    lon: typeof raw.longitude === 'number' ? raw.longitude : undefined,
    speedKmh: typeof raw.speed === 'number' ? raw.speed * 1.60934 : undefined,
    odometerKm: typeof raw.odometer === 'number' ? raw.odometer * 1.60934 : undefined,
    softwareVersion: typeof raw.software_version === 'string' ? raw.software_version : undefined,
  };
}

class TessieProviderImpl implements VehicleProvider {
  id = 'tessie' as const;

  async readiness(): Promise<{
    ok: boolean;
    checks: { name: string; ok: boolean; detail: string }[];
  }> {
    return {
      ok: true,
      checks: [
        {
          name: 'User credentials',
          ok: true,
          detail: 'Requires the user\u2019s own valid Tessie API token (stored encrypted).',
        },
        {
          name: 'Optional adapter',
          ok: true,
          detail: 'Tessie support is optional and independent of the Tesla adapter.',
        },
        {
          name: 'Base URL',
          ok: true,
          detail: `TESSIE_BASE_URL=${env.TESSIE_BASE_URL} (configurable).`,
        },
      ],
    };
  }

  async listVehicles(ctx: ProviderContext): Promise<ProviderVehicleDescriptor[]> {
    const res = await this.request(ctx, 'GET', '/vehicles');
    if (!res.ok) throw new Error(`Tessie vehicle list failed (${res.status}).`);
    const body = (await res.json()) as { results?: Record<string, unknown>[] };
    return (body.results ?? []).map((v) => ({
      providerVehicleId: String(v.vin),
      displayName: String(v.display_name ?? `Vehicle ${String(v.vin).slice(-6)}`),
      make: 'Tesla',
      model: '',
      vehicleClass: 'fallback' as const,
      vinLast4: String(v.vin).slice(-4),
      capabilities: TESSIE_CAPABILITIES,
    }));
  }

  async fetchState(ctx: ProviderContext, providerVehicleId: string): Promise<FetchStateResult> {
    const res = await this.request(ctx, 'GET', `/${encodeURIComponent(providerVehicleId)}/state`);
    if (!res.ok) throw new Error(`Tessie state fetch failed (${res.status}).`);
    const body = (await res.json()) as Record<string, unknown>;
    return {
      state: { ...mapTessieState(body), vehicleId: undefined } as never,
      live: true,
      freshForSec: 60,
    };
  }

  async sendCommand(
    ctx: ProviderContext,
    providerVehicleId: string,
    type: CommandType,
    params: CommandParams,
  ): Promise<CommandDispatchResult> {
    const cmd = TESSIE_COMMANDS[type];
    if (!cmd)
      return { kind: 'unsupported', errorMessage: `Command ${type} is not mapped for Tessie.` };
    const qs = new URLSearchParams({ retry_duration: '40', wait_for_completion: 'true' });
    if (type === 'set_charge_limit') qs.set('percent', String(params.chargeLimitPct ?? 80));
    if (type === 'set_temperature') qs.set('temperature', String(params.temperatureC ?? 21));
    if (type === 'set_charging_amps') qs.set('amps', String(params.chargingAmps ?? 32));
    if (type === 'valet_mode') qs.set('enable', String(params.valetOn ?? true));
    if (type === 'speed_limit')
      qs.set('mph', String(Math.round((params.speedLimitKmh ?? 110) / 1.60934)));
    const res = await this.request(
      ctx,
      'POST',
      `/${encodeURIComponent(providerVehicleId)}/command/${cmd}?${qs.toString()}`,
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return {
        kind: 'rejected',
        errorMessage: `Tessie rejected ${type} (${res.status}): ${text.slice(0, 200)}`,
      };
    }
    return { kind: 'accepted', response: 'Command accepted by Tessie API.' };
  }

  async health(ctx: ProviderContext): Promise<{ ok: boolean; detail: string }> {
    try {
      const res = await this.request(ctx, 'GET', '/vehicles');
      return { ok: res.ok, detail: `Tessie API reachable (${res.status}).` };
    } catch (e) {
      return { ok: false, detail: `Tessie API unreachable: ${(e as Error).message.slice(0, 120)}` };
    }
  }

  private async request(ctx: ProviderContext, method: string, path: string): Promise<Response> {
    const creds = ctx.credentials as { token?: string };
    if (!creds.token) throw new Error('Missing Tessie API token.');
    return fetch(`${env.TESSIE_BASE_URL}${path}`, {
      method,
      headers: { Authorization: `Bearer ${creds.token}`, 'Content-Type': 'application/json' },
    });
  }
}

export const TessieProvider = TessieProviderImpl;
