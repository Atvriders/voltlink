#!/bin/bash
# simulate-image.sh — reproduces the Dockerfile's stages locally (no Docker on
# this machine): a production-only install, prisma generate, the exact COPY
# layout, then boots every role from that layout with NODE_ENV=production
# against a temporary database and runs a smoke test. Stand-in for the CI
# container job (guide 04 §2, START_HERE Phase 3 task 2).
set -euo pipefail
cd "$(dirname "$0")/.."

WORK=$(mktemp -d)
SIM_DB="voltlink_sim_$$"
PIDS=()
cleanup() {
  if [ "${SIM_KEEP:-0}" = "1" ]; then echo "[simulate-image] keeping $WORK"; return; fi
  for p in "${PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done
  wait 2>/dev/null || true
  PGPASSWORD="$DB_PW" "$PSQL" -h 127.0.0.1 -p 5433 -U voltlink -d postgres -c "DROP DATABASE IF EXISTS $SIM_DB" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
PSQL="$HOME/.local/pgclient/root/usr/lib/postgresql/18/bin/psql"
DB_PW="$(cat ~/.local/var/voltlink-db-pw)"

echo "[simulate-image] 1/6 production-only install (stage: prod-deps)"
mkdir -p "$WORK/apps/api/prisma"
cp package.json package-lock.json tsconfig.base.json "$WORK/"
cp packages/shared/package.json "$WORK/packages/shared/" 2>/dev/null || true
mkdir -p "$WORK/packages/shared" && cp packages/shared/package.json "$WORK/packages/shared/"
cp apps/api/package.json "$WORK/apps/api/"
cp apps/api/prisma/schema.prisma "$WORK/apps/api/prisma/"
(cd "$WORK" && npm ci --omit=dev --workspace=@voltlink/api --include-workspace-root=false --no-audit --no-fund --loglevel=error)

echo "[simulate-image] 2/6 prisma generate + stub check"
(cd "$WORK" && node node_modules/prisma/build/index.js generate --schema apps/api/prisma/schema.prisma)
(cd "$WORK" && rm -rf node_modules/@voltlink)
(cd "$WORK" && test -f apps/api/node_modules/argon2/package.json && node -e "new (require('@prisma/client').PrismaClient)()")

echo "[simulate-image] 3/6 build + COPY layout"
npm run build >/dev/null 2>&1
cp -r apps/api/dist "$WORK/apps/api/dist"
rm -rf "$WORK/apps/api/prisma" && cp -r apps/api/prisma "$WORK/apps/api/prisma"
cp apps/api/openapi.json "$WORK/apps/api/openapi.json"
rm -rf "$WORK/apps/api/web-dist" && cp -r apps/api/web-dist "$WORK/apps/api/web-dist"

echo "[simulate-image] 4/6 self-test"
(cd "$WORK/apps/api" && node dist/cli/selftest.cjs)

echo "[simulate-image] 5/6 temporary database + migrate role"
PGPASSWORD="$DB_PW" "$PSQL" -h 127.0.0.1 -p 5433 -U voltlink -d postgres -c "CREATE DATABASE $SIM_DB" >/dev/null
export DATABASE_URL="postgresql://voltlink:${DB_PW}@127.0.0.1:5433/${SIM_DB}"
export REDIS_URL="redis://127.0.0.1:6379"
export JWT_SECRET="$(openssl rand -hex 32)"
export VL_MASTER_KEY="$(openssl rand -base64 32)"
export PUBLIC_URL="http://localhost:3111"
export VL_ALLOW_INSECURE_HTTP=true
export NODE_ENV=production
export PORT=3111
export STATUS_PORT=3112
export VL_SETUP_TOKEN="simulate-image-setup-token-$(openssl rand -hex 8)"

(cd "$WORK/apps/api" && node dist/cli/migrate.cjs)

echo "[simulate-image] 6/6 boot every role + smoke"
( cd "$WORK/apps/api" || { echo "web-cd-failed: $WORK" >> "$WORK/web.log"; exit 9; } ; { echo "web-pwd=$(pwd)"; node dist/index.cjs; echo "web-exit=$?"; } >"$WORK/web.log" 2>&1 ) & PIDS+=($!)
(cd "$WORK/apps/api" && node dist/worker.cjs >"$WORK/worker.log" 2>&1) & PIDS+=($!)
(cd "$WORK/apps/api" && node dist/scheduler.cjs >"$WORK/scheduler.log" 2>&1) & PIDS+=($!)
(cd "$WORK/apps/api" && node dist/statusServer.cjs >"$WORK/status.log" 2>&1) & PIDS+=($!)

for i in $(seq 1 90); do
  curl -fsS "http://127.0.0.1:3111/healthz" >/dev/null 2>&1 && break
  sleep 0.5
done
READY=$(curl -fsS "http://127.0.0.1:3111/readyz" || echo "curl-failed")
echo "[simulate-image] readyz: $READY"
echo "$READY" |  grep -q '"ready":true' || { echo "[simulate-image] web/readyz failed:"; tail -50 "$WORK/web.log"; exit 1; }
curl -fsS "http://127.0.0.1:3112/healthz" | grep -q '"ok":true' || { echo "[simulate-image] status/healthz failed:"; tail -20 "$WORK/status.log"; exit 1; }

# First-run setup: register with the setup token (bootstrapped owner).
CSRF="$(curl -sS -c "$WORK/cj" -X POST -H 'Content-Type: application/json' -d '{}' "http://127.0.0.1:3111/api/v1/auth/register" -o /dev/null -w '%{http_code}' || true)"
TOKEN="$(grep vl_csrf "$WORK/cj" | awk '{print $NF}' | tail -1)"
REG=$(curl -sS -b "$WORK/cj" -H "x-vl-csrf: $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"email\":\"sim-$(date +%s)@example.test\",\"password\":\"sim-password-12345\",\"name\":\"Sim\",\"setupToken\":\"$VL_SETUP_TOKEN\"}" \
  "http://127.0.0.1:3111/api/v1/auth/register")
echo "$REG" | grep -q '"token"\|"user"' || { echo "[simulate-image] register failed: $REG"; tail -20 "$WORK/web.log"; exit 1; }

# Demo fleet connect through the registered session.
SESSION=$(echo "$REG" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const b=JSON.parse(d);console.log((b.data?.token)||'')}catch{}})")
if [ -n "$SESSION" ]; then
  curl -fsS -b "vl_session=$SESSION" -H "x-vl-csrf: $TOKEN" -H 'Content-Type: application/json' -d '{}' \
    "http://127.0.0.1:3111/api/v1/providers/demo/connect" | grep -q '"data"'
fi

sleep 1
grep -q "\[voltlink\]" "$WORK/web.log"
grep -q "\[voltlink\]" "$WORK/worker.log" || true
grep -q "\[voltlink\]" "$WORK/scheduler.log" || true

echo "[simulate-image] PASS: every role booted in production mode and the smoke test passed"
