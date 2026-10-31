// Worker runtime (guide 04 §4): BullMQ workers with error listeners, a
// graceful shutdown that drains active jobs, and consumer health.

import { Worker, type Processor, type WorkerOptions } from 'bullmq';
import { workerConnection, producerConnection } from '../core/redis';
import { closeQueues, PREFIX } from './queues';
import { prisma } from '../core/db';
import { pool } from '../core/db';

const workers: Worker[] = [];

export function startWorker(
  name: string,
  processor: Processor,
  opts: Partial<WorkerOptions> = {},
): Worker {
  const w = new Worker(name, processor, {
    connection: workerConnection(),
    prefix: PREFIX,
    concurrency: 4,
    ...opts,
  });
  w.on('error', (err) => console.error(`[voltlink] worker ${name} error:`, err)); // mandatory listener
  w.on('failed', (job, err) =>
    console.error(`[voltlink] job ${name} failed`, { jobId: job?.id, attempts: job?.attemptsMade, err }),
  );
  workers.push(w);
  return w;
}

export const consumersHealthy = (): boolean =>
  workers.length > 0 && workers.every((w) => w.isRunning());

export function installShutdown(extra: () => Promise<void>): void {
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    setTimeout(() => process.exit(1), 80_000).unref(); // stays under compose stop_grace_period
    await Promise.allSettled(workers.map((w) => w.close()));
    await extra();
    await closeQueues();
    try {
      await producerConnection().quit();
    } catch {
      /* already closed */
    }
    await prisma.$disconnect();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop());
  process.on('SIGINT', () => void stop());
}

export const activeWorkerCount = (): number => workers.length;
