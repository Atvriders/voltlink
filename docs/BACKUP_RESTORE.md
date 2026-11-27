# Backup & restore

Two things must be backed up together:

1. **PostgreSQL data** — everything except provider credentials' _plaintext_.
2. **`VL_MASTER_KEY`** — decrypts provider credentials and other sealed
   envelopes. Without it a restored database still works, but providers must
   be reconnected.

## Backup (Docker Compose)

<!-- run: backup -->

```bash
docker compose exec -T postgres pg_dump -U voltlink -d voltlink -Fc \
  > backup.dump
```

`pg_dump -Fc` is safe while VoltLink runs. Name the file with the date on a
real host (`backup_$(date +%F).dump`); automate with cron and keep the last N
dumps off-host.

Also export the secrets and store them in a password manager. Run this on the
host — it is not part of the runnable block above, so CI never prints them:

```bash
grep -E '^(VL_MASTER_KEY|JWT_SECRET|POSTGRES_PASSWORD)=' .env
```

The repository ships `scripts/backup-restore.sh` for the same flow
(`backup <file>` / `restore <file> <fresh-database-name>`); it is the
reference implementation and tolerates the four benign partition-error lines
PostgreSQL reports when restoring VoltLink's partitioned tables.

## Restore

Restore into a FRESH database, then run the migrate role and boot the stack.
Restoring over the live database is not recommended:

<!-- run: restore-create-db -->

```bash
# 1. create a fresh database inside the compose postgres
docker compose exec -T postgres psql -U voltlink -d postgres \
  -c 'CREATE DATABASE voltlink_restore'
```

<!-- run: restore-load -->

```bash
# 2. restore the dump into it. PostgreSQL reports four benign partition
#    errors for the partitioned telemetry tables; anything else fails the
#    restore — the same rule scripts/backup-restore.sh applies.
set +e
docker compose exec -T postgres pg_restore -U voltlink \
  -d voltlink_restore < backup.dump > restore.log 2>&1
rc=$?
set -e
other=$(grep -E 'pg_restore: (error|warning)' restore.log \
  | grep -vE 'cannot drop table|other objects depend on it|is a partitioned table|does not exist' || true)
if [ -n "$other" ] || { [ "$rc" -ne 0 ] && ! grep -q 'cannot drop table' restore.log; }; then
  echo "restore failed (rc=$rc):" >&2
  cat restore.log >&2
  exit 1
fi
echo 'restored into voltlink_restore (only benign partition errors were tolerated)'
```

<!-- run: restore-verify -->

```bash
# 3. the restored database carries the same rows as the source
for table in '"User"' '"Organization"' '"Vehicle"' '"VehicleCommand"'; do
  src=$(docker compose exec -T postgres psql -U voltlink -d voltlink -tAc "SELECT count(*) FROM $table")
  dst=$(docker compose exec -T postgres psql -U voltlink -d voltlink_restore -tAc "SELECT count(*) FROM $table")
  printf '%s source=%s restored=%s\n' "$table" "$src" "$dst"
  [ "$src" = "$dst" ] || { echo "row count mismatch for $table" >&2; exit 1; }
done
```

<!-- run: restore-boot -->

```bash
# 4. point the stack at the restored database and boot — the migrate role
#    applies any newer migrations under the advisory lock
set -a; . ./.env; set +a
printf 'VOLTLINK_DATABASE_URL=postgresql://voltlink:%s@postgres:5432/voltlink_restore\n' \
  "$POSTGRES_PASSWORD" >> .env
docker compose up -d --wait
```

`scripts/backup-restore.sh restore backup.dump voltlink_restore` runs steps 1–2
for hosts without Compose and fails only on non-partition restore errors.

## Consistency notes

- The queue lives in Redis (`REDIS_URL`); in-flight queue items are ephemeral
  by design and recover on retry after a restore.
- Migrations run only in the `migrate` role (the other roles never migrate —
  they wait up to 120 s for the schema to be current); after restoring an
  older dump, booting the stack upgrades the schema to the image's version.
- `docker compose down` keeps the `pgdata` volume; `down -v` deletes it.
