// VoltLink places, geofences, privacy zones, automations, notifications.

export type PlaceType = 'home' | 'work' | 'public' | 'charger' | 'custom';

export interface Place {
  id: string;
  name: string;
  type: PlaceType;
  lat: number;
  lon: number;
  radiusM: number;
}

export interface Geofence {
  id: string;
  name: string;
  lat: number;
  lon: number;
  radiusM: number;
  alertOn: 'enter' | 'leave' | 'both';
  enabled: boolean;
  lastTriggeredAt?: string;
}

export interface PrivacyZone {
  id: string;
  name: string;
  lat: number;
  lon: number;
  radiusM: number;
  enabled: boolean;
}

// ---- Automations ----

export const TRIGGER_TYPES = [
  'scheduled',
  'enter_place',
  'leave_place',
  'battery_threshold',
  'charging_started',
  'charging_stopped',
  'charging_completed',
  'plug_connected',
  'door_open',
  'vehicle_parked',
  'drive_started',
  'temperature_threshold',
  'vehicle_online',
  'provider_reconnected',
  'trunk_open',
  'fault_detected',
  'webhook',
] as const;
export type TriggerType = (typeof TRIGGER_TYPES)[number];

export const CONDITION_TYPES = [
  'vehicle',
  'day',
  'time_range',
  'place',
  'battery_below',
  'battery_above',
  'charging_state',
  'plug_state',
  'previous_result',
] as const;
export type ConditionType = (typeof CONDITION_TYPES)[number];

export const ACTION_TYPES = [
  'notify_app',
  'notify_email',
  'notify_push',
  'webhook',
  'climate_start',
  'climate_stop',
  'set_temperature',
  'charge_start',
  'charge_stop',
  'set_charge_limit',
  'lock',
  'sentry_mode',
  'flash_lights',
  'honk_horn',
  'tag_drive',
  'create_incident',
  'generate_report',
] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export interface TriggerSpec {
  type: TriggerType;
  params: Record<string, unknown>;
}

export interface ConditionSpec {
  type: ConditionType;
  params: Record<string, unknown>;
}

export interface ActionSpec {
  type: ActionType;
  params: Record<string, unknown>;
}

export interface Automation {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  vehicleId?: string | null; // null = all vehicles
  trigger: TriggerSpec;
  conditions: ConditionSpec[];
  actions: ActionSpec[];
  cooldownSec: number;
  maxRetries: number;
  lastRunAt?: string;
  lastResult?: string;
  runCount: number;
  failureCount: number;
  createdAt: string;
}

export interface AutomationExecution {
  id: string;
  automationId: string;
  triggeredAt: string;
  triggerEvent?: string;
  conditionsMet: boolean;
  result: 'success' | 'failed' | 'skipped' | 'cooldown' | 'dry_run';
  actionResults: { action: ActionType; ok: boolean; detail: string }[];
  errorMessage?: string;
}

// ---- Notifications ----

export const EVENT_TYPES = [
  'battery_low',
  'charging_completed',
  'charging_started',
  'charging_stopped',
  'vehicle_online',
  'vehicle_offline',
  'command_completed',
  'command_failed',
  'geofence_enter',
  'geofence_leave',
  'automation_fired',
  'incident_created',
  'incident_updated',
  'status_change',
  'security_alert',
  'maintenance_reminder',
  'system',
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export type Severity = 'info' | 'success' | 'warning' | 'critical';

export type DeliveryChannel =
  'in_app' | 'email' | 'push' | 'webhook' | 'ntfy' | 'gotify' | 'discord' | 'teams';

export interface AppNotification {
  id: string;
  event: EventType;
  severity: Severity;
  title: string;
  body: string;
  vehicleId?: string;
  vehicleName?: string;
  readAt?: string;
  createdAt: string;
}

export interface NotificationPreference {
  channel: DeliveryChannel;
  event: EventType;
  severity: Severity;
  enabled: boolean;
}

export interface WebhookEndpoint {
  id: string;
  name: string;
  url: string;
  secret?: string; // only set on create; masked on read
  enabled: boolean;
  lastStatus?: number;
  lastDeliveryAt?: string;
}
