# Installation

VoltLink runs as three long-lived processes (web, worker, scheduler) plus an
optional standalone status site, all built from one Docker image.

## Supported paths

1. **Docker Compose (recommended)** — `docker-compose.yml` for previews,
   `compose.production.yml` for production with the published GHCR image.
2. **From source** — for development or bare-metal servers with existing
   PostgreSQL/Redis. See [Development](DEVELOPMENT.md).

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

Install Node 24 and PostgreSQL 16+, create a database, then:

```bash
npm ci
npm run build
npx prisma generate --schema apps/api/prisma/schema.prisma
npx prisma migrate deploy --schema apps/api/prisma/schema.prisma

# web
NODE_ENV=production PORT=3000 node apps/api/dist/index.cjs
# worker
NODE_ENV=production node apps/api/dist/worker.cjs
# scheduler
NODE_ENV=production node apps/api/dist/scheduler.cjs
```

## First boot checklist

1. Register the owner account.
2. Set `PUBLIC_URL` to your real HTTPS origin (required in production).
3. Optional: SMTP, VAPID keys for push, Tesla/Tessie credentials.
4. Optional: `TRUST_PROXY=true` when behind nginx/Caddy/Traefik.

## Reverse proxy

Any proxy that forwards `X-Forwarded-*` works; enable `TRUST_PROXY=true`.
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
