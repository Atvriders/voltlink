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

- `npm audit --omit=dev` (2026-11-24, after the effect/deepmerge-ts overrides):
  **0 high, 0 critical, 0 moderate — 0 production advisories.** The two
  previous high advisories travelled the Prisma CLI chain
  (`prisma` → `@prisma/config` → `effect`, `deepmerge-ts`); since `prisma`
  runs inside the production image (`prisma migrate deploy` at boot, see
  `apps/api/src/core/cli/migrate.ts`), they are fixed with pinned
  `overrides` in the root package.json: `effect` 3.22.5 (CVE-2026-121707
  ReDoS, patched in 3.22.1) and `deepmerge-ts` 8.0.0 (CVE-2026-40345 stack
  exhaustion, patched in 8.0.0). The Prisma drift gate and the migration
  tests run green with the overrides (evidence: `green/C-AUDIT.audit-full.log`,
  `green/R2-68.ci-combined-vitest.log`, the migrations job logs).
- `npm audit` (dev included): 0 high, 0 critical, 7 moderate — all dev-only
  tooling (`@vitest/mocker` ×3, `vitest`, `glob` via eslint, `minimatch`
  via the gltfpack CLI). None ship in the image.
- CI runs a container image scan (Trivy) with an expiry-checked ignore file
  and a full-history secret scan (gitleaks) on every push.

## Operational hardening checklist

1. Put VoltLink behind TLS; set `PUBLIC_URL` to the HTTPS origin.
2. Set `TRUST_PROXY=1` only when exactly one trusted proxy terminates TLS (or
   a comma list of proxy addresses/CIDRs); the boolean `true` value makes the
   web role refuse to start.
3. Generate strong `JWT_SECRET`, `VL_MASTER_KEY`, `POSTGRES_PASSWORD`.
4. Enable TOTP for owner/admin accounts; register a passkey as backup.
5. Keep `pull_policy: always` (production compose) and subscribe to releases
   in the changelog.
6. Back up `VL_MASTER_KEY` with your database backups — without it stored
   provider credentials cannot be decrypted.
