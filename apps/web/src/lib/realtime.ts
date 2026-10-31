// Real-time SSE client (F-SIGNOUT): a singleton so sign-out can stop the stream
// before the query cache is cleared, preventing a late event from repopulating
// another user's data.

export type RealtimeEvents = {
  vehicle_state?: () => void;
  notification?: () => void;
  command_finished?: () => void;
};

let es: EventSource | null = null;
let closed = false;
let listeners: RealtimeEvents = {};
let startRequested = false;

export function realtimeStart(events: RealtimeEvents): void {
  listeners = events;
  startRequested = true;
  if (es) return;
  closed = false;
  connect();
}

function connect(): void {
  if (closed || !startRequested) return;
  es = new EventSource('/api/v1/realtime');
  es.addEventListener('vehicle_state', () => listeners.vehicle_state?.());
  es.addEventListener('notification', () => listeners.notification?.());
  es.addEventListener('command_finished', () => listeners.command_finished?.());
  es.onerror = () => {
    es?.close();
    es = null;
    if (!closed) setTimeout(connect, 5000);
  };
}

export function realtimeStop(): void {
  closed = true;
  startRequested = false;
  listeners = {};
  es?.close();
  es = null;
}
