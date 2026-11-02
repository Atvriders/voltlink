# Security

## Authentication

- **Passwords** hashed with Argon2id.
- **TOTP** two-factor authentication (setup, confirm, disable, recovery-safe).
- **WebAuthn passkeys** for login and for high-risk step-up.
- **Sessions** are server-side records with hashed tokens; every session can
  be listed and revoked individually or all at once (logout everywhere).

## Authorization

- Role model: OWNER / DRIVER / VIEWER per organization (instance-admin
  account plus status/incidents operator personas), enforced server-side with a
  permission matrix.
- Vehicle sharing via explicit grants with permission levels.
- API and UI enforce the same rules server-side.

## Transport & requests

- Hardened security headers with a locked-down CSP (custom middleware,
  not helmet).
- CSRF tokens for every mutating request (cookie + header double-submit).
- Rate limiting per IP (configurable `VL_RATE_LIMIT_PER_MIN`), plus dedicated
  auth-endpoint limits and brute-force lockout.
- SSE endpoint is authenticated and rate-limit exempt (per-connection).

## Secrets & storage

- Provider credentials are **envelope-encrypted** (AES-256-GCM with a wrapped
  data key) under `VL_MASTER_KEY`; envelopes are versioned for key rotation.
- Boot-time validation refuses placeholder-looking secrets.
- `apps/api/.env` is gitignored; never commit `JWT_SECRET` or `VL_MASTER_KEY`.

## Command safety

- High-risk commands require step-up authentication.
- Global / provider / vehicle kill switches.
- Capability checks, rate buckets, idempotency, full audit trail.

## Input handling

- Typed request validation: zod schemas on command parameters and key
  flows; all handlers reject invalid input with typed error codes.
- Webhook URL validation (scheme/host allowlist) before saving.
- HTML in user content is sanitized in the SPA (DOMPurify) and limited
  server-side; notifications render safely.

## Dependency scanning

- `npm audit` (2026-11-02): **0 critical, 0 high, 3 moderate** advisories —
  all three are dev-only tooling (`@eslint-community/eslint-utils`,
  `@eslint/config-array`, `@donmccurdy/caporal` used by the gltfpack CLI);
  no runtime dependency is affected.
- CI runs a container image scan (Trivy) with an expiry-checked ignore file
  and a full-history secret scan (gitleaks) on every push.

## Operational hardening checklist

1. Put VoltLink behind TLS; set `PUBLIC_URL` to the HTTPS origin.
2. Set `TRUST_PROXY=true` only when a trusted proxy terminates TLS.
3. Generate strong `JWT_SECRET`, `VL_MASTER_KEY`, `POSTGRES_PASSWORD`.
4. Enable TOTP for owner/admin accounts; register a passkey as backup.
5. Keep `pull_policy: always` (production compose) and subscribe to releases
   in the changelog.
6. Back up `VL_MASTER_KEY` with your database backups — without it stored
   provider credentials cannot be decrypted.
