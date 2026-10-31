// Server-Sent Events hub: per-user, per-vehicle, and global channels.

import type { Response } from 'express';

export type SseEvent = {
  channel: string;
  type: string;
  data: unknown;
  at: string;
};

interface Client {
  res: Response;
  userId: string;
}

const clients = new Set<Client>();
let heartbeat: NodeJS.Timeout | null = null;

export function sseStart(): void {
  if (heartbeat) return;
  heartbeat = setInterval(() => {
    const ping = `: ping ${Date.now()}\n\n`;
    for (const c of clients) {
      try {
        c.res.write(ping);
      } catch {
        clients.delete(c);
      }
    }
  }, 25000);
  heartbeat.unref();
}

export function sseStop(): void {
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = null;
  for (const c of clients) {
    try {
      c.res.end();
    } catch {
      /* ignore */
    }
  }
  clients.clear();
}

export function sseAddClient(userId: string, res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  res.write('retry: 3000\n\n');
  const client: Client = { res, userId };
  clients.add(client);
  res.on('close', () => clients.delete(client));
}

/** Publish to everyone, a single user, or a vehicle channel. */
export function ssePublish(event: {
  type: string;
  data: unknown;
  userId?: string;
  vehicleId?: string;
}): void {
  const at = new Date().toISOString();
  const frame = `event: ${event.type}\ndata: ${JSON.stringify({ ...(event.data as object), at })}\n\n`;
  for (const c of clients) {
    if (event.userId && c.userId !== event.userId) continue;
    if (event.vehicleId) {
      // vehicle channels are scoped by user; only this user's stream gets it
      // when userId filter present. Broadcast vehicle events to all clients of
      // users that own/see the vehicle — handled by the caller passing userId
      // or omitting it for public channels.
    }
    try {
      c.res.write(frame);
    } catch {
      clients.delete(c);
    }
  }
}

export function sseCount(): number {
  return clients.size;
}

/** End every SSE stream of a user (A-SSEREVOKE: sessions revoked or account
 * deletion requested). */
export function sseRevokeUser(userId: string): void {
  for (const c of clients) {
    if (c.userId !== userId) continue;
    try {
      c.res.end();
    } catch {
      /* ignore */
    }
    clients.delete(c);
  }
}
