# Providers

VoltLink talks to vehicles through a provider framework. Every provider
implements the same contract — state fetch, command dispatch, account linking —
so the rest of the platform (telemetry, controls, automations, fleet) never
knows which one is behind a vehicle.

| Provider   | What it is                                                               | Use it for                                |
| ---------- | ------------------------------------------------------------------------ | ----------------------------------------- |
| **Tesla**  | Official Tesla Fleet API (OAuth)                                         | Real Tesla vehicles                       |
| **Tessie** | Optional third-party Tesla data service                                  | Vehicles that need the Tessie API instead |
| **Demo**   | Deterministic simulator with 5 fictional vehicles and 30 days of history | Evaluating every feature without a car    |
| **Mock**   | Scriptable provider with per-command scripts                             | Tests and failure-path drills             |

## Connecting

1. Open **Providers**.
2. Pick a provider and follow its flow:
   - **Demo** — one click. Seeds 5 vehicles with drives, charges, places,
     geofences, rate rules, automations and notifications.
   - **Tesla** — redirects to Tesla's authorization page, exchanges the code
     for tokens, stores them encrypted. See [Tesla setup](TESLA_SETUP.md).
   - **Tessie** — paste an API token (or use the optional token webhook to
     receive tokens from Tessie). See [Tessie](OPTIONAL_TESSIE_PROVIDER.md).

## Credential security

Provider credentials are sealed with AES-256-GCM before storage. A random data
encryption key encrypts the payload; that key is wrapped by the master key
(`VL_MASTER_KEY`). Envelopes are versioned (`KEY_VERSION`) so keys can rotate
without re-encrypting everything at once. Losing `VL_MASTER_KEY` makes stored
credentials unreadable — back it up with your database.

## Readiness diagnostics

The Providers page runs a live readiness check per connected provider:
credential presence, configuration completeness (OAuth client ID/secret,
redirect URI), and reachability of the provider base URL. Each failing check is
shown with a concrete remediation.

## Import & refresh

- **Import vehicles** pulls the current vehicle list from the provider into
  VoltLink.
- **Refresh state** (per vehicle or via the poller) fetches live state; the
  poller is sleep-aware — it schedules the next fetch after the vehicle's
  expected wake time instead of hammering a sleeping car.

## Disconnecting

Disconnect removes the provider credentials and marks the imported vehicles
offline but keeps history, drives, charges and settings unless you delete the
vehicle itself.

## Demo degraded mode

The Demo provider can simulate a degraded provider (Admin page toggle): state
fetches start failing, which exercises offline detection, freshness badges
(`stale`, `last_known`), and automation triggers for `vehicle_offline`.
