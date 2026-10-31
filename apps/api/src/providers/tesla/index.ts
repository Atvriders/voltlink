// Tesla Fleet API provider (guide 01). Replaces the old single-file adapter:
// signed commands via the proxy, per-account region, rotating refresh tokens,
// per-vehicle capabilities and non-billable readiness.

import { teslaConfig } from './config';
import { scopesFromJwt, getValidAccessToken } from './tokens';
import { teslaRequest } from './client';
import { mapVehicleData, vehicleDataEndpoints } from './mapping';
import { deriveTeslaCapabilities } from './capabilities';
import { buildTeslaSteps } from './commands';
import { normalizeTeslaError, normalizeTeslaResponse } from './normalize';
import type {
  CommandDispatchResult,
  FetchStateResult,
  ProviderContext,
  ProviderVehicleDescriptor,
  VehicleProvider,
} from '../types';
import type { CommandParams, CommandType } from '@voltlink/shared';

const VEHICLES_PATH = '/api/1/vehicles';

export class TeslaProviderImpl implements VehicleProvider {
  id = 'tesla' as const;

  async readiness(): Promise<{
    ok: boolean;
    checks: { name: string; ok: boolean; detail: string }[];
  }> {
    const cfg = teslaConfig();
    const checks = [
      {
        name: 'Client ID',
        ok: !!cfg.clientId,
        detail: cfg.clientId
          ? 'OAuth client configured.'
          : 'Set TESLA_CLIENT_ID from developer.tesla.com.',
      },
      {
        name: 'Client secret',
        ok: !!cfg.clientSecret,
        detail: cfg.clientSecret ? 'Client secret configured.' : 'Set TESLA_CLIENT_SECRET.',
      },
      {
        name: 'Redirect URI',
        ok: cfg.redirectUri.startsWith('https://') || cfg.allowTestEndpoints,
        detail: `Configured redirect: ${cfg.redirectUri}. Register this exact URI with the Tesla app.`,
      },
      {
        name: 'Command proxy',
        ok: !!cfg.commandProxyUrl,
        detail: cfg.commandProxyUrl
          ? `Signed commands route through ${cfg.commandProxyUrl}.`
          : 'TESLA_COMMAND_PROXY_URL is not set; commands are unavailable.',
      },
    ];
    return { ok: checks.every((c) => c.ok), checks };
  }

  async listVehicles(ctx: ProviderContext): Promise<ProviderVehicleDescriptor[]> {
    const out: ProviderVehicleDescriptor[] = [];
    let page = 1;
    for (;;) {
      const res = await teslaRequest({
        accountId: ctx.accountId,
        method: 'GET',
        path: `${VEHICLES_PATH}?page=${page}`,
        meter: 'unbilled',
      });
      const body = (await res.json()) as {
        response?: {
          id: number;
          vin: string;
          display_name: string;
          state: string;
          access_type?: string;
          granular_access?: { hide_private?: boolean };
        }[];
        pagination?: { next: string | null };
      };
      const rows = body.response ?? [];
      for (const v of rows) {
        // No vehicle_data loop on import: list + fleet_status only (P-TESLAMAP).
        const fleet = await this.fleetStatus(ctx.accountId, v.vin).catch(() => null);
        const hidePrivate = v.granular_access?.hide_private === true;
        const scopes = scopesFromJwt(await getValidAccessToken(ctx.accountId).catch(() => ''));
        const { capabilities, details } = deriveTeslaCapabilities({
          scopes,
          hidePrivate,
          fleet: fleet
            ? { protocolRequired: fleet.protocolRequired, keyPaired: fleet.keyPaired }
            : null,
        });
        out.push({
          providerVehicleId: v.vin, // guide 01 keys vehicles by VIN
          displayName: v.display_name || `Tesla ${v.vin.slice(-4)}`,
          make: 'Tesla',
          model: undefined,
          year: undefined,
          vehicleClass: 'fallback',
          vinLast4: v.vin.slice(-4),
          capabilities,
          capabilityDetails: details as Record<
            string,
            { supported: boolean; usable: boolean; reason?: string; min?: number; max?: number }
          >,
          accessType: v.access_type,
          hidePrivate,
        });
      }
      if (!body.pagination?.next) break;
      page++;
    }
    return out;
  }

  private async fleetStatus(
    accountId: string,
    vin: string,
  ): Promise<{ protocolRequired: boolean; keyPaired: boolean; firmwareVersion?: string }> {
    const res = await teslaRequest({
      accountId,
      method: 'POST',
      path: `${VEHICLES_PATH}/fleet_status`,
      body: { vins: [vin] },
      meter: 'unbilled',
    });
    const body = (await res.json()) as {
      response?: Record<
        string,
        {
          vehicle_command_protocol_required?: boolean;
          key_paired_vins?: string[];
          total_number_of_keys?: number;
          vehicle_info?: { firmware_version?: string };
        }
      >;
    };
    const r = body.response?.[vin];
    if (!r) return { protocolRequired: false, keyPaired: false };
    return {
      protocolRequired: r.vehicle_command_protocol_required === true,
      keyPaired: Array.isArray(r.key_paired_vins) && r.key_paired_vins.includes(vin),
      firmwareVersion: r.vehicle_info?.firmware_version,
    };
  }

