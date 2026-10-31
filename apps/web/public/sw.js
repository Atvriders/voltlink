/* VoltLink service worker: push display and click routing only (no caching). */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('push', (event) => {
  let d = {};
  try {
    d = event.data ? event.data.json() : {};
  } catch {
    d = { body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(self.registration.showNotification(typeof d.title === 'string' && d.title ? d.title : 'VoltLink', {
    body: typeof d.body === 'string' ? d.body : '',
    tag: typeof d.tag === 'string' ? d.tag : undefined,
    icon: '/icons/icon-192.png',
    data: { url: typeof d.url === 'string' ? d.url : '/' },
    requireInteraction: d.severity === 'critical',
  })); // always show: subscriptions are userVisibleOnly
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/', self.location.origin);
  if (target.origin !== self.location.origin) return; // never open foreign URLs from a payload
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find((w) => new URL(w.url).origin === target.origin);
    if (win) {
      await win.focus();
      win.postMessage({ type: 'voltlink:navigate', path: target.pathname + target.search });
      return;
    }
    await self.clients.openWindow(target.href);
  })());
});
