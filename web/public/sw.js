/* Web Push only: CRM responses and customer data are never cached. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('push', event => {
  let payload = {};
  try { payload = event.data?.json() ?? {}; } catch { /* Still show a visible notification. */ }
  event.waitUntil(self.registration.showNotification(payload.title || 'Артель CRM', {
    body: payload.body || 'У вас новое напоминание. Откройте CRM.',
    icon: '/icons/icon-192.png', badge: '/icons/icon-192.png',
    tag: payload.tag || 'artel-reminder', data: { url: payload.url || '/#work' },
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil((async () => {
    let url = new URL('/#work', self.location.origin);
    try {
      const target = new URL(event.notification.data?.url, self.location.origin);
      if (target.origin === self.location.origin && target.pathname === '/') url = target;
    } catch { /* Fall back to the work page. */ }
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const client = windows.find(window => new URL(window.url).origin === self.location.origin);
    if (client) { await client.navigate(url.href); return client.focus(); }
    return self.clients.openWindow(url.href);
  })());
});