  async fetchState(ctx: ProviderContext, providerVehicleId: string): Promise<FetchStateResult> {
    // State without waking: /vehicles/{vin} first (P-TESLAMAP).
    const stateRes = await teslaRequest({
      accountId: ctx.accountId,
      method: 'GET',
      path: `${VEHICLES_PATH}/${providerVehicleId}`,
      meter: 'unbilled',
    });
    const stateBody = (await stateRes.json()) as {
      response?: { state?: string; in_service?: boolean; vehicle_config?: Record<string, unknown> };
    };
    const raw = stateBody.response?.state ?? 'unknown';
    const conn: 'online' | 'asleep' | 'offline' = stateBody.response?.in_service
      ? 'offline'
      : raw === 'online'
        ? 'online'
        : raw === 'asleep'
          ? 'asleep'
          : 'offline';

    if (conn !== 'online') {
      // One vehicle_data_cached fetch to capture the final state (never wakes).
      try {
        const cached = await teslaRequest({
          accountId: ctx.accountId,
          method: 'GET',
          path: `${VEHICLES_PATH}/${providerVehicleId}/vehicle_data_cached`,
          meter: 'unbilled',
        });
        if (cached.status !== 404 && cached.status !== 412) {
          const cbody = (await cached.json()) as { response?: Record<string, unknown> };
          const mapped = mapVehicleData(cbody.response ?? {}, conn);
          return {
            state: { ...mapped, freshness: 'last_known' } as never,
            live: false,
            freshForSec: 3600,
          };
        }
      } catch {
        /* cache is best-effort */
      }
      throw new Error(`vehicle_${conn}`);
    }

    const scopes = scopesFromJwt(await getValidAccessToken(ctx.accountId).catch(() => ''));
    const qs = vehicleDataEndpoints({ hasLocationScope: scopes.includes('vehicle_location') });
    const res = await teslaRequest({
      accountId: ctx.accountId,
      method: 'GET',
      path: `${VEHICLES_PATH}/${providerVehicleId}/vehicle_data?${qs}`,
      meter: 'device_data',
    });
    if (res.status === 408) throw new Error('vehicle_asleep');
    const body = (await res.json()) as { response?: Record<string, unknown> };
    const mapped = mapVehicleData(body.response ?? {}, conn);
    return {
      state: { ...mapped, vehicleId: undefined } as never,
      live: true,
      freshForSec: 60,
    };
  }

  async sendCommand(
    ctx: ProviderContext,
    providerVehicleId: string,
    type: CommandType,
    params: CommandParams,
  ): Promise<CommandDispatchResult> {
    const steps = buildTeslaSteps(type, params, {});
    if (steps.length === 0) {
      return { kind: 'unsupported', errorMessage: `Command ${type} is not mapped for Tesla.` };
    }
    let sent = false;
    for (const step of steps) {
      // wake_up goes DIRECT to the fleet host; everything else through the proxy.
      const viaProxy = step.name !== 'wake_up';
      try {
        sent = true;
        const res = await teslaRequest({
          accountId: ctx.accountId,
          method: 'POST',
          path: `${VEHICLES_PATH}/${providerVehicleId}${viaProxy ? '/command/' + step.name : '/' + step.name}`,
          body: step.body,
          via: viaProxy ? 'proxy' : 'fleet',
          meter: viaProxy ? 'commands' : 'wakes',
        });
        const body = (await res.json().catch(() => ({}))) as {
          response?: { result?: boolean; reason?: string };
        };
        const out = normalizeTeslaResponse(body, step);
        if (out.kind !== 'accepted' || steps.length === 1) return out;
        // multi-step: continue to the next step only on success
        if (out.kind !== 'accepted') return out;
      } catch (err) {
        return normalizeTeslaError(err, sent, step);
      }
    }
    return { kind: 'accepted', response: 'All command steps accepted.', providerCode: 'OK' };
  }

  async health(ctx: ProviderContext): Promise<{ ok: boolean; detail: string }> {
    try {
      const res = await teslaRequest({
        accountId: ctx.accountId,
        method: 'GET',
        path: `${VEHICLES_PATH}`,
        meter: 'unbilled',
      });
      return { ok: res.ok, detail: `Fleet API reachable (${res.status}).` };
    } catch (e) {
      return { ok: false, detail: `Fleet API unreachable: ${(e as Error).message.slice(0, 120)}` };
    }
  }
}

export const TeslaProvider = TeslaProviderImpl;
