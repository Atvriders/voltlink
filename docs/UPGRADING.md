# Upgrading

> v1.1.1 changed the install to need no `.env` file at all: every required
> value has a default inside the compose file, and `docker-compose.yml` (which
> includes `compose.production.yml` and sets the project name `voltlink`) is
> downloaded together with it, so every command is a bare `docker compose`.
> Scripts that pass `-f compose.production.yml` explicitly keep working. The
> upgrade path below is unchanged; the v1.0.0-file upgrade is verified in CI
> (the upgrade-smoke job boots v1.0.0's own compose file first).

## Production (published image)

- Back up first ([BACKUP_RESTORE.md](BACKUP_RESTORE.md)) — cheap insurance.
- Download the new release's `docker-compose.yml` and `compose.production.yml`
  (the file and the image tag always match), or pin the tag in an optional
  `.env` override:

  ```bash
  # optional .env override
  VOLTLINK_IMAGE_TAG=v1.1.1

  docker compose pull
  docker compose up -d --wait
  ```

- The `migrate` service applies migrations on every boot under an advisory
  lock; the other roles wait for the migrations to be current.
- Roll back by pinning the previous tag:

  ```bash
  VOLTLINK_IMAGE_TAG=<previous-tag> docker compose pull
  VOLTLINK_IMAGE_TAG=<previous-tag> docker compose up -d --wait
  ```

  Roll forward-only schema migrations may reject older images — check
  `CHANGELOG.md` for migration notes before downgrading.

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
  ```

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
