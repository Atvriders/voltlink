// OAuth authorize + token exchange (guide 01 §3, Z-TESLASTATE). PKCE S256 with
// a single-use, session-bound server state; the token exchange happens on
// fleet-auth (not auth.tesla.com), and scopes never include energy_*.

import crypto from 'node:crypto';
import { teslaConfig } from './config';
import { classify } from './classify';

export const TESLA_SCOPES =
  'openid offline_access vehicle_device_data vehicle_location vehicle_cmds vehicle_charging_cmds';

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function teslaAuthorizeUrl(
  state: string,
  codeChallenge: string,
  opts: { reconnect?: boolean } = {},
): string {
  const cfg = teslaConfig();
  const params = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: 'code',
    scope: TESLA_SCOPES,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    show_keypair_step: 'true',
    ...(opts.reconnect ? { prompt_missing_scopes: 'true' } : {}),
  });
  return `${cfg.authorizeUrl}?${params.toString()}`;
}

export interface ExchangedTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
  scopes: string[];
}

export async function teslaExchangeCode(
  code: string,
  codeVerifier: string,
): Promise<ExchangedTokens> {
  const cfg = teslaConfig();
  const res = await fetch(cfg.tokenUrl, {
    method: 'POST',
    signal: AbortSignal.timeout(20_000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      code,
      redirect_uri: cfg.redirectUri,
      audience: cfg.defaultAudience,
      code_verifier: codeVerifier,
    }),
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) throw classify(res.status, text, res.headers);
  const body = JSON.parse(text) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope?: string;
  };
  if (!body.access_token || !body.refresh_token) {
    throw new Error('Tesla token exchange returned no tokens');
  }
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token,
    expiresAt: Date.now() + Number(body.expires_in || 28800) * 1000,
    scopes: body.scope ? body.scope.split(/\s+/) : [],
  };
}
