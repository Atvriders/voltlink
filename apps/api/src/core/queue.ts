// Background job queue abstraction. Production uses Redis; development and
// tests use the Postgres-backed implementation when REDIS_URL is unset.

import Redis from 'ioredis';
import { prisma, query, pool } from './db';
import { env } from './env';

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
  enqueue(queue: string, payload: unknown, opts?: EnqueueOptions): Promise<string>;
  /** Register a handler for a queue. Returns a consumer with start/stop. */
  consume(
    queue: string,
    concurrency: number,
    handler: (payload: unknown, jobId: string) => Promise<void>,
  ): QueueConsumer;
  depth(queue: string): Promise<number>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Postgres-backed queue (FOR UPDATE SKIP LOCKED)
// ---------------------------------------------------------------------------

class PgQueue implements JobQueue {
  private consumers = new Map<string, { stop: boolean; promise?: Promise<void> }>();
  async enqueue(queueName: string, payload: unknown, opts: EnqueueOptions = {}): Promise<string> {
    const dedupeKey = opts.dedupeKey ? `dedupe:${queueName}:${opts.dedupeKey}` : undefined;
    const job = await prisma.backgroundJob.create({
      data: {
        queue: queueName,
        payload: JSON.stringify(payload),
        runAt: new Date(Date.now() + (opts.delayMs ?? 0)),
        maxAttempts: opts.maxAttempts ?? 3,
        dedupeKey,
      },
    });
    return job.id;
  }

  consume(
    queueName: string,
    concurrency: number,
    handler: (payload: unknown, jobId: string) => Promise<void>,
  ): QueueConsumer {
    const state: { stop: boolean; promise?: Promise<void> } = { stop: false };
    const workerId = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    const run = async () => {
      while (!state.stop) {
        try {
          const client = await pool.connect();
          try {
            await client.query('BEGIN');
            const res = await client.query(
              `SELECT id, payload, attempts FROM "BackgroundJob"
               WHERE queue = $1 AND status = 'pending' AND "runAt" <= now()
               ORDER BY "runAt" ASC LIMIT $2
               FOR UPDATE SKIP LOCKED`,
              [queueName, concurrency],
            );
            if (res.rows.length === 0) {
              await client.query('COMMIT');
              await new Promise((r) => setTimeout(r, 500));
              continue;
            }
            await client.query(
              `UPDATE "BackgroundJob" SET status='processing', "lockedAt"=now(), "lockedBy"=$1, "startedAt"=now() WHERE id = ANY($2)`,
              [workerId, res.rows.map((r) => r.id)],
            );
            await client.query('COMMIT');
            for (const row of res.rows) {
              void (async () => {
                try {
                  await handler(JSON.parse(row.payload), row.id);
                  await prisma.backgroundJob.update({
                    where: { id: row.id },
                    data: { status: 'done', doneAt: new Date() },
                  });
                } catch (err) {
                  const attempts = (row.attempts as number) + 1;
                  const failed = attempts >= (row.maxAttempts as number);
                  await prisma.backgroundJob.update({
                    where: { id: row.id },
                    data: {
                      attempts,
                      status: failed ? 'dead' : 'pending',
                      error: String((err as Error).message).slice(0, 2000),
                      runAt: failed
                        ? undefined
                        : new Date(Date.now() + Math.min(2 ** attempts, 300) * 1000),
                      doneAt: failed ? new Date() : undefined,
                    },
                  });
                }
              })();
            }
          } finally {
            client.release();
          }
        } catch {
          // connection hiccup — retry shortly
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    };
    this.consumers.set(queueName, state);
    state.promise = run();
    return {
      start: () => undefined,
      stop: async () => {
        state.stop = true;
        await state.promise;
      },
    };
  }

  async depth(queueName: string): Promise<number> {
    const r = await query<{ c: string }>(
      `SELECT count(*)::text AS c FROM "BackgroundJob" WHERE queue=$1 AND status IN ('pending','processing')`,
      [queueName],
    );
    return Number(r.rows[0]?.c ?? '0');
  }

  async ping(): Promise<boolean> {
    try {
      await query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    for (const s of this.consumers.values()) s.stop = true;
  }
}

// ---------------------------------------------------------------------------
// Redis-backed queue (list-based, no extra dependencies beyond ioredis)
// ---------------------------------------------------------------------------

class RedisQueue implements JobQueue {
  private redis: Redis;
  constructor(url: string) {
    this.redis = new Redis(url, { maxRetriesPerRequest: 2, lazyConnect: true });
  }

  async enqueue(queueName: string, payload: unknown, opts: EnqueueOptions = {}): Promise<string> {
    const jobId = `${queueName}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
    const record = JSON.stringify({
      id: jobId,
      payload,
      attempts: 0,
      maxAttempts: opts.maxAttempts ?? 3,
    });
    if (opts.dedupeKey) {
      const ok = await this.redis.set(`vl:dedupe:${opts.dedupeKey}`, '1', 'EX', 3600, 'NX');
      if (!ok) return jobId; // duplicate suppressed
    }
    if (opts.delayMs && opts.delayMs > 0) {
      await this.redis.zadd(`vl:zset:${queueName}`, Date.now() + opts.delayMs, record);
    } else {
      await this.redis.rpush(`vl:queue:${queueName}`, record);
    }
    return jobId;
  }

  consume(
    queueName: string,
    concurrency: number,
    handler: (payload: unknown, jobId: string) => Promise<void>,
  ): QueueConsumer {
    const state = { stop: false };
    const processOne = async (record: string) => {
      const job = JSON.parse(record);
      try {
        await handler(job.payload, job.id);
      } catch (err) {
        job.attempts += 1;
        if (job.attempts < job.maxAttempts) {
          await this.redis.zadd(
            `vl:zset:${queueName}`,
            Date.now() + Math.min(2 ** job.attempts, 300) * 1000,
            JSON.stringify(job),
          );
        } else {
          await this.redis.rpush(
            `vl:dead:${queueName}`,
            JSON.stringify({ ...job, error: String((err as Error).message).slice(0, 2000) }),
          );
        }
      }
    };
    const loop = async () => {
      while (!state.stop) {
        const due = await this.redis.zrangebyscore(
          `vl:zset:${queueName}`,
          0,
          Date.now(),
          'LIMIT',
          0,
          concurrency,
        );
        if (due.length > 0) {
          await this.redis.zrem(`vl:zset:${queueName}`, ...due);
          await Promise.all(due.map(processOne));
        }
        const br = await this.redis.blpop(`vl:queue:${queueName}`, 1);
        if (br) await processOne(br[1]);
      }
    };
    const promise = loop();
    return {
      start: () => undefined,
      stop: async () => {
        state.stop = true;
        await promise;
      },
    };
  }

  async depth(queueName: string): Promise<number> {
    const [len, zcard] = await Promise.all([
      this.redis.llen(`vl:queue:${queueName}`),
      this.redis.zcard(`vl:zset:${queueName}`),
    ]);
    return len + zcard;
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.redis.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    this.redis.disconnect();
  }
}

let instance: JobQueue | null = null;

export function getQueue(): JobQueue {
  if (!instance) {
    instance = env.REDIS_URL ? new RedisQueue(env.REDIS_URL) : new PgQueue();
  }
  return instance;
}
