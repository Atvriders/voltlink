// VoltLink environment configuration with boot-time validation.
// The contract itself lives in env-spec.ts (zod, no side effects) so that
// scripts/check-compose can prove every compose file passes every variable.
// Rejects placeholder-looking secrets so a misconfigured deployment fails
// loudly instead of running with a published default key.

import { z } from 'zod';
import { ENV_SPEC } from './env-spec';

const PLACEHOLDER = /(secret|change.?me|changeme|placeholder|example|your-|xxxx|default)/i;

function requireSecret(name: string, minLen: number): string {
  const v = process.env[name];
  if (!v || v.length < minLen) {
    throw new Error(`${name} is missing or too short (minimum ${minLen} characters).`);
  }
  if (PLACEHOLDER.test(v)) {
    throw new Error(`${name} looks like a placeholder value; refusing to boot with it.`);
  }
  return v;
}

function optional(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

function numberOpt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// P-ENVDB: a missing DATABASE_URL must never silently fall back to a developer's
// database. Refuse to load the module at all when it is unset.
if (!process.env.DATABASE_URL) {
  throw new Error(
    'DATABASE_URL is required; refusing to boot without an explicit database URL (set it in apps/api/.env or the environment).',
  );
}

const PUBLIC_URL = optional('PUBLIC_URL', 'http://localhost:3000');
let publicHost = 'localhost';
try {
  publicHost = new URL(PUBLIC_URL).hostname;
} catch {
  // keep the localhost default; PUBLIC_URL is validated again at boot
}

export const env = {
  NODE_ENV: optional('NODE_ENV', 'production'),
  PORT: numberOpt('PORT', 3000),
  RATE_LIMIT_PER_MIN: numberOpt(
    'VL_RATE_LIMIT_PER_MIN',
    process.env.NODE_ENV === 'test' ? 100_000 : 900,
  ),
  HOST: optional('HOST', '0.0.0.0'),
  PUBLIC_URL,
  STEPUP_WINDOW_SEC: Math.min(900, Math.max(60, numberOpt('VL_STEPUP_WINDOW_SEC', 300))),
  WEBAUTHN_RP_ID: optional('VL_WEBAUTHN_RP_ID', publicHost),
  TRUST_PROXY: optional('TRUST_PROXY', 'false'),
  DEV_ECHO_TOKENS: process.env.VL_DEV_ECHO_TOKENS === '1',

  DATABASE_URL: process.env.DATABASE_URL,
  REDIS_URL: process.env.REDIS_URL || '',

  JWT_SECRET: () => requireSecret('JWT_SECRET', 32),
  JWT_EXPIRES_SEC: numberOpt('JWT_EXPIRES_SEC', 60 * 60 * 24 * 14),

  // Envelope encryption master keys. VL_MASTER_KEY is the active key; the
  // comma-separated list in VL_MASTER_KEYS (vN:base64) supports rotation.
  MASTER_KEY: () => requireSecret('VL_MASTER_KEY', 32),

  CSRF_COOKIE_NAME: 'vl_csrf',
  SESSION_COOKIE: 'vl_session',

  SMTP_URL: process.env.SMTP_URL || '', // smtp://user:pass@host:587
  MAIL_FROM: optional('MAIL_FROM', `VoltLink <no-reply@${publicHost}>`),
  MAIL_TO_CONSOLE: process.env.MAIL_TO_CONSOLE !== 'false',

  TOTP_ISSUER: optional('VL_TOTP_ISSUER', 'VoltLink'),
  WEBAUTHN_RP_NAME: optional('VL_WEBAUTHN_RP_NAME', 'VoltLink'),

  // Tesla official API (https://developer.tesla.com) OAuth app credentials.
  TESLA_CLIENT_ID: process.env.TESLA_CLIENT_ID || '',
  TESLA_CLIENT_SECRET: process.env.TESLA_CLIENT_SECRET || '',
  TESLA_REDIRECT_URI: optional(
    'TESLA_REDIRECT_URI',
    'http://localhost:3000/api/v1/providers/tesla/callback',
  ),
  TESLA_BASE_URL: optional('TESLA_BASE_URL', 'https://fleet-api.prd.na.vn.cloud.tesla.com'),
  TESLA_TOKEN_URL: optional(
    'TESLA_TOKEN_URL',
    'https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token',
  ),
  TESLA_AUTHORIZE_URL: optional(
    'TESLA_AUTHORIZE_URL',
    'https://auth.tesla.com/oauth2/v3/authorize',
  ),
  TESLA_DEFAULT_AUDIENCE: optional(
    'TESLA_DEFAULT_AUDIENCE',
    'https://fleet-api.prd.na.vn.cloud.tesla.com',
  ),
  TESLA_FLEET_BASE_NA: optional(
    'TESLA_FLEET_BASE_NA',
    'https://fleet-api.prd.na.vn.cloud.tesla.com',
  ),
  TESLA_FLEET_BASE_EU: optional(
    'TESLA_FLEET_BASE_EU',
    'https://fleet-api.prd.eu.vn.cloud.tesla.com',
  ),
  TESLA_PARTNER_DOMAIN: optional('TESLA_PARTNER_DOMAIN', ''),
  TESLA_PUBLIC_KEY_FILE: optional('TESLA_PUBLIC_KEY_FILE', '/run/voltlink/tesla/public-key.pem'),
  TESLA_COMMAND_PROXY_URL: optional('TESLA_COMMAND_PROXY_URL', ''),
  TESLA_ALLOW_TEST_ENDPOINTS: optional('TESLA_ALLOW_TEST_ENDPOINTS', ''),
  TESLA_DAILY_BUDGET_USD: optional('TESLA_DAILY_BUDGET_USD', ''),
  VL_GEOCODER: optional('VL_GEOCODER', 'off'),
  VL_GEOCODER_URL: optional('VL_GEOCODER_URL', ''),

  TESSIE_BASE_URL: optional('TESSIE_BASE_URL', 'https://api.tessie.com'),

  VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY || '',
  VAPID_PRIVATE_KEY: process.env.VAPID_PRIVATE_KEY || '',
  VAPID_SUBJECT: optional('VAPID_SUBJECT', `mailto:admin@${publicHost}`),
  VL_PUSH_SERVICE_HOSTS: optional('VL_PUSH_SERVICE_HOSTS', ''),

  DEMO_DEFAULT_ENABLED: process.env.VL_DEMO_DEFAULT_ENABLED === 'true',
  LOG_LEVEL: optional('LOG_LEVEL', 'info'),

  // NEW-15 / I-COMPOSEENV additions.
  ALLOW_INSECURE_HTTP: process.env.VL_ALLOW_INSECURE_HTTP === 'true',
  CSP_CONNECT_ORIGINS: optional('VL_CSP_CONNECT_ORIGINS', ''),
  STATUS_PORT: numberOpt('STATUS_PORT', 3001),
};

/**
 * Parse TRUST_PROXY. `true` lets a client choose its own X-Forwarded-For and
 * defeats every per-IP limit, so it makes the web role refuse to start. The
 * accepted values are false (default, also empty or 0), a hop count, or a
 * comma list of proxy addresses/CIDRs (e.g. `loopback,172.16.0.0/12`).
 */
export function parseTrustProxy(value: string): number | string[] | false {
  const v = value.trim();
  if (v === '' || v === '0' || v === 'false') return false;
  if (v === 'true') {
    throw new Error(
      'TRUST_PROXY=true is unsafe (client-spoofable X-Forwarded-For); use a hop count or an address/CIDR list, or false.',
    );
  }
  if (/^\d+$/.test(v)) return Number(v);
  const entries = v
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);
  if (entries.length === 0) return false;
  for (const e of entries) {
    if (
      !/^(loopback|linklocal|uniquelocal|\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?|[0-9a-f:]+(\/\d{1,3})?)$/i.test(
        e,
      )
    ) {
      throw new Error(
        `TRUST_PROXY entry ${JSON.stringify(e)} is not a hop count, address or CIDR.`,
      );
    }
  }
  return entries;
}

