// Realtime hub (web role only, guide 04 §5): SSE sockets fanned out across
// processes via the Redis bus, with heartbeats, Last-Event-ID resume and
// session-revocation fan-out.

import type { Request, Response } from 'express';
import { workerConnection, producerConnection } from '../core/redis';
import { CONTROL, userKey, REPLAY_MS, type RevokeMsg } from './bus';
import { prisma } from '../core/db';

type Client = {
  res: Response;
  sessionId: string;
  lastId: string;
  pending: [string, string][] | null;
  timers: NodeJS.Timeout[];
  closed: boolean;
};

const byUser = new Map<string, Set<Client>>();
const subscribed = new Map<string, Promise<unknown>>();
let sub: ReturnType<typeof workerConnection> | null = null;
let reader: ReturnType<typeof producerConnection> | null = null;

const cmp = (a: string, b: string) => {
  const [am, as] = a.split('-').map(Number);
  const [bm, bs] = b.split('-').map(Number);
  return (am ?? 0) - (bm ?? 0) || (as ?? 0) - (bs ?? 0);
};

const frame = (id: string, p: string) => {
  const e = JSON.parse(p) as { type: string; data: unknown; at: string };
  return `id: ${id}\nevent: ${e.type}\ndata: ${JSON.stringify({ ...(e.data as object), at: e.at })}\n\n`;
};

function send(c: Client, s: string) {
  if (c.res.writableEnded) return;
  if (c.res.writableLength > 1_048_576) return void c.res.destroy(); // slow client: drop; it resumes
  c.res.write(s);
}

function close(c: Client, reason?: string) {
  if (c.res.writableEnded) return;
  if (reason) c.res.write(`event: ${reason}\ndata: {}\n\n`);
  c.res.end();
}

async function isSessionLive(sessionId: string): Promise<boolean> {
  const s = await prisma.userSession.findUnique({
    where: { id: sessionId },
    select: { revokedAt: true, expiresAt: true, user: { select: { deletionRequestedAt: true } } },
  });
  if (!s) return false;
  if (s.revokedAt) return false;
  if (s.expiresAt <= new Date()) return false;
  if (s.user.deletionRequestedAt) return false;
  return true;
}

export async function startHub(): Promise<void> {
  sub = workerConnection();
  reader = producerConnection();
  sub.on('message', (ch: string, msg: string) => {
    if (ch === CONTROL) {
      const m = JSON.parse(msg) as RevokeMsg;
      for (const c of [...(byUser.get(m.userId) ?? [])]) {
        if ('sessionIds' in m ? m.sessionIds.includes(c.sessionId) : c.sessionId !== m.allExcept) {
          close(c, 'session_revoked');
        }
      }
      return;
    }
    const i = msg.indexOf('|');
    const id = msg.slice(0, i);
    const p = msg.slice(i + 1);
    for (const c of byUser.get(ch.slice('voltlink:rt:u:'.length)) ?? []) {
      if (c.pending) c.pending.push([id, p]);
      else if (cmp(id, c.lastId) > 0) {
        c.lastId = id;
        send(c, frame(id, p));
      }
    }
  });
  await sub.subscribe(CONTROL);
}

export function stopHub(): void {
  for (const set of byUser.values()) {
    for (const c of set) {
      c.timers.forEach(clearTimeout);
      if (!c.res.writableEnded) c.res.end();
    }
  }
  byUser.clear();
  subscribed.clear();
  sub?.disconnect();
  sub = null;
  reader = null;
}

export async function sseHandler(req: Request, res: Response): Promise<void> {
  if (!sub || !reader) {
    res.status(503).json({ error: { code: 'NOT_READY', message: 'Realtime hub is not ready.' } });
    return;
  }
  const actor = req.actor as { userId: string; sessionId: string };
  const key = userKey(actor.userId);
  const set = byUser.get(actor.userId) ?? new Set<Client>();
  if (set.size >= 10) {
    res.status(429).json({ error: { code: 'TOO_MANY_STREAMS', message: 'Too many open streams.' } });
    return;
  }
  res
    .status(200)
    .set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  const c: Client = { res, sessionId: actor.sessionId, lastId: '0-0', pending: [], timers: [], closed: false };
  set.add(c);
  byUser.set(actor.userId, set);
  res.on('close', () => {
    c.closed = true;
    c.timers.forEach(clearTimeout);
    set.delete(c);
    if (!set.size) {
      byUser.delete(actor.userId);
      subscribed.delete(actor.userId);
      const unsub = sub ? sub.unsubscribe(key) : undefined;
      if (unsub && typeof unsub === 'object') void (unsub as Promise<unknown>).catch(() => undefined);
    }
  });
  if (!subscribed.has(actor.userId)) subscribed.set(actor.userId, sub.subscribe(key));
  await subscribed.get(actor.userId);
  const raw = String(req.get('Last-Event-ID') ?? req.query.lastEventId ?? '');
  const last = /^\d+-\d+$/.test(raw) ? raw : null;
  if (last) {
    const [oldest] = await reader.xrange(key, '-', '+', 'COUNT', 1);
    if ((oldest && cmp(oldest[0], last) > 0) || Date.now() - Number(last.split('-')[0]) > REPLAY_MS) {
      send(c, 'event: resync\ndata: {}\n\n');
    }
  }
  c.lastId = last ?? '0-0';
  for (const [id, f] of await reader.xrange(key, last ? `(${last}` : `${Date.now() - 2000}-0`, '+', 'COUNT', 200)) {
    if (cmp(id, c.lastId) > 0) {
      c.lastId = id;
      send(c, frame(id, f[1]!));
    }
  }
  for (const [id, p] of c.pending!) {
    if (cmp(id, c.lastId) > 0) {
      c.lastId = id;
      send(c, frame(id, p));
    }
  }
  c.pending = null;
  if (c.closed) return;
  let beats = 0;
  c.timers.push(
    setInterval(() => {
      send(c, 'event: heartbeat\ndata: {}\n\n'); // no id: Last-Event-ID does not move
      if (++beats % 4 === 0) {
        void isSessionLive(actor.sessionId).then((ok) => {
          if (!ok) close(c, 'session_revoked');
        });
      }
    }, 15_000),
    setTimeout(() => close(c), 30 * 60_000), // lifetime cap: the reconnect re-runs authentication
  );
}
