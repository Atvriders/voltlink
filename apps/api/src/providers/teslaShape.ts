// Pure mappers for Tesla-shaped vehicle data — Tesla body.response and Tessie
// /{vin}/state share this (guide 02 §6). No I/O, no logging.

import type {
  Capability,
  ChargeState,
  VehicleClass,
  VehicleState,
  VehicleStatus,
} from '@voltlink/shared';

type Obj = Record<string, unknown>;
export type MappedState = Omit<VehicleState, 'vehicleId' | 'provider' | 'providerVehicleId'>;
export type SleepStatus = 'asleep' | 'waiting_for_sleep' | 'awake' | 'unknown';
const MI_KM = 1.609344;

export const obj = (v: unknown): Obj =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
export function num(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}
const bool = (v: unknown) => (typeof v === 'boolean' ? v : undefined);
const flag = (v: unknown) => {
  const n = num(v);
  return n === undefined ? undefined : n !== 0;
};
const km = (mi: number | undefined) => (mi === undefined ? undefined : mi * MI_KM);
const CHARGE: Record<string, ChargeState> = {
  Charging: 'charging',
  Complete: 'complete',
  Disconnected: 'disconnected',
  Stopped: 'stopped',
  NoPower: 'no_power',
  Starting: 'starting',
};

export function mapTeslaVehicleData(
  raw: unknown,
  o: { sleep?: SleepStatus; now?: number } = {},
): MappedState {
  const b = obj(raw);
  const cs = obj(b.charge_state);
  const cl = obj(b.climate_state);
  const ds = obj(b.drive_state);
  const vs = obj(b.vehicle_state);
  const vc = obj(b.vehicle_config);
  const chargingState: ChargeState | undefined =
    typeof cs.charging_state === 'string' ? (CHARGE[cs.charging_state] ?? 'unknown') : undefined;
  const speedMph = num(ds.speed);
  const shift = typeof ds.shift_state === 'string' ? ds.shift_state : undefined;
  const top = typeof b.state === 'string' ? b.state : undefined;
  const status: VehicleStatus =
    o.sleep === 'asleep' || top === 'asleep'
      ? 'asleep'
      : top === 'offline'
        ? 'offline'
        : chargingState === 'charging' || chargingState === 'starting'
          ? 'charging'
          : shift === 'D' || shift === 'R' || shift === 'N' || (speedMph ?? 0) > 0
            ? 'driving'
            : shift === 'P'
              ? 'parked'
              : 'online';
  const ts = [cs.timestamp, cl.timestamp, ds.timestamp, vs.timestamp]
    .map(num)
    .filter((n): n is number => n !== undefined)
    .map((n) => (n < 1e12 ? n * 1000 : n));
  const rhd = vc.rhd === true;
  const [df, pf, dr, pr] = [vs.df, vs.pf, vs.dr, vs.pr].map(flag);
  const [fl, fr, rl, rr] = [
    vs.tpms_pressure_fl,
    vs.tpms_pressure_fr,
    vs.tpms_pressure_rl,
    vs.tpms_pressure_rr,
  ].map(num);
  const win = [vs.fd_window, vs.fp_window, vs.rd_window, vs.rp_window].map(flag);
  const slm = obj(vs.speed_limit_mode);
  const upd = obj(vs.software_update);
  const usable = num(cs.usable_battery_level);
  const remaining = num(cs.energy_remaining);
  const ttfHours = num(cs.time_to_full_charge);
  return {
    fetchedAt: new Date(ts.length ? Math.max(...ts) : (o.now ?? Date.now())).toISOString(),
    freshness: 'last_known',
    dataSource: 'telemetry',
    status,
    batteryPercent: num(cs.battery_level),
    batteryRangeKm: km(num(cs.battery_range)),
    chargeLimitPct: num(cs.charge_limit_soc),
    batteryCapacityKwh:
      remaining && usable ? Math.round((remaining / (usable / 100)) * 10) / 10 : undefined,
    chargingState,
    chargePowerKw: num(cs.charger_power),
    chargeCurrentA: num(cs.charger_actual_current),
    chargeAmpsRequest: num(cs.charge_current_request),
    chargeVoltageV: num(cs.charger_voltage),
    chargerPhases: num(cs.charger_phases),
    timeToFullChargeMin:
      num(cs.minutes_to_full_charge) ??
      (ttfHours === undefined ? undefined : Math.round(ttfHours * 60)),
    chargePortOpen: bool(cs.charge_port_door_open),
    chargeEnergyAddedKwh: num(cs.charge_energy_added),
    plugConnected:
      chargingState && chargingState !== 'unknown' ? chargingState !== 'disconnected' : undefined,
    climateOn: bool(cl.is_climate_on),
    insideTempC: num(cl.inside_temp),
    outsideTempC: num(cl.outside_temp),
    driverTempSettingC: num(cl.driver_temp_setting),
    fanLevel: num(cl.fan_status),
    defrostOn: flag(cl.defrost_mode),
    isPreconditioning: bool(cl.is_preconditioning),
    seatHeaterLevel: num(cl.seat_heater_left),
    steeringHeaterOn: bool(cl.steering_wheel_heater),
    locked: bool(vs.locked),
    trunkOpen: flag(vs.rt),
    frunkOpen: flag(vs.ft),
    doors: [df, pf, dr, pr].some((d) => d !== undefined)
      ? {
          frontLeft: !!(rhd ? pf : df),
          frontRight: !!(rhd ? df : pf),
          rearLeft: !!(rhd ? pr : dr),
          rearRight: !!(rhd ? dr : pr),
        }
      : undefined,
    windowsOpen: win.some((w) => w === undefined) ? undefined : win.some(Boolean),
    sentryMode: bool(vs.sentry_mode),
    valetMode: bool(vs.valet_mode),
    speedLimitMode:
      typeof slm.active === 'boolean'
        ? { active: slm.active, limitKmh: km(num(slm.current_limit_mph)) }
        : undefined,
    softwareVersion: typeof vs.car_version === 'string' ? vs.car_version.split(' ')[0] : undefined,
    softwareUpdate:
      typeof upd.status === 'string'
        ? { status: upd.status, version: typeof upd.version === 'string' ? upd.version : undefined }
        : undefined,
    odometerKm: km(num(vs.odometer)),
    tirePressureKpa:
      fl !== undefined && fr !== undefined && rl !== undefined && rr !== undefined
        ? {
            frontLeft: Math.round(fl * 100),
            frontRight: Math.round(fr * 100),
            rearLeft: Math.round(rl * 100),
            rearRight: Math.round(rr * 100),
          }
        : undefined,
    lat: num(ds.latitude),
    lon: num(ds.longitude),
    headingDeg: num(ds.heading),
    speedKmh: km(speedMph) ?? (status === 'driving' ? undefined : 0),
  };
}