export function validateEnv() {
  const parsed = ENV_SPEC.safeParse(process.env);
  if (!parsed.success) {
    // Fail closed with a readable report (guide 04 §1).
    console.error('[voltlink] invalid environment:\n' + z.prettifyError(parsed.error));
    process.exit(1);
  }
  // JWT secret required for any real run; tests inject their own.
  if (env.NODE_ENV !== 'test' || process.env.JWT_SECRET) {
    env.JWT_SECRET();
  }
  parseTrustProxy(env.TRUST_PROXY); // throws on the unsafe `true` value
  // A bad VL_OUTBOUND_ALLOW entry must fail boot, not weaken the SSRF policy.
  import('../net/outboundPolicy').then(({ parseAllowlist }) =>
    parseAllowlist(process.env.VL_OUTBOUND_ALLOW),
  );
  if (env.NODE_ENV === 'production') {
    env.MASTER_KEY();
    const httpInsecure =
      !/^https:\/\//.test(env.PUBLIC_URL) && !env.PUBLIC_URL.startsWith('http://localhost');
    if (httpInsecure && process.env.VL_ALLOW_INSECURE_HTTP !== 'true') {
      throw new Error(
        'PUBLIC_URL must be an https:// URL in production, or set VL_ALLOW_INSECURE_HTTP=true for a plain-HTTP LAN deployment (passkeys and web push stay unavailable there).',
      );
    }
  }
  const host = publicHost;
  const rpId = env.WEBAUTHN_RP_ID;
  if (rpId && host !== rpId && !host.endsWith('.' + rpId) && host !== 'localhost') {
    throw new Error(
      `VL_WEBAUTHN_RP_ID (${rpId}) must equal the PUBLIC_URL host (${host}) or be a parent domain of it.`,
    );
  }
  if (
    env.DEV_ECHO_TOKENS &&
    !(env.NODE_ENV === 'development' && ['localhost', '127.0.0.1'].includes(host))
  ) {
    throw new Error(
      'VL_DEV_ECHO_TOKENS=1 is only allowed in development with a localhost PUBLIC_URL.',
    );
  }
}
