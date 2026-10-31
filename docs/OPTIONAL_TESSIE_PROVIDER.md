# Tessie provider (optional)

Tessie is an optional third-party Tesla API. VoltLink maps Tessie's documented
state schema and command list — no invented fields or commands.

## Connect

`POST /api/v1/providers/tessie/connect {token, label}` verifies the token
against Tessie (`GET /vins`) **before** storing it, and stores the account as
`connected` so Import is immediately available. The token is sealed at rest and
never returned by any API.

## Commands

Tessie endpoints used: `GET /{vin}/state`, `GET /{vin}/status`, `POST /{vin}/wake`,
`POST /{vin}/command/{name}` (e.g. `lock`, `start_charging`, `set_charge_limit`,
`vent_windows`, `share`). Pre-wake happens for climate and charging commands;
toggles are never auto-retried after an unknown outcome.

## Readiness

`GET /api/v1/providers/readiness` verifies the stored token with a real call —
Tessie readiness is never hard-coded.

## Webhooks

Tessie has **no webhook API** (only an optional outbound WebSocket stream).
`POST /api/v1/providers/tessie/webhook` answers 404; VoltLink does not implement
one.
