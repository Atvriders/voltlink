// SSE facade (guide 04 §5): publishes go to the cross-process Redis bus; the
// hub in realtime/hub.ts holds the browser sockets in the web role. Publishing
// is fire-and-forget — Redis being down must never take a request down.

import { publishToUsers, publishSessionRevocation } from '../realtime/bus';
import { startHub, stopHub } from '../realtime/hub';

export type SseEvent = {
  channel: string;
  type: string;
  data: unknown;
  at: string;
};

export function sseStart(): void {
  void startHub().catch((err) => console.error('[voltlink] realtime hub failed to start:', err));
}

export function sseStop(): void {
  stopHub();
}

export function sseCount(): number {
  // Admin diagnostics: local sockets only (hub-held).
  return 0;
}

export function sseAddClient(_userId: string, _res: unknown): void {
  // Replaced by realtime/hub.ts sseHandler (kept for compatibility).
}

/** Publish to a single user (audience must be resolved by the caller). */
export function ssePublish(event: { userId?: string; type: string; data: unknown }): void {
  if (!event.userId) return;
  // Redis may be absent (tests, cold boot): publishing must never throw.
  try {
    void publishToUsers([event.userId], { type: event.type, data: event.data });
  } catch {
    /* bus unavailable — events are best-effort */
  }
}

/** End every SSE stream of a user (A-SSEREVOKE). */
export function sseRevokeUser(userId: string): void {
  void publishSessionRevocation({ userId, allExcept: null });
}
