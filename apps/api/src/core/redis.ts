// Redis connections for BullMQ (guide 04 §4): producers fail fast until
// connected; workers use maxRetriesPerRequest null so a Redis blip never kills
// an active job.

import Redis, { type RedisOptions } from 'ioredis';

const base = (): RedisOptions => ({
  retryStrategy: (n) => Math.max(Math.min(Math.exp(n), 20_000), 1_000),
});

let producer: Redis | undefined;

export async function initRedis(url = process.env.REDIS_URL ?? ''): Promise<Redis> {
  // Every role calls this before serving.
  producer = new Redis(url, {
    ...base(),
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  await producer.connect();
  return producer;
}

export const producerConnection = (): Redis =>
  producer ??
  (() => {
    throw new Error('initRedis() has not run');
  })();

export const workerConnection = (): Redis =>
  new Redis(process.env.REDIS_URL ?? '', { ...base(), maxRetriesPerRequest: null });
