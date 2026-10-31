# Notifications

Eight channels, per-channel preferences, per-notification filtering.

## Channels

| Channel        | Setup                                          |
| -------------- | ---------------------------------------------- |
| In-app         | Always available (Notifications page inbox)    |
| Email          | `SMTP_URL` (or console logging in development) |
| Web push       | VAPID keypair + browser permission             |
| Custom webhook | Any HTTP endpoint (JSON POST)                  |
| ntfy           | Self-hosted or ntfy.sh topic                   |
| Gotify         | Gotify server URL + app token                  |
| Discord        | Webhook URL                                    |
| Teams          | Microsoft Teams incoming webhook URL           |

## Preferences

**Notifications → Preferences** gives per-channel toggles plus per-event-type
fine-tuning — for example: email for `command_finished` and
`battery_low`, but in-app only for `drive_started`.

## Channel URLs (ntfy / Gotify / Discord / Teams)

The **Webhooks** tab stores per-user URLs (e.g. `ntfy://topic`, a Discord
webhook, a Teams incoming webhook). URLs are validated before saving
(scheme/host allowlist for self-hosted notification servers, so a malicious
automation can't make the server phone home to arbitrary SSRF targets).

## Push

Web Push uses standard VAPID. Set `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY`
(`npx web-push generate-vapid-keys`) and `VAPID_SUBJECT`; users subscribe from
the browser.

## Sources

Notifications originate from:

- Command lifecycle outcomes (see Vehicle controls)
- Automation actions
- Geofence and privacy events
- Fleet maintenance reminders
- Admin actions (e.g. forced logout notices)

All are filtered through the same preference engine, stored in the inbox, and
markable read (or all-read).
