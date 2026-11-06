// Tesla command step builder: every documented control with parameter
// variants, clamps and context-dependent branches (guide 01 §9, P-TESLASIGN).
import { describe, expect, it } from 'vitest';
import { buildTeslaSteps, type CmdCtx } from './commands';
import type { CommandType } from '@voltlink/shared';

const ctx: CmdCtx = {
  pin: '1234',
  userLocation: { lat: 47.6, lon: -122.3 },
  rhd: true,
  snapshotLat: 47.7,
  snapshotLon: -122.4,
  speedLimitMinMph: 50,
  speedLimitMaxMph: 85,
  tempMinC: 15,
  tempMaxC: 28,
  chargeLimitMinPct: 50,
  chargeLimitMaxPct: 100,
  chargeCurrentMaxA: 48,
};

describe('buildTeslaSteps', () => {
  const simple = (type: CommandType) => buildTeslaSteps(type, {}, ctx);

  it('builds simple steps for lock, unlock, climate and charging controls', () => {
    expect(simple('wake')).toEqual([{ name: 'wake_up', body: {}, idempotent: true }]);
    expect(simple('lock')[0]).toMatchObject({ name: 'door_lock', idempotent: true });
    expect(simple('unlock')[0]).toMatchObject({ name: 'door_unlock' });
    expect(simple('climate_start')[0]).toMatchObject({ name: 'auto_conditioning_start' });
    expect(simple('climate_stop')[0]).toMatchObject({ name: 'auto_conditioning_stop' });
    expect(simple('charge_start')[0]).toMatchObject({ name: 'charge_start' });
    expect(simple('charge_stop')[0]).toMatchObject({ name: 'charge_stop' });
    expect(simple('charge_port_open')[0]).toMatchObject({ name: 'charge_port_door_open' });
    expect(simple('charge_port_close')[0]).toMatchObject({ name: 'charge_port_door_close' });
    expect(simple('remote_start')[0]).toMatchObject({ name: 'remote_start_drive' });
    expect(simple('schedule_update')[0]).toMatchObject({ body: { offset_sec: 30 } });
    expect(simple('cancel_update')[0]).toMatchObject({ name: 'cancel_software_update' });
    expect(buildTeslaSteps('not_a_command' as never, {}, ctx)).toEqual([]);
  });

  it('clamps temperature and charge parameters to the context limits', () => {
    const hot = buildTeslaSteps('set_temperature', { temperatureC: 40 }, ctx)[0]!;
    expect(hot.body).toEqual({ driver_temp: 28, passenger_temp: 28 });
    const cold = buildTeslaSteps('set_temperature', { temperatureC: 5 }, ctx)[0]!;
    expect(cold.body).toEqual({ driver_temp: 15, passenger_temp: 15 });
    const limit = buildTeslaSteps('set_charge_limit', { chargeLimitPct: 120 }, ctx)[0]!;
    expect(limit.body).toEqual({ percent: 100 });
    const amps = buildTeslaSteps('set_charging_amps', { chargingAmps: 99 }, ctx)[0]!;
    expect(amps.body).toEqual({ charging_amps: 48 });
  });

  it('uses context for defrost, seat/steering heat, RHD and windows', () => {
    expect(buildTeslaSteps('defrost', {}, ctx)[0]!.body).toEqual({
      on: true,
      manual_override: false,
    });
    expect(buildTeslaSteps('defrost', { defrostOn: false }, ctx)[0]!.body.on).toBe(false);
    expect(buildTeslaSteps('seat_heater', {}, ctx)[0]!.body).toEqual({
      seat_position: 1,
      level: 1,
    });
    const lhd = { ...ctx, rhd: false };
    expect(buildTeslaSteps('seat_heater', { seatLevel: 3 }, lhd)[0]!.body).toEqual({
      seat_position: 0,
      level: 3,
    });
    expect(buildTeslaSteps('steering_heater', {}, ctx)[0]!.body).toEqual({ on: true });
    expect(buildTeslaSteps('window_vent', {}, ctx)[0]).toMatchObject({ name: 'window_control' });
    const close = buildTeslaSteps('window_close', {}, ctx)[0]!;
    expect(close.body).toEqual({ command: 'close', lat: 47.6, lon: -122.3 });
    expect(buildTeslaSteps('window_close', {}, { ...ctx, userLocation: undefined })[0]!.body).toEqual({
      command: 'close',
    });
  });

  it('builds non-idempotent trunk, lights, horn and homelink steps', () => {
    expect(buildTeslaSteps('open_trunk', {}, ctx)[0]).toMatchObject({
      name: 'actuate_trunk',
      idempotent: false,
      body: { which_trunk: 'rear' },
    });
    expect(buildTeslaSteps('open_frunk', {}, ctx)[0]!.body).toEqual({ which_trunk: 'front' });
    expect(buildTeslaSteps('flash_lights', {}, ctx)[0]!.idempotent).toBe(false);
    expect(buildTeslaSteps('honk_horn', {}, ctx)[0]!.idempotent).toBe(false);
    expect(buildTeslaSteps('homelink', {}, ctx)[0]!.body).toEqual({ lat: 47.7, lon: -122.4 });
    expect(buildTeslaSteps('homelink', {}, { ...ctx, snapshotLat: undefined })[0]!.body).toEqual({
      lat: 0,
      lon: -122.4,
    });
  });

  it('builds sentry, valet and speed-limit step sequences', () => {
    expect(buildTeslaSteps('sentry_mode', {}, ctx)[0]!.body).toEqual({ on: true });
    expect(buildTeslaSteps('sentry_mode', { sentryOn: false }, ctx)[0]!.body).toEqual({ on: false });
    expect(buildTeslaSteps('valet_mode', { valetOn: true }, ctx)[0]!.body).toEqual({
      on: true,
      password: '1234',
    });
    expect(buildTeslaSteps('valet_mode', { valetOn: false }, ctx)[0]!.body).toEqual({ on: false });

    const off = buildTeslaSteps('speed_limit', { speedLimitOn: false }, ctx);
    expect(off[0]!.name).toBe('speed_limit_deactivate');
    const on = buildTeslaSteps('speed_limit', { speedLimitKmh: 130, speedLimitOn: true }, ctx);
    expect(on[0]).toMatchObject({ name: 'speed_limit_set_limit', body: { limit_mph: 81 } });
    expect(on[1]!.name).toBe('speed_limit_activate');
  });

  it('builds navigation steps for coordinates and names', () => {
    const coords = buildTeslaSteps(
      'send_navigation',
      { destination: { name: 'Home', lat: 47.6062, lon: -122.3321 } },
      ctx,
    )[0]!;
    expect(coords.name).toBe('navigation_request');
    expect((coords.body.value as Record<string, string>)['android.intent.extra.TEXT']).toBe(
      '47.606200,-122.332100',
    );
    const named = buildTeslaSteps(
      'send_navigation',
      { destination: { name: 'Rivermark' } as never },
      ctx,
    )[0]!;
    expect((named.body.value as Record<string, string>)['android.intent.extra.TEXT']).toBe(
      'Rivermark',
    );
  });
});
