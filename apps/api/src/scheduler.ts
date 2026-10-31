// Scheduler role: provider polling, scheduled automations, retention,
// aggregation maintenance, and status checks.

import { env, validateEnv } from './core/env';
import { prisma } from './core/db';
import { waitForMigrations } from './cli/migrate';
import { poller } from './telemetry/poller';
import { dispatchTrigger } from './automations/engine';
import { runRetention } from './telemetry/retention';
import { setSetting } from './core/settings';
import { runStatusChecks, ensureComponents } from './status/service';
import { initRedis } from './core/redis';
import { pool } from './core/db';

async function main(): Promise<void> {
  validateEnv();
  await initRedis();
  await waitForMigrations();
  await prisma.$connect();
  await ensureComponents();

  poller.start();
  console.log('[voltlink] scheduler started');

  // Scheduled automations: evaluate each minute.
  const minute = setInterval(async () => {
    try {
      await setSetting('schedulerBeat', '1');
      const rows = await prisma.automation.findMany({
        where: { enabled: true, triggerType: 'scheduled' },
      });
      for (const row of rows) {
        void dispatchTrigger({
          type: 'scheduled',
          userId: row.userId,
          vehicleId: row.vehicleId ?? undefined,
          data: {},
        });
      }
    } catch (err) {
      console.error('scheduled automation tick failed:', (err as Error).message);
    }
  }, 60_000);
  minute.unref();

  // Status checks hourly (offset from the web role's hourly check).
  const statusTimer = setInterval(async () => {
    try {
      await runStatusChecks();
    } catch (err) {
      console.error('status check failed:', (err as Error).message);
    }
  }, 3600_000);
  statusTimer.unref();

  // P-PARTITION: create partitions ahead of time (current + next two months)
  // so month boundaries never race ingestion. Daily, plus once at boot.
  const ensurePartitions = async () => {
    for (let m = 0; m <= 2; m++) {
      const ts = new Date();
      ts.setUTCDate(1);
      ts.setUTCMonth(ts.getUTCMonth() + m, 1);
      await pool.query('SELECT voltlink_ensure_partition($1)', [ts]);
    }
  };
  void ensurePartitions().catch((err) => console.error('partition pre-create failed:', (err as Error).message));
  const partitions = setInterval(() => void ensurePartitions().catch(() => undefined), 24 * 3600_000);
  partitions.unref();

  // Retention: daily.
  const retention = setInterval(async () => {
    try {
      const result = await runRetention();
      console.log('[voltlink] retention:', JSON.stringify(result));
    } catch (err) {
      console.error('retention failed:', (err as Error).message);
    }
  }, 24 * 3600_000);
  retention.unref();

  // Polling heartbeat.
  void poller.tick();

  const shutdown = () => {
    poller.stop();
    clearInterval(partitions);
    void prisma.$disconnect().then(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

void main().catch((err) => {
  console.error('[voltlink] scheduler fatal error:', err);
  process.exit(1);
});

// NEW-05: log and keep serving; never crash a role on a stray rejection.
process.on('unhandledRejection', (reason) => {
  console.error('[voltlink] scheduler unhandledRejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[voltlink] scheduler uncaughtException:', err);
});

void env;
