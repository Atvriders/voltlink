// Signed commands through the Vehicle Command Protocol proxy (guide 01 §9,
// P-TESLASIGN). Every /command/* call goes to TESLA_COMMAND_PROXY_URL with the
// user's token; the proxy forwards legacy REST cars by itself.

import type { CommandParams, CommandType } from '@voltlink/shared';

export interface CmdCtx {
  pin?: string;
  userLocation?: { lat: number; lon: number };
  rhd?: boolean;
  snapshotLat?: number;
  snapshotLon?: number;
  speedLimitMinMph?: number;
  speedLimitMaxMph?: number;
  tempMinC?: number;
  tempMaxC?: number;
  chargeLimitMinPct?: number;
  chargeLimitMaxPct?: number;
  chargeCurrentMaxA?: number;
}

export interface CommandStep {
  name: string;
  body: Record<string, unknown>;
  idempotent: boolean;
}

const one = (
  name: string,
  idempotent: boolean,
  body: Record<string, unknown> = {},
): CommandStep[] => [{ name, body, idempotent }];

const clamp = (v: number, min?: number, max?: number) => Math.min(max ?? v, Math.max(min ?? v, v));

export function buildTeslaSteps(type: CommandType, p: CommandParams, ctx: CmdCtx): CommandStep[] {
  switch (type) {
    case 'wake':
      return one('wake_up', true); // sent DIRECT to the fleet host, not the proxy
    case 'lock':
      return one('door_lock', true);
    case 'unlock':
      return one('door_unlock', true);
    case 'climate_start':
      return one('auto_conditioning_start', true);
    case 'climate_stop':
      return one('auto_conditioning_stop', true);
    case 'set_temperature':
      return one('set_temps', true, {
        driver_temp: clamp(Number(p.temperatureC ?? 21), ctx.tempMinC, ctx.tempMaxC),
        passenger_temp: clamp(Number(p.temperatureC ?? 21), ctx.tempMinC, ctx.tempMaxC),
      });
    case 'defrost':
      return one('set_preconditioning_max', true, {
        on: p.defrostOn !== false,
        manual_override: false,
      });
    case 'seat_heater':
      return one('remote_seat_heater_request', true, {
        seat_position: ctx.rhd ? 1 : 0,
        level: p.seatLevel ?? 1,
      });
    case 'steering_heater':
      return one('remote_steering_wheel_heater_request', true, { on: p.steeringOn ?? true });
    case 'charge_start':
      return one('charge_start', true);
    case 'charge_stop':
      return one('charge_stop', true);
    case 'set_charge_limit':
      return one('set_charge_limit', true, {
        percent: clamp(
          Number(p.chargeLimitPct ?? 80),
          ctx.chargeLimitMinPct,
          ctx.chargeLimitMaxPct,
        ),
      });
    case 'set_charging_amps':
      return one('set_charging_amps', true, {
        charging_amps: clamp(Number(p.chargingAmps ?? 32), 1, ctx.chargeCurrentMaxA),
      });
    case 'charge_port_open':
      return one('charge_port_door_open', true);
    case 'charge_port_close':
      return one('charge_port_door_close', true);
    case 'open_trunk':
      return one('actuate_trunk', false, { which_trunk: 'rear' });
    case 'open_frunk':
      return one('actuate_trunk', false, { which_trunk: 'front' });
    case 'window_vent':
      return one('window_control', true, { command: 'vent' });
    case 'window_close':
      return one('window_control', true, {
        command: 'close',
        ...(ctx.userLocation ? { lat: ctx.userLocation.lat, lon: ctx.userLocation.lon } : {}),
      });
    case 'sentry_mode':
      return one('set_sentry_mode', true, { on: p.sentryOn ?? true });
    case 'flash_lights':
      return one('flash_lights', false);
    case 'honk_horn':
      return one('honk_horn', false);
    case 'homelink':
      return one('trigger_homelink', false, {
        lat: ctx.snapshotLat ?? 0,
        lon: ctx.snapshotLon ?? 0,
      });
    case 'remote_start':
      return one('remote_start_drive', true);
    case 'valet_mode':
      return one(
        'set_valet_mode',
        true,
        p.valetOn ? { on: true, password: ctx.pin ?? '' } : { on: false },
      );
    case 'speed_limit': {
      const steps: CommandStep[] = [];
      if (p.speedLimitOn === false) {
        steps.push({
          name: 'speed_limit_deactivate',
          body: { pin: ctx.pin ?? '' },
          idempotent: true,
        });
      } else {
        const mph = Math.round((p.speedLimitKmh ?? 110) / 1.609344);
        steps.push({
          name: 'speed_limit_set_limit',
          body: { limit_mph: clamp(mph, ctx.speedLimitMinMph, ctx.speedLimitMaxMph) },
          idempotent: true,
        });
        steps.push({
          name: 'speed_limit_activate',
          body: { pin: ctx.pin ?? '' },
          idempotent: true,
        });
      }
      return steps;
    }
    case 'send_navigation': {
      const d = p.destination;
      const text =
        d && Number.isFinite(d.lat) && Number.isFinite(d.lon)
          ? `${d.lat!.toFixed(6)},${d.lon!.toFixed(6)}`
          : (d?.name?.trim() ?? '');
      return one('navigation_request', false, {
        type: 'share_ext_content_raw',
        value: {
          'android.intent.ACTION': 'android.intent.action.SEND',
          'android.intent.TYPE': 'text/plain',
          'android.intent.extra.TEXT': text,
        },
        locale: 'en-US',
        timestamp_ms: String(Date.now()),
      });
    }
    case 'schedule_update':
      return one('schedule_software_update', true, { offset_sec: p.updateDelaySec ?? 30 });
    case 'cancel_update':
      return one('cancel_software_update', true);
    default:
      return [];
  }
}
