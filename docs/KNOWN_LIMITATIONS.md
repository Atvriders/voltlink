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

- **The container image is linux/amd64 only.** The image is built and
  verified for amd64 (see the Docker Compose guide); arm64 hosts are not
  supported by the published image today.
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

## Spec deferrals (2026-11-25 completion sweep)

Owner-directed completion of the spec matrix: these requirements from the
original spec are deliberately not part of v1.1.1. Each is recorded here so
`SPEC_COMPLETION_MATRIX.md` (handoff) can honestly mark it n/a.

- **UI icons are third-party** (lucide-react, licensed — `docs/ASSET_LICENSES.md`); only the logo is original. Replacing every icon with original artwork is out of scope.
- **Per-provider permissions**: provider management is org-role based; the per-account `ProviderAccountGrant` model exists but is not enforced.
- **Per-vehicle provider-unavailable state**: provider errors show on the provider card only.
- **Polling**: static rate buckets only — provider `429`/`Retry-After` is not honored, and the poller does not read retention settings.
- **Monthly aggregates**: `/charging/totals` aggregates sessions on demand; the `AggregateMonthly` cache table is upserted by ingest but never read.
- **Charging UI**: monthly totals, session comparisons, charging-behavior and seasonal/rolling battery analyses have no UI (endpoints exist for some); no period-comparison view; no print CSS (CSV/JSON exports exist); fast-charge classification is never assigned (home/work/public badges exist).
- **Battery analytics**: seasonal comparison and rolling averages are not implemented.
- **Software updates**: `schedule_update` exists; `cancel_update` is not a command type.
- **Automations**: the `door_open` trigger covers doors only (not trunk or left-open duration); conditions for driver, provider capability and user role are not in `CONDITION_TYPES`; notification preferences have no per-vehicle field; registration/insurance/service records carry `dueAt` but reminder events are never emitted.
- **Fleet**: no utilization view; no per-driver activity route; active alerts show only the failed-automation count.
- **Status platform**: no historical calendar; no public-page response-time chart (admin 24h chart exists); Tesla/Tessie monitoring counts recent errors without a reachability probe.
- **3D viewer**: `wheelStyle` and `windowsOpen` are not rendered; brake-light, indicator and battery meshes are missing; lock/climate 3D cues and component highlighting are pending; indicators/windows/airflow/defrost/lifecycle animations are pending; `frameloop` is always on (no reduced rendering while hidden).
- **Branding**: only an `orgName` text setting — no logo/colour/asset upload.
- **Scale**: the poller is batched (200/tick) with serial enqueue, but a real 5,000-vehicle load test was never run; lists are not virtualized; no analytics cache layer.
- **Presentation renders**: the Phase-12 render step (product renders/thumbnails beyond the 512×288 showroom thumbs) is post-push work.
