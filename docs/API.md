# API reference

Base URL: `https://<your-host>/api/v1`. All responses are JSON; collections
use `{ data: [...] }`, single resources `{ data: {...} }`, errors
`{ error: { code, message } }`. Auth is a session cookie (`vl_session`) plus a
CSRF header (`X-VL-CSRF`) for mutating requests — the SPA handles both
automatically.

Machine-readable spec: [docs/openapi.json](openapi.json) (also served at
`/api/docs` as JSON).

## Auth — `/auth`

| Method   | Path                                             | Notes                                            |
| -------- | ------------------------------------------------ | ------------------------------------------------ |
| POST     | `/auth/register`                                 | Create account                                   |
| POST     | `/auth/login`                                    | Password login                                   |
| POST     | `/auth/login/totp`                               | Second step when TOTP enabled                    |
| POST     | `/auth/forgot-password` / `/auth/reset-password` | Reset flow                                       |
| POST     | `/auth/verify-email`                             | Verify email token                               |
| GET      | `/auth/me`                                       | Current user                                     |
| POST     | `/auth/logout`                                   | Revoke current session                           |
| GET      | `/auth/sessions`                                 | List sessions                                    |
| DELETE   | `/auth/sessions/:id`                             | Revoke a session                                 |
| POST     | `/auth/sessions/revoke-all`                      | Revoke everything                                |
| GET/POST | `/auth/totp/*`                                   | TOTP setup / confirm / disable                   |
| POST     | `/auth/passkey/*`                                | WebAuthn registration + authentication           |
| POST     | `/auth/step-up`                                  | Step-up re-authentication for high-risk commands |
| GET      | `/auth/csrf`                                     | Issue CSRF cookie + header value                 |

## Users & settings — `/users`

| Method | Path                     | Notes                         |
| ------ | ------------------------ | ----------------------------- |
| PATCH  | `/users/settings`        | Units, timezone, theme        |
| POST   | `/users/change-password` |                               |
| GET    | `/users/export`          | Full JSON export of your data |
| DELETE | `/users`                 | Permanent account deletion    |
| POST   | `/users/demo-mode`       | Connect demo fleet            |
| PATCH  | `/users/retention`       | Retention settings            |

## Providers — `/providers`

Readiness diagnostics, demo connect/refresh, Tesla authorize + OAuth callback,
Tessie connect + token webhook, vehicle import, disconnect, demo-degraded
toggle. See [Providers](PROVIDERS.md).

## Vehicles — `/vehicles`

| Method                | Path                                    | Notes                       |
| --------------------- | --------------------------------------- | --------------------------- |
| GET                   | `/vehicles`                             | List with state + freshness |
| GET                   | `/vehicles/:id` / `/vehicles/:id/state` | Details / live state        |
| POST                  | `/vehicles/:id/refresh`                 | Force state fetch           |
| PATCH                 | `/vehicles/:id`                         | Rename, notes               |
| GET/POST/DELETE       | `/vehicles/:id/permissions*`            | Share access with roles     |
| GET/POST              | `/vehicles/places/all` (+ DELETE)       | Places                      |
| GET/POST/PATCH/DELETE | `/vehicles/geofences/all*`              | Geofences                   |
| GET/POST/PATCH/DELETE | `/vehicles/privacy-zones*`              | Privacy zones               |

## Commands — `/commands`

| Method | Path                         | Notes                                       |
| ------ | ---------------------------- | ------------------------------------------- |
| POST   | `/commands/:vehicleId/issue` | Issue a command (`{ command }`)             |
| GET    | `/commands?vehicleId=`       | List with lifecycle state                   |
| GET    | `/commands/:id`              | Detail + audit events                       |
| POST   | `/commands/:id/cancel`       | Cancel while pending                        |
| GET    | `/commands/switches`         | Kill-switch state (global/provider/vehicle) |

## Drives, charging, analytics

| Area      | Paths                                                                                                                                       |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Drives    | `GET /drives`, `/drives/totals`, `/drives/:id`, `PATCH /drives/:id`, export CSV/JSON                                                        |
| Charging  | `GET /charging/sessions`, `/charging/totals`, `PATCH /charging/sessions/:id` (manual cost), rate rules CRUD at `/charging/rates/*`, exports |
| Analytics | `/analytics/battery`, `/analytics/efficiency`, `/analytics/aggregates`, `/analytics/battery-health`, `/analytics/charging-behavior`         |

## Automations — `/automations`

CRUD, `POST /automations/:id/dry-run`, `POST /automations/:id/trigger`,
`GET /automations/:id/executions`, plus unauthenticated webhook ingestion at
`POST /automations/webhook/:token`.

## Notifications — `/notifications`

Inbox (`/notifications`, mark read), preferences, channel URLs
(`ntfy`/`gotify`/`discord`/`teams`), webhooks, push subscription.

## Fleet — `/fleet`

`/fleet/overview`, groups, drivers, departments, cost centers, assignments,
maintenance records, `POST /fleet/report`.

## Status — `/status`

Public: `/status` (page), `/status/rss`, `/status/badge.svg`,
`POST /status/subscribe`.
Admin: components, incidents + updates, maintenance windows, checks.

## Admin — `/admin`

Settings (command kill switches etc.), users + roles, health, retention,
queue (dead letters + flush).

## Realtime

`GET /realtime` — SSE stream of vehicle events for the authenticated user.
The SPA subscribes automatically and falls back to polling when SSE is
unavailable.
