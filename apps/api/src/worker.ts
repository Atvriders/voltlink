// Worker role: BullMQ consumers (guide 04 §4). Every QueueName has
// exactly one startWorker here (queue.contract.test.ts proves the invariant).

import { validateEnv } from './core/env';
import { initRedis } from './core/redis';
import { startWorker, installShutdown } from './jobs/runtime';
import { waitForMigrations } from './cli/migrate';
import { prisma } from './core/db';
import { processCommandJob, sweepStuckCommands, recoverStuckCommands } from './commands/service';
import { processTelemetryJob } from './telemetry/poller';
import { setSetting } from './core/settings';
import { runPrivacyRedaction } from './jobs/privacy-redaction';
import { runAccountDeletion } from './jobs/account-deletion';

async function main(): Promise<void> {
  validateEnv();
  await initRedis();
  await waitForMigrations();
  await import('./net/policy').then((m) => m.buildOutboundPolicy());
  await prisma.$connect();

  // P-STUCK: recover commands stuck in submitted/accepted from before this
  // worker started, and sweep commands past their window.
  await recoverStuckCommands();
  await sweepStuckCommands();

  startWorker('vehicle-commands', async (job) => {
    const payload = job.data as { commandId: string; stage?: 'dispatch' | 'confirm' };
    await processCommandJob(payload);
  });
  startWorker('telemetry', async (job) => {
    const p = job.data as { accountId: string; vehicleId: string; providerVehicleId: string };
    await processTelemetryJob(p);
  });
  startWorker('reports', async (job) => {
    const p = job.data as { userId: string; kind: string };
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
  });
  startWorker('privacy-redaction', async (job) => {
    await runPrivacyRedaction((job.data as { zoneId: string }).zoneId);
  });
  startWorker('account-deletion', async (job) => {
    await runAccountDeletion((job.data as { userId: string }).userId);
  });
  startWorker('automations', async (job) => {
    const { dispatchTrigger } = await import('./automations/engine');
    const p = job.data as { userId: string; vehicleId?: string; trigger: string; data: unknown };
    await dispatchTrigger({ type: p.trigger as never, userId: p.userId, vehicleId: p.vehicleId, data: p.data as Record<string, unknown> });
  });
  startWorker('maintenance', async (job) => {
    const { notify } = await import('./notifications/service');
    const p = job.data as { userId: string; recordId: string; title: string; vehicleName?: string };
    await notify({
      userId: p.userId,
      event: 'system',
      severity: 'info',
      title: 'Maintenance due',
      body: `${p.vehicleName ?? 'Vehicle'}: ${p.title}`,
    });
  });
  startWorker('tesla-token-refresh', async (job) => {
    // Phase 6 wires the refresh call; the queue must exist and consume now so
    // every enqueue has exactly one consumer (guide 04 §4 invariant).
    const p = job.data as { accountId: string };
    const account = await prisma.providerAccount.findUnique({ where: { id: p.accountId } });
    if (!account || account.provider !== 'tesla') return;
    console.warn('[voltlink] tesla-token-refresh: refresh wiring lands in Phase 6 (account %s)', p.accountId);
  });
  startWorker('demo', async (job) => {
    const p = job.data as { userId: string };
    await prisma.appNotification.create({
      data: {
        userId: p.userId,
        event: 'system',
        severity: 'info',
        title: 'Demo fleet ready',
        body: 'Your fictional demo fleet finished loading.',
        channel: 'in_app',
      },
    });
  });

  // Command sweeper: every 60 s time out commands with no provider result.
  const sweep = setInterval(() => void sweepStuckCommands().catch(() => undefined), 60_000);
  sweep.unref();

  const beat = setInterval(
    () => void setSetting('workerBeat', new Date().toISOString()).catch(() => undefined),
    30_000,
  );
  beat.unref();

  console.log('[voltlink] worker started');

  installShutdown(async () => {
    clearInterval(sweep);
    clearInterval(beat);
  });
}

void main().catch((err) => {
  console.error('[voltlink] worker fatal:', err);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  // NEW-05: log and keep serving; never crash a role on a stray rejection.
  console.error('[voltlink] unhandledRejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[voltlink] uncaughtException:', err);
});
