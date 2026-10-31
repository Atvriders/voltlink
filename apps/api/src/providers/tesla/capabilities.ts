// Per-vehicle capability discovery (guide 01 §8, NEW-07). No fixed list; what a
// vehicle can do comes from scopes, vehicle_data and fleet_status.

import type { Capability } from '@voltlink/shared';

type Obj = Record<string, unknown>;
const o = (v: unknown): Obj => (v && typeof v === 'object' ? (v as Obj) : {});
const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export interface CapabilityDetail {
  supported: boolean;
  usable: boolean;
  reason?: 'missing_scope' | 'pending_discovery' | 'not_equipped' | 'virtual_key_not_paired';
  min?: number;
  max?: number;
}

export function deriveTeslaCapabilities(i: {
  scopes: string[];
  hidePrivate: boolean;
  vd?: Obj;
  fleet?: { protocolRequired: boolean; keyPaired: boolean } | null;
}): { capabilities: Capability[]; details: Partial<Record<Capability, CapabilityDetail>> } {
  const has = (s: string) => i.scopes.includes(s);
  const cmds = has('vehicle_cmds');
  const chg = cmds || has('vehicle_charging_cmds'); // either scope suffices
  const cfg = o(i.vd?.vehicle_config);
  const vs = o(i.vd?.vehicle_state);
  const cl = o(i.vd?.climate_state);
  const cs = o(i.vd?.charge_state);
  const hw = (ok: boolean) => (i.vd ? ok : null); // null = pending discovery
  const rules: Array<[Capability, boolean, boolean | null, Partial<CapabilityDetail>?]> = [
    ['location', has('vehicle_location') && !i.hidePrivate, true],
    ['wake', has('vehicle_device_data'), true],
    ['lock', cmds, true],
    ['unlock', cmds, true],
    ['flash_lights', cmds, true],
    ['honk_horn', cmds, true],
    ['climate_start', cmds, true],
    ['climate_stop', cmds, true],
    ['defrost', cmds, true],
    ['set_temperature', cmds, true, { min: n(cl.min_avail_temp), max: n(cl.max_avail_temp) }],
    ['seat_heater', cmds, hw(n(cl.seat_heater_left) !== undefined)],
    ['steering_heater', cmds, hw(typeof cl.steering_wheel_heater === 'boolean')],
    ['charge_start', chg, true],
    ['charge_stop', chg, true],
    ['charge_port_open', chg, true],
    [
      'set_charge_limit',
      chg,
      true,
      { min: n(cs.charge_limit_soc_min), max: n(cs.charge_limit_soc_max) },
    ],
    ['set_charging_amps', chg, true, { min: 1, max: n(cs.charge_current_request_max) }],
    ['charge_port_close', chg, hw(cfg.motorized_charge_port === true)],
    ['open_trunk', cmds, hw(cfg.can_actuate_trunks === true)],
    ['open_frunk', cmds, hw(cfg.can_actuate_trunks === true)],
    ['window_vent', cmds, hw(n(vs.fd_window) !== undefined)],
    ['window_close', cmds, hw(n(vs.fd_window) !== undefined)],
    ['sentry_mode', cmds, hw(vs.sentry_mode_available === true)],
    ['remote_start', cmds, hw(vs.remote_start_supported === true)],
    ['homelink', cmds && has('vehicle_location'), hw((n(vs.homelink_device_count) ?? 0) > 0)],
    ['valet_mode', cmds, hw(typeof vs.valet_mode === 'boolean')],
    ['speed_limit', cmds, hw(Object.keys(o(vs.speed_limit_mode)).length > 0)],
    ['send_navigation', cmds, hw(cfg.can_accept_navigation_requests === true)],
    ['schedule_update', cmds, hw(typeof vs.software_update === 'object')],
    ['cancel_update', cmds, hw(typeof vs.software_update === 'object')],
  ];
  const keyBlocked = !!i.fleet && i.fleet.protocolRequired && !i.fleet.keyPaired;
  const details: Partial<Record<Capability, CapabilityDetail>> = {};
  for (const [cap, scopeOk, hwOk, extra] of rules) {
    const signed = !['location', 'wake'].includes(cap);
    const reason = !scopeOk
      ? 'missing_scope'
      : hwOk === null
        ? 'pending_discovery'
        : !hwOk
          ? 'not_equipped'
          : signed && keyBlocked
            ? 'virtual_key_not_paired'
            : undefined;
    details[cap] = { supported: scopeOk && hwOk !== false, usable: !reason, reason, ...extra };
  }
  const capabilities = (Object.keys(details) as Capability[]).filter((c) => details[c]!.usable);
  return { capabilities, details };
}
