# Automations

Automations react to vehicle and platform events: **trigger → conditions →
actions**, with cooldowns, dry-run and full execution history.

## Anatomy

```
Automation
├── trigger        one of 12 trigger events
├── conditions     optional filters (battery below X%, outside geofence, time…)
├── actions        one or more: notify / webhook / create incident /
│                  generate report / vehicle command
├── cooldown       minimum seconds between runs (default 300)
└── enabled        on/off, plus dry-run for testing
```

## Trigger events

`charge_started`, `charge_completed`, `drive_started`, `drive_completed`,
`battery_low`, `battery_high`, `geofence_enter`, `geofence_exit`,
`vehicle_offline`, `vehicle_online`, `command_finished`, `maintenance_due`.

## Conditions

- Battery state-of-charge below / above a threshold
- Inside or outside a chosen geofence
- Time of day window
- Vehicle filter (all / one vehicle / a fleet group)

## Actions

| Action          | Effect                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------- |
| Notify          | Notification through the user's preferred channels                                          |
| Webhook         | `POST` JSON payload to a chosen webhook endpoint                                            |
| Create incident | Opens a status-page incident with the payload                                               |
| Generate report | Queues a fleet or vehicle report generation                                                 |
| Vehicle command | Issues a command through the normal lifecycle (step-up still applies to high-risk commands) |

## Testing

Every automation supports **dry-run**: pick a recent event and VoltLink
evaluates trigger, conditions and actions without executing writes, showing
exactly what _would_ have happened.

The **executions** panel records each real run: timestamps, matched conditions,
per-action outcomes, and errors.

## Examples

- _"If battery falls below 20% and it's after 22:00, notify me"_
- _"When the pickup exits the jobsite geofence, create an incident and notify
  the fleet group"_
- _"On charge completed, generate a charging behaviour report"_

## Webhook payload

Webhook actions deliver a signed JSON body (trigger, vehicle, event data,
timestamp) to your endpoint. Outbound webhooks are signed per the
[Standard Webhooks](https://www.standardwebhooks.com/) scheme: the
`webhook-id`, `webhook-timestamp` and `webhook-signature` (`v1,<base64>`) headers
carry an HMAC-SHA256 over `<id>.<timestamp>.<body>`, and the signing secret is
the `whsec_…` value shown once at endpoint creation. Verify with the official
library:

```ts
import { Webhook } from 'standardwebhooks';
const secret = process.env.VL_WEBHOOK_SECRET; // whsec_… from endpoint creation
const wh = new Webhook(secret);
wh.verify(JSON.stringify(payload), headers); // throws on failure
```

(Plain `superagent`-style receivers can reconstruct the signature as
`v1,base64(hmac_sha256(secret, webhookId + "." + webhookTimestamp + "." + rawBody))`.)

## Inbound webhooks

A webhook-triggered automation exposes an inbound URL at
`POST /api/v1/hooks/automations/:publicId` (no session, no CSRF). Sign requests
with the same Standard Webhooks scheme using the `whsec_…` secret shown once at
hook creation:

```ts
import { Webhook } from 'standardwebhooks';
const wh = new Webhook(secret);
const body = JSON.stringify({ state: 'occupied' });
const headers = {
  'webhook-id': crypto.randomUUID(),
  'webhook-timestamp': String(Math.floor(Date.now() / 1000)),
  'webhook-signature': `v1,${base64HmacSha256(secret, `${headersId}.${headersTs}.${body}`)}`,
};
await fetch(`https://voltlink.example.com/api/v1/hooks/automations/${publicId}`, {
  method: 'POST',
  headers,
  body,
});
```

Deliveries are deduplicated by `webhook-id` (replays answer `{ ok: true,
replayed: true }`); a bad signature is rejected with `401 SIGNATURE`.
[Test receivers in the official playground](https://www.standardwebhooks.com/)
or use the `wh.verify` example above.
