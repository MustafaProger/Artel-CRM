/* Web Push only: CRM responses and customer data are never cached. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('push', event => {
  let payload = {};
  try { const value = event.data?.json(); if (value && typeof value === 'object') payload = value; } catch { /* Still show a generic visible notification. */ }
  event.waitUntil((async () => {
    // A queued push may arrive after logout or a different account's login.
    // Native transport can be reused; only the currently authorized session may
    // reveal this payload's event/link or acknowledge its delivery probe.
    let authorized = false;
    if (typeof payload.displayBinding === 'string' && /^[a-f0-9]{64}$/.test(payload.displayBinding)) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5000);
      try {
        const response = await fetch(new URL('/api/push/config', self.location.origin).href, {
          credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal,
        });
        if (response.ok) authorized = (await response.json()).displayBinding === payload.displayBinding;
      } catch { /* Offline, revoked and unconfirmed sessions receive generic text. */ }
      finally { clearTimeout(timeout); }
    }
    await self.registration.showNotification(authorized ? payload.title || 'Артэль CRM' : 'Артэль CRM', {
      body: authorized ? payload.body || 'У вас новое напоминание. Откройте CRM.' : 'Новое уведомление. Войдите в CRM, чтобы проверить актуальные данные.',
      icon: '/icons/icon-192.png?v=20260911', badge: '/icons/icon-192.png?v=20260911',
      tag: authorized ? payload.tag || 'artel-reminder' : 'artel-reminder', data: { url: authorized ? payload.url || '/#work' : '/#work' },
    });
    if (!authorized) return;
    if (typeof payload.url === 'string' && payload.url.startsWith('/#driver-trip/')) {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windows) client.postMessage({ type: 'artel-driver-trip-assigned' });
    }
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
      if (target.origin === self.location.origin && (target.pathname === '/' || target.pathname === '/invoices/' && target.hash === '#invoices')) url = target;
    } catch { /* Fall back to the work page. */ }
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const client = windows.find(window => {
      const current = new URL(window.url);
      return current.origin === self.location.origin && (url.hash !== '#invoices' || current.pathname === '/' || /^\/invoices(?:\/|$)/.test(current.pathname));
    });
    if (client) {
      if (url.hash === '#invoices') {
        client.postMessage({ type: 'artel-open-invoices', jobId: url.searchParams.get('invoiceJob') });
        return client.focus();
      }
      await client.navigate(url.href); return client.focus();
    }
    return self.clients.openWindow(url.href);
  })());
});
