// Compatibility shim over the BullMQ job system (guide 04 §4). New code should
// import { enqueue } from '../jobs/queues' and { startWorker } from
// '../jobs/runtime' directly; this module keeps the legacy getQueue() surface
// for existing call sites.

import { enqueue, queue, type QueueName } from '../jobs/queues';
import { producerConnection } from './redis';

export interface EnqueueOptions {
  delayMs?: number;
  dedupeKey?: string;
  maxAttempts?: number;
}

export interface QueueConsumer {
  start(): void;
  stop(): Promise<void>;
}

export interface JobQueue {
  enqueue(queueName: string, payload: unknown, opts?: EnqueueOptions): Promise<string>;
  depth(queueName: string): Promise<number>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

class BullQueue implements JobQueue {
  async enqueue(queueName: string, payload: unknown, opts: EnqueueOptions = {}): Promise<string> {
    return enqueue(queueName as QueueName, payload as object, {
      delayMs: opts.delayMs,
      dedupeKey: opts.dedupeKey,
      attempts: opts.maxAttempts,
    });
  }

  async depth(queueName: string): Promise<number> {
    try {
      const counts = await queue(queueName as QueueName).getJobCounts(
        'active',
        'waiting',
        'delayed',
      );
      return Object.values(counts).reduce((a, b) => a + b, 0);
    } catch {
      return 0;
    }
  }

  async ping(): Promise<boolean> {
    try {
      return (await producerConnection().ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    // Connections are owned by jobs/queues + jobs/runtime.
  }
}

const instance = new BullQueue();

export function getQueue(): JobQueue {
  return instance;
}
