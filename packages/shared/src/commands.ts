// VoltLink command model.

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
