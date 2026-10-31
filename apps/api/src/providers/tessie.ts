// Tessie provider (guide 02): documented state schema + command list, real
// readiness checks (NEW-08), no invented mappings (P-TESSIE). Tessie has no
// webhook API — the provider webhook route answers 404 for Tessie.

import {
  mapTeslaVehicleData,
  modelNameFromCarType,
  vehicleClassFromCarType,
  modelYearFromVin,
  colorHexFromTesla,
  deriveHardwareCapabilities,
  obj,
} from './teslaShape';
import type { CommandParams, CommandType } from '@voltlink/shared';
import type {
  CommandDispatchResult,
  FetchStateResult,
  ProviderContext,
  ProviderVehicleDescriptor,
  VehicleProvider,
} from './types';

class ProviderError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryAfterSec?: number,
  ) {
    super(message);
  }
}

const REASONS: Record<string, string> = {
  'no cable': 'No charge cable is connected.',
  'cable connected': 'A charge cable is connected.',
  'already active': 'Already on; the vehicle made no change.',
  'already inactive': 'Already off; the vehicle made no change.',
  'incorrect pin': 'Incorrect PIN.',
  cpd_enabled: 'Child presence detection blocked the command.',
};
const friendlyReason = (r?: string) =>
  r
    ? (REASONS[r] ?? `Vehicle refused the command: ${r}`)
    : 'Vehicle refused the command (no reason given).';

type TessieStep = { name: string; query?: Record<string, unknown>; maxAttempts?: number };
type Plan =
  | {
      kind: 'ok';
      steps: TessieStep[];
      idempotent: boolean;
      wakeOnly?: boolean;
      preWake?: boolean;
      guard?: (s: Record<string, unknown>) => string | null;
    }
  | { kind: 'invalid'; reason: string }
  | { kind: 'unsupported'; reason: string };

const one = (
  name: string,
  query: Record<string, unknown> = {},
  extra: {
    idempotent?: boolean;
    wakeOnly?: boolean;
    preWake?: boolean;
    guard?: (s: Record<string, unknown>) => string | null;
  } = {},
): Plan => ({
  kind: 'ok',
  steps: [{ name, query }],
  idempotent: extra.idempotent !== false,
  ...extra,
});
const bad = (reason: string): Plan => ({ kind: 'invalid', reason });

