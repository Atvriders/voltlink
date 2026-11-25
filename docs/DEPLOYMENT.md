# Deployment

## Sizing

VoltLink is light. For a personal fleet (1–10 vehicles):

- 1 vCPU / 2 GB RAM runs web + worker + scheduler + PostgreSQL + Redis
  comfortably.
- Disk: telemetry ≈ a few MB/vehicle/month at default retention; keep
  20+ GB headroom for PostgreSQL and backups.

For a large fleet, scale `web` and `worker` horizontally (see Docker Compose)
and move PostgreSQL to managed hosting.

## HTTPS

1. Point a DNS record at the server.
2. Terminate TLS at a reverse proxy (Caddy, nginx, Traefik) in front of the
   web container; set `TRUST_PROXY=1` for exactly one trusted proxy (or a
   comma list of proxy addresses/CIDRs). `TRUST_PROXY=true` makes the web
   role refuse to start.
3. Set `PUBLIC_URL=https://<host>`.

Example Caddyfile:

```
voltlink.example.com {
  reverse_proxy 127.0.0.1:3110
}
```

Example nginx server block — see [Installation](INSTALLATION.md).

## Security before going live

- Strong `JWT_SECRET`, `VL_MASTER_KEY`, `POSTGRES_PASSWORD`
- `PUBLIC_URL` on HTTPS, `TRUST_PROXY=1` behind the trusted proxy (never `true`;
  the web role refuses to start on it)
- TOTP on the owner account
- Firewall: expose only 80/443; keep PostgreSQL/Redis internal to the compose
  network

## Monitoring

- `/healthz` and `/readyz` (web), `/metrics` (Prometheus-style process metrics)
- Container healthchecks + `docker compose ps`
- Public status page for humans; RSS/SVG badge for dashboards

## Backup

Schedule daily `pg_dump` plus a secure copy of `VL_MASTER_KEY` — see
[Backup & restore](BACKUP_RESTORE.md).

## Update cadence

Subscribe to releases; production compose uses `pull_policy: always` with
pinned tags per environment.
