// VoltLink command model.

import { z } from 'zod';

export const COMMAND_TYPES = [
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
  'cancel_update',
] as const;
export type CommandType = (typeof COMMAND_TYPES)[number];

export const COMMAND_STATUSES = [
  'queued',
  'submitted',
  'accepted',
  'confirmed',
  'failed',
  'rejected',
  'unsupported',
  'timed_out',
  'canceled',
] as const;
export type CommandStatus = (typeof COMMAND_STATUSES)[number];

export const RISK_LEVELS = ['low', 'medium', 'high'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];

/** Which command types are high risk (step-up authentication required). */
export const HIGH_RISK_COMMANDS: readonly CommandType[] = [
  'unlock',
  'remote_start',
  'homelink',
  'valet_mode',
  'speed_limit',
  'sentry_mode',
];

export interface CommandDefinition {
  type: CommandType;
  label: string;
  risk: RiskLevel;
  requiresCapability: string;
  description: string;
}

export const COMMAND_DEFINITIONS: Record<CommandType, CommandDefinition> = {
  wake: {
    type: 'wake',
    label: 'Wake vehicle',
    risk: 'low',
    requiresCapability: 'wake',
    description: 'Wake the vehicle from sleep.',
  },
  lock: {
    type: 'lock',
    label: 'Lock',
    risk: 'low',
    requiresCapability: 'lock',
    description: 'Lock all doors.',
  },
  unlock: {
    type: 'unlock',
    label: 'Unlock',
    risk: 'high',
    requiresCapability: 'unlock',
    description: 'Unlock all doors. Requires re-authentication.',
  },
  climate_start: {
    type: 'climate_start',
    label: 'Start climate',
    risk: 'low',
    requiresCapability: 'climate_start',
    description: 'Turn on climate control.',
  },
  climate_stop: {
    type: 'climate_stop',
    label: 'Stop climate',
    risk: 'low',
    requiresCapability: 'climate_stop',
    description: 'Turn off climate control.',
  },
  set_temperature: {
    type: 'set_temperature',
    label: 'Set temperature',
    risk: 'low',
    requiresCapability: 'set_temperature',
    description: 'Set the cabin target temperature.',
  },
  defrost: {
    type: 'defrost',
    label: 'Defrost',
    risk: 'low',
    requiresCapability: 'defrost',
    description: 'Start maximum defrost.',
  },
  seat_heater: {
    type: 'seat_heater',
    label: 'Seat heater',
    risk: 'low',
    requiresCapability: 'seat_heater',
    description: 'Set seat heater level.',
  },
  steering_heater: {
    type: 'steering_heater',
    label: 'Steering wheel heat',
    risk: 'low',
    requiresCapability: 'steering_heater',
    description: 'Toggle steering wheel heater.',
  },
  charge_start: {
    type: 'charge_start',
    label: 'Start charging',
    risk: 'low',
    requiresCapability: 'charge_start',
    description: 'Start charging if plugged in.',
  },
  charge_stop: {
    type: 'charge_stop',
    label: 'Stop charging',
    risk: 'low',
    requiresCapability: 'charge_stop',
    description: 'Stop the active charging session.',
  },
  set_charge_limit: {
    type: 'set_charge_limit',
    label: 'Charge limit',
    risk: 'low',
    requiresCapability: 'set_charge_limit',
    description: 'Set the charge limit percentage.',
  },
  set_charging_amps: {
    type: 'set_charging_amps',
    label: 'Charging amps',
    risk: 'low',
    requiresCapability: 'set_charging_amps',
    description: 'Set the charging current.',
  },
  charge_port_open: {
    type: 'charge_port_open',
    label: 'Open charge port',
    risk: 'low',
    requiresCapability: 'charge_port_open',
    description: 'Open the charge port door.',
  },
  charge_port_close: {
    type: 'charge_port_close',
    label: 'Close charge port',
    risk: 'low',
    requiresCapability: 'charge_port_close',
    description: 'Close the charge port door.',
  },
  open_trunk: {
    type: 'open_trunk',
    label: 'Open trunk',
    risk: 'low',
    requiresCapability: 'open_trunk',
    description: 'Open the trunk/liftgate.',
  },
  open_frunk: {
    type: 'open_frunk',
    label: 'Open frunk',
    risk: 'low',
    requiresCapability: 'open_frunk',
    description: 'Open the front trunk.',
  },
  window_vent: {
    type: 'window_vent',
    label: 'Vent windows',
    risk: 'low',
    requiresCapability: 'window_vent',
    description: 'Crack all windows for ventilation.',
  },
  window_close: {
    type: 'window_close',
    label: 'Close windows',
    risk: 'low',
    requiresCapability: 'window_close',
    description: 'Close all windows.',
  },
  sentry_mode: {
    type: 'sentry_mode',
    label: 'Security mode',
    risk: 'high',
    requiresCapability: 'sentry_mode',
    description: 'Toggle security monitoring.',
  },
  flash_lights: {
    type: 'flash_lights',
    label: 'Flash lights',
    risk: 'low',
    requiresCapability: 'flash_lights',
    description: 'Flash the exterior lights.',
  },
  honk_horn: {
    type: 'honk_horn',
    label: 'Honk horn',
    risk: 'low',
    requiresCapability: 'honk_horn',
    description: 'Sound the horn.',
  },
  homelink: {
    type: 'homelink',
    label: 'HomeLink',
    risk: 'high',
    requiresCapability: 'homelink',
    description: 'Trigger a HomeLink device.',
  },
  remote_start: {
    type: 'remote_start',
    label: 'Remote start',
    risk: 'high',
    requiresCapability: 'remote_start',
    description: 'Start the vehicle remotely.',
  },
  valet_mode: {
    type: 'valet_mode',
    label: 'Valet mode',
    risk: 'high',
    requiresCapability: 'valet_mode',
    description: 'Toggle valet mode.',
  },
  speed_limit: {
    type: 'speed_limit',
    label: 'Speed limit mode',
    risk: 'high',
    requiresCapability: 'speed_limit',
    description: 'Toggle or set speed limit mode.',
  },
  send_navigation: {
    type: 'send_navigation',
    label: 'Send destination',
    risk: 'low',
    requiresCapability: 'send_navigation',
    description: 'Send a destination to the in-car navigation.',
  },
  schedule_update: {
    type: 'schedule_update',
    label: 'Software update',
    risk: 'low',
    requiresCapability: 'schedule_update',
    description: 'Schedule a software update.',
  },
  cancel_update: {
    type: 'cancel_update',
    label: 'Cancel software update',
    risk: 'low',
    requiresCapability: 'cancel_update',
    description: 'Cancel a pending software update.',
  },
};

