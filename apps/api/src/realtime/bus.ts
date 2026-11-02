// Cross-process realtime bus (guide 04 §5, P-SSE): any role publishes; only
// web holds browser sockets. Redis streams give per-user event ids and
// Last-Event-ID replay.

import { producerConnection } from '../core/redis';

const PUBLISH_LUA = `local id = redis.call('XADD', KEYS[1], 'MAXLEN', '~', ARGV[1], '*', 'e', ARGV[2])
redis.call('PEXPIRE', KEYS[1], ARGV[3]) redis.call('PUBLISH', KEYS[1], id .. '|' .. ARGV[2]) return id`;

export const REPLAY_MS = 5 * 60_000;
export const CONTROL = 'voltlink:rt:control';
export const userKey = (u: string) => `voltlink:rt:u:${u}`;

type Bus = ReturnType<typeof producerConnection> & {
  voltlinkRtPublish(k: string, maxlen: number, json: string, ttlMs: number): Promise<string>;
};

let bus: Bus | undefined;
const conn = (): Bus => {
  const c = producerConnection() as unknown as Bus;
  if (bus !== c) {
    c.defineCommand('voltlinkRtPublish', { numberOfKeys: 1, lua: PUBLISH_LUA });
    bus = c;
  }
  return c;
};

/** There is no broadcast: callers resolve the audience first. */
export async function publishToUsers(
  userIds: string[],
  ev: { type: string; data: unknown },
): Promise<void> {
  const json = JSON.stringify({ ...ev, at: new Date().toISOString() });
  const audience = [...new Set(userIds.filter(Boolean))];
  try {
    await Promise.all(
      audience.map(
        (u) =>
          conn()
            .voltlinkRtPublish(userKey(u), 200, json, REPLAY_MS)
            .catch(() => undefined), // Redis down must never take a request down
      ),
    );
  } catch {
    // initRedis() not run (tests/cold boot): publishing is best-effort.
  }
}

export type RevokeMsg = { userId: string } & (
  { sessionIds: string[] } | { allExcept: string | null }
);

export const publishSessionRevocation = async (m: RevokeMsg): Promise<void> => {
  await producerConnection()
    .publish(CONTROL, JSON.stringify(m))
    .catch(() => undefined);
};
