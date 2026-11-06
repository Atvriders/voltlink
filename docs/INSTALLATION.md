# Installation

VoltLink runs as three long-lived processes (web, worker, scheduler) plus an
optional standalone status site, all built from one Docker image.

## Supported paths

1. **Docker Compose (recommended)** — `docker-compose.yml` for previews,
   `compose.production.yml` for production with the published GHCR image.
2. **From source** — for development or bare-metal servers with existing
   PostgreSQL/Redis. See [Development](DEVELOPMENT.md).

## Bare metal (no Docker)

With an existing PostgreSQL (role with CREATEDB) and Redis:

```bash
npm ci
npm run build                                    # prisma generate + bundles + SPA staging

# Write the secrets ONCE and reuse the same file for every role and every
# restart. Regenerating JWT_SECRET or VL_MASTER_KEY on each start invalidates
# sessions and sealed secrets, so keep them stable.
cat > /etc/voltlink.env <<'ENV'
NODE_ENV=production
DATABASE_URL=postgresql://user:pass@host:5432/voltlink
REDIS_URL=redis://host:6379
PUBLIC_URL=https://voltlink.example.com
JWT_SECRET=$(openssl rand -hex 32)
VL_MASTER_KEY=$(openssl rand -base64 32)
# First boot only: create the owner account, then remove this line.
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

The first-run owner account is created from the web UI at `/setup`: it asks
for the `VL_SETUP_TOKEN` value. A fresh install with `VL_SETUP_TOKEN` unset
generates a one-time token at boot and prints it once to the web role's log
(`[voltlink] first-run setup token ...`). Either way the token is consumed on
registration and never accepted again.

## Docker Compose

```bash
cp .env.example .env
# edit .env (secrets + PUBLIC_URL)
docker compose up -d
```

The stack:

| Service     | Purpose                                          | Port                            |
| ----------- | ------------------------------------------------ | ------------------------------- |
| `postgres`  | PostgreSQL 17 with the VoltLink database         | internal                        |
| `redis`     | Job queue (telemetry polling, command lifecycle) | internal                        |
| `web`       | API + SPA + SSE realtime                         | 3000 → host `${WEB_PORT:-3110}` |
| `worker`    | Telemetry poll jobs + command dispatch/confirm   | internal                        |
| `scheduler` | Retention jobs, scheduled reports, status checks | internal                        |

Each role runs `migrateLeader` at boot: exactly one instance at a time applies
migrations under a PostgreSQL advisory lock.

## Bare metal / systemd

Install Node 24 and PostgreSQL 16+, create a database, then (the app does
not load dotenv files — set the environment explicitly):

```bash
npm ci
npm run build
npx prisma generate --schema apps/api/prisma/schema.prisma
npx prisma migrate deploy --schema apps/api/prisma/schema.prisma

# Persist secrets once (see the bare-metal block above for the full file).
set -a; . /etc/voltlink.env; set +a

# web
NODE_ENV=production PORT=3000 node apps/api/dist/index.cjs
# worker
NODE_ENV=production node apps/api/dist/worker.cjs
# scheduler
NODE_ENV=production node apps/api/dist/scheduler.cjs
```

## First boot checklist

1. Set `VL_SETUP_TOKEN` (or read the generated token from the web role's log)
   and register the owner account from the web UI at `/setup`.
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
