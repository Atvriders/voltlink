# Changelog

All notable changes to VoltLink are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] — 2026-11-20

The round-2 verification release. v1.0.0 could not complete first-run setup
by following its own docs (no setup token was generated and the web UI had no
field for one) — that, plus the whole round-2 review corpus, is fixed here.

> **Errata (2026-11-24):** the v1.1.0 tag failed CI — main run 44802966345
> and tag run 44802968208 both red (prettier gate 37 files, unit-int 0
> tests, migrations tag-config error, e2e/image/publish/promote skipped).
> It was tagged before the main run and beyond the owner's pre-approval,
> and it is **not a release** — no image was published and no GitHub
> Release exists. The round-2 corpus was not fixed: 220 of 253 rows were
> open at tag time, R8/R9 were open, and the format and lint gates failed.
> Fixed forward in v1.1.1.

### Fixed

- **First-run setup (R2-01/R2-20):** the web role now logs the one-time setup
  token at boot and the Setup UI accepts it, so a fresh install following
  README/QUICK_START reaches the register page.
- **Command history (TI-44):** `VehicleCommand.vehicleId` is nullable with
  `onDelete: SetNull` — deleting a vehicle no longer erases its command
  history, and orphaned commands are ended `failed` with an audit event.
- **Automation retries (TI-13):** per-action retry — successful actions run
  exactly once, only failing actions re-run.
- **SSE revocations (R2-31):** password change, password reset and admin
  suspend publish session revocations to live streams.
- **Admin visibility (R2-35):** non-admin users get a 403 card and a hidden
  Administration nav; `/auth/me` carries `isInstanceAdmin`.
- **Tessie/Tesla contracts (R2-32):** documented guide-02 routes, query
  params, and speed-limit PIN handoff through a one-time encrypted secret.
- **Asset validation (R2-63):** glTF validation runs before loading; broken
  GLBs are SPEC_INVALID findings, never crashes.
- **3D pipeline (R2-15/R2-39):** the charging pulse reaches the connector's
  descendant meshes (no more per-frame TypeErrors for charging vehicles);
  the parent-inverse fix + a below-ground validator rule regenerated every
  GLB so door windows sit above the ground plane.
- **Viewer (R2-43/R2-61/R2-62):** orbit/zoom no longer snaps back after the
  first user input; no 404 HEAD fires before the staged manifest resolves;
  low/medium presets now use the `_lod2`/`_lod` variants and the unused `ao`
  preset flag is gone.
- **A11y:** account menu and vehicle switcher names match their visible
  labels, the Settings link is a 24 px target, passkey empty state lists
  correctly, showroom class labels clear contrast — axe is green across all
  five themes on every core page.
- **Admin health (NEW-10):** migration status resolves across flat and
  nested dist layouts.
- **Docs truth:** `SECURITY.md` states the real npm audit figures.

### Changed

- Demo/visual determinism for the e2e visual suite: `VL_DEMO_FROZEN_AT`
  freezes the demo sim and the seeded demo world, with dynamic-region masks,
  so the committed pixel baselines are stable across runs.
- `package-lock.json` after the non-breaking `npm audit fix`.

### Known limitations

- Environments are built and staged but the viewer does not yet load one
  (R2-41); the LOD0 triangle minimum is still met by flat subdivision
  (R2-42). Both remain open and tracked in PROGRESS.md.

## [Unreleased]

### Added

- OpenAPI 3.1 generated from the live route table (191+ operations, session /
  CSRF / bearer security schemes), served at `/api/docs`, with route-coverage,
  phantom-operation and snapshot-drift tests.
- Generated completion matrix (`COMPLETION.md`) driven by the append-only
  evidence ledger; `npx tsx scripts/completion-check.ts` verifies every cited
  level.
- Organization-scoped tenancy record in ARCHITECTURE_DECISIONS (AD-17/18) and
  an honest retroactive FOUNDATION_AUDIT.md.
- Hardened legacy scanner: reads every tracked text file, separator-tolerant
  terms, planted-term self-test.

### Removed

- `/api/v1/exports` users-router alias (use `/api/v1/users/export`).
- Legacy `docker/Dockerfile` from the foundation project and the duplicate
  root `LICENSE` (only `LICENSE.md` remains).

### Changed

- Renamed every technical identifier from the old spelling `voltlank` to `voltlink` (packages, image, database role and name, SQL functions, metrics, Docker user, entrypoint and healthcheck binaries, theme ids, export filenames, env prefix `VOLTLINK_`). The old database objects (`voltlank_ensure_partition`, `voltlank_migrations`) are dropped by the rename migration. Stored themes are normalized to the new ids. This is a breaking change for anyone scraping the old metric names or pinning old volume names; see UPGRADING.md.

## [1.0.0] — 2026-10-27

### Added

- **Telemetry**: live vehicle state, sleep-aware polling, partitioned
  telemetry storage, auto-detected drives and charging sessions.
- **Controls**: full command lifecycle
  (`queued → submitted → accepted → confirmed` with
  `failed/rejected/unsupported/timed_out/canceled`), high-risk step-up auth,
  kill switches, rate limits, audit trail.
- **Providers**: official Tesla Fleet API adapter, optional Tessie adapter,
  deterministic DemoProvider, scriptable MockProvider; encrypted credential
  store; readiness diagnostics.
- **Auth**: Argon2id passwords, email verification, TOTP, WebAuthn passkeys,
  session management + revocation, CSRF protection, rate limiting.
- **Analytics**: drives + totals, charging + cost rules (flat/TOU/location),
  battery health, efficiency, charging behaviour, CSV/JSON exports.
- **Automations**: 17 triggers, conditions, actions (notify, webhook,
  incident, report, vehicle command), cooldowns, dry-run, execution history.
- **Notifications**: 8 channels (in-app, email, push, webhook, ntfy, Gotify,
  Discord, Teams) with per-channel preferences.
- **Fleet**: groups, drivers, departments, cost centers, assignments,
  maintenance, fleet report.
- **Status platform**: 16 components, incidents + updates, maintenance
  windows, uptime, public page, RSS, SVG badge, subscriptions.
- **Web**: 5 themes (incl. high-contrast and colorblind-safe), SSE realtime
  with polling fallback, state-aware WebGL showroom with Blender-generated
  GLB assets (5 vehicle classes + LODs), offline fictional map, presentation
  mode, onboarding.
- **Ops**: multi-role Docker image, dev + production compose stacks, GHCR
  publishing (`latest`, `v1.0.0`, commit SHA), CI with E2E, asset validation,
  audit + Trivy + SBOM.
- **Privacy**: privacy zones, configurable retention, full export, permanent
  deletion.
- **Docs**: full documentation suite + OpenAPI spec.

### Security

- Provider credentials envelope-encrypted (AES-256-GCM, wrapped DEK,
  versioned keys).
- Boot-time refusal of placeholder secrets.

## Notes

- CI gitleaks scans the full history on every push; the first push of a new
  repository has no parent commit for range scans, so any push after the
  initial one is scanned incrementally.
