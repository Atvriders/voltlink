// Worker role: consumes job queues. One production image, multiple runtime
// commands (see Dockerfile and compose files).

import { env, validateEnv } from './core/env';
import { getQueue } from './core/queue';
import { runMigrationLeader } from './cli/migrateLeader';
import { prisma } from './core/db';
import { processCommandJob } from './commands/service';
import { processTelemetryJob } from './telemetry/poller';
import { setSetting } from './core/settings';

async function main(): Promise<void> {
  validateEnv();
  await runMigrationLeader();
  await prisma.$connect();

  const queue = getQueue();
  const consumers = [
    queue.consume('vehicle-commands', 4, (payload) => processCommandJob(payload as { commandId: string; stage?: 'dispatch' | 'confirm' })),
    queue.consume('telemetry', 4, (payload) => processTelemetryJob(payload as { accountId: string; vehicleId: string; providerVehicleId: string })),
    queue.consume('reports', 2, async (payload) => {
      const p = payload as { userId: string; kind: string };
      await prisma.appNotification.create({
        data: {
          userId: p.userId,
          event: 'system',
          severity: 'info',
          title: 'Report ready',
          body: `Your ${p.kind.replace(/_/g, ' ')} report was generated.`,
          channel: 'in_app',
        },
      });
    }),
    queue.consume('demo', 1, async (payload) => {
      // demo seed completion bookkeeping
      const p = payload as { userId: string };
      await prisma.appNotification.create({
        data: { userId: p.userId, event: 'system', severity: 'info', title: 'Demo fleet ready', body: 'Your fictional demo fleet finished loading.', channel: 'in_app' },
      });
    }),
  ];

  const beat = setInterval(() => void setSetting('workerBeat', new Date().toISOString()).catch(() => undefined), 30_000);
  beat.unref();
  console.log('[voltlink] worker started');
  const shutdown = () => {
    void Promise.all(consumers.map((c) => c.stop())).then(() => prisma.$disconnect().then(() => process.exit(0)));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

void main().catch((err) => {
  console.error('[voltlink] worker fatal error:', err);
  process.exit(1);
});

void env;
