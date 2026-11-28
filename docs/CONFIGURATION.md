# Configuration

All configuration is environment variables. In Docker Compose they come from
the defaults baked into `compose.production.yml`, overridden by `.env` or the
environment (`.env.example` lists every variable); bare-metal exports them
directly.

## Required

| Variable        | Description                                                                                                                                                                                                                   |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JWT_SECRET`    | Session-token signing secret, ≥ 32 chars. `openssl rand -hex 32`. Required in every environment (Docker Compose ships a local-trial default — rotate it before exposing the stack).                                           |
| `VL_MASTER_KEY` | 32-byte base64 master key for envelope encryption of provider credentials. `openssl rand -base64 32`. Required when `NODE_ENV=production` (Docker Compose ships a local-trial default — rotate it before exposing the stack). |
| `DATABASE_URL`  | PostgreSQL connection string, e.g. `postgresql://voltlink:pass@host:5432/voltlink`.                                                                                                                                           |
| `PUBLIC_URL`    | Public HTTPS origin; must be `https://` in production (secure cookies). Docker Compose defaults to `http://localhost:3110`.                                                                                                   |

## Core

| Variable                  | Default       | Description                                               |
| ------------------------- | ------------- | --------------------------------------------------------- |
| `PORT`                    | `3000`        | HTTP listen port                                          |
| `HOST`                    | `0.0.0.0`     | Bind address                                              |
| `NODE_ENV`                | `development` | `production` enables strict validation                    |
| `VL_ROLE`                 | `web`         | `web` \| `worker` \| `scheduler` \| `status` \| `migrate` |
| `REDIS_URL`               | _(empty)_     | Redis URL; when empty the queue falls back to PostgreSQL  |
| `VL_RATE_LIMIT_PER_MIN`   | `900`         | Global API rate limit per IP per minute                   |
| `TRUST_PROXY`             | `false`       | Honour `X-Forwarded-*` behind a proxy                     |
| `STATUS_PORT`             | `3001`        | Port the `status` role listens on                         |
| `LOG_LEVEL`               | `info`        | Log level                                                 |
| `VL_DEMO_DEFAULT_ENABLED` | `false`       | Auto-enable demo mode for new accounts (development only) |

## Email

| Variable          | Description                                                                                                           |
| ----------------- | --------------------------------------------------------------------------------------------------------------------- |
| `SMTP_URL`        | `smtp://user:pass@host:587`; empty = mail is suppressed (one log line per mail, never the body or a link)             |
| `MAIL_FROM`       | From header                                                                                                           |
| `MAIL_TO_CONSOLE` | `false` (default). `true` prints every mail instead of sending — development only; production refuses to boot with it |

## Authentication extras

| Variable              | Default     | Description                                      |
| --------------------- | ----------- | ------------------------------------------------ |
| `VL_TOTP_ISSUER`      | `VoltLink`  | OTP app issuer label                             |
| `VL_WEBAUTHN_RP_ID`   | `localhost` | WebAuthn relying-party ID (your public hostname) |
| `VL_WEBAUTHN_RP_NAME` | `VoltLink`  | WebAuthn relying-party display name              |
| `JWT_EXPIRES_SEC`     | `1209600`   | Session lifetime in seconds (14 days)            |

## Providers

| Variable                                 | Description                                                |
| ---------------------------------------- | ---------------------------------------------------------- |
| `TESLA_CLIENT_ID`, `TESLA_CLIENT_SECRET` | Official Tesla Fleet API OAuth credentials                 |
| `TESLA_REDIRECT_URI`                     | OAuth callback URL, must match the Tesla developer console |
| `TESLA_BASE_URL`                         | Fleet API base URL (region-dependent default)              |
| `TESSIE_BASE_URL`                        | Optional Tessie API base URL                               |

See [Tesla setup](TESLA_SETUP.md) and [Tessie](OPTIONAL_TESSIE_PROVIDER.md).

## Web push

| Variable                                 | Description                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------- |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Web Push VAPID keypair (generate with `npx web-push generate-vapid-keys`) |
| `VAPID_SUBJECT`                          | `mailto:` contact for push subscriptions                                  |

## Application settings (runtime, per owner)