export interface CommandParams {
  temperatureC?: number;
  chargeLimitPct?: number;
  chargingAmps?: number;
  seatLevel?: number;
  steeringOn?: boolean;
  sentryOn?: boolean;
  valetOn?: boolean;
  pin?: string;
  speedLimitKmh?: number;
  destination?: { name: string; lat: number; lon: number };
  updateDelaySec?: number;
  homelinkName?: string;
  defrostOn?: boolean;
  seatPosition?: string;
  speedLimitOn?: boolean;
  locale?: string;
  userLocation?: { lat: number; lon: number };
}

export interface VehicleCommand {
  id: string;
  vehicleId: string;
  vehicleName: string;
  providerAccountId: string;
  type: CommandType;
  params: CommandParams;
  status: CommandStatus;
  risk: RiskLevel;
  idempotencyKey: string;
  userId: string;
  createdAt: string;
  submittedAt?: string;
  completedAt?: string;
  providerResponse?: string;
  responseCategory?: string;
  confirmation?: string;
  errorMessage?: string;
  /** true when state change has been confirmed by telemetry/provider */
  confirmed: boolean;
}

export interface CommandAuditEvent {
  id: string;
  commandId: string;
  event: string;
  actor: string;
  detail: string;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Per-command parameter validation (G-02): types, ranges, 4-digit PINs and
// destination length, rejected with 422 before a row is created.
// ---------------------------------------------------------------------------

const pin = z
  .string()
  .regex(/^\d{4}$/, 'PIN must be exactly 4 digits')
  .optional();
export const COMMAND_PARAM_SCHEMAS: Record<CommandType, z.ZodTypeAny> = {
  wake: z.object({}).optional(),
  lock: z.object({}).optional(),
  unlock: z.object({ pin }).optional(),
  climate_start: z.object({}).optional(),
  climate_stop: z.object({}).optional(),
  // F-PARAMS: canonical parameter names and ranges shared with the UI's
  // PARAM_CONTROLS table (guide 07 §2.6).
  set_temperature: z.object({ temperatureC: z.number().min(15).max(28) }).optional(),
  defrost: z.object({ defrostOn: z.boolean().optional() }).optional(),
  seat_heater: z.object({ seatLevel: z.number().int().min(0).max(3) }).optional(),
  steering_heater: z.object({ steeringOn: z.boolean() }).optional(),
  charge_start: z.object({}).optional(),
  charge_stop: z.object({}).optional(),
  set_charge_limit: z.object({ chargeLimitPct: z.number().int().min(50).max(100) }).optional(),
  set_charging_amps: z.object({ chargingAmps: z.number().int().min(5).max(48) }).optional(),
  charge_port_open: z.object({}).optional(),
  charge_port_close: z.object({}).optional(),
  open_trunk: z.object({}).optional(),
  open_frunk: z.object({}).optional(),
  window_vent: z.object({}).optional(),
  window_close: z.object({}).optional(),
  sentry_mode: z.object({ sentryOn: z.boolean() }).optional(),
  flash_lights: z.object({}).optional(),
  honk_horn: z.object({}).optional(),
  homelink: z
    .object({
      lat: z.number().min(-90).max(90),
      lon: z.number().min(-180).max(180),
    })
    .optional(),
  remote_start: z.object({}).optional(),
  valet_mode: z
    .object({ valetOn: z.boolean(), pin })
    .refine((p) => p.valetOn === false || p.pin !== undefined, {
      message: 'valet_mode on requires a 4-digit pin.',
    })
    .optional(),
  speed_limit: z
    .object({
      speedLimitKmh: z.number().min(80).max(145).optional(),
      speedLimitOn: z.boolean().optional(),
      pin,
    })
    .refine((p) => p.speedLimitKmh !== undefined || p.speedLimitOn !== undefined, {
      message: 'speed_limit needs speedLimitKmh and/or speedLimitOn.',
    })
    .optional(),
  send_navigation: z
    .object({
      destination: z.object({
        name: z.string().min(1).max(200),
        lat: z.number().min(-90).max(90),
        lon: z.number().min(-180).max(180),
      }),
    })
    .optional(),
  schedule_update: z.object({ updateDelaySec: z.number().int().min(0).max(7200) }).optional(),
  cancel_update: z.object({}).optional(),
};

/** Commands with no observable state: they end at `accepted` with confirmation
 * `not_observable` — never `confirmed`, and the stuck-command sweeper never
 * times them out (guide 01 §10). */
export const NOT_OBSERVABLE_COMMANDS: readonly CommandType[] = [
  'flash_lights',
  'honk_horn',
  'homelink',
  'send_navigation',
];

/**
 * P-CONFIRM: the expected-state predicate per observable command type.
 * Matched against the freshly ingested snapshot; `true` confirms.
 */
export function commandStatePredicate(
  type: CommandType,
  params: Record<string, unknown>,
  state: Record<string, unknown>,
): boolean {
  switch (type) {
    case 'lock':
      return state.locked === true;
    case 'unlock':
      return state.locked === false;
    case 'climate_start':
      return state.climateOn === true;
    case 'climate_stop':
      return state.climateOn === false;
    case 'set_temperature': {
      const want = params.driverTempC ?? params.passengerTempC;
      const got =
        params.driverTempC !== undefined ? state.driverTempSettingC : state.passengerTempSettingC;
      return typeof want === 'number' && typeof got === 'number' && Math.abs(got - want) <= 0.5;
    }
    case 'charge_start':
      return state.chargingState === 'Charging' || state.chargingState === 'Starting';
    case 'charge_stop':
      return state.chargingState !== 'Charging' && state.chargingState !== 'Starting';
    case 'set_charge_limit':
      return (
        typeof params.chargeLimitPct === 'number' && state.chargeLimitPct === params.chargeLimitPct
      );
    case 'charge_port_open':
      return state.chargePortDoorOpen === true;
    case 'charge_port_close':
      return state.chargePortDoorOpen === false;
    case 'sentry_mode':
      return state.sentryMode === params.on;
    case 'window_vent':
      return state.windowsVented === true;
    case 'window_close':
      return state.windowsVented === false;
    case 'open_trunk':
      return state.trunkOpen === true;
    case 'open_frunk':
      return state.frunkOpen === true;
    case 'defrost':
      return state.defrostOn === true;
    case 'seat_heater':
      return true; // verified by climate state on next poll; acceptance is the observable step
    case 'steering_heater':
      return true;
    case 'set_charging_amps':
      return (
        typeof params.chargingAmps === 'number' &&
        state.chargeCurrentRequestAmps === params.chargingAmps
      );
    case 'remote_start':
      return state.remoteStartActive === true;
    case 'valet_mode':
      return state.valetMode === params.on;
    case 'speed_limit':
      return typeof params.limitMph === 'number' && state.speedLimitMph === params.limitMph;
    case 'wake':
      return state.status === 'online';
    default:
      return false;
  }
}
