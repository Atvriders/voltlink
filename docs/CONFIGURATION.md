# Configuration

All configuration is environment variables. In Docker Compose they come from
`.env` (copy `.env.example`); bare-metal exports them directly.

## Required

| Variable        | Description                                                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `JWT_SECRET`    | Session-token signing secret, ≥ 32 chars. `openssl rand -hex 32`. Required in every environment.                                           |
| `VL_MASTER_KEY` | 32-byte base64 master key for envelope encryption of provider credentials. `openssl rand -base64 32`. Required when `NODE_ENV=production`. |
| `DATABASE_URL`  | PostgreSQL connection string, e.g. `postgresql://voltlink:pass@host:5432/voltlink`.                                                        |
| `PUBLIC_URL`    | Public HTTPS origin; must be `https://` in production (secure cookies).                                                                    |

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

| Variable          | Description                                                               |
| ----------------- | ------------------------------------------------------------------------- |
| `SMTP_URL`        | `smtp://user:pass@host:587`; empty = console logging of messages          |
| `MAIL_FROM`       | From header                                                               |
| `MAIL_TO_CONSOLE` | `true` (default) logs every mail instead of sending — useful for previews |

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