The Admin page exposes owner-tunable settings stored in the database
(`AppSetting`): global command enable/disable, provider command kill switches,
vehicle-level kill switches, retention defaults, registration enable/disable,
and status-page branding.

## Validation behaviour

Boot fails fast when a required secret is missing, too short, or looks like a
placeholder (`secret`, `change-me`, …), and when `PUBLIC_URL` is not HTTPS in
production. That is intentional: never deploy with a published default key.

## Basemaps (F-MAPGRID)

`VL_MAP_MODE` selects the basemap style:

| Value            | Style                                                                                              | Use                                                                                       |
| ---------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `demo` (default) | Fictional grid from the `--vl-map-*` theme tokens, no network                                      | Demo, CI, air-gapped installs                                                             |
| `pmtiles`        | Protomaps style over `VL_MAP_PMTILES_URL`; glyphs and sprites from `VL_MAP_ASSETS_URL`             | Recommended self-host: one file, served by the app from `VL_MAP_TILES_DIR` under `/tiles` |
| `style`          | `VL_MAP_STYLE_URL` as-is, e.g. OpenFreeMap `https://tiles.openfreemap.org/styles/liberty` (no key) | The operator already runs a tile provider                                                 |

- `VL_MAP_ATTRIBUTION` — attribution text shown for the basemap.
- `VL_CSP_CONNECT_ORIGINS` — comma-separated extra https origins that tiles,
  glyphs or sprites load from; the CSP is extended automatically with the
  origins of the configured style, PMTiles and asset URLs.

Self-host recipe (extract once, serve forever):

```bash
pmtiles extract https://build.protomaps.com/<YYYYMMDD>.pmtiles ./tiles/region.pmtiles --bbox=-105.2,38.6,-104.0,39.5 --maxzoom=15
# copy fonts/ and sprites/ from github.com/protomaps/basemaps-assets into ./tiles/assets (check its LICENSE files first)
docker run -v "$PWD/tiles:/data/tiles:ro" -e VL_MAP_MODE=pmtiles -e VL_MAP_TILES_DIR=/data/tiles   -e VL_MAP_PMTILES_URL=/tiles/region.pmtiles ghcr.io/atvriders/voltlink:latest
```

Never commit a provider key and never default to a keyed provider: a keyed tile
URL is visible to every signed-in browser. If you use MapTiler, restrict the key
with its "Allowed HTTP origins" setting. In `demo` mode the app shows a
"Fictional demo map" badge, and a notice whenever real vehicles appear on the
fictional basemap.

## Image reference (Docker Compose)

| Variable                  | Default     | Description                                                                                                                                                                                                       |
| ------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `COMPOSE_FILE`            | unset       | Compose entry point. `docker-compose.yml` (downloaded together with `compose.production.yml`) includes the production file, so every command is a bare `docker compose` with no `.env` and no `COMPOSE_FILE`.     |
| `VOLTLINK_IMAGE_TAG`      | `v1.1.2`    | Release tag the compose file ships with; leave unset to use it. `check:compose` fails if it stops matching the package version. `latest` stays opt-in.                                                            |
| `VOLTLINK_IMAGE_DIGEST`   | empty       | Pin the exact `ghcr.io/atvriders/voltlink@sha256:<digest>` for immutable deployments.                                                                                                                             |
| `VOLTLINK_BIND_ADDRESS`   | `127.0.0.1` | Address the published ports bind to. Use a reverse proxy instead of `0.0.0.0`.                                                                                                                                    |
| `VOLTLINK_STATUS_PORT`    | `3001`      | Host port the `status` profile publishes on (compose-only; the container always listens on `STATUS_PORT`).                                                                                                        |
| `CLOUDFLARE_TUNNEL_TOKEN` | —           | Only with `docker-compose.tunnel.yml`: the token of a remotely-managed Cloudflare Tunnel. The overlay also requires `PUBLIC_URL` to be the tunnel hostname and sets `TRUST_PROXY=1` for the single connector hop. |
| `VOLTLINK_DATABASE_URL`   | —           | Optional external PostgreSQL URL; unset = the bundled `postgres` service, whose password is `POSTGRES_PASSWORD`.                                                                                                  |
