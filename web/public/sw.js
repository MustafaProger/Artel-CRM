/* Web Push only: CRM responses and customer data are never cached. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('push', event => {
  let payload = {};
  try { payload = event.data?.json() ?? {}; } catch { /* Still show a visible notification. */ }
  event.waitUntil((async () => {
    await self.registration.showNotification(payload.title || 'Артель CRM', {
      body: payload.body || 'У вас новое напоминание. Откройте CRM.',
      icon: '/icons/icon-192.png?v=20260911', badge: '/icons/icon-192.png?v=20260911',
      tag: payload.tag || 'artel-reminder', data: { url: payload.url || '/#work' },
    });
    // Only explicit test pushes carry a receipt capability. Confirm creation by
    // this browser, never whether a person saw or read the notification.
    const probe = payload.probe;
    if (!probe || typeof probe.id !== 'string' || !/^[\w-]{1,128}$/.test(probe.id) || typeof probe.token !== 'string' || !/^[\w-]{32,128}$/.test(probe.token)) return;
    // Retry only the receipt: three 5-second attempts with 1/2-second backoff.
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await new Promise(resolve => setTimeout(resolve, attempt * 1000));
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      try {
        const response = await fetch(new URL('/api/push/test-receipt', self.location.origin).href, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          credentials: 'omit', cache: 'no-store', redirect: 'error', signal: controller.signal,
          body: JSON.stringify({ probeId: probe.id, token: probe.token }),
        });
        if (response.ok) return;
        if (response.status !== 429 && (response.status < 500 || response.status >= 600)) return;
      } catch { /* Network failures may retry; the displayed notification remains. */ }
      finally { clearTimeout(timeout); }
    }
  })());
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
