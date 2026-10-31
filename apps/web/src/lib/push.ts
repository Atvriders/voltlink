// Web Push wiring (N-PUSH, guide 03 §7). prepare() runs on page mount;
// enable() is called ONLY from the subscribe button's click handler so the
// permission prompt stays tied to a user gesture.

import { api } from '../api/client';

const b64uToBytes = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

export type PushSupport = 'supported' | 'needs-home-screen' | 'insecure-context' | 'unsupported';

export function pushSupport(): PushSupport {
  if (!window.isSecureContext) return 'insecure-context'; // plain-http LAN installs cannot use push
  const ok = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const ios =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone =
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as { standalone?: boolean }).standalone === true;
  return ok ? 'supported' : ios && !standalone ? 'needs-home-screen' : 'unsupported';
}

let cfg: { enabled: boolean; publicKey: string; keyId: string } | null = null;
let reg: ServiceWorkerRegistration | null = null;

export async function prepare(): Promise<void> {
  cfg = await api<{ enabled: boolean; publicKey: string; keyId: string }>(
    '/api/v1/notifications/push/config',
  );
  if ('serviceWorker' in navigator && window.isSecureContext) {
    reg = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  }
}

export async function unsubscribePush(): Promise<void> {
  // Called on sign-out: drop this browser's subscription so a shared device
  // stops receiving the previous user's alerts.
  try {
    const sub =
      reg ??
      ('serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : null);
    const existing = await sub?.pushManager.getSubscription();
    if (existing) {
      await api('/api/v1/notifications/push/subscriptions', {
        method: 'DELETE',
        body: { endpoint: existing.endpoint },
      });
    }
  } catch {
    /* best-effort */
  }
}

export async function enable(): Promise<void> {
  // Keep awaits minimal before the permission prompt (gesture requirement).
  if (!cfg?.enabled || !reg) throw new Error('Push is not configured on this server.');
  if ((await Notification.requestPermission()) !== 'granted')
    throw new Error('Notifications are blocked for this site.');
  let sub = await reg.pushManager.getSubscription();
  const current = sub?.options.applicationServerKey
    ? new Uint8Array(sub.options.applicationServerKey)
    : null;
  if (sub && (!current || current.toString() !== b64uToBytes(cfg.publicKey).toString())) {
    await sub.unsubscribe(); // VAPID key rotated (RFC 8292): resubscribe
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: b64uToBytes(cfg.publicKey),
  });
  await api('/api/v1/notifications/push/subscriptions', {
    method: 'PUT',
    body: { subscription: sub.toJSON(), keyId: cfg.keyId },
  });
}
