// MockProvider — scripted adapter for automated tests. Deterministic, offline,
// and only available in non-production environments.

import type { Capability, CommandParams, CommandType, VehicleState } from '@voltlink/shared';
import type {
  CommandDispatchResult,
  FetchStateResult,
  ProviderContext,
  ProviderVehicleDescriptor,
  VehicleProvider,
} from './types';

interface Script {
  state: Partial<VehicleState>;
  commands?: Record<string, CommandDispatchResult>;
}

const scripts = new Map<string, Script>();

export function scriptMockVehicle(
  providerVehicleId: string,
  state: Partial<VehicleState>,
  commands: Record<string, CommandDispatchResult> = {},
): void {
  scripts.set(providerVehicleId, { state, commands });
}

export function clearMockScripts(): void {
  scripts.clear();
}

const MOCK_CAPABILITIES: Capability[] = [
  'wake',
  'lock',
  'unlock',
  'climate_start',
  'climate_stop',
  'charge_start',
  'charge_stop',
  'set_charge_limit',
  'flash_lights',
  'honk_horn',
  'location',
];

class MockProviderImpl implements VehicleProvider {
  id = 'mock' as const;

  async readiness(): Promise<{
    ok: boolean;
    checks: { name: string; ok: boolean; detail: string }[];
  }> {
    return {
      ok: true,
      checks: [
        { name: 'Test mode', ok: true, detail: 'Mock provider serves scripted test data only.' },
      ],
    };
  }

  async listVehicles(_ctx: ProviderContext): Promise<ProviderVehicleDescriptor[]> {
    return [...scripts.keys()].map((id) => ({
      providerVehicleId: id,
      displayName: `Mock ${id}`,
      vehicleClass: 'compact_sedan',
      capabilities: MOCK_CAPABILITIES,
    }));
  }

  async fetchState(ctx: ProviderContext, providerVehicleId: string): Promise<FetchStateResult> {
    const s = scripts.get(providerVehicleId);
    if (!s) throw new Error('Mock vehicle not scripted');
    return {
      state: {
        status: 'online',
        freshness: 'live',
        dataSource: 'telemetry',
        fetchedAt: new Date().toISOString(),
        locked: true,
        ...s.state,
        vehicleId: undefined,
      } as never,
      live: true,
      freshForSec: 60,
    };
  }

  async sendCommand(
    _ctx: ProviderContext,
    providerVehicleId: string,
    type: CommandType,
    _params: CommandParams,
  ): Promise<CommandDispatchResult> {
    const s = scripts.get(providerVehicleId);
    if (!s) return { kind: 'rejected', errorMessage: 'Unknown mock vehicle.' };
    if (s.commands?.[type]) return s.commands[type];
    return { kind: 'accepted', response: 'mock:accepted' };
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    return { ok: true, detail: 'Mock provider healthy.' };
  }
}

export const MockProvider = MockProviderImpl;