function planTessieCommand(type: CommandType, p: CommandParams): Plan {
  switch (type) {
    case 'wake':
      return one('wake', {}, { wakeOnly: true });
    case 'lock':
      return one('lock');
    case 'unlock':
      return one('unlock');
    case 'climate_start':
      return one('start_climate', {}, { preWake: true });
    case 'climate_stop':
      return one('stop_climate', {}, { preWake: true });
    case 'set_temperature':
      return typeof p.temperatureC === 'number' && p.temperatureC >= 15 && p.temperatureC <= 28
        ? one('set_temperature', { temperature: p.temperatureC }, { preWake: true })
        : bad('temperatureC must be 15–28 °C.');
    case 'defrost':
      return one('start_defrost', {}, { preWake: true });
    case 'seat_heater':
      return one('set_seat_heat', { seat: 0, level: p.seatLevel ?? 1 }, { preWake: true });
    case 'steering_heater':
      return one('set_steering_wheel_heat', { on: p.steeringOn !== false }, { preWake: true });
    case 'charge_start':
      return one('start_charging', {}, { preWake: true });
    case 'charge_stop':
      return one('stop_charging', {}, { preWake: true });
    case 'set_charge_limit':
      return typeof p.chargeLimitPct === 'number' &&
        p.chargeLimitPct >= 50 &&
        p.chargeLimitPct <= 100
        ? one('set_charge_limit', { percent: p.chargeLimitPct })
        : bad('chargeLimitPct must be 50–100.');
    case 'set_charging_amps':
      return typeof p.chargingAmps === 'number' &&
        Number.isInteger(p.chargingAmps) &&
        p.chargingAmps >= 1 &&
        p.chargingAmps <= 100
        ? one('set_charging_amps', { amps: p.chargingAmps })
        : bad('chargingAmps must be an integer 1–100.');
    case 'charge_port_open':
      return one(
        'open_charge_port',
        {},
        {
          guard: (s) =>
            obj(s.charge_state).charge_port_door_open === true
              ? 'Charge port is already open.'
              : null,
        },
      );
    case 'charge_port_close':
      return one('close_charge_port');
    case 'open_trunk':
      return one('activate_rear_trunk', {}, { idempotent: false });
    case 'open_frunk':
      return one('activate_front_trunk', {}, { idempotent: false });
    case 'window_vent':
      return one('vent_windows');
    case 'window_close':
      return one('close_windows');
    case 'sentry_mode':
      return typeof p.sentryOn === 'boolean'
        ? one(p.sentryOn ? 'enable_sentry' : 'disable_sentry')
        : bad('sentryOn is required.');
    case 'flash_lights':
      return one('flash', {}, { idempotent: false });
    case 'honk_horn':
      return one('honk', {}, { idempotent: false });
    case 'homelink':
      return one('trigger_homelink', {}, { idempotent: false });
    case 'remote_start':
      return one('remote_start', {}, { idempotent: false });
    case 'valet_mode':
      return typeof p.valetOn === 'boolean'
        ? one(p.valetOn ? 'enable_valet' : 'disable_valet')
        : bad('valetOn is required.');
    case 'speed_limit': {
      const steps: TessieStep[] = [];
      const mph =
        p.speedLimitKmh === undefined ? undefined : Math.round(p.speedLimitKmh / 1.609344);
      if (mph !== undefined) steps.push({ name: 'set_speed_limit', query: { mph } });
      if (p.speedLimitOn !== undefined) {
        if (!/^\d{4}$/.test(p.pin ?? '')) return bad('A 4-digit speed-limit PIN is required.');
        steps.push({
          name: p.speedLimitOn ? 'enable_speed_limit' : 'disable_speed_limit',
          query: { pin: p.pin as string },
        });
      }
      if (!steps.length) return bad('Provide speedLimitKmh and/or speedLimitOn.');
      return { kind: 'ok', steps, idempotent: true };
    }
    case 'send_navigation': {
      const d = p.destination;
      const value =
        d && Number.isFinite(d.lat) && Number.isFinite(d.lon)
          ? `${d.lat!.toFixed(6)},${d.lon!.toFixed(6)}`
          : d?.name?.trim();
      return value
        ? one('share', { value: value.slice(0, 300), locale: 'en-US' }, { idempotent: false })
        : bad('destination is required.');
    }
    case 'schedule_update':
      return typeof p.updateDelaySec === 'number' && p.updateDelaySec >= 0
        ? one('schedule_software_update', { in_seconds: p.updateDelaySec })
        : bad('updateDelaySec must be ≥ 0.');
    case 'cancel_update':
      return one('cancel_software_update');
    default:
      return { kind: 'unsupported', reason: `${String(type)} is not offered by the Tessie API.` };
  }
}

class TessieClient {
  constructor(
    private base: string,
    private token: string,
  ) {}

