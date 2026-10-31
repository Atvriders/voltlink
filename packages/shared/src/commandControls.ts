// Parameter controls for vehicle commands (guide 07 §2.6, F-PARAMS). The web UI
// builds inputs from this table and the API validates against the same ranges.

import type { CommandType } from './commands';

export interface RangeControl {
  kind: 'range';
  param: string;
  min: number;
  max: number;
  step: number;
  unit?: string; // display unit; values are sent in the documented unit (°C, %, A, km/h, s)
  convertFromDisplay?: (display: number) => number; // imperial → canonical
}

export interface ToggleControl {
  kind: 'toggle';
  param: string;
  pinRequired?: boolean;
}

export interface PinControl {
  kind: 'pin';
  param: string;
}

export interface DestinationControl {
  kind: 'destination';
  param: string;
}

export type ParamControl = RangeControl | ToggleControl | PinControl | DestinationControl;

export const PARAM_CONTROLS: Partial<Record<CommandType, ParamControl[]>> = {
  set_temperature: [
    { kind: 'range', param: 'temperatureC', min: 15, max: 28, step: 0.5, unit: '°C' },
  ],
  set_charge_limit: [
    { kind: 'range', param: 'chargeLimitPct', min: 50, max: 100, step: 1, unit: '%' },
  ],
  set_charging_amps: [
    { kind: 'range', param: 'chargingAmps', min: 5, max: 48, step: 1, unit: 'A' },
  ],
  seat_heater: [{ kind: 'range', param: 'seatLevel', min: 0, max: 3, step: 1 }],
  speed_limit: [
    { kind: 'range', param: 'speedLimitKmh', min: 80, max: 145, step: 1, unit: 'km/h' },
    { kind: 'toggle', param: 'speedLimitOn' },
    { kind: 'pin', param: 'pin' },
  ],
  schedule_update: [
    { kind: 'range', param: 'updateDelaySec', min: 0, max: 7200, step: 60, unit: 's' },
  ],
  steering_heater: [{ kind: 'toggle', param: 'steeringOn' }],
  sentry_mode: [{ kind: 'toggle', param: 'sentryOn' }],
  valet_mode: [
    { kind: 'toggle', param: 'valetOn' },
    { kind: 'pin', param: 'pin' },
  ],
  defrost: [{ kind: 'toggle', param: 'defrostOn' }],
  send_navigation: [{ kind: 'destination', param: 'destination' }],
};

export function controlsFor(type: CommandType): ParamControl[] {
  return PARAM_CONTROLS[type] ?? [];
}
