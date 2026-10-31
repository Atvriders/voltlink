// Partner registration + public key hosting (guide 01 §2, P-TESLASIGN).
// The public key is served from /.well-known (wired in app.ts) and registered
// in each region with a partner token (never persisted).

import crypto from 'node:crypto';
import fs from 'node:fs';
import { setSetting } from '../../core/settings';
import { regionBase, teslaConfig } from './config';
import { classify } from './classify';

let cachedKey: { pem: string; hex: string } | null | undefined;

export function teslaPublicKey(): { pem: string; hex: string } | null {
  if (cachedKey !== undefined) return cachedKey;
  try {
    const pem = fs.readFileSync(teslaConfig().publicKeyFile, 'utf8');
    const k = crypto.createPublicKey(pem);
    if (k.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
      throw new Error('Tesla needs a prime256v1 key');
    }
    const jwk = k.export({ format: 'jwk' }) as { x: string; y: string };
    const hex =
      '04' +
      Buffer.from(jwk.x, 'base64url').toString('hex') +
      Buffer.from(jwk.y, 'base64url').toString('hex');
    cachedKey = { pem, hex };
  } catch {
    cachedKey = null;
  }
  return cachedKey;
}

export async function partnerToken(base: string): Promise<{ accessToken: string }> {
  const cfg = teslaConfig();
  const res = await fetch(`${base}/oauth2/v3/token`, {
    method: 'POST',
    signal: AbortSignal.timeout(20_000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      scope:
        'openid offline_access vehicle_device_data vehicle_location vehicle_cmds vehicle_charging_cmds',
      audience: base,
    }),
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) throw classify(res.status, text, res.headers);
  const body = JSON.parse(text) as { access_token: string };
  if (!body.access_token) throw new Error('Partner token response has no access_token');
  return { accessToken: body.access_token };
}

export async function registerPartner(
  region: 'na' | 'eu',
): Promise<{ region: string; ok: boolean }> {
  const cfg = teslaConfig();
  const base = regionBase(region);
  const { accessToken } = await partnerToken(base);
  const headers = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };
  const reg = await fetch(`${base}/api/1/partner_accounts`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ domain: cfg.partnerDomain }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!reg.ok) throw classify(reg.status, await reg.text().catch(() => ''), reg.headers);
  const chk = await fetch(
    `${base}/api/1/partner_accounts/public_key?${new URLSearchParams({ domain: cfg.partnerDomain })}`,
    { headers, signal: AbortSignal.timeout(20_000) },
  );
  if (!chk.ok) throw classify(chk.status, await chk.text().catch(() => ''), chk.headers);
  const hex = String(
    ((await chk.json()) as { response?: { public_key?: string } }).response?.public_key ?? '',
  ).toLowerCase();
  const ok = hex === teslaPublicKey()?.hex;
  await setSetting(
    `tesla.partner.${region}`,
    JSON.stringify({ domain: cfg.partnerDomain, ok, at: new Date().toISOString() }),
  );
  return { region, ok };
}
