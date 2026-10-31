// The environment contract (guide 04 §1, I-COMPOSEENV): one zod schema with
// no side effects. env.ts parses it once in validateEnv(); scripts/check-compose
// imports ENV_KEYS to prove both compose files pass every variable through.

import { z } from 'zod';

const bool = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

const optionalString = z.string().default('');

export const ENV_SPEC = z.object({
  NODE_ENV: z.string().default('production'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  DATABASE_URL: z.string({ error: 'DATABASE_URL is required' }).min(1),
  REDIS_URL: z.string().default(''),
  PUBLIC_URL: z.url().default('http://localhost:3000'),
  VL_ALLOW_INSECURE_HTTP: bool,
  TRUST_PROXY: z.string().default('false'),
  VL_WEBAUTHN_RP_ID: z.string().default(''),
  VL_CSP_CONNECT_ORIGINS: optionalString,
  STATUS_PORT: z.coerce.number().int().default(3001),
  JWT_SECRET: optionalString,
  JWT_EXPIRES_SEC: z.coerce.number().int().positive().default(1_209_600),
  VL_MASTER_KEY: optionalString,
  VL_MASTER_KEYS: optionalString,
  VL_RATE_LIMIT_PER_MIN: z.coerce.number().int().positive().default(900),
  VL_STEPUP_WINDOW_SEC: z.coerce.number().int().positive().default(300),
  VL_SETUP_TOKEN: optionalString,
  SMTP_URL: optionalString,
  MAIL_FROM: optionalString,
  MAIL_TO_CONSOLE: z.string().default('true'),
  VL_TOTP_ISSUER: z.string().default('VoltLink'),
  VL_WEBAUTHN_RP_NAME: z.string().default('VoltLink'),
  TESLA_CLIENT_ID: optionalString,
  TESLA_CLIENT_SECRET: optionalString,
  TESLA_REDIRECT_URI: optionalString,
  TESLA_BASE_URL: optionalString,
  TESLA_TOKEN_URL: optionalString,
  TESLA_AUTHORIZE_URL: optionalString,
  TESLA_DEFAULT_AUDIENCE: optionalString,
  TESLA_FLEET_BASE_NA: optionalString,
  TESLA_FLEET_BASE_EU: optionalString,
  TESLA_PARTNER_DOMAIN: optionalString,
  TESLA_PUBLIC_KEY_FILE: optionalString,
  TESLA_COMMAND_PROXY_URL: optionalString,
  TESLA_ALLOW_TEST_ENDPOINTS: optionalString,
  TESLA_DAILY_BUDGET_USD: optionalString,
  VL_GEOCODER: optionalString,
  VL_GEOCODER_URL: optionalString,
  VL_MAP_MODE: optionalString,
  VL_MAP_STYLE_URL: optionalString,
  VL_MAP_PMTILES_URL: optionalString,
  VL_MAP_ASSETS_URL: optionalString,
  VL_MAP_ATTRIBUTION: optionalString,
  VL_MAP_TILES_DIR: optionalString,
  TESSIE_BASE_URL: optionalString,
  VAPID_PUBLIC_KEY: optionalString,
  VAPID_PRIVATE_KEY: optionalString,
  VAPID_SUBJECT: optionalString,
  VL_DEMO_DEFAULT_ENABLED: bool,
  VL_OUTBOUND_ALLOW: optionalString,
  VL_PUSH_SERVICE_HOSTS: optionalString,
  VL_DEV_ECHO_TOKENS: bool,
  LOG_LEVEL: z.string().default('info'),
});

export const ENV_KEYS = Object.keys(ENV_SPEC.shape) as (keyof typeof ENV_SPEC.shape)[];
