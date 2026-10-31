// Provider framework: the interface every vehicle provider implements.

import type {
  Capability,
  CommandParams,
  CommandType,
  ProviderId,
  VehicleClass,
  VehicleState,
} from '@voltlink/shared';

export interface ProviderContext {
  accountId: string;
  userId: string;
  /** Decrypted credential payload (provider-specific shape). */
  credentials: Record<string, unknown>;
  /** Provider account row extras. */
  meta: { provider: string; label: string; demo: boolean; scopes: string[] };
}

export interface ProviderVehicleDescriptor {
  providerVehicleId: string;
  displayName: string;
  make?: string;
  model?: string;
  year?: number;
  vehicleClass: VehicleClass;
  exteriorColor?: string;
  wheelStyle?: string;
  vinLast4?: string;
  capabilities: Capability[];
  capabilityDetails?: Record<
    string,
    { supported: boolean; usable: boolean; reason?: string; min?: number; max?: number }
  >;
  accessType?: string;
  hidePrivate?: boolean;
}

export interface FetchStateResult {
  /** Normalized state (without vehicleId/providerVehicleId, added by caller). */
  state: Omit<VehicleState, 'vehicleId' | 'provider' | 'providerVehicleId'>;
  /** True when the provider responded live; false = cached/last-known. */
  live: boolean;
  /** Seconds the returned data may be considered fresh. */
  freshForSec: number;
}

export type CommandResultKind =
  'accepted' | 'rejected' | 'unsupported' | 'timed_out' | 'failed' | 'outcome_unknown';

export interface CommandDispatchResult {
  kind: CommandResultKind;
  providerCode?: string;
  retryable?: boolean;
  retryAfterSec?: number;
  response?: string;
  category?: string;
  errorMessage?: string;
}

export interface VehicleProvider {
  id: ProviderId;
  /** Human-readable readiness checks for the diagnostics page. */
  readiness(
    ctx: ProviderContext,
  ): Promise<{ ok: boolean; checks: { name: string; ok: boolean; detail: string }[] }>;
  listVehicles(ctx: ProviderContext): Promise<ProviderVehicleDescriptor[]>;
  fetchState(ctx: ProviderContext, providerVehicleId: string): Promise<FetchStateResult>;
  /** Dispatch a command to the provider. Never throws for provider-level rejections. */
  sendCommand(
    ctx: ProviderContext,
    providerVehicleId: string,
    type: CommandType,
    params: CommandParams,
  ): Promise<CommandDispatchResult>;
  health(ctx: ProviderContext): Promise<{ ok: boolean; detail: string }>;
}

/** Seeded, deterministic RNG (mulberry32). */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Sleep-aware freshness window (seconds) per provider. */
export function freshFor(provider: string, stateStatus: string | undefined): number {
  if (provider === 'demo') return 120;
  if (stateStatus === 'online' || stateStatus === 'charging' || stateStatus === 'driving')
    return 60;
  if (stateStatus === 'asleep') return 15 * 60;
  return 10 * 60;
}
