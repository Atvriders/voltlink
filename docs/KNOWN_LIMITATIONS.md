# Known limitations

Kept honest and current. File an issue for anything that matters to you.

## Providers

- **Live-provider flows are untested as of this writing.** Tesla and Tessie
  adapters are implemented and covered by fake-provider contract tests only;
  real-vehicle testing is blocked on owner credentials (COMPLETION.md
  LP-0001/LP-0002). Treat the adapters as mock-verified, not field-verified.
- **Tesla** is the only real-vehicle provider with a full adapter today.
  Tessie exists as an optional adapter. Other makes would plug into the same
  provider interface (`apps/api/src/providers/types.ts`).
- Tesla Fleet API access depends on your application's tier; some endpoints
  return `unsupported` until Tesla provisions them. The command lifecycle
  records that outcome accurately.
- No vehicle-to-cloud telemetry push (Tesla streaming telemetry) — VoltLink
  polls with sleep-aware scheduling.

## Platform

- SSE events fan out cross-process through a Redis stream bus when
  `REDIS_URL` is set; without Redis, publishing is best-effort per web
  instance and the polling fallback covers correctness. Scaling web
  horizontally works when Redis is configured.
- Queue is Redis-backed when `REDIS_URL` is set (recommended at scale);
  without Redis it uses PostgreSQL (`FOR UPDATE SKIP LOCKED`) — fine for small
  deployments, slower under heavy load.
- Migrations are roll-forward; downgrading an image across a breaking
  migration needs a backup restore.
- No multi-tenant hosting service — one VoltLink instance is one
  installation. Multi-user within an instance is fully supported via roles
  and vehicle sharing.

## Web

- Map tiles: the demo uses a fictional offline city. Production deployments
  should swap in a real tile provider in `apps/web/src/lib/map.ts`
  (MapLibre-compatible).
- WebGL needs a GPU/WebGL-capable browser; degraded gracefully to the
  procedural fallback.
- Voice/smartwatch apps are out of scope; the web UI is responsive down to
  phone widths.

## Build environment

- This machine has no Docker daemon: container, compose, production-image and
  backup/restore tests run in CI only and are cited by job URL after the
  release push. Local runs that skip a step never set a completion level.
- Guide 08 §15.1/15.2 extras (AsyncLocalStorage context IDs, pino log
  transport) and the Sentry hook are documented as deferred; the current
  implementation uses request-scoped IDs and a structured console logger with
  redaction.
- GitHub Actions has never run yet (no push): the SHA-pinned workflow is
  in place and will be verified in the release phase.

## Data & privacy

- Privacy zones apply to new samples; enabling one does not retroactively
  rewrite old location rows (use retention/export/delete for those).
- Email verification links are printed to the server console when no SMTP is
  configured (development convenience only).

## Asset pipeline

- Vehicle models are stylized low-poly originals, not manufacturer-accurate
  recreations.
- Blender is needed only to regenerate assets; shipped GLBs work without it.
