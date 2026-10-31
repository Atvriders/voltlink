#!/bin/sh
# voltlink-entrypoint — role = first argument, else $VL_ROLE, else web.
set -eu
role="${1:-${VL_ROLE:-web}}"
export VL_ROLE="$role"
# The healthcheck runs as a separate process: leave the resolved role where it
# can read it (tmpfs /tmp).
mkdir -p /tmp/voltlink 2>/dev/null && printf '%s' "$role" > /tmp/voltlink/role 2>/dev/null || true
cd /app/apps/api
case "$role" in
  web) exec node dist/index.cjs ;;
  worker) exec node dist/worker.cjs ;;
  scheduler) exec node dist/scheduler.cjs ;;
  status) exec node dist/statusServer.cjs ;;
  migrate) exec node dist/cli/migrate.cjs ;;
  selftest) exec node dist/cli/selftest.cjs ;;
  *) echo "[voltlink] unknown role '$role' (web|worker|scheduler|status|migrate|selftest)" >&2; exit 64 ;;
esac
