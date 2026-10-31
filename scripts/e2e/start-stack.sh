#!/bin/bash
# start-stack.sh — boots web + worker + scheduler from the local build against
# a Postgres + Redis (provided by CI services or compose). Used by the
# e2e-fullstack job (guide 08 §14). Not a substitute for the image smoke test.
set -euo pipefail
cd "$(dirname "$0")/../.."
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"

# A previous stack on port 3111 would win the health check; kill it first.
pkill -f 'dist/index.cjs' || true
pkill -f 'dist/worker.cjs' || true
pkill -f 'dist/scheduler.cjs' || true
pkill -f 'fake-smtp.mjs' || true
sleep 1

cd apps/api
node dist/cli/migrate.cjs >/tmp/voltlink-migrate.log 2>&1 || { tail -40 /tmp/voltlink-migrate.log; exit 1; }
node "$(dirname "$0")/fake-smtp.mjs" >/tmp/voltlink-smtp.log 2>&1 &
echo $! >/tmp/voltlink-smtp.pid
VL_DEV_ECHO_TOKENS=true NODE_ENV=development PORT=3111 node dist/index.cjs >/tmp/voltlink-api.log 2>&1 &
echo $! >/tmp/voltlink-api.pid
NODE_ENV=development node dist/worker.cjs >/tmp/voltlink-worker.log 2>&1 &
echo $! >/tmp/voltlink-worker.pid
NODE_ENV=development node dist/scheduler.cjs >/tmp/voltlink-scheduler.log 2>&1 &
echo $! >/tmp/voltlink-scheduler.pid
for i in $(seq 1 60); do curl -sf http://127.0.0.1:3111/healthz >/dev/null && break; sleep 1; done
# First-run setup: a fresh database requires the setup token on the first
# registration. Bootstrap an instance admin so the e2e specs can register users.
if [ -n "${VL_SETUP_TOKEN:-}" ]; then
  JAR=$(mktemp)
  curl -sf -c "$JAR" http://127.0.0.1:3111/api/v1/auth/csrf > "$JAR.json" || true
  CSRF=$(python3 -c "import json;print(json.load(open('$JAR.json'))['data']['token'])" 2>/dev/null || true)
  if [ -n "$CSRF" ]; then
    curl -sf -b "$JAR" -X POST http://127.0.0.1:3111/api/v1/auth/register \
      -H 'Content-Type: application/json' \
      -H "x-vl-csrf: $CSRF" \
      -d "{\"name\":\"E2E Instance Admin\",\"email\":\"admin@voltlink-e2e.test\",\"password\":\"e2e-admin-password-123\",\"setupToken\":\"${VL_SETUP_TOKEN}\"}" >/dev/null || true
  fi
  rm -f "$JAR" "$JAR.json"
  # E2E specs register fresh users directly, so the instance must be open.
  node -e '
    const { Client } = require("pg");
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    c.connect()
      .then(() => c.query("INSERT INTO \"AppSetting\" (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", ["instance.registrationMode", "open"]))
      .catch(() => {})
      .finally(() => c.end());
  ' || true
fi
exit 0
tail -40 /tmp/voltlink-api.log
exit 1
