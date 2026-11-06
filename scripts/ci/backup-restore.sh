#!/usr/bin/env bash
# VoltLink database backup and restore (docs/BACKUP_RESTORE.md).
#
#   backup:  scripts/ci/backup-restore.sh backup  [outfile]
#   restore: scripts/ci/backup-restore.sh restore <dumpfile>
#
# Connection settings come from DATABASE_URL when set (postgresql://user:pass@
# host:port/db), otherwise from PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE.
# Explicit PG* variables always win over DATABASE_URL.

set -euo pipefail

PG_BIN="$(command -v pg_dump || true)"
if [ -z "$PG_BIN" ]; then
  echo "error: pg_dump/pg_restore not found on PATH" >&2
  exit 1
fi

# ---- connection handling ----------------------------------------------------
if [ -z "${PGHOST:-}${PGDATABASE:-}${PGUSER:-}" ] && [ -n "${DATABASE_URL:-}" ]; then
  # postgresql://user:password@host:port/db
  REST="${DATABASE_URL#postgresql://}"
  CREDS="${REST%%@*}"; HOSTPORTDB="${REST#*@}"
  DB_USER="${CREDS%%:*}"
  DB_PASS="${CREDS#*:}"; [ "$DB_PASS" = "$CREDS" ] && DB_PASS=''
  DB_HOST="${HOSTPORTDB%%:*}"
  PORTDB="${HOSTPORTDB#*:}"
  DB_PORT="${PORTDB%%/*}"
  DB_NAME="${PORTDB#*/}"
fi
DB_HOST="${PGHOST:-${DB_HOST:-127.0.0.1}}"
DB_PORT="${PGPORT:-${DB_PORT:-5432}}"
DB_USER="${PGUSER:-${DB_USER:-voltlink}}"
DB_NAME="${PGDATABASE:-${DB_NAME:-voltlink}}"
export PGPASSWORD="${PGPASSWORD:-${DB_PASS:-}}"

CMD=("${PG_BIN%/*}"/pg_dump "${PG_BIN%/*}"/pg_restore)
DUMP() { "${PG_BIN%/*}"/pg_dump -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" "$@"; }
RESTORE() { "${PG_BIN%/*}"/pg_restore -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" "$@"; }
PSQL() { "${PG_BIN%/*}"/psql -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" "$@"; }

case "${1:-}" in
  backup)
    OUT="${2:-backup_$(date +%F_%H%M%S).dump}"
    echo "backing up $DB_NAME@$DB_HOST:$DB_PORT -> $OUT"
    DUMP --format=custom --compress=9 --no-owner --file="$OUT"
    echo "backup ok: $OUT ($(du -h "$OUT" | cut -f1))"
    ;;

  restore)
    FILE="${2:-}"
    [ -n "$FILE" ] || { echo "usage: $0 restore <dumpfile>" >&2; exit 2; }
    [ -f "$FILE" ] || { echo "error: dumpfile not found: $FILE" >&2; exit 2; }
    echo "restoring $DB_NAME@$DB_HOST:$DB_PORT <- $FILE"
    LOG="$(mktemp)"
    if ! RESTORE --clean --if-exists --no-owner --verbose "$FILE" >"$LOG" 2>&1; then
      echo "pg_restore failed:" >&2
      tail -30 "$LOG" >&2
      rm -f "$LOG"
      exit 1
    fi
    rm -f "$LOG"
    echo "restore ok; verifying"
    for table in "User" "Organization" "Vehicle" "VehicleCommand" "Drive" "AppSetting"; do
      COUNT="$(PSQL -tA -c "SELECT count(*) FROM \"$table\"" | tr -d '[:space:]')"
      echo "  $table: $COUNT rows"
    done
    echo "restore verified"
    ;;

  *)
    echo "usage: $0 backup [outfile] | $0 restore <dumpfile>" >&2
    exit 2
    ;;
esac
