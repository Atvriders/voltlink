#!/bin/bash
# tesla-e2e.sh — runs the Tesla Playwright spec against the fake Fleet API.
set -euo pipefail
cd "$(dirname "$0")/../.."
export PATH="$HOME/.nvm/versions/node/v24.19.0/bin:$PATH"
set -a
. apps/api/.env 2>/dev/null || true
set +a

pkill -f fake-tesla-server || true
rm -f /tmp/fake-tesla.url
npx tsx scripts/e2e/fake-tesla-server.ts >/tmp/fake-tesla.log 2>&1 &
FAKE_PID=$!
for i in $(seq 1 40); do [ -f /tmp/fake-tesla.url ] && break; sleep 0.25; done
FAKE="$(cat /tmp/fake-tesla.url)"
curl -sf "$FAKE/health" >/dev/null || { echo "fake not healthy" >&2; exit 1; }

export TESLA_ALLOW_TEST_ENDPOINTS=true
export TESLA_TOKEN_URL="$FAKE/oauth2/v3/token"
export TESLA_AUTHORIZE_URL="$FAKE/oauth2/v3/authorize"
export TESLA_DEFAULT_AUDIENCE="$FAKE"
export TESLA_FLEET_BASE_NA="$FAKE"
export TESLA_FLEET_BASE_EU="$FAKE"
export TESLA_COMMAND_PROXY_URL="$FAKE"
export TESLA_CLIENT_ID=e2e-client
export TESLA_CLIENT_SECRET=e2e-secret
export TESLA_REDIRECT_URI="http://127.0.0.1:3111/api/v1/providers/tesla/callback"
export TESLA_PARTNER_DOMAIN=127.0.0.1
export TESLA_PUBLIC_KEY_FILE=/nonexistent
export E2E_TESLA_FAKE_URL="$FAKE"

npx tsx apps/api/scripts/e2e-seed-tesla-user.ts
bash scripts/e2e/start-stack.sh
trap 'pkill -f fake-tesla-server || true' EXIT
npx playwright test tests/e2e/tesla.spec.ts --project=tesla "$@"
