# Backup & restore

Two things must be backed up together:

1. **PostgreSQL data** — everything except provider credentials' _plaintext_.
2. **`VL_MASTER_KEY`** — decrypts provider credentials and other sealed
   envelopes. Without it a restored database still works, but providers must
   be reconnected.

## Backup (Docker Compose)

```bash
docker compose -f compose.production.yml exec -T postgres pg_dump -U voltlink -d voltlink -Fc \
  > backup_$(date +%F).dump

# Secrets (one-time export, store securely, e.g. password manager)
grep -E '^(VL_MASTER_KEY|JWT_SECRET|POSTGRES_PASSWORD)=' .env
```

`pg_dump -Fc` is safe while VoltLink runs. Automate with cron; keep the last N
dumps off-host.

The repository ships `scripts/backup-restore.sh` for the same flow
(`backup <file>` / `restore <file> <fresh-database-name>`); it is the
reference implementation and tolerates the four benign partition-error lines
PostgreSQL reports when restoring VoltLink's partitioned tables.

## Restore

Restore into a FRESH database, then run the migrate role and boot the stack.
Restoring over the live database is not recommended:

```bash
# 1. create a fresh database inside the compose postgres
docker compose -f compose.production.yml exec -T postgres psql -U voltlink -d postgres \
  -c 'CREATE DATABASE voltlink_restore'

# 2. restore the dump into it (pg_restore reports four benign partition errors)
docker compose -f compose.production.yml exec -T postgres pg_restore -U voltlink \
  -d voltlink_restore < backup_2026-11-24.dump

# 3. point the stack at the restored database and boot — the migrate role
#    applies any newer migrations under the advisory lock
printf 'VOLTLINK_DATABASE_URL=postgresql://voltlink:...@postgres:5432/voltlink_restore\n' >> .env
docker compose -f compose.production.yml up -d --wait
```

`scripts/backup-restore.sh restore backup_2026-11-24.dump voltlink_restore`
runs steps 1–2 and fails only on non-partition restore errors.

## Consistency notes

- The queue lives in Redis (`REDIS_URL`); in-flight queue items are ephemeral
  by design and recover on retry after a restore.
- Migrations run only in the `migrate` role (the other roles never migrate —
  they wait up to 120 s for the schema to be current); after restoring an
  older dump, booting the stack upgrades the schema to the image's version.
- `docker compose down` keeps the `pgdata` volume; `down -v` deletes it.
