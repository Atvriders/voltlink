#!/bin/bash
# start-stack.sh — boots web + worker + scheduler from the local build against
# a Postgres + Redis provided by the caller. Used by the e2e-fullstack job
# (guide 08 §14). Not a substitute for the image smoke test.
#
# R2-24 safety rules (shared machine):
#   - never pkill -f anything: this script stops only the PIDs it started,
#     recorded in RUN_DIR/*.pid
#   - never sources apps/api/.env: every variable comes from the environment
#   - bootstrap goes through the HTTP API (setup token register -> login ->
#     step-up -> open registration), never raw SQL
#   - no `|| true`: every step fails hard (stop uses a scoped `set +e` guard)
#   - everything runs in production mode
#
# Usage:
#   bash scripts/e2e/start-stack.sh          # start
#   bash scripts/e2e/start-stack.sh stop     # stop only this stack's processes
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# R2-24: the run directory (cookie jar, logs, setup token) must live OUTSIDE
# the repo so evidence like the setup token can never be committed. Default to
# a machine-local temp dir; CI and developers set RUN_DIR explicitly when they
# want a stable location.
RUN_DIR="${RUN_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/voltlink-stack.XXXXXX")}"
PID_FILE="$RUN_DIR/pids"
LOG_DIR="$RUN_DIR/logs"
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"

stop_stack() {
  if [ -f "$PID_FILE" ]; then
    set +e
    while read -r name pid; do
      if kill -0 "$pid" 2>/dev/null; then
        kill "$pid" 2>/dev/null
        for _ in $(seq 1 20); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
        if kill -0 "$pid" 2>/dev/null; then
          kill -9 "$pid" 2>/dev/null
        fi
      fi
    done < "$PID_FILE"
    set -e
    rm -f "$PID_FILE"
  fi
}

if [ "${1:-}" = "stop" ]; then
  stop_stack
  # Remove the run directory (cookie jar + logs hold the setup token).
  rm -rf "$RUN_DIR"
  exit 0
fi

# ---- visual mode (guide 08 §11.2) -------------------------------------------
# `start-stack.sh visual` boots the scripted frozen demo stack for the visual
# baselines: a FRESH voltlink_visual database every time, NODE_ENV=test,
# VL_TEST_FROZEN_NOW fixed, provider poller off. No hand-set environment is
# ever needed; TESTING.md documents this mode.
VISUAL_MODE=0
if [ "${1:-}" = "visual" ]; then
  VISUAL_MODE=1
fi

mkdir -p "$RUN_DIR" "$LOG_DIR"
[ -f "$PID_FILE" ] && stop_stack
: > "$PID_FILE"

record_pid() {
  echo "$1 $2" >> "$PID_FILE"
}

: "${DATABASE_URL:?DATABASE_URL is required (start-stack.sh no longer reads .env)}"
: "${REDIS_URL:?REDIS_URL is required}"
: "${JWT_SECRET:?JWT_SECRET is required}"
: "${VL_MASTER_KEY:?VL_MASTER_KEY is required}"
: "${PUBLIC_URL:?PUBLIC_URL is required (e.g. http://127.0.0.1:3110)}"
if [ "$VISUAL_MODE" = "1" ]; then
  # Guide 08 §11.2: rewrite the database to voltlink_visual (unless the caller
  # pins VL_VISUAL_KEEP_DB) and reset it so every visual run starts from the
  # same fresh demo world.
  if [ "${VL_VISUAL_KEEP_DB:-}" != "1" ]; then
    DATABASE_URL="$(node -e "const u=new URL(process.argv[1]);u.pathname='/voltlink_visual';process.stdout.write(u.toString())" "$DATABASE_URL")"
    ADMIN_DB_URL="$(node -e "const u=new URL(process.argv[1]);u.pathname='/postgres';process.stdout.write(u.toString())" "$DATABASE_URL")"
    node "$SCRIPT_DIR/reset-visual-db.mjs" "$ADMIN_DB_URL" || {
      echo 'visual db reset failed' >&2
      exit 1
    }
  fi
  export NODE_ENV="test"
  export VL_TEST_FROZEN_NOW="2026-06-15T15:30:00Z"
  export VL_POLLER_ENABLED="false"
  echo 'visual mode: fresh voltlink_visual database, NODE_ENV=test, VL_TEST_FROZEN_NOW=2026-06-15T15:30:00Z, VL_POLLER_ENABLED=false'
