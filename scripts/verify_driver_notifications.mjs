import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, webkit, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import webPush from 'web-push';
import { driverNotificationFixture, subscription, tripBody } from '../tests/helpers/driver-notifications.ts';

const output = resolve('qa/driver-notifications-compact-20261005'); await mkdir(output, { recursive: true });
const report = { checks: [], browserErrors: [], externalRequests: [], realProviderDelivery: false };
const pass = text => { report.checks.push(text); console.log(`PASS ${text}`); };
for (const [name, browserType] of [['chromium', chromium], ['webkit', webkit]]) {
  const sent = [], keys = webPush.generateVAPIDKeys();
  const f = await driverNotificationFixture(async (device, payload) => { sent.push({ userId: device.userId, ...JSON.parse(payload) }); }, { ...keys, subject: 'https://example.test', schedule: true });
  let server, browser;
  try {
    server = await createServer({ configFile: false, envDir: false, root: resolve('web'), cacheDir: resolve(f.directory, 'vite'), plugins: [react(), { name: 'notification-qa-api', configureServer(server) { server.middlewares.use(f.middleware); } }], server: { host: '127.0.0.1', port: 0, strictPort: false, fs: { allow: [resolve('web'), resolve('node_modules')] } } });
    await server.listen(); const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
    browser = await browserType.launch({ headless: true, ...(name === 'chromium' ? { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' } : {}) });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce' });
    await context.route('**/*', route => { if (new URL(route.request().url()).origin === origin) return route.continue(); report.externalRequests.push(route.request().url()); return route.abort(); });
    const fake = subscription();
    await context.addInitScript(({ fake, publicKey }) => {
      let active = sessionStorage.getItem('qaPushActive') === 'true';
      window.qaPermissionRequests = 0;
      const notification = { permission: active ? 'granted' : 'default', requestPermission: async () => { window.qaPermissionRequests++; notification.permission = 'granted'; return 'granted'; } };
      Object.defineProperty(window, 'Notification', { configurable: true, value: notification });
      Object.defineProperty(window, 'PushManager', { configurable: true, value: class {} });
      const sub = { ...fake, options: { applicationServerKey: Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)).buffer }, toJSON: () => fake, unsubscribe: async () => { active = false; sessionStorage.removeItem('qaPushActive'); return true; } };
      const registration = { pushManager: { getSubscription: async () => active ? sub : null, subscribe: async () => { active = true; sessionStorage.setItem('qaPushActive', 'true'); return sub; } } };
      const sw = new EventTarget(); Object.assign(sw, { register: async () => registration, ready: Promise.resolve(registration), getRegistration: async () => registration });
      Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: sw });
    }, { fake, publicKey: keys.publicKey });
    const driver = f.drivers[0];
    assert.equal((await context.request.post(origin + '/api/auth/login', { data: { login: driver.login, password: driver.password } })).status(), 200);
    const page = await context.newPage(); page.on('pageerror', error => report.browserErrors.push(error.message));
    await page.goto(origin + '/#driver-trips');
    const gear = page.locator('.driver-settings-link');
    const settings = page.locator('.personal-settings-page');
    const notifications = page.getByRole('region', { name: 'Уведомления', exact: true });
    const goToTrips = async () => {
      await page.getByRole('link', { name: 'Мои рейсы', exact: true }).click();
      await expect(page).toHaveURL(/#driver-trips$/);
      await expect(settings).not.toBeVisible();
    };
    const openNotifications = async () => {
      await gear.click();
      await expect(page).toHaveURL(/#settings$/);
      await expect(notifications).toBeVisible();
    };
    const enable = notifications.getByRole('button', { name: 'Подключить этот браузер', exact: true });
    await expect(gear).toBeVisible();
    assert.equal(await page.evaluate(() => window.qaPermissionRequests), 0);
    for (const width of [1440, 760, 390, 375, 320]) {
      await page.setViewportSize({ width, height: 585 });
      const size = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
      assert.ok(size.scroll <= size.width + 1, `${name} overflow at ${width}`);
      await expect(gear).toBeInViewport(); await expect(page.locator('.driver-search')).toBeInViewport();
      await expect(page.locator('.driver-trip-card').first()).toBeInViewport();
      await page.screenshot({ path: resolve(output, `${name}-${width}.png`) });
      await openNotifications(); await expect(enable).toBeEnabled();
      await expect(settings.getByRole('heading', { name: 'Профиль', exact: true })).toBeVisible();
      const bounds = await settings.boundingBox(); assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
      assert.deepEqual((await new AxeBuilder({ page }).include('.personal-settings-page').analyze()).violations, []);
      if (width === 375) await page.screenshot({ path: resolve(output, `${name}-settings-375.png`), fullPage: true });
      await goToTrips();
    }
    pass(`${name}: settings navigation and accessible profile and notification sections at 5 widths`);
    await openNotifications(); await enable.click();
    const testNotification = notifications.getByRole('button', { name: 'Проверить уведомление', exact: true });
    await expect(testNotification).toBeVisible();
    await expect(page).toHaveURL(/#settings$/);
    assert.equal((await f.store.read(f.source)).push.devices[0].userId, driver.userId);
    await page.reload(); await expect(testNotification).toBeVisible();
    assert.equal(await page.evaluate(() => window.qaPermissionRequests), 0);
    await goToTrips();
    pass(`${name}: browser subscription stays on settings and survives reload without prompting`);
    const created = await f.admin('/api/shipment-trips', 'POST', tripBody(f.trip)); assert.equal(created.status, 201);
    assert.equal(sent.length, 1); assert.equal(sent[0].userId, driver.userId);
    // A worker message refreshes the visible list immediately, without a manual reload.
    await page.evaluate(() => navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'artel-driver-trip-assigned' } })));
    await expect(page.locator('.driver-trip-card')).toHaveCount(2);
    await page.goto(origin + sent[0].url);
    await expect(page.locator('.driver-trip-detail')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Место погрузки', exact: true })).toBeVisible();
    await openNotifications();
    await page.getByRole('button', { name: 'Проверить уведомление', exact: true }).click();
    await expect(page.getByText('Проверка создана. Ожидаем подтверждение браузера…')).toBeVisible();
    await expect.poll(() => sent.at(-1)?.probe?.id).toBeTruthy();
    const probe = sent.at(-1).probe;
    await goToTrips();
    assert.equal((await f.request('/api/push/test-receipt', 'POST', { probeId: probe.id, token: probe.token })).status, 200);
    await expect.poll(async () => (await driver.call(`/api/push/test-status?probeId=${probe.id}`)).body.status).toBe('confirmed');
    await openNotifications();
    await expect(page.getByText('Браузер получил тестовое уведомление.')).toBeVisible();
    await page.getByRole('button', { name: 'Отключить этот браузер', exact: true }).click(); await expect(enable).toBeEnabled();
    assert.equal((await f.store.read(f.source)).push.devices.length, 0);
    pass(`${name}: real HTTP subscription, trip assignment, immediate list refresh, exact trip link, pending/confirmed receipt and unsubscribe (simulated PushManager)`);
    await page.evaluate(() => { Notification.permission = 'default'; Notification.requestPermission = async () => { Notification.permission = 'denied'; return 'denied'; }; });
    await enable.click(); await expect(page.getByText('Разрешите уведомления для CRM в настройках браузера или устройства.')).toBeVisible();
    await expect(enable).toBeDisabled(); await expect(settings).toBeVisible();
    await goToTrips();
    await expect(page.locator('.driver-trip-card')).toHaveCount(2);
    const notificationSession = await context.cookies(origin);
    await page.evaluate(() => {
      Object.defineProperty(navigator, 'userAgent', {
        configurable: true, value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile Safari/604.1',
      });
    });
    await openNotifications();
    await expect(page.getByText(/На iPhone\/iPad.*откройте меню/)).toBeVisible();
    await context.close();
    pass(`${name}: denied permission and iPhone installation guidance with an emulated user agent`);
    if (name === 'chromium') {
      const real = await browser.newContext({ permissions: ['notifications'] });
      // The notification body is bound to the session that registered the device.
      await real.addCookies(notificationSession);
      const tab = await real.newPage(); await tab.goto(origin + '/#driver-trips');
      await tab.evaluate(async () => { await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready; });
      const worker = real.serviceWorkers()[0]; assert.ok(worker);
      await tab.close();
      const shown = await worker.evaluate(async payload => {
        self.dispatchEvent(new PushEvent('push', { data: JSON.stringify(payload) }));
        for (let i = 0; i < 100; i++) {
          const notifications = await self.registration.getNotifications({ tag: payload.tag });
          if (notifications.length) { const row = notifications[0]; const result = { title: row.title, body: row.body, url: row.data.url }; row.close(); return result; }
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        return null;
      }, sent[0]);
      assert.equal(shown?.title, 'Новый рейс · Артэль'); assert.equal(shown?.url, sent[0].url);
      pass('chromium: actual service worker creates the new-trip notification with the CRM tab closed (synthetic PushEvent)');
      const probeSub = subscription();
      const device = await real.request.post(origin + '/api/push/subscription', { data: { explicit: true, subscription: probeSub } });
      assert.equal(device.status(), 200);
      const probeResult = await real.request.post(origin + '/api/push/test', { data: { endpoint: probeSub.endpoint } });
      assert.equal(probeResult.status(), 200);
      const { probeId } = await probeResult.json();
      await worker.evaluate(payload => self.dispatchEvent(new PushEvent('push', { data: JSON.stringify(payload) })), sent.at(-1));
      await expect.poll(async () => {
        const response = await real.request.get(origin + `/api/push/test-status?probeId=${probeId}`);
        return (await response.json()).status;
      }).toBe('confirmed');
      await worker.evaluate(async () => { for (const notification of await self.registration.getNotifications()) notification.close(); });
      pass('chromium: actual service worker acknowledges notification creation through the real receipt API with no CRM tab open');
      await real.close();
    }
  } finally { await browser?.close(); await server?.close(); await f.close(); }
}
assert.deepEqual(report.browserErrors, []); assert.deepEqual(report.externalRequests, []);
await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
