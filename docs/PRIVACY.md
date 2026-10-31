# Privacy

VoltLink is self-hosted: vehicle data lives in your PostgreSQL database and
never passes through a VoltLink-operated service.

## Privacy zones

Mark areas on the map where the vehicle's location should not be recorded in
detail. When a telemetry sample lands inside an enabled privacy zone:

- The stored address is redacted (only the zone is recorded, not the street
  address)
- Location history rows are trimmed to the zone centre
- Drives that start or end inside a zone show the zone instead of the point

Privacy zones apply to new samples immediately. Enabling a zone (or moving a
vehicle into one) also triggers a retroactive redaction job: existing drives,
drive route points, charging sessions, location rows and telemetry snapshots
falling inside the zone are redacted within a few minutes — no manual export
and delete is needed. The redaction is irreversible for raw coordinates (only
the zone reference is kept).

## Retention

Per-user configurable retention (Settings → Privacy):

- **Telemetry retention** — how long raw telemetry is kept (default 365 days);
  older rows are pruned by the scheduler.
- **Location retention** — separate, typically shorter window for precise
  location data.

Aggregates (daily summaries) outlive raw rows and contain no exact locations.

## Export & delete

- **Export** (Settings → Privacy → Export): a complete JSON bundle of your
  vehicles, drives, charging, automations, notifications and account data.
- **Delete account**: removes your user, vehicles, history and settings
  permanently. Fleet-shared data you created is removed where you own it.

## Data flow

- Telemetry enters via the provider adapter and is stored partitioned by time.
- Emails are sent only when you configure SMTP; by default messages are
  logged to the server console instead.
- The public status page exposes no vehicle data — only platform health.

## Children's data

VoltLink does not target children and collects no marketing data of any kind.
