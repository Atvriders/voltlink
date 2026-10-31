# Demo mode

Demo mode gives every user a complete, deterministic playground: five fictional
vehicles and a month of realistic data, seeded from a fixed random seed.

## Enable

**Providers → Enable demo mode** (one click). Or set
`VL_DEMO_DEFAULT_ENABLED=true` so every new account starts with the demo fleet.

## The demo fleet

| Vehicle | Class             | Notes                                                  |
| ------- | ----------------- | ------------------------------------------------------ |
| Aurora  | Compact sedan     | Commuter schedule                                      |
| Comet   | Sport sedan       | Rejects `remote_start` (as scripted)                   |
| Terra   | Compact crossover | Night-time charging                                    |
| Atlas   | SUV               | The family hauler                                      |
| Bison   | Pickup            | Rejects `open_trunk` (as scripted); a `wake` times out |

The fleet uses fictional makes (Halcyon, Cascade, Northline) and a fictional
region (the in-app map is a deterministic fictional city — no external tiles).

## What gets seeded

- 30 days of telemetry, auto-detected drives and charging sessions
- Places (home/work/charger), geofences, a privacy zone
- Electricity rate rules (flat, time-of-use, per-location)
- Fleet structure: groups, drivers, departments, cost centers, assignments,
  maintenance records
- Automations with execution history, notifications, notification preferences
- Status platform content: 16 components, an active incident, a resolved
  incident, and a maintenance window

## Determinism

All demo behaviour derives from a seeded PRNG per account, so two demo accounts
see the same schedules and values. That makes the demo usable in automated
browser tests.

## Simulation model

`simulatedState()` computes state at any timestamp: commutes along loop routes,
charging windows, lock/door/climate events, security-alarm episodes, and
freshness that degrades with polling age. Commands against demo vehicles go
through the full lifecycle, including the deterministic rejections listed
above, so failure paths are demonstrable.

## Degraded mode

The Admin page can toggle a degraded demo provider — state fetches then fail,
producing offline vehicles, stale/last-known badges and `vehicle_offline`
automation triggers. Toggle back to recover.
