import { chromium, webkit, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import webPush from 'web-push';
const root = resolve(import.meta.dirname, '..'), output = resolve(root, 'qa/push');
await mkdir(output, { recursive: true });
const folder = await mkdtemp(resolve(tmpdir(), 'artel-push-ui-'));
const keys = webPush.generateVAPIDKeys();
const port = Number(process.env.ARTEL_PUSH_QA_PORT || 5198), origin = `http://127.0.0.1:${port}`;
const report = { checks: [], measurements: [], browserErrors: [], realPush: false };
const pass = name => { report.checks.push(name); console.log('PASS', name); };
let server, chrome, safari;
try {
  await assert.rejects(fetch(origin, { signal: AbortSignal.timeout(500) }));
  server = spawn(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), '--port', String(port), '--strictPort'], { cwd: root, stdio: 'ignore', env: { ...process.env, ARTEL_STORE_DIR: folder, VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_KEY: keys.privateKey, VAPID_SUBJECT: 'https://artel-crm.vercel.app', PUSH_SCHEDULE_ENABLED: 'true' } });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`${origin}/api/auth/session`)).ok) break; } catch {} await new Promise(done => setTimeout(done, 100)); }
  const password = randomUUID();
  const setup = await fetch(`${origin}/api/auth/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: 'push-ui-qa', name: 'QA', password }) });
  assert.equal(setup.status, 200);
  chrome = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  safari = await webkit.launch({ headless: true });
  for (const [name, browser] of [['chromium', chrome], ['webkit', safari]]) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true, locale: 'ru-RU', timezoneId: 'Europe/Moscow' });
    assert.equal((await context.request.post(`${origin}/api/auth/login`, { data: { login: 'push-ui-qa', password } })).status(), 200);
    const page = await context.newPage(); page.on('pageerror', error => report.browserErrors.push(`${name}: ${error.message}`));
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: width > 768 ? 1000 : 844 });
      await page.goto(`${origin}/#china`);
      await page.getByRole('button', { name: 'Добавить день', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await dialog.getByLabel('Дата', { exact: true }).fill('2026-09-10');
      const size = await dialog.evaluate(element => {
        const date = element.querySelector('input[type=date]'); const numeric = element.querySelector('input[inputmode=decimal]');
        const box = date.getBoundingClientRect(), parent = date.parentElement.getBoundingClientRect();
        return { date: { width: box.width, height: box.height, right: box.right }, parent: { width: parent.width, right: parent.right }, numericHeight: numeric?.getBoundingClientRect().height, scroll: element.scrollWidth, client: element.clientWidth };
      });
      assert.ok(size.date.right <= size.parent.right + 1, `${name} ${width}: date overflow`);
      assert.ok(size.scroll <= size.client + 1, `${name} ${width}: dialog overflow`);
      assert.ok(size.date.height <= 44, `${name} ${width}: date height`);
      if (size.numericHeight) assert.equal(size.date.height, size.numericHeight);
      report.measurements.push({ browser: name, width, ...size });
      if (width === 390) await page.screenshot({ path: resolve(output, `china-${name}-390.png`) });
      await page.goto(`${origin}/#work`);
      await page.getByRole('button', { name: 'Новая задача', exact: true }).click();
      await page.getByLabel('Напоминание', { exact: true }).fill('2026-09-11T12:30');
      const workSize = await page.getByRole('dialog').evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth, dates: [...element.querySelectorAll('input[type=date], input[type=datetime-local]')].map(input => ({ width: input.getBoundingClientRect().width, height: input.getBoundingClientRect().height, parent: input.parentElement.getBoundingClientRect().width })) }));
      assert.ok(workSize.scroll <= workSize.width + 1);
      assert.ok(workSize.dates.every(date => date.width <= date.parent + 1 && date.height <= 44));
      await page.getByRole('button', { name: 'Отмена', exact: true }).click();
      await page.getByRole('button', { name: 'Не сохранять', exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await page.goto(`${origin}/#work`);
      await expect(page.getByRole('button', { name: 'Новая задача', exact: true })).toBeVisible();
      const pageSize = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: innerWidth }));
      assert.ok(pageSize.scroll <= pageSize.width + 1, `${name} ${width}: work page overflow`);
      if (width === 390) await page.screenshot({ path: resolve(output, `work-${name}-390.png`), fullPage: true });
    }
    pass(`${name}: date/datetime fields and work toolbar fit 320, 390, 768 and 1440 px`);
    await context.close();
  }
  const context = await chrome.newContext({ viewport: { width: 1280, height: 900 }, permissions: ['notifications'], timezoneId: 'Europe/Moscow' });
  assert.equal((await context.request.post(`${origin}/api/auth/login`, { data: { login: 'push-ui-qa', password } })).status(), 200);
  const page = await context.newPage();
  await page.goto(`${origin}/#work`);
  await page.getByRole('button', { name: 'Включить уведомления', exact: true }).click();
  try {
    await expect(page.getByRole('button', { name: 'Проверить уведомление', exact: true })).toBeVisible({ timeout: 15000 });
    await page.getByRole('button', { name: 'Проверить уведомление', exact: true }).click();
    await expect(page.getByText('Проверка отправлена. Проверьте уведомления устройства.')).toBeVisible({ timeout: 10000 });
    report.realPush = true; pass('Real browser push subscription and provider accepted test message');
  } catch {
    report.realPushError = await page.locator('.work-push-settings').innerText();
    console.log('INFO Real browser push unavailable in this automated browser; testing subscription UI with a simulated PushManager.');
  }
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
  await page.close();
  const notification = await worker.evaluate(async () => {
    self.dispatchEvent(new PushEvent('push', { data: JSON.stringify({ title: 'Артель CRM QA', body: 'Проверка service worker', tag: 'qa-worker', url: '/#work' }) }));
    for (let i = 0; i < 50; i++) {
      const notifications = await self.registration.getNotifications({ tag: 'qa-worker' });
      if (notifications.length) { const result = { title: notifications[0].title, body: notifications[0].body }; notifications[0].close(); return result; }
      await new Promise(done => setTimeout(done, 100));
    }
    return null;
  });
  assert.equal(notification?.title, 'Артель CRM QA');
  pass('Actual service worker shows notification after the CRM tab closes (synthetic PushEvent)');
  await context.close();
  // Deterministic UI contract test, independent of browser-provider availability.
  const fakeContext = await chrome.newContext({ permissions: ['notifications'] });
  const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
  const fake = { endpoint: 'https://fcm.googleapis.com/fcm/send/qa-ui-simulation', keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
  await fakeContext.addInitScript(({ fake, publicKey }) => {
    let active = false;
    const sub = { ...fake, options: { applicationServerKey: Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)).buffer }, toJSON: () => fake, unsubscribe: async () => { active = false; return true; } };
    PushManager.prototype.getSubscription = async () => active ? sub : null;
    PushManager.prototype.subscribe = async () => { active = true; return sub; };
  }, { fake, publicKey: keys.publicKey });
  await fakeContext.request.post(`${origin}/api/auth/login`, { data: { login: 'push-ui-qa', password } });
  const fakePage = await fakeContext.newPage();
  await fakePage.goto(`${origin}/#work`);
  await fakePage.getByRole('button', { name: 'Включить уведомления', exact: true }).click();
  await expect(fakePage.getByRole('button', { name: 'Проверить уведомление', exact: true })).toBeVisible();
  await fakePage.route('**/api/push/test', route => route.fulfill({ json: { ok: true } }));
  await fakePage.getByRole('button', { name: 'Проверить уведомление', exact: true }).click();
  await expect(fakePage.getByText('Проверка отправлена. Проверьте уведомления устройства.')).toBeVisible();
  await fakePage.getByRole('button', { name: 'Выключить', exact: true }).click();
  await expect(fakePage.getByRole('button', { name: 'Включить уведомления', exact: true })).toBeVisible();
  pass('Enable, test and disable UI with real subscription API and simulated browser push transport');
  const taskResponse = await fakeContext.request.post(`${origin}/api/work/tasks`, { data: { title: 'Открыть из уведомления', reminderAt: null } });
  const task = (await taskResponse.json()).entry;
  await fakePage.goto(`${origin}/?workKind=tasks&workId=${task.id}#work`);
  await expect(fakePage.getByRole('dialog').getByLabel('Название', { exact: true })).toHaveValue('Открыть из уведомления');
  pass('Notification deep link opens the exact task');
  await fakeContext.close();
  assert.deepEqual(report.browserErrors, []);
} finally {
  await chrome?.close(); await safari?.close();
  if (server) { server.kill('SIGTERM'); await new Promise(done => server.once('exit', done)); }
  await rm(folder, { recursive: true, force: true });
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
}
