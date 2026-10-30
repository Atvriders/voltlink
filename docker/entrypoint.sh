#!/bin/sh
# VoltLink container entrypoint: start the selected role.
# Migrations run inside every role via the advisory-lock migration leader, so
# no ordering between replicas is required.
set -eu

role="${VL_ROLE:-web}"

echo "[voltlink] starting role: ${role} (node $(node --version))"

case "$role" in
  web)
    exec node dist/index.cjs
    ;;
  worker)
    exec node dist/worker.cjs
    ;;
  scheduler)
    exec node dist/scheduler.cjs
    ;;
  status)
    exec node dist/statusServer.cjs
    ;;
  migrate)
    exec node dist/cli/migrateLeader.cjs
    ;;
  *)
    echo "[voltlink] unknown VL_ROLE: ${role} (expected web|worker|scheduler|status|migrate)" >&2
    exit 1
    ;;
esac
