// Fleet HTTP client (guide 01 §6): every Tesla request goes through here.
// Handles auth refresh-once-and-retry, region re-discovery on 421, the billing
// meter, and maps network failures to proxy_unavailable / outcome_unknown.

import { prisma } from '../../core/db';
import { getValidAccessToken, markReauthRequired } from './tokens';
import { discoverRegion } from './region';
import { teslaConfig } from './config';
import { classify, TeslaApiError } from './classify';

export type MeterCategory = 'device_data' | 'wakes' | 'commands' | 'unbilled';

export interface TeslaRequest {
  accountId: string;
  method: string;
  path: string;
  body?: unknown;
  via?: 'fleet' | 'proxy';
  meter: MeterCategory;
  allowlist?: boolean; // path allowlist is enforced by the caller (L602)
}

async function meterUsage(accountId: string, res: Response, meter: MeterCategory): Promise<void> {
  const category = res.status < 500 ? meter : 'unbilled';
  const day = new Date();
  day.setUTCHours(0, 0, 0, 0);
  await prisma.$executeRaw`
    INSERT INTO "ProviderUsageDaily" ("accountId", "day", "category", "count")
    VALUES (${accountId}, ${day}, ${category}, 1)
    ON CONFLICT ("accountId", "day", "category")
    DO UPDATE SET "count" = "ProviderUsageDaily"."count" + 1
  `.catch(() => undefined);
}

export async function teslaRequest(req: TeslaRequest): Promise<Response> {
  const cfg = teslaConfig();
  const account = await prisma.providerAccount.findUnique({ where: { id: req.accountId } });
  if (!account) throw new Error(`Unknown Tesla account ${req.accountId}`);
  if (account.status !== 'connected') {
    throw new TeslaApiError(401, 'reauth_required', 'account status: ' + account.status);
  }

  let retriedAuth = false;
  let rediscovered = false;
  const viaProxy = req.via === 'proxy';
  const base = viaProxy ? cfg.commandProxyUrl : account.fleetApiBaseUrl || cfg.defaultAudience;
  if (!base)
    throw new TeslaApiError(503, 'proxy_unavailable', 'TESLA_COMMAND_PROXY_URL is not set');

  // The allowlist lives in routes/contract (L602): every path used in the app
  // must appear there. This client only asserts a sane shape.
  if (!req.path.startsWith('/')) throw new Error(`Tesla path must be absolute: ${req.path}`);

  for (;;) {
    const accessToken = await getValidAccessToken(req.accountId, { force: retriedAuth });
    let res: Response;
    try {
      res = await fetch(`${base}${req.path}`, {
        method: req.method,
        signal: AbortSignal.timeout(viaProxy ? 30_000 : 20_000),
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          ...(req.body !== undefined ? {} : {}),
        },
        body: req.body === undefined ? undefined : JSON.stringify(req.body),
      });
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      if (viaProxy && (msg.includes('ECONNREFUSED') || msg.includes('fetch failed'))) {
        throw new TeslaApiError(503, 'proxy_unavailable', 'Tesla command proxy unreachable');
      }
      throw new TeslaApiError(504, 'outcome_unknown', msg.slice(0, 200));
    }
    await meterUsage(req.accountId, res, req.meter);
    if (res.ok) return res;
    const err = classify(res.status, await res.text().catch(() => ''), res.headers);
    if (err.category === 'token_expired' && !retriedAuth) {
      retriedAuth = true; // one force refresh and one retry
      continue;
    }
    if (err.category === 'wrong_region' && !rediscovered && !viaProxy) {
      rediscovered = true;
      try {
        const accessToken2 = await getValidAccessToken(req.accountId);
        const d = await discoverRegion(accessToken2);
        await prisma.providerAccount.update({
          where: { id: req.accountId },
          data: { region: d.region, fleetApiBaseUrl: d.baseUrl },
        });
        continue;
      } catch {
        /* fall through to the original error */
      }
    }
    if (err.category === 'reauth_required') {
      await markReauthRequired(req.accountId, err.detail).catch(() => undefined);
    }
    throw err;
  }
}
