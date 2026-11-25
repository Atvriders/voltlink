# Testing

## Layers

| Layer             | Tool                                  | Where                                                           |
| ----------------- | ------------------------------------- | --------------------------------------------------------------- |
| Unit              | Vitest                                | `apps/api/test/`, `apps/web/src/**/*.test.ts(x)`                |
| API               | Vitest + supertest against PostgreSQL | `apps/api/test/`                                                |
| E2E               | Playwright (desktop + Pixel 7 mobile) | `tests/e2e/`                                                    |
| Visual regression | Playwright snapshots                  | `tests/e2e/`                                                    |
| WebGL assets      | Playwright + GLB validation           | `tests/e2e/webgl-assets.spec.ts`, `scripts/assets/validate.mts` |
| Security          | auth/CSRF/rate-limit tests            | `apps/api/test/`                                                |
| Legacy content    | grep-based scan                       | `scripts/legacy-scan.ts`                                        |

## Running

```bash
npm test                          # unit + API (needs test DB)
npx prisma migrate deploy         # once, against the test database
npm run e2e                       # Playwright (API on :3111 required)
npm run legacy:scan               # fails on leftover pre-rebrand content
```

## E2E details

`playwright.config.ts` defines five projects — `desktop`, `tablet` (iPad
Pro 11 Chromium), `mobile` (Pixel 7), `webgl-swiftshader` (software GL) and
`no-webgl` (WebGL disabled, graceful-degradation smoke) — against
`http://127.0.0.1:3111`. The suite:

- registers fresh users, enables demo mode, walks the whole product
- asserts the command lifecycle is visible (`Queued → …`)
- verifies the WebGL showroom loads **real GLB assets** (not the procedural
  fallback) for all five vehicle classes
- collects console errors and fails on unexpected ones

Start the target server before the suite:

```bash
cd apps/api && PORT=3111 node dist/index.cjs
```

## Visual regression

The visual baselines are generated from the SCRIPTED frozen demo stack
(guide 08 §11.2), never from a hand-set environment:

```
RUN_DIR="$PWD/scripts/e2e/run-visual" \
DATABASE_URL=postgresql://voltlink:voltlink@127.0.0.1:5432/voltlink \
REDIS_URL=redis://127.0.0.1:6379 \
JWT_SECRET=<32+ char secret> VL_MASTER_KEY=<base64> \
PUBLIC_URL=http://127.0.0.1:3111 \
bash scripts/e2e/start-stack.sh visual
```

Visual mode resets the dedicated `voltlink_visual` database on every boot,
runs `NODE_ENV=test` with `VL_TEST_FROZEN_NOW=2026-06-15T15:30:00Z` and
`VL_POLLER_ENABLED=false`; the API rejects `VL_TEST_FROZEN_NOW` in
production (the demo clock is test-only, `apps/api/src/core/demoClock.ts`).
After the migrations the stack also seeds the global status content once
(`node dist/cli/seed-status.cjs`), so the public status page, the status
admin page and their charts render the same seeded world no matter which
tests have enabled a demo fleet already — uptime figures, the response-times
chart and every status timestamp are order-independent. CI's e2e-fullstack
job boots this same mode. The Playwright specs freeze the
browser clock with `page.clock.setFixedTime` before navigating, so relative
times are pixel-stable on any day.

`tests/e2e/visual.spec.ts` (desktop project) snapshots: sign-in, overview
(desktop + light theme), live vehicle, drives, charging, automations, fleet,
map, public status, settings security, admin (as the instance admin), the
non-admin 403 card, battery, notifications, providers, vehicles, drive
detail, showroom (page + viewer element), admin users, status admin and
onboarding. `tests/e2e/visual-mobile.spec.ts` runs under the real mobile
(Pixel 7) and tablet (iPad Pro 11) projects: overview and live vehicle.
Every snapshot is preceded by content assertions on the page's own seeded
data, dynamic regions (account chip, `[data-relative-time]` elements) are
masked, and full-page tolerance is `maxDiffPixels: 25` (the WebGL viewer
element shot uses `maxDiffPixelRatio: 0.01`). Baselines live in
`tests/e2e/visual.spec.ts-snapshots/` and are regenerated only in R6 with
`--update-snapshots` against the scripted visual stack, reviewing every diff
image before committing.

## Blender assets

`blender/rebuild_all.sh` regenerates the five vehicle GLBs (+ LOD variants and
thumbnails) and fails if any asset is missing parts or invalid. CI validates
the committed artifacts with `npx tsx scripts/assets/validate.mts`.

## CI

`.github/workflows/ci.yml` runs: typecheck, lint, unit/API tests (PostgreSQL
service), E2E, asset validation, `npm audit` gates, Docker image build +
Trivy scan + SBOM, and GHCR publishing on `main`.
