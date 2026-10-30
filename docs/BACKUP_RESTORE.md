# Backup & restore

Two things must be backed up together:

1. **PostgreSQL data** — everything except provider credentials' *plaintext*.
2. **`VL_MASTER_KEY`** — decrypts provider credentials and other sealed
   envelopes. Without it a restored database still works, but providers must
   be reconnected.

## Backup (Docker Compose)

```bash
# Logical dump
docker compose exec -T postgres pg_dump -U voltlink -d voltlink -Fc \
  > backup_$(date +%F).dump

# Secrets (one-time export, store securely, e.g. password manager)
grep -E '^(VL_MASTER_KEY|JWT_SECRET|POSTGRES_PASSWORD)=' .env
```

Automate with cron; keep the last N dumps off-host. `pg_dump -Fc` is safe while
VoltLink runs.

## Restore

```bash
docker compose stop web worker scheduler
docker compose exec -T postgres pg_restore -U voltlink -d voltlink --clean \
  --if-exists < backup_2026-10-27.dump
docker compose start web worker scheduler
```

`pg_restore --clean --if-exists` drops and recreates objects; point it at a
fresh database if you prefer:

```bash
docker compose exec -T postgres createdb -U voltlink voltlink_restore
docker compose exec -T postgres pg_restore -U voltlink -d voltlink_restore \
  < backup_2026-10-27.dump
```

Then update `DATABASE_URL` accordingly.

## Consistency notes

- WAL archiving (e.g. `pgbackrest` or managed PostgreSQL) gives point-in-time
  recovery if you need it; VoltLink's schema is plain PostgreSQL and works
  with standard tooling.
- The queue lives in PostgreSQL when `REDIS_URL` is unset, so a single
  PostgreSQL dump captures queued work too. With Redis, in-flight queue items
  are ephemeral by design and recover on retry.
- Migrations run automatically on boot — after restoring an older dump, the
  web role upgrades the schema to the image's version.
