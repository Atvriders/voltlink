// Tesla Fleet API configuration (guide 01 §1). Every value comes from env;
// an empty client id means "Tesla not configured" (never a boot failure, L622).

import { env } from '../../core/env';

export interface TeslaConfig {
  configured: boolean;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  authorizeUrl: string;
  tokenUrl: string;
  defaultAudience: string;
  fleetBaseNa: string;
  fleetBaseEu: string;
  partnerDomain: string;
  publicKeyFile: string;
  commandProxyUrl: string;
  allowTestEndpoints: boolean;
  dailyBudgetUsd?: number;
}

export function teslaConfig(): TeslaConfig {
  const domain = (() => {
    try {
      return new URL(env.PUBLIC_URL).host.toLowerCase();
    } catch {
      return '';
    }
  })();
  // TESLA_BASE_URL is a deprecated alias for TESLA_DEFAULT_AUDIENCE (one release).
  const defaultAudience =
    process.env.TESLA_DEFAULT_AUDIENCE ||
    process.env.TESLA_BASE_URL ||
    'https://fleet-api.prd.na.vn.cloud.tesla.com';
  return {
    configured: Boolean(env.TESLA_CLIENT_ID && env.TESLA_CLIENT_SECRET),
    clientId: env.TESLA_CLIENT_ID,
    clientSecret: env.TESLA_CLIENT_SECRET,
    redirectUri: env.TESLA_REDIRECT_URI,
    authorizeUrl: process.env.TESLA_AUTHORIZE_URL || 'https://auth.tesla.com/oauth2/v3/authorize',
    tokenUrl:
      process.env.TESLA_TOKEN_URL || 'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token',
    defaultAudience,
    fleetBaseNa: process.env.TESLA_FLEET_BASE_NA || 'https://fleet-api.prd.na.vn.cloud.tesla.com',
    fleetBaseEu: process.env.TESLA_FLEET_BASE_EU || 'https://fleet-api.prd.eu.vn.cloud.tesla.com',
    partnerDomain: (process.env.TESLA_PARTNER_DOMAIN || domain).toLowerCase(),
    publicKeyFile: process.env.TESLA_PUBLIC_KEY_FILE || '/run/voltlink/tesla/public-key.pem',
    commandProxyUrl: process.env.TESLA_COMMAND_PROXY_URL || '',
    allowTestEndpoints:
      process.env.TESLA_ALLOW_TEST_ENDPOINTS === 'true' && env.NODE_ENV === 'test',
    dailyBudgetUsd: process.env.TESLA_DAILY_BUDGET_USD
      ? Number(process.env.TESLA_DAILY_BUDGET_USD)
      : undefined,
  };
}

export function regionBase(region: 'na' | 'eu'): string {
  return region === 'eu' ? teslaConfig().fleetBaseEu : teslaConfig().fleetBaseNa;
}

/** Assert a discovered Fleet API base URL is a real Tesla host (tests may use localhost). */
export function assertTeslaBase(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`Invalid Fleet API base URL: ${raw.slice(0, 80)}`);
  }
  const host = u.hostname;
  const ok = u.protocol === 'https:' || (teslaConfig().allowTestEndpoints && host === '127.0.0.1');
  if (!ok) throw new Error(`Fleet API base URL must be https (got ${raw.slice(0, 80)})`);
  if (
    !teslaConfig().allowTestEndpoints &&
    !host.endsWith('.tesla.com') &&
    !host.endsWith('.tesla.cn')
  ) {
    throw new Error(`Fleet API base URL is not a Tesla host (got ${host})`);
  }
  return raw;
}