else
  export NODE_ENV="${NODE_ENV:-production}"
fi
# R2-24: the shared machine — bind loopback unless the caller explicitly opts out.
export HOST="${HOST:-127.0.0.1}"
export PORT="${PORT:-3111}"
export SMTP_PORT="${SMTP_PORT:-1025}"
export VL_SMTP_HTTP_PORT="${VL_SMTP_HTTP_PORT:-1026}"
export SMTP_URL="${SMTP_URL:-smtp://127.0.0.1:$SMTP_PORT}"
export MAIL_TO_CONSOLE="${MAIL_TO_CONSOLE:-false}"
# A local default keeps `bash scripts/e2e/start-stack.sh` working from a fresh
# shell; CI and the image pass their own. The single-hyphen default keeps an
# EXPLICITLY EMPTY value empty (R2-01/R2-24): the fresh-install path must be
# able to exercise the unset-token boot.
export VL_SETUP_TOKEN="${VL_SETUP_TOKEN-e2e-local-setup-token-0123456789abcdef}"
# Local stacks listen on plain HTTP; CI keeps this flag as-is.
export VL_ALLOW_INSECURE_HTTP="${VL_ALLOW_INSECURE_HTTP:-true}"
export VL_E2E_SMTP_HTTP="${VL_E2E_SMTP_HTTP:-http://127.0.0.1:$VL_SMTP_HTTP_PORT}"
# R2-24: cap the Prisma pool for the shared server (100 connections total).
case "$DATABASE_URL" in
  *connection_limit=*) ;;
  *\?*) export DATABASE_URL="$DATABASE_URL&connection_limit=5" ;;
  *) export DATABASE_URL="$DATABASE_URL?connection_limit=5" ;;
esac

cd "$REPO_ROOT/apps/api"

node "$SCRIPT_DIR/fake-smtp.mjs" >"$LOG_DIR/smtp.log" 2>&1 &
SMTP_PID=$!
record_pid smtp $SMTP_PID
smtp_ready=0
for _ in $(seq 1 20); do
  if kill -0 "$SMTP_PID" 2>/dev/null && curl -sf "$VL_E2E_SMTP_HTTP/health" >/dev/null 2>&1; then smtp_ready=1; break; fi
  kill -0 "$SMTP_PID" 2>/dev/null || break  # our sink died; never accept a foreign one
  sleep 0.2
done
[ "$smtp_ready" = "1" ] || { echo "fake smtp did not come up" >&2; tail -20 "$LOG_DIR/smtp.log"; exit 1; }

node dist/cli/migrate.cjs >"$LOG_DIR/migrate.log" 2>&1 || { tail -40 "$LOG_DIR/migrate.log"; exit 1; }

if [ "$VISUAL_MODE" = "1" ]; then
  # Guide 08 §11.2: seed the global status content once at boot so the status
  # pages (public page, status admin) render the same seeded world regardless
  # of which tests have enabled a demo fleet so far. Deterministic order-free
  # uptime figures and response-time chart.
  node dist/cli/seed-status.cjs >"$LOG_DIR/seed-status.log" 2>&1 || {
    tail -40 "$LOG_DIR/seed-status.log"
    exit 1
  }
fi

node dist/index.cjs >"$LOG_DIR/api.log" 2>&1 &
API_PID=$!
record_pid api $API_PID
node dist/worker.cjs >"$LOG_DIR/worker.log" 2>&1 &
record_pid worker $!
node dist/scheduler.cjs >"$LOG_DIR/scheduler.log" 2>&1 &
record_pid scheduler $!

ready=0
for i in $(seq 1 60); do
  if kill -0 "$API_PID" 2>/dev/null && curl -sf "http://127.0.0.1:$PORT/healthz" >/dev/null; then
    ready=1
    break
  fi
  kill -0 "$API_PID" 2>/dev/null || break  # our web died; never log into a foreign stack on this port
  sleep 1
done
if [ "$ready" != "1" ]; then
  echo 'web API did not become healthy within 60s; last 60 lines of the API log:'
  tail -60 "$LOG_DIR/api.log"
  exit 1
fi

# ---- bootstrap, entirely over HTTP (R2-24) ----
BASE="http://127.0.0.1:$PORT"
JAR="$RUN_DIR/admin.jar"
ADMIN_EMAIL='admin@voltlink-e2e.test'
ADMIN_PASSWORD='e2e-admin-password-123'

