# Installation

VoltLink runs as three long-lived processes (web, worker, scheduler) plus an
optional standalone status site, all built from one Docker image.

## Supported paths

1. **Docker Compose (recommended)** — the single install guide is
   [DOCKER_COMPOSE.md](DOCKER_COMPOSE.md): download `docker-compose.yml` and
   `compose.production.yml` for the release, then `docker compose up -d
--wait`. No `.env` file — every required value has a default inside the
   compose file. The stack pulls the image the CI pipeline built and published
   (`ghcr.io/atvriders/voltlink`) and never builds.
2. **From source** — for development or bare-metal servers with existing
   PostgreSQL/Redis. See below and [Development](DEVELOPMENT.md).

## Bare metal (no Docker)

With an existing PostgreSQL (role with CREATEDB) and Redis:

```bash
npm ci
npm run build                                    # prisma generate + bundles + SPA staging

# Write the secrets ONCE and reuse the same file for every role and every
# restart. Regenerating JWT_SECRET or VL_MASTER_KEY on each start invalidates
# sessions and sealed secrets, so keep them stable.
# The UNQUOTED heredoc runs the openssl commands ONCE while writing the file,
# so .env-style files never contain $(...) literals.
cat > /etc/voltlink.env <<ENV
NODE_ENV=production
DATABASE_URL=postgresql://user:pass@host:5432/voltlink
REDIS_URL=redis://host:6379
PUBLIC_URL=https://voltlink.example.com
JWT_SECRET=$(openssl rand -hex 32)
VL_MASTER_KEY=$(openssl rand -base64 32)
# First boot only: create the instance administrator, then remove this line.
VL_SETUP_TOKEN=$(openssl rand -hex 16)
ENV
chmod 600 /etc/voltlink.env

set -a; . /etc/voltlink.env; set +a
node apps/api/dist/cli/migrate.cjs              # migrate role: apply migrations once
node apps/api/dist/index.cjs                    # web role (API + SPA + SSE)
```

Start the other roles the same way, from any working directory:
`node apps/api/dist/worker.cjs`, `node apps/api/dist/scheduler.cjs` and
`node apps/api/dist/statusServer.cjs` (port `STATUS_PORT`, default 3001).
Every role waits for the migrations to be current and never applies them
itself. The `migrate` role is the only one that deploys migrations, under a
Postgres advisory lock.

The instance administrator is created from the web UI at `/setup`: it asks
for the `VL_SETUP_TOKEN` value. A fresh install with `VL_SETUP_TOKEN` unset
generates a token at boot and logs it on EVERY boot until setup completes
(`[voltlink] first-run setup token ...` — the token is the last field of the
line). A configured `VL_SETUP_TOKEN` is never logged. The token is consumed
on registration and never accepted again.

## Docker Compose

The single Docker Compose guide is [DOCKER_COMPOSE.md](DOCKER_COMPOSE.md):
download `docker-compose.yml` and `compose.production.yml` from the release
tag's URL, then the bare `docker compose up -d --wait` works — no `.env` file
and no `COMPOSE_FILE`, because every required value has a default inside the
compose file (`docker-compose.yml` includes the production file and sets the
project name). Everything pulls `ghcr.io/atvriders/voltlink` — the image the
GitHub Actions CI pipeline builds, verifies and publishes — nothing builds.

The stack:

| Service     | Purpose                                          | Port                            |
| ----------- | ------------------------------------------------ | ------------------------------- |
| `postgres`  | PostgreSQL 17 with the VoltLink database         | internal                        |
| `redis`     | Job queue (telemetry polling, command lifecycle) | internal                        |
| `web`       | API + SPA + SSE realtime                         | 3000 → host `${WEB_PORT:-3110}` |
| `worker`    | Telemetry poll jobs + command dispatch/confirm   | internal                        |
| `scheduler` | Retention jobs, scheduled reports, status checks | internal                        |

The `migrate` role is the only one that applies migrations (under a
PostgreSQL advisory lock); every other role waits for the migrations to be
current and never applies them itself.

## First boot checklist

1. Complete first-run setup from the web UI at `/setup` with `VL_SETUP_TOKEN`,
   or read the generated token from the web role's log (logged on every boot
   until setup completes).
2. Set `PUBLIC_URL` to your real HTTPS origin (required in production).
3. Optional: SMTP, VAPID keys for push, Tesla/Tessie credentials.
4. Behind a reverse proxy set `TRUST_PROXY` to a hop count or address list,
   never `true` (a bare `true` trusts a client-spoofable `X-Forwarded-For`;
   the app refuses to boot with it).

## Reverse proxy

Any proxy that forwards `X-Forwarded-*` works; enable `TRUST_PROXY=1`
(one proxy hop) or `TRUST_PROXY=127.0.0.1,::1` (trust only the local proxy).
VoltLink uses SSE on `/api/v1/realtime` — configure buffering off:

```nginx
location / {
  proxy_pass http://127.0.0.1:3110;
  proxy_http_version 1.1;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  proxy_set_header X-Forwarded-Proto https;
}
location /api/v1/realtime {
  proxy_pass http://127.0.0.1:3110;
  proxy_http_version 1.1;
  proxy_buffering off;
  proxy_cache off;
}
```
