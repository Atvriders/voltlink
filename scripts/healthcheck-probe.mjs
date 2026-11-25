// healthcheck-probe.mjs — worker/scheduler healthcheck probe (I-HEALTH).
// docker/healthcheck.sh runs `node /app/healthcheck-probe.mjs <role>` inside
// the container for the worker and scheduler roles. The probe verifies the
// role's REAL heartbeat — the workerBeat/schedulerBeat settings the roles
// record for /admin/health — with a freshness bound, and fails when
// REDIS_URL is missing (a worker without its queue is not healthy).
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export const BEAT_BOUNDS = {
  worker: 90_000, // matches /admin/health workersActive
  scheduler: 5 * 60_000, // spec L1217: beats < 5 min old
};

export function beatValueMs(value) {
  const n = Number(value);
  if (Number.isFinite(n) && n > 0) return n;
  const t = new Date(String(value)).getTime();
  return Number.isFinite(t) ? t : NaN;
}

export function beatFresh(role, value, nowMs = Date.now()) {
  const bound = BEAT_BOUNDS[role];
  if (!bound) return false;
  const ms = beatValueMs(value);
  const age = nowMs - ms;
  return Number.isFinite(age) && age >= 0 && age < bound;
}

export function configProblems({ role, redisUrl }) {
  const problems = [];
  if (!redisUrl) problems.push('REDIS_URL is required');
  if (role !== 'worker' && role !== 'scheduler') problems.push(`unknown role '${role}'`);
  return problems;
}

async function main() {
  const role = process.argv[2] ?? process.env.VL_ROLE ?? '';
  const problems = configProblems({ role, redisUrl: process.env.REDIS_URL });
  if (problems.length > 0) {
    console.error(`[healthcheck] ${problems.join('; ')}`);
    process.exit(1);
  }
  const require = createRequire(import.meta.url);
  const Redis = require('ioredis');
  const redis = new Redis(process.env.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    connectTimeout: 4000,
  });
  const redisOk = await redis
    .ping()
    .then(() => {
      redis.disconnect();
      return true;
    })
    .catch(() => {
      redis.disconnect();
      return false;
    });
  if (!redisOk) {
    console.error('[healthcheck] redis ping failed');
    process.exit(1);
  }
  const pg = require('pg');
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect();
    const key = role === 'worker' ? 'workerBeat' : 'schedulerBeat';
    const { rows } = await client.query('SELECT value FROM "AppSetting" WHERE key = $1', [key]);
    const value = rows[0]?.value;
    if (!beatFresh(role, value)) {
      console.error(`[healthcheck] ${role} heartbeat missing or stale (${value ?? 'null'})`);
      process.exit(1);
    }
    process.exit(0);
  } finally {
    await client.end().catch(() => undefined);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main().catch((err) => {
    console.error('[healthcheck]', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
