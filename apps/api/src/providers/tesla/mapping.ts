// vehicle_data mapping (guide 01 §7, P-TESLAMAP / G-04): Tesla's documented
// fields in Tesla's units, mapped to VoltLink's state shape.

import type { ChargeState } from '@voltlink/shared';

type Obj = Record<string, unknown>;
const o = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {});
const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const b = (v: unknown) => (typeof v === 'boolean' ? v : undefined);
const km = (mi: unknown) => (n(mi) === undefined ? undefined : n(mi)! * 1.609344);
const isOpen = (v: unknown) => (typeof v === 'number' ? v !== 0 : v === true);

const CHARGE: Record<string, ChargeState> = {
  Charging: 'charging',
  Complete: 'complete',
  Disconnected: 'disconnected',
  Stopped: 'stopped',
  Starting: 'starting',
  NoPower: 'no_power',
};

export function mapVehicleData(
  vd: Obj,
  conn: 'online' | 'asleep' | 'offline',
): Record<string, unknown> {
  const cs = o(vd.charge_state);
  const cl = o(vd.climate_state);
  const dr = o(vd.drive_state);
  const vs = o(vd.vehicle_state);
  const loc = o(vd.location_data);
  const cfg = o(vd.vehicle_config);
  const rhd = cfg.rhd === true;
  const charging = CHARGE[String(cs.charging_state)] ?? 'unknown';
  const shift = typeof dr.shift_state === 'string' ? dr.shift_state : null;
  const driving = shift === 'D' || shift === 'R' || shift === 'N' || (n(dr.speed) ?? 0) > 0;
  const ts = Math.max(0, ...[cs, cl, dr, vs].map((x) => n(x.timestamp) ?? 0));
  const tp = ['fl', 'fr', 'rl', 'rr'].map((k) => n(vs[`tpms_pressure_${k}`])); // bar
  const sl = o(vs.speed_limit_mode);
  return {
    fetchedAt: new Date(ts || Date.now()).toISOString(),
    status:
      conn !== 'online'
        ? conn
        : driving
          ? 'driving'
          : charging === 'charging' || charging === 'starting'
            ? 'charging'
            : 'parked',
    batteryPercent: n(cs.battery_level),
    batteryRangeKm: km(cs.battery_range),
    chargeLimitPct: n(cs.charge_limit_soc),
    chargingState: charging,
    chargePowerKw: n(cs.charger_power),
    chargeCurrentA: n(cs.charger_actual_current),
    chargeCurrentRequestA: n(cs.charge_current_request),
    chargeVoltageV: n(cs.charger_voltage),
    chargerPhases: n(cs.charger_phases),
    timeToFullChargeMin: n(cs.minutes_to_full_charge),
    chargeEnergyAddedKwh: n(cs.charge_energy_added),
    chargePortOpen: b(cs.charge_port_door_open),
    // G-04: never charge_port_latch — Tesla's own example shows latch
    // "Engaged" while charging_state is "Disconnected".
    plugConnected: charging === 'unknown' ? undefined : charging !== 'disconnected',
    climateOn: b(cl.is_climate_on),
    insideTempC: n(cl.inside_temp), // Celsius regardless of GUI units
    outsideTempC: n(cl.outside_temp),
    driverTempSettingC: n(cl.driver_temp_setting),
    fanLevel: n(cl.fan_status),
    isPreconditioning: b(cl.is_preconditioning),
    defrostOn: n(cl.defrost_mode) === undefined ? undefined : cl.defrost_mode !== 0,
    seatHeaterLevel: n(rhd ? cl.seat_heater_right : cl.seat_heater_left),
    steeringHeaterOn: b(cl.steering_wheel_heater),
    locked: b(vs.locked),
    trunkOpen: isOpen(vs.rt),
    frunkOpen: isOpen(vs.ft),
    sentryMode: b(vs.sentry_mode),
    valetMode: b(vs.valet_mode),
    doors: rhd
      ? {
          frontLeft: isOpen(vs.pf),
          rearLeft: isOpen(vs.pr),
          frontRight: isOpen(vs.df),
          rearRight: isOpen(vs.dr),
        }
      : {
          frontLeft: isOpen(vs.df),
          rearLeft: isOpen(vs.dr),
          frontRight: isOpen(vs.pf),
          rearRight: isOpen(vs.pr),
        },
    windowsOpen: ['fd_window', 'fp_window', 'rd_window', 'rp_window'].some((k) => isOpen(vs[k])),
    speedLimitMode: Object.keys(sl).length
      ? { active: sl.active === true, limitKmh: km(sl.current_limit_mph) }
      : undefined,
    lat: n(dr.latitude) ?? n(loc.latitude),
    lon: n(dr.longitude) ?? n(loc.longitude),
    headingDeg: n(dr.heading) ?? n(loc.heading),
    speedKmh: km(dr.speed),
    odometerKm: km(vs.odometer),
    softwareVersion: typeof vs.car_version === 'string' ? vs.car_version.split(' ')[0] : undefined,
    tirePressureKpa: tp.every((p) => p !== undefined)
      ? {
          frontLeft: tp[0]! * 100,
          frontRight: tp[1]! * 100,
          rearLeft: tp[2]! * 100,
          rearRight: tp[3]! * 100,
        }
      : undefined,
  };
}

/** The endpoints query for vehicle_data (semicolon-encoded, §7). */
export function vehicleDataEndpoints(opts: { hasLocationScope: boolean }): string {
  const eps = [
    'charge_state',
    'climate_state',
    'drive_state',
    'vehicle_state',
    'vehicle_config',
    'gui_settings',
  ];
  if (opts.hasLocationScope) eps.push('location_data');
  return new URLSearchParams({ endpoints: eps.join(';') }).toString();
}