# VL_FRESH_SETUP=1: leave the instance in setup mode for the fresh-install
# browser test (R3). The token comes from VL_SETUP_TOKEN or, when unset, from
# the one generated and logged by the web role at boot — exactly what the
# install docs describe.
if [ "${VL_FRESH_SETUP:-}" = "1" ]; then
  if [ -n "${VL_SETUP_TOKEN:-}" ]; then
    FRESH_TOKEN="$VL_SETUP_TOKEN"
  else
    grep -o 'first-run setup token [A-Za-z0-9_-]*' "$LOG_DIR/api.log" | head -1 | awk '{print $NF}' > "$RUN_DIR/fresh-token"
    FRESH_TOKEN="$(cat "$RUN_DIR/fresh-token")"
    [ -n "$FRESH_TOKEN" ] || { echo "no first-run token in api.log" >&2; exit 1; }
  fi
  echo "FRESH_SETUP_TOKEN=$FRESH_TOKEN" > "$RUN_DIR/fresh-setup.env"
  echo "stack up (fresh setup): web on :$PORT; setup token written to $RUN_DIR/fresh-setup.env"
  exit 0
fi

curl -sf -c "$JAR" "$BASE/api/v1/auth/setup-status" > "$RUN_DIR/setup-status.json"
NEEDS_SETUP=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$RUN_DIR/setup-status.json','utf8')).data.needsSetup)")

csrf_token() {
  curl -sf -b "$JAR" -c "$JAR" "$BASE/api/v1/auth/csrf" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(JSON.parse(d).data.token))"
}

if [ "$NEEDS_SETUP" = "true" ]; then
  # First run: create the instance admin with the setup token (201).
  CSRF=$(csrf_token)
  curl -sf -b "$JAR" -c "$JAR" -X POST "$BASE/api/v1/auth/register" \
    -H 'Content-Type: application/json' \
    -H "x-vl-csrf: $CSRF" \
    -d "{\"name\":\"E2E Instance Admin\",\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\",\"setupToken\":\"${VL_SETUP_TOKEN}\"}" \
    -o "$RUN_DIR/register.json" -w '%{http_code}' > "$RUN_DIR/register.status"
  [ "$(cat "$RUN_DIR/register.status")" = "201" ] || { echo "setup register failed: $(cat "$RUN_DIR/register.json")" >&2; exit 1; }
else
  # Reused database: sign in as the existing admin.
  CSRF=$(csrf_token)
  curl -sf -b "$JAR" -c "$JAR" -X POST "$BASE/api/v1/auth/login" \
    -H 'Content-Type: application/json' -H "x-vl-csrf: $CSRF" \
    -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" \
    -o "$RUN_DIR/login.json" -w '%{http_code}' > "$RUN_DIR/login.status"
  [ "$(cat "$RUN_DIR/login.status")" = "200" ] || { echo "admin login failed: $(cat "$RUN_DIR/login.json")" >&2; exit 1; }
fi

# Step up with the password (a fresh session has no recent step-up).
CSRF3=$(csrf_token)
curl -sf -b "$JAR" -c "$JAR" -X POST "$BASE/api/v1/auth/step-up" \
  -H 'Content-Type: application/json' -H "x-vl-csrf: $CSRF3" \
  -d '{"method":"password","password":"'"$ADMIN_PASSWORD"'"}' \
  -o "$RUN_DIR/stepup.json" -w '%{http_code}' > "$RUN_DIR/stepup.status"
[ "$(cat "$RUN_DIR/stepup.status")" = "200" ] || { echo "step-up failed: $(cat "$RUN_DIR/stepup.json")" >&2; exit 1; }

# Open registration (e2e specs register fresh users; open mode needs SMTP,
# which the fake sink provides). Idempotent on reused databases.
CSRF4=$(csrf_token)
curl -sf -b "$JAR" -c "$JAR" -X PATCH "$BASE/api/v1/admin/settings" \
  -H 'Content-Type: application/json' -H "x-vl-csrf: $CSRF4" \
  -d '{"registrationMode":"open"}' \
  -o "$RUN_DIR/open.json" -w '%{http_code}' > "$RUN_DIR/open.status"
[ "$(cat "$RUN_DIR/open.status")" = "200" ] || { echo "open-registration PATCH failed: $(cat "$RUN_DIR/open.json")" >&2; exit 1; }

echo "stack up: web on :$PORT, worker + scheduler running, registration open (admin bootstrapped via API)"
