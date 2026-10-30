# Upgrading

## Production (published image)

```bash
docker compose -f compose.production.yml pull
docker compose -f compose.production.yml up -d
```

- Back up first (see Backup & restore) — cheap insurance.
- Migrations apply automatically on boot under an advisory lock; multiple
  replicas racing is safe.
- Roll back by pinning the previous tag:

  ```bash
  VOLTLINK_IMAGE_TAG=<previous-tag> docker compose -f compose.production.yml up -d

## Rename to voltlink (technical identifiers)

VoltLink 1.1.0 (unreleased) renames every technical identifier to `voltlink`
(the previous spelling is recorded only in the CHANGELOG rename entry).

- The Compose project and its named volumes are renamed, so the old project's
  `*_pgdata` and `*_redisdata` volumes are not picked up by the new project.
  To migrate data, stop the old stack, then either rename the volumes
  (`docker volume rename <old>_pgdata voltlink_pgdata`, likewise for the Redis
  volume), or back up with the old stack (see BACKUP_RESTORE.md) and restore
  into the new one before starting it.
- The database role and database are `voltlink`. If you managed them manually, create `voltlink` and grant it ownership of the restored database.
- Stored user themes are normalized automatically by the theme migration.
- Metric names and the image-tag env prefix changed as part of the rename (see
  the CHANGELOG rename entry for the old spelling); update any dashboards that
  scrape the metrics and any scripts that set the image-tag variable.
  ```

  Roll forward-only schema migrations may reject older images — check
  `CHANGELOG.md` for migration notes before downgrading.

## Development compose

```bash
docker compose up -d --build
```

## Version policy

- `latest` tracks `main`.
- `v1.0.0` and future tags are stable releases.
- Commit-SHA tags exist for every push: pin those for auditable rollbacks.
- Breaking changes and migration notes appear in `CHANGELOG.md`.

## Multi-replica upgrades

Upgrade `web` and `worker` together when the changelog says a queue-payload or
SSE contract changed; otherwise rolling upgrades are fine.
