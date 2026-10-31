// The only enqueue API (guide 04 §4). Same call shape as the removed
// JobQueue.enqueue. Every queue name must have exactly one startWorker in
// worker.ts (queue.contract.test.ts proves the invariant).

import { Queue, type JobsOptions } from 'bullmq';
import { producerConnection } from '../core/redis';

export const PREFIX = 'voltlink';

export const QUEUE_DEFAULTS = {
  'vehicle-commands': { attempts: 1 }, // provider commands are not idempotent: the DB state machine decides
  telemetry: { attempts: 3, backoff: { type: 'exponential', delay: 5_000, jitter: 0.2 } },
  'tesla-token-refresh': { attempts: 5, backoff: { type: 'exponential', delay: 30_000, jitter: 0.2 } },
  automations: { attempts: 3, backoff: { type: 'exponential', delay: 10_000 } },
  reports: { attempts: 2, backoff: { type: 'fixed', delay: 30_000 } },
  'privacy-redaction': { attempts: 5, backoff: { type: 'exponential', delay: 60_000 } },
  'account-deletion': { attempts: 10, backoff: { type: 'exponential', delay: 60_000 } },
  maintenance: { attempts: 3, backoff: { type: 'exponential', delay: 60_000 } },
  demo: { attempts: 3, backoff: { type: 'exponential', delay: 5_000 } },
} satisfies Record<string, JobsOptions>;

export type QueueName = keyof typeof QUEUE_DEFAULTS;

const KEEP: JobsOptions = {
  removeOnComplete: { age: 86_400, count: 5_000 },
  removeOnFail: { age: 14 * 86_400 },
};

const queues = new Map<QueueName, Queue>();

export function queue(name: QueueName): Queue {
  let q = queues.get(name);
  if (!q) {
    queues.set(
      name,
      (q = new Queue(name, {
        connection: producerConnection(),
        prefix: PREFIX,
        defaultJobOptions: { ...KEEP, ...QUEUE_DEFAULTS[name] },
      })),
    );
  }
  return q;
}

export const closeQueues = async (): Promise<void> => {
  await Promise.all([...queues.values()].map((q) => q.close()));
  queues.clear();
};

export async function enqueue(
  name: QueueName,
  payload: object,
  o: { delayMs?: number; dedupeKey?: string; jobId?: string; attempts?: number } = {},
): Promise<string> {
  const job = await queue(name).add(name, payload, {
    delay: o.delayMs,
    attempts: o.attempts,
    jobId: o.jobId, // no ':' and not integer-like
    deduplication: o.dedupeKey ? { id: `${name}:${o.dedupeKey}` } : undefined,
  });
  return job.id!;
}
