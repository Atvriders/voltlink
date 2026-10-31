// VoltLink auth, settings, and API envelope types.

import { z } from 'zod';

export interface UserPublic {
  id: string;
  email: string;
  name: string;
  role: string;
  emailVerified: boolean;
  totpEnabled: boolean;
  passkeyEnabled: boolean;
  timezone: string;
  units: 'metric' | 'imperial';
  theme: string;
  demoEnabled: boolean;
  presentationMode: boolean;
  onboardingCompletedAt?: string | null;
  onboardingStep?: string;
  favoriteVehicleIds?: string[];
  createdAt: string;
}

export interface SessionInfo {
  id: string;
  current: boolean;
  ip: string;
  userAgent: string;
  createdAt: string;
  lastSeenAt?: string;
  expiresAt: string;
}

// ---- API envelope ----

export interface ApiErrorBody {
  code: string;
  message: string;
  requestId?: string;
  details?: unknown;
}

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  sort: z.string().optional(),
  order: z.enum(['asc', 'desc']).optional().default('desc'),
});
export type PaginationQuery = z.infer<typeof paginationSchema>;

export interface Settings {
  units: 'metric' | 'imperial';
  timezone: string;
  locale: string;
  theme: string;
  telemetryRetentionDays: number;
  locationRetentionDays: number;
  demoMode: boolean;
  presentationMode: boolean;
  globalReadOnly: boolean;
  commandsEnabled: boolean;
  providerCommandsEnabled: boolean;
  vehicleCommandsEnabled: boolean;
  orgName: string;
  orgLogoUrl?: string;
}

export interface RetentionSettings {
  telemetryRetentionDays: number;
  locationRetentionDays: number;
}

export interface ExportSummary {
  user: UserPublic;
  vehicles: number;
  drives: number;
  chargeSessions: number;
  telemetryPoints: number;
  commands: number;
  notifications: number;
  automations: number;
  generatedAt: string;
}

export interface HealthInfo {
  process: string;
  version: string;
  uptimeSec: number;
  database: 'ok' | 'error';
  redis: 'ok' | 'error' | 'unused';
  migrationsCurrent: boolean;
  queueDepth: number;
  workersActive: boolean;
  schedulerActive: boolean;
  telemetryFresh: boolean;
  memoryMb: number;
}
