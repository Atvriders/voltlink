// VoltLink vehicle domain types — the normalized contract between providers,
// the API, and the web client.

export const VEHICLE_CLASSES = [
  'compact_sedan',
  'sport_sedan',
  'compact_crossover',
  'suv',
  'pickup',
  'fallback',
] as const;
export type VehicleClass = (typeof VEHICLE_CLASSES)[number];

export const PROVIDER_IDS = ['tesla', 'tessie', 'demo', 'mock'] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export const FRESHNESS = ['live', 'recent', 'stale', 'last_known'] as const;
export type Freshness = (typeof FRESHNESS)[number];

export const VEHICLE_STATUS = [
  'online',
  'asleep',
  'offline',
  'charging',
  'driving',
  'parked',
  'unknown',
] as const;
export type VehicleStatus = (typeof VEHICLE_STATUS)[number];

export const CHARGE_STATES = [
  'charging',
  'complete',
  'disconnected',
  'stopped',
  'no_power',
  'starting',
  'error',
  'unknown',
] as const;
export type ChargeState = (typeof CHARGE_STATES)[number];

export const CAPABILITIES = [
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
  'location',
] as const;
export type Capability = (typeof CAPABILITIES)[number];

export interface DoorState {
  frontLeft: boolean;
  frontRight: boolean;
  rearLeft: boolean;
  rearRight: boolean;
}

export interface TirePressures {
  frontLeft: number; // kPa
  frontRight: number;
  rearLeft: number;
  rearRight: number;
}

/** Normalized, provider-independent vehicle state. */
export interface VehicleState {
  vehicleId: string;
  provider: ProviderId;
  providerVehicleId: string;
  fetchedAt: string; // ISO
  freshness: Freshness;
  status: VehicleStatus;
  dataSource: 'telemetry' | 'command_confirmation' | 'estimated';
  // Battery
  batteryPercent?: number;
  batteryRangeKm?: number;
  chargeLimitPct?: number;
  batteryCapacityKwh?: number; // estimated usable capacity
  // Charging
  chargingState?: ChargeState;
  chargePowerKw?: number;
  chargeCurrentA?: number;
  chargeAmpsRequest?: number;
  chargeVoltageV?: number;
  chargerPhases?: number;
  timeToFullChargeMin?: number;
  chargePortOpen?: boolean;
  plugConnected?: boolean;
  chargeEnergyAddedKwh?: number; // current session
  // Climate
  climateOn?: boolean;
  insideTempC?: number;
  outsideTempC?: number;
  driverTempSettingC?: number;
  fanLevel?: number;
  defrostOn?: boolean;
  isPreconditioning?: boolean;
  seatHeaterLevel?: number;
  steeringHeaterOn?: boolean;
  // Locks / closures
  locked?: boolean;
  doors?: DoorState;
  trunkOpen?: boolean;
  frunkOpen?: boolean;
  windowsOpen?: boolean;
  // Lights / security
  sentryMode?: boolean;
  alarmState?: 'off' | 'armed' | 'triggered';
  /** Transient client-side signal while a flash-lights command is pending. */
  flashLightsBlink?: boolean;
  valetMode?: boolean;
  speedLimitMode?: { active: boolean; limitKmh?: number };
  // Location
  lat?: number;
  lon?: number;
  headingDeg?: number;
  speedKmh?: number;
  address?: string;
  // Vehicle info
  odometerKm?: number;
  softwareVersion?: string;
  softwareUpdate?: { status: string; version?: string };
  tirePressureKpa?: TirePressures;
  updatedSecAgo?: number;
}

export interface VehicleInfo {
  id: string;
  displayName: string;
  provider: ProviderId;
  providerVehicleId: string;
  vehicleClass: VehicleClass;
  make?: string;
  model?: string;
  year?: number;
  exteriorColor?: string;
  wheelStyle?: string;
  vinLast4?: string;
  capabilities: Capability[];
  demo: boolean;
  ownerId: string;
  providerAccountId: string;
  providerAccountLabel?: string;
  groupIds: string[];
  createdAt: string;
}

export interface VehicleWithState extends VehicleInfo {
  state: VehicleState | null;
}

export interface ProviderInfo {
  id: string;
  provider: ProviderId;
  label: string;
  status: 'connected' | 'error' | 'revoked' | 'pending';
  demo: boolean;
  lastSyncAt?: string;
  lastError?: string;
  vehicleCount: number;
  scopes?: string[];
}

export interface ProviderReadiness {
  provider: ProviderId;
  label: string;
  configured: boolean;
  ok: boolean;
  checks: { name: string; ok: boolean; detail: string }[];
}
