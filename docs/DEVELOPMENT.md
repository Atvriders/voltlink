# Development

## Prerequisites

- Node.js 24 (nvm recommended)
- PostgreSQL 16+ locally (or via compose), Redis optional
- Blender 5.x (only for regenerating vehicle assets)

## Setup

```bash
git clone https://github.com/Atvriders/voltlink.git
cd voltlink
npm ci
cp .env.example .env                    # then export the values you need
npx prisma generate --schema apps/api/prisma/schema.prisma
npx prisma migrate deploy --schema apps/api/prisma/schema.prisma
```

## Run in development

```bash
npm run dev:api   # Express on :3000 with tsx watch
npm run dev:web   # Vite on :5173, proxies /api to the API
```

Vite dev server proxies API calls; cookies and CSRF work out of the box.

## Build

```bash
npm run build
# API bundle → apps/api/dist/*.cjs (esbuild CJS — see AD-08)
# SPA → apps/web/dist, staged to apps/api/web-dist for `node dist/index.cjs`
```

Run the production-like server locally:

```bash
cd apps/api && PORT=3111 node dist/index.cjs
```

## Database & migrations

```bash
# generate a migration script from schema changes (never interactive)
npx prisma migrate diff --from-migrations apps/api/prisma/migrations \
  --to-schema-datamodel apps/api/prisma/schema.prisma \
  --shadow-database-url "$SHADOW_DATABASE_URL" --script -o apps/api/prisma/migrations/<ts>_name/migration.sql
# review the SQL by hand, then apply
npx prisma migrate deploy
```

`prisma migrate dev` needs a TTY and aborts without one, so use
`migrate diff --script` + review + `migrate deploy` in scripts and CI.

The telemetry table is **partitioned by time**; a SQL function
(`voltlink_ensure_partition()`) creates partitions ahead of ingestion and runs
at boot.

## Code layout

```
apps/api/src
  core/        env, db, crypto, queue (PG + Redis), SSE hub, settings, geo
  auth/        service, middleware, routes
  providers/   types, registry, tesla, tessie, demo, mock
  telemetry/   ingest, poller, seed, retention
  commands/    issue + process (dispatch/confirm stages)
  automations/ engine
  notifications/ service, push, simple webhooks
  status/      checks + public bundle
  routes/      vehicles, drives, charging, analytics, fleet, admin…
  index/worker/scheduler/statusServer.ts   role entrypoints
apps/web/src
  pages/       one file per page (lazy-loaded)
  webgl/       VehicleViewer (GLB + procedural fallback)
  api/         fetch client (CSRF + 401 event)
  auth/        AuthContext, themes
```

## Useful scripts

```bash
npm run typecheck
npm run lint
npm run legacy:scan          # fails on leftover non-VoltLink domain content
npm run e2e                  # Playwright (needs a running API on :3111)
blender/rebuild_all.sh       # regenerate vehicle GLBs + thumbnails + manifest
```

### Tests

`npm test` runs shared, API and web suites. The API migration tests create
throwaway databases and therefore need a Postgres role with `CREATEDB`:

- `TEST_DATABASE_ADMIN_URL` points at that role (e.g.
  `postgresql://voltlink:pw@127.0.0.1:5433/postgres`).
- When it is unset, tests derive it from `DATABASE_URL` by using the
  `postgres` maintenance database on the same server, so a fresh shell with
  only `DATABASE_URL` configured still works.

## Env for local dev

See [Configuration](CONFIGURATION.md). `JWT_SECRET` is required everywhere;
`VL_MASTER_KEY` only in production (`NODE_ENV=production`).

## Architecture decisions

Every significant choice is recorded with rationale in
[ARCHITECTURE_DECISIONS.md](ARCHITECTURE_DECISIONS.md).
