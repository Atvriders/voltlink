#!/bin/sh
# voltlink-healthcheck — probes the readiness of the role that is actually running.
set -eu
role="$(cat /tmp/voltlink/role 2>/dev/null || printf '%s' "${VL_ROLE:-web}")"
probe() {
  node -e "fetch('http://127.0.0.1:'+process.argv[1]+process.argv[2],{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" "$1" "$2"
}
case "$role" in
  web) probe "${PORT:-3000}" /readyz ;;
  status) probe "${STATUS_PORT:-3001}" /healthz ;;
  worker|scheduler)
    # I-HEALTH: verify the role's REAL heartbeat (workerBeat/schedulerBeat
    # recorded for /admin/health) with a freshness bound, and fail when
    # REDIS_URL is missing. The probe also pings Redis.
    exec node /app/healthcheck-probe.mjs "$role"
    ;;
  migrate|selftest) exit 0 ;;
  *) exit 1 ;;
esac
