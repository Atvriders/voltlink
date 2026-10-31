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
    # Liveness: this script only runs while the main process is alive; also
    # verify Redis is reachable when configured.
    if [ -n "${REDIS_URL:-}" ]; then
      node -e "const R=require('ioredis');const c=new R(process.env.REDIS_URL,{lazyConnect:true,maxRetriesPerRequest:1});c.ping().then(()=>{c.disconnect();process.exit(0)}).catch(()=>process.exit(1))"
    else
      exit 0
    fi
    ;;
  migrate|selftest) exit 0 ;;
  *) exit 1 ;;
esac
