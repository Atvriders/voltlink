// VoltLink environment configuration with boot-time validation.
// Rejects placeholder-looking secrets so a misconfigured deployment fails
// loudly instead of running with a published default key.

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
  NODE_ENV: optional('NODE_ENV', 'development'),
  PORT: numberOpt('PORT', 3000),
  RATE_LIMIT_PER_MIN: numberOpt('VL_RATE_LIMIT_PER_MIN', 900),
  HOST: optional('HOST', '0.0.0.0'),
  PUBLIC_URL,

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
  WEBAUTHN_RP_ID: optional('VL_WEBAUTHN_RP_ID', 'localhost'),
  WEBAUTHN_RP_NAME: optional('VL_WEBAUTHN_RP_NAME', 'VoltLink'),

  // Tesla official API (https://developer.tesla.com) OAuth app credentials.
  TESLA_CLIENT_ID: process.env.TESLA_CLIENT_ID || '',
  TESLA_CLIENT_SECRET: process.env.TESLA_CLIENT_SECRET || '',
  TESLA_REDIRECT_URI: optional('TESLA_REDIRECT_URI', 'http://localhost:3000/api/v1/providers/tesla/callback'),
  TESLA_BASE_URL: optional('TESLA_BASE_URL', 'https://fleet-api.prd.na.vn.cloud.tesla.com'),

  TESSIE_BASE_URL: optional('TESSIE_BASE_URL', 'https://api.tessie.com'),

  VAPID_PUBLIC_KEY: process.env.VAPID_PUBLIC_KEY || '',
  VAPID_PRIVATE_KEY: process.env.VAPID_PRIVATE_KEY || '',
  VAPID_SUBJECT: optional('VAPID_SUBJECT', `mailto:admin@${publicHost}`),

  DEMO_DEFAULT_ENABLED: process.env.VL_DEMO_DEFAULT_ENABLED === 'true',
  TRUST_PROXY: process.env.TRUST_PROXY === 'true',
  LOG_LEVEL: optional('LOG_LEVEL', 'info'),
};

export function validateEnv() {
  // JWT secret required for any real run; tests inject their own.
  if (env.NODE_ENV !== 'test' || process.env.JWT_SECRET) {
    env.JWT_SECRET();
  }
  if (env.NODE_ENV === 'production') {
    env.MASTER_KEY();
    if (!/^https:\/\//.test(env.PUBLIC_URL) && !env.PUBLIC_URL.startsWith('http://localhost')) {
      throw new Error('PUBLIC_URL must be an https:// URL in production (required for secure cookies).');
    }
  }
}
