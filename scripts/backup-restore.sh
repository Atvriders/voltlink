#!/bin/bash
# backup-restore.sh — the reference backup/restore for VoltLink (R2-52).
# Runs where the PostgreSQL client tools exist (host, or inside the compose
# postgres container). Use the documented docker compose commands for the
# compose stack; this script is the same flow for hosts/bare metal.
#
#   backup:  scripts/backup-restore.sh backup  backup.dump
#            (pg_dump -Fc of $DATABASE_URL)
#   restore: scripts/backup-restore.sh restore backup.dump voltlink_restore
#            (creates a FRESH database, restores into it, tolerating only the
#             four benign partition errors PostgreSQL reports for VoltLink's
#             partitioned telemetry tables)
#
# Env: DATABASE_URL (the app database), VOLTLINK_DATABASE_ADMIN_URL (a URL to
# the server's maintenance database for CREATE DATABASE; defaults to
# DATABASE_URL with the database swapped for `postgres`).
set -euo pipefail

action=${1:-}
case "$action" in
  backup)
    out=${2:?usage: backup-restore.sh backup <file>}
    : "${DATABASE_URL:?set DATABASE_URL}"
    pg_dump "$DATABASE_URL" -Fc -f "$out"
    ls -la "$out"
    ;;
  restore)
    file=${2:?usage: backup-restore.sh restore <file> <fresh-db-name>}
    db=${3:?usage: backup-restore.sh restore <file> <fresh-db-name>}
    : "${DATABASE_URL:?set DATABASE_URL}"
    if [ -n "${VOLTLINK_DATABASE_ADMIN_URL:-}" ]; then
      admin=$VOLTLINK_DATABASE_ADMIN_URL
    else
      admin=$(node -e 'const u=new URL(process.argv[1]);u.pathname="/postgres";process.stdout.write(u.toString())' "$DATABASE_URL")
    fi
    psql "$admin" -c "DROP DATABASE IF EXISTS \"$db\" WITH (FORCE)" >/dev/null
    psql "$admin" -c "CREATE DATABASE \"$db\"" >/dev/null
    # Restore into the fresh database; tolerate ONLY the four benign
    # partition-error lines PostgreSQL emits for VoltLink's partitioned tables.
    log=$(mktemp)
    set +e
    restore_url=$(node -e 'const u=new URL(process.argv[1]);u.pathname="/"+process.argv[2];process.stdout.write(u.toString())' "$DATABASE_URL" "$db")
    pg_restore -d "$restore_url" "$file" >"$log" 2>&1
    rc=$?
    set -e
    # The four benign partition errors look like:
    #   pg_restore: error: could not execute query: ERROR:  cannot drop table
    #   telemetry... because other objects depend on it ... (4 occurrences)
    other=$(grep -E 'pg_restore: (error|warning)' "$log" \
      | grep -vE 'cannot drop table|other objects depend on it|is a partitioned table|does not exist' || true)
    if [ -n "$other" ] || { [ "$rc" -ne 0 ] && ! grep -q 'cannot drop table' "$log"; }; then
      echo "restore failed (rc=$rc):" >&2
      cat "$log" >&2
      rm -f "$log"
      exit 1
    fi
    rm -f "$log"
    echo "restored into fresh database '$db' (the four benign partition errors were tolerated)"
    echo "next: run the migrate role against the restored database, then boot the stack"
    ;;
  *)
    echo "usage: backup-restore.sh <backup <file> | restore <file> <fresh-db-name>>" >&2
    exit 64
    ;;
esac