const MODEL: Record<string, string> = {
  models: 'Model S',
  models2: 'Model S',
  model3: 'Model 3',
  modelx: 'Model X',
  modely: 'Model Y',
};
export const modelNameFromCarType = (t: string) =>
  MODEL[t] ?? (t.includes('cybertruck') ? 'Cybertruck' : 'Tesla');
export const vehicleClassFromCarType = (t: string): VehicleClass =>
  t.includes('cybertruck')
    ? 'pickup'
    : t === 'model3'
      ? 'compact_sedan'
      : t.startsWith('models')
        ? 'sport_sedan'
        : t === 'modely'
          ? 'compact_crossover'
          : t === 'modelx'
            ? 'suv'
            : 'fallback';
const YEAR = 'ABCDEFGHJKLMNPRSTVWXY'; // 49 CFR 565.15(d)(1)
export function modelYearFromVin(vin: string): number | undefined {
  const c = vin.length === 17 ? vin.charAt(9).toUpperCase() : '';
  const i = c ? YEAR.indexOf(c) : -1;
  return i >= 0 ? 2010 + i : /^[1-9]$/.test(c) ? 2030 + Number(c) : undefined;
}
export function colorHexFromTesla(v: unknown): string | undefined {
  const s = typeof v === 'string' ? v.toLowerCase() : '';
  const hit = (
    [
      ['white', '#eceff1'],
      ['pearl', '#eceff1'],
      ['black', '#15171a'],
      ['silver', '#b8bec4'],
      ['grey', '#5d636b'],
      ['gray', '#5d636b'],
      ['blue', '#1f3f8f'],
      ['red', '#9e1b22'],
      ['cherry', '#6d1420'],
    ] as const
  ).find(([k]) => s.includes(k));
  return hit?.[1];
}

/** Hardware-derived capabilities for Tessie (scopes don't apply there). */
export function deriveHardwareCapabilities(raw: unknown): Capability[] {
  const b = obj(raw);
  const vs = obj(b.vehicle_state);
  const vc = obj(b.vehicle_config);
  const cl = obj(b.climate_state);
  const cs = obj(b.charge_state);
  const c = new Set<Capability>([
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
    'charge_port_open',
    'window_vent',
    'window_close',
    'flash_lights',
    'honk_horn',
    'schedule_update',
    'cancel_update',
  ]);
  if (num(cs.charge_current_request_max) !== undefined) c.add('set_charging_amps');
  if (vc.motorized_charge_port === true) c.add('charge_port_close');
  if (vc.can_actuate_trunks === true) {
    c.add('open_trunk');
    c.add('open_frunk');
  }
  if (typeof cl.seat_heater_left === 'number') c.add('seat_heater');
  if (typeof cl.steering_wheel_heater === 'boolean') c.add('steering_heater');
  if (vs.sentry_mode_available === true) c.add('sentry_mode');
  if (vs.remote_start_supported === true) c.add('remote_start');
  if ((num(vs.homelink_device_count) ?? 0) > 0) c.add('homelink');
  if (typeof vs.valet_mode === 'boolean') c.add('valet_mode');
  if (Object.keys(obj(vs.speed_limit_mode)).length > 0) c.add('speed_limit');
  if (vc.can_accept_navigation_requests === true) c.add('send_navigation');
  return [...c];
}