  private async req(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await fetch(`${this.base}${path}`, {
      ...init,
      signal: AbortSignal.timeout(30_000),
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
    return res;
  }

  async getState(vin: string): Promise<Record<string, unknown>> {
    const res = await this.req(`/${vin}/state`);
    if (res.status === 401) throw new ProviderError('AUTH', 'Tessie rejected the API token.');
    if (res.status === 429) throw new ProviderError('RATE_LIMITED', 'Tessie rate limit.', 30);
    if (res.status === 404) throw new ProviderError('NOT_FOUND', 'Unknown VIN or no access.');
    if (!res.ok) throw new ProviderError('UPSTREAM', `Tessie state failed (${res.status}).`);
    return (await res.json()) as Record<string, unknown>;
  }

  async getStatus(vin: string): Promise<string> {
    try {
      const state = await this.getState(vin);
      return String(state.state ?? state.status ?? 'awake');
    } catch (err) {
      if (err instanceof ProviderError && err.code === 'AUTH') throw err;
      return 'awake';
    }
  }

  async wake(vin: string): Promise<boolean> {
    const res = await this.req(`/${vin}/wake`, { method: 'POST', body: '{}' });
    const body = (await res.json().catch(() => ({}))) as { result?: boolean };
    return body.result === true;
  }

  async command(
    vin: string,
    name: string,
    query: Record<string, unknown>,
    maxAttempts = 1,
  ): Promise<{ result: boolean; reason?: string }> {
    for (let i = 0; i < maxAttempts; i++) {
      const res = await this.req(`/${vin}/command/${name}`, {
        method: 'POST',
        body: JSON.stringify(query),
      });
      if (res.status === 401) throw new ProviderError('AUTH', 'Tessie rejected the API token.');
      if (res.status === 402)
        throw new ProviderError('PAYMENT_REQUIRED', 'Tessie plan does not allow this.');
      if (res.status === 404) throw new ProviderError('NOT_FOUND', 'Unknown command or VIN.');
      if (res.status === 429) throw new ProviderError('RATE_LIMITED', 'Tessie rate limit.', 30);
      if (!res.ok) throw new ProviderError('UPSTREAM', `Tessie command failed (${res.status}).`);
      const body = (await res.json()) as { result?: boolean; reason?: string };
      if (typeof body.result === 'boolean') return { result: body.result, reason: body.reason };
    }
    return { result: false, reason: 'max attempts' };
  }
}

class TessieProviderImpl implements VehicleProvider {
  id = 'tessie' as const;

  private baseUrl(): string {
    return process.env.TESSIE_BASE_URL || 'https://api.tessie.com';
  }

  private token(ctx: ProviderContext): string {
    const t =
      (ctx.credentials as { token?: string; apiKey?: string }).token ??
      (ctx.credentials as { apiKey?: string }).apiKey;
    if (!t) throw new ProviderError('AUTH', 'No Tessie API token stored.');
    return t;
  }

  private client(ctx: ProviderContext): TessieClient {
    if (ctx.meta.demo) throw new ProviderError('DEMO_GUARD', 'Demo contexts cannot call Tessie.');
    return new TessieClient(this.baseUrl(), this.token(ctx));
  }

  async readiness(): Promise<{
    ok: boolean;
    checks: { name: string; ok: boolean; detail: string }[];
  }> {
    // NEW-08: real checks, never hard-coded ok.
    const base = this.baseUrl();
    const checks = [
      {
        name: 'API token configured',
        ok: Boolean(process.env.TESSIE_API_KEY),
        detail: process.env.TESSIE_API_KEY
          ? 'TESSIE_API_KEY is set.'
          : 'Set TESSIE_API_KEY from tessie.com/settings/api.',
      },
      {
        name: 'Base URL',
        ok: base.startsWith('https://'),
        detail: `Tessie base: ${base}.`,
      },
    ];
    if (process.env.TESSIE_API_KEY) {
      try {
        const res = await fetch(`${base}/vins`, {
          signal: AbortSignal.timeout(15_000),
          headers: { Authorization: `Bearer ${process.env.TESSIE_API_KEY}` },
        });
        checks.push({
          name: 'Token verification',
          ok: res.status === 200,
          detail:
            res.status === 200
              ? 'Tessie token accepted.'
              : `Tessie rejected the token (${res.status}).`,
        });
      } catch (err) {
        checks.push({
          name: 'Token verification',
          ok: false,
          detail: `Could not reach Tessie: ${(err as Error).message.slice(0, 100)}`,
        });
      }
    }
    return { ok: checks.every((c) => c.ok), checks };
  }

  async listVehicles(ctx: ProviderContext): Promise<ProviderVehicleDescriptor[]> {
    const c = this.client(ctx);
    const res = await fetch(`${this.baseUrl()}/vins`, {
      signal: AbortSignal.timeout(20_000),
      headers: { Authorization: `Bearer ${this.token(ctx)}` },
    });
    if (!res.ok) throw new ProviderError('AUTH', `Tessie vehicle list failed (${res.status}).`);
    const vins =
      ((await res.json()) as { results?: string[]; vins?: string[] }).results ??
      ((await res.json().catch(() => ({}))) as { vins?: string[] }).vins ??
      [];
    const out: ProviderVehicleDescriptor[] = [];
    for (const vin of vins) {
      const raw = await c.getState(vin).catch(() => ({}));
      const state = obj(raw);
      const config = obj(state.vehicle_config);
      const carType = String(config.car_type ?? '');
      out.push({
        providerVehicleId: vin,
        displayName: String(state.display_name ?? state.vehicle_name ?? `Tessie ${vin.slice(-4)}`),
        make: 'Tesla',
        model: modelNameFromCarType(carType),
        year: modelYearFromVin(vin),
        vehicleClass: vehicleClassFromCarType(carType),
        exteriorColor: colorHexFromTesla(state.exterior_color ?? state.color),
        vinLast4: vin.slice(-4),
        capabilities: deriveHardwareCapabilities(state),
      });
    }
    return out;
  }

  async fetchState(ctx: ProviderContext, providerVehicleId: string): Promise<FetchStateResult> {
    const state = await this.client(ctx).getState(providerVehicleId);
    const sleep = String(state.state ?? '');
    const mapped = mapTeslaVehicleData(state, {
      sleep:
        sleep === 'asleep'
          ? 'asleep'
          : sleep === 'waiting_for_sleep'
            ? 'waiting_for_sleep'
            : 'awake',
    });
    return {
      state: { ...mapped, vehicleId: undefined } as never,
      live: sleep !== 'asleep',
      freshForSec: 60,
    };
  }

  async sendCommand(
    ctx: ProviderContext,
    providerVehicleId: string,
    type: CommandType,
    params: CommandParams,
  ): Promise<CommandDispatchResult> {
    const plan = planTessieCommand(type, params);
    if (plan.kind === 'unsupported') return { kind: 'unsupported', errorMessage: plan.reason };
    if (plan.kind === 'invalid')
      return { kind: 'rejected', errorMessage: plan.reason, providerCode: 'VALIDATION' };
    let sent = false;
    try {
      const c = this.client(ctx);
      if (plan.wakeOnly || (plan.preWake && (await c.getStatus(providerVehicleId)) !== 'awake')) {
        sent = !!plan.wakeOnly;
        if (!(await c.wake(providerVehicleId))) {
          return {
            kind: 'timed_out',
            errorMessage: 'Vehicle did not wake within 90 s (Tessie).',
            providerCode: 'WAKE_TIMEOUT',
          };
        }
        if (plan.wakeOnly)
          return {
            kind: 'accepted',
            response: 'Tessie reports the vehicle awake.',
            providerCode: 'OK',
          };
      }
      if (plan.guard) {
        const why = plan.guard(await c.getState(providerVehicleId));
        if (why) return { kind: 'rejected', errorMessage: why, providerCode: 'PRECHECK' };
      }
      for (const step of plan.steps) {
        sent = true;
        const r = await c.command(providerVehicleId, step.name, step.query ?? {}, step.maxAttempts);
        if (r.result) continue;
        if (r.reason === 'not supported')
          return {
            kind: 'unsupported',
            errorMessage: `Vehicle does not support ${step.name}.`,
            providerCode: 'NOT_SUPPORTED',
          };
        return {
          kind: 'rejected',
          errorMessage: friendlyReason(r.reason),
          providerCode: `RESULT_FALSE:${r.reason ?? 'none'}`,
        };
      }
      return {
        kind: 'accepted',
        response: `Tessie result=true: ${plan.steps.map((s) => s.name).join(' → ')}`,
        providerCode: 'OK',
      };
    } catch (err) {
      if (!(err instanceof ProviderError))
        return {
          kind: 'failed',
          errorMessage: 'Unexpected adapter error.',
          providerCode: 'INTERNAL',
        };
      const base = { errorMessage: err.message, providerCode: err.code };
      if (!sent) {
        return {
          kind: 'failed',
          ...base,
          retryable: !['AUTH', 'DEMO_GUARD', 'BAD_REQUEST', 'PAYMENT_REQUIRED'].includes(err.code),
          retryAfterSec: err.retryAfterSec,
        };
      }
      if (err.code === 'UPSTREAM' && !plan.idempotent) return { kind: 'outcome_unknown', ...base };
      if (err.code === 'BAD_REQUEST') return { kind: 'rejected', ...base };
      return {
        kind: 'failed',
        ...base,
        retryable: err.code === 'RATE_LIMITED' || err.code === 'UNREACHABLE',
        retryAfterSec: err.retryAfterSec,
      };
    }
  }

  async health(ctx: ProviderContext): Promise<{ ok: boolean; detail: string }> {
    try {
      const res = await fetch(`${this.baseUrl()}/vins`, {
        signal: AbortSignal.timeout(15_000),
        headers: { Authorization: `Bearer ${this.token(ctx)}` },
      });
      return { ok: res.ok, detail: `Tessie API reachable (${res.status}).` };
    } catch (e) {
      return { ok: false, detail: `Tessie API unreachable: ${(e as Error).message.slice(0, 120)}` };
    }
  }
}

export const TessieProvider = TessieProviderImpl;
