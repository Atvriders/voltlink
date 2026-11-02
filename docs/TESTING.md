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

`tests/e2e/visual.spec.ts` snapshots 12 pages under `toHaveScreenshot`:
sign-in, overview (desktop, light theme, mobile), live vehicle, drives,
charging, automations, fleet, map, public status, admin, settings.
Baselines live in `tests/e2e/visual.spec.ts-snapshots/` and are reviewed by eye
before committing; every test asserts its own demo data first.

## Blender assets

`blender/rebuild_all.sh` regenerates the five vehicle GLBs (+ LOD variants and
thumbnails) and fails if any asset is missing parts or invalid. CI validates
the committed artifacts with `npx tsx scripts/assets/validate.mts`.

## CI

`.github/workflows/ci.yml` runs: typecheck, lint, unit/API tests (PostgreSQL
service), E2E, asset validation, `npm audit` gates, Docker image build +
Trivy scan + SBOM, and GHCR publishing on `main`.
