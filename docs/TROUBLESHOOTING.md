# Troubleshooting

## Containers won't start / restart loop

```bash
docker compose logs --tail 200 web
```

Common causes:

| Symptom | Cause & fix |
| --- | --- |
| `JWT_SECRET is missing or too short` | Set a real secret, ≥ 32 chars, not a placeholder. |
| `VL_MASTER_KEY is missing…` | Required in production; `openssl rand -base64 32`. |
| `PUBLIC_URL must be an https:// URL` | Set the real HTTPS origin (or use development mode for local http). |
| `Can't reach database` | PostgreSQL healthcheck failed — check `docker compose ps postgres` and the password in `DATABASE_URL`/`POSTGRES_PASSWORD`. |
| `Prisma CLI not found` | Image layout changed — pull the current image, don't hand-build. |
| `migration failed` | Read the migration error in the log; restore a backup if the schema is damaged. |

## Healthcheck failing

- `web`/`status`: `curl http://localhost:3110/healthz` on the host.
- `worker`: with `REDIS_URL` set it pings Redis; without Redis it reports
  liveness only.
- `postgres`: `pg_isready`; `redis`: `redis-cli ping`.

## Web UI loads but stays "loading"

1. Open the browser devtools network tab — is `/api/v1/auth/me` 401? You're
   logged out: log in again (sessions can be revoked server-side).
2. 429 responses: global rate limit — check for runaway polling, raise
   `VL_RATE_LIMIT_PER_MIN` if legitimate.
3. Blank page with console errors: hard-refresh (stale SPA bundle after
   upgrade) and check `docker compose logs web`.

## SSE / realtime not updating

- Proxies must not buffer `/api/v1/realtime` (see Installation).
- The SPA falls back to polling automatically — stale data after 30 s means
  both paths are blocked.

## Commands stuck in `submitted`

The worker confirms commands by observing telemetry. If the vehicle is asleep
or the provider lags, the command eventually lands in `timed_out` (~60 s).
Check the command's audit events and the provider readiness panel.

## Demo data missing

Demo mode is per account. **Providers → Enable demo mode** again, or
`VL_DEMO_DEFAULT_ENABLED=true` for fresh accounts.

## Reset everything

```bash
docker compose down -v   # deletes the database volume
docker compose up -d
```

## Getting help

File an issue at <https://github.com/Atvriders/voltlink/issues> with:
`docker compose ps`, the failing container's logs, and the exact error text.
Redact secrets before pasting logs anywhere.
