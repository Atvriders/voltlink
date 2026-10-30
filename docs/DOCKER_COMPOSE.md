# Docker Compose

Two compose files are shipped:

- `docker-compose.yml` — full stack that **builds the image locally**. Use for
  previews, demos, and development on the machine where the repo is checked out.
- `compose.production.yml` — production stack that **pulls the published image**
  (`ghcr.io/atvriders/voltlink`) and performs no local build.

## Development compose

```bash
docker compose up -d            # builds and starts everything
docker compose up -d --build web # rebuild after code changes
docker compose logs -f web worker
docker compose down -v          # wipe everything including the database
```

## Production compose

```bash
curl -fsSL https://raw.githubusercontent.com/Atvriders/voltlink/main/compose.production.yml -o compose.production.yml
# .env with real secrets
docker compose -f compose.production.yml up -d
docker compose -f compose.production.yml pull  # updates the image
```

Pin the image tag per environment:

```bash
VOLTLINK_IMAGE_TAG=v1.0.0 docker compose -f compose.production.yml up -d
```

Published tags: `latest`, `v1.0.0`, and the full commit SHA for every main push.

## Image roles

One image, four roles, selected with `VL_ROLE`:

| `VL_ROLE` | Process | Healthcheck |
| --- | --- | --- |
| `web` | API + SPA + SSE | HTTP `GET /healthz` |
| `worker` | telemetry poll + command jobs | Redis ping (when `REDIS_URL` set) |
| `scheduler` | retention + scheduled jobs | process liveness |
| `status` | standalone public status site | HTTP `GET /healthz` |
| `migrate` | one-shot: apply migrations | — |

## Scaling

- `web` scales horizontally (stateless; SSE is per-instance but the client
  reconnects transparently). Put replicas behind a load balancer with sticky
  sessions for SSE or accept reconnects.
- `worker` scales horizontally (queue consumers with `FOR UPDATE SKIP LOCKED`).
- `scheduler` is safe to run as a single replica; it uses advisory locks for
  singleton jobs.

```bash
docker compose -f compose.production.yml up -d --scale web=2 --scale worker=2
```

## Volumes & backup

- Named volume `pgdata` holds PostgreSQL. Back it up per
  [Backup & restore](BACKUP_RESTORE.md) — `docker compose down` does **not**
  delete it, `down -v` does.

## Healthchecks

Every role ships a role-aware healthcheck (`docker/healthcheck.sh`). Compose
services `postgres` and `redis` have their own checks, and `web`/`worker`/
`scheduler` wait for both to be healthy before starting.
