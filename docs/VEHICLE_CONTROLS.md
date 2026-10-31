# Vehicle controls

Vehicle commands are first-class entities with a full lifecycle, not
fire-and-forget calls.

## Command lifecycle

```
queued → submitted → accepted → confirmed
            └→ failed | rejected | unsupported | timed_out | canceled
```

1. **queued** — validated and persisted. Checks: vehicle capabilities, global /
   provider / vehicle kill switches, rate buckets, idempotency.
2. **submitted** — the provider accepted the dispatch (e.g. Tesla accepted the
   request).
3. **accepted** — observed by the worker from the provider's acknowledgement.
4. **confirmed** — the state change is visible in telemetry (e.g. doors
   unlocked), or the provider reported completion.
5. **timed_out** — no confirmation within the timeout window (~60 s).
6. **rejected / unsupported** — the provider refused or does not support the
   command (e.g. `charge_start` with no cable, or an endpoint outside your
   Tesla application tier).
7. **canceled** — you canceled it before it left `queued`/`submitted`.

Every transition is recorded in `CommandAuditEvent` and surfaced in the Live
vehicle page's command stepper.

## Command groups

| Group    | Commands                                 |
| -------- | ---------------------------------------- |
| Access   | lock, unlock                             |
| Lights   | flash_lights, honk_horn                  |
| Climate  | climate_on, climate_off, set_temperature |
| Charging | charge_start, charge_stop, charge_limit  |
| Wake     | wake, remote_start                       |
| Cargo    | open_trunk, open_frunk                   |
| Security | enable_sentry, disable_sentry            |

## High-risk step-up

Some commands can put people or property at risk, so they require **step-up
authentication**: re-confirm with your password, TOTP, or a passkey within a
short window before the command dispatches.

High-risk commands: `unlock`, `remote_start`, `homelink`, `valet_mode`,
`speed_limit`, `sentry_mode`.

The step-up window is short (minutes); when it lapses the command is refused
and you re-authorize.

## Safety switches

Three levels of kill switches (Admin → Command safety):

1. **Global** — disable all commands platform-wide.
2. **Provider** — disable all commands for one provider (e.g. during a Tesla
   outage).
3. **Vehicle** — disable commands for one vehicle (e.g. a car in service).

Additionally, command definitions carry **capability requirements** — a command
is disabled in the UI and rejected by the API when the vehicle or provider
doesn't support it.

## Rate limiting & idempotency

Commands share per-command rate buckets (e.g. you can't spam `honk_horn`), and
issuing the same command for the same vehicle within a short window reuses the
existing command instead of duplicating it.

## Notification on finish

When a command leaves the pending states, the issuing user gets a notification
(in-app and per preference email/push) with the outcome.
