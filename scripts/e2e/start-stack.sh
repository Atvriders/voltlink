#!/bin/bash
# start-stack.sh — boots web + worker + scheduler from the local build against
# a Postgres + Redis (provided by CI services or compose). Used by the
# e2e-fullstack job (guide 08 §14). Not a substitute for the image smoke test.
set -euo pipefail
cd "$(dirname "$0")/../.."
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"

cd apps/api
node dist/cli/migrate.cjs >/tmp/voltlink-migrate.log 2>&1 || { tail -40 /tmp/voltlink-migrate.log; exit 1; }
NODE_ENV=development PORT=3111 node dist/index.cjs >/tmp/voltlink-api.log 2>&1 &
echo $! >/tmp/voltlink-api.pid
NODE_ENV=development node dist/worker.cjs >/tmp/voltlink-worker.log 2>&1 &
echo $! >/tmp/voltlink-worker.pid
NODE_ENV=development node dist/scheduler.cjs >/tmp/voltlink-scheduler.log 2>&1 &
echo $! >/tmp/voltlink-scheduler.pid
for i in $(seq 1 60); do curl -sf http://127.0.0.1:3111/healthz >/dev/null && exit 0; sleep 1; done
tail -40 /tmp/voltlink-api.log
exit 1
