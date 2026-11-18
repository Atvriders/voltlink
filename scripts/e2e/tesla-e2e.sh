#!/bin/bash
# tesla-e2e.sh — runs the Tesla Playwright spec against the fake Fleet API.
# R2-24 safety: no pkill -f, no sourcing apps/api/.env, no raw SQL seeding,
# no `|| true`; the stack runs in production mode.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
RUN_DIR="${RUN_DIR:-$SCRIPT_DIR/run}"
mkdir -p "$RUN_DIR"
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"

rm -f "$RUN_DIR/fake-tesla.url"
export FAKE_TESLA_URL_FILE="$RUN_DIR/fake-tesla.url"
npx tsx "$SCRIPT_DIR/fake-tesla-server.ts" >"$RUN_DIR/fake-tesla.log" 2>&1 &
FAKE_PID=$!
echo "fake $FAKE_PID" >> "$RUN_DIR/tesla-pids"
cleanup() {
  set +e
  bash "$SCRIPT_DIR/start-stack.sh" stop
  if kill -0 "$FAKE_PID" 2>/dev/null; then kill "$FAKE_PID" 2>/dev/null; fi
}
trap cleanup EXIT

for i in $(seq 1 40); do [ -f "$RUN_DIR/fake-tesla.url" ] && break; sleep 0.25; done
[ -f "$RUN_DIR/fake-tesla.url" ] || { echo 'fake tesla server did not write its URL' >&2; tail -20 "$RUN_DIR/fake-tesla.log"; exit 1; }
FAKE="$(cat "$RUN_DIR/fake-tesla.url")"
curl -sf "$FAKE/health" >/dev/null || { echo 'fake tesla not healthy' >&2; tail -20 "$RUN_DIR/fake-tesla.log"; exit 1; }

export TESLA_ALLOW_TEST_ENDPOINTS=true
export TESLA_TOKEN_URL="$FAKE/oauth2/v3/token"
export TESLA_AUTHORIZE_URL="$FAKE/oauth2/v3/authorize"
export TESLA_DEFAULT_AUDIENCE="$FAKE"
export TESLA_FLEET_BASE_NA="$FAKE"
export TESLA_FLEET_BASE_EU="$FAKE"
export TESLA_COMMAND_PROXY_URL="$FAKE"
export TESLA_CLIENT_ID=e2e-client
export TESLA_CLIENT_SECRET=e2e-secret
export TESLA_REDIRECT_URI="http://127.0.0.1:${PORT:-3111}/api/v1/providers/tesla/callback"
export TESLA_PARTNER_DOMAIN=127.0.0.1
export TESLA_PUBLIC_KEY_FILE=/nonexistent
export E2E_TESLA_FAKE_URL="$FAKE"

bash "$SCRIPT_DIR/start-stack.sh"
node "$SCRIPT_DIR/seed-tesla-user.mjs"
npx playwright test tests/e2e/tesla.spec.ts --project=tesla "$@"
