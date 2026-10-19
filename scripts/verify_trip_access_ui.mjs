// Isolated browser/API acceptance for trip identity and account controls.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium, webkit, expect } from '@playwright/test';
import { createSnapshotMiddleware } from '../server/local-api.ts';
import { integrationRuntime, integrationConfig } from '../tests/helpers/trip-saby-integration.ts';
import { SabyClient } from '../server/saby-client.ts';
import { saveShipmentTrip } from '../server/shipment-trips.ts';

const rt = await integrationRuntime(), root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'qa/trip-access-20261008');
await mkdir(output, { recursive: true });
const report = { synthetic: true, providerCalls: 0, checks: [], errors: [], screenshots: [] };
const deny = async () => { report.providerCalls++; throw new Error('External provider forbidden'); };
const middleware = createSnapshotMiddleware(rt.snapshotDirectory, { operationsStore: rt.store,
  sabyClient: new SabyClient(integrationConfig(), deny), sabyWorkflowMonitoringEnabled: false,
  bankEnvironment: { ARTEL_BANK_SYNC_ENABLED: 'false', ARTEL_BANK_REQUESTS_ENABLED: 'false' },
  bankRequest: deny, sberRequest: deny, fetcher: deny, checkoApiKey: '',
  pushConfig: { publicKey: '', privateKey: '', subject: '', schedule: false }, pushSender: deny });
let server, browser;
try {
  await rt.store.mutate(rt.source, data => {
    data.directories.drivers[0].name = 'Тестовый водитель';
    const fields = Object.fromEntries(['organization_id', 'date', 'supplier_id', 'carrier_id', 'oil_depot_id', 'product_id', 'purchase_price_unspecified_unit', 'quantity_tonnes', 'driver_id', 'vehicle_id', 'loading_planned_at', 'additional_costs'].map(key => [key, rt.trip.fields[key]]));
    const customers = rt.trip.customers.map(row => ({ fields: Object.fromEntries(['customer_id', 'manager_id', 'payment_form_id', 'quantity_litres', 'sale_price_per_litre', 'transport_amount', 'unloading_address_id', 'unloading_planned_at'].map(key => [key, row.fields[key]])) }));
    saveShipmentTrip(rt.base, data, { fields, customers, idempotencyKey: randomUUID() });
    return { result: null, changed: true };
  });
  server = await createServer({ configFile: false, envDir: false, root: resolve(root, 'web'), cacheDir: resolve(rt.directory, 'vite'), plugins: [react(), { name: 'synthetic-api', configureServer(vite) { vite.middlewares.use(middleware); } }], server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  const base = `http://127.0.0.1:${server.httpServer.address().port}`;
  const owner = { name: 'Тестовый директор', login: 'trip.qa.owner', password: randomUUID(), managerId: 'manager' };
  const setup = await fetch(base + '/api/auth/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(owner) });
  assert.equal(setup.status, 200);
  const cookie = setup.headers.get('set-cookie').split(';')[0];
  const call = async (path, method = 'GET', body, credential = cookie) => {
    const response = await fetch(base + path, { method, headers: { cookie: credential, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const value = await response.json(); assert.ok(response.ok, value.error || `HTTP ${response.status}`); return value;
  };
  const driver = await call('/api/drivers/driver/access', 'POST', { version: 0, action: 'issue' });
  let driverLogin = driver.access.login;
  const employee = await call('/api/directories', 'POST', { kind: 'managers', name: 'Тестовый сотрудник' });
  await call('/api/auth/users', 'POST', { name: 'Тестовый сотрудник', managerId: employee.entry.id, login: 'trip.qa.staff', password: randomUUID(), role: 'employee', active: true, sections: ['trips'] });
  for (const [engine, launcher] of [['chromium', chromium], ['webkit', webkit]]) {
    browser = await launcher.launch({ headless: true, ...(engine === 'chromium' ? { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' } : {}) });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    await context.addInitScript(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.__qaClipboard = value; } } }); const original = window.setInterval; window.__qaIntervals = []; window.setInterval = (callback, delay, ...args) => { window.__qaIntervals.push(delay); return original(callback, delay, ...args); }; });
    await context.addCookies([{ name: cookie.split('=')[0], value: cookie.split('=').slice(1).join('='), url: base }]);
    await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    const page = await context.newPage(); page.on('pageerror', error => report.errors.push(error.message));
    for (const width of [1440, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(base + '/#trips');
      await expect(page.getByTestId('trip-card')).toHaveCount(2);
      for (const number of [1,2]) await expect(page.getByRole('heading', { name: `Рейс №${number}`, exact: true })).toBeVisible();
      await page.getByLabel('Поиск рейса', { exact: true }).fill('№1');
      await expect(page.getByTestId('trip-card')).toHaveCount(1);
      await page.getByRole('button', { name: 'Изменить рейс', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Изменить рейс №1', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Отмена', exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await page.getByLabel('Поиск рейса', { exact: true }).fill('');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      const path = resolve(output, `${engine}-trips-${width}.png`); await page.screenshot({ path }); report.screenshots.push(path);
      report.checks.push(`${engine} ${width}: trip numbers, search, editor, no overflow`);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.route('**/api/shipment-trips/*/saby-workflow', async route => {
      const response = await route.fetch(), result = await response.json();
      await route.fulfill({ json: { ...result, locked: true, phase: 'awaiting_carrier', monitoring: { enabled: true, intervalSeconds: 60 } } });
    });
    await page.getByRole('button', { name: 'Saby', exact: true }).first().click();
    await expect(page.getByText('Фоновая проверка обмена', { exact: true })).toBeVisible();
    assert.ok(await page.evaluate(() => window.__qaIntervals.includes(60_000)));
    await page.unroute('**/api/shipment-trips/*/saby-workflow');
    report.checks.push(`${engine}: one-minute monitoring label and actual frontend timer`);
    await page.goto(base + '/#accounts');
    await page.locator('.account-row').filter({ has: page.locator('.account-user-title strong', { hasText: 'Тестовый сотрудник' }) }).getByRole('button', { name: 'Изменить', exact: true }).click();
    const input = page.getByLabel('Новый пароль (если нужно)', { exact: true });
    await page.getByRole('button', { name: 'Сгенерировать пароль', exact: true }).click();
    const first = await input.inputValue(); assert.match(first, /^[A-Za-z0-9_-]{24}$/); assert.equal(await input.getAttribute('type'), 'password');
    await page.getByRole('button', { name: 'Сгенерировать пароль', exact: true }).click();
    const next = await input.inputValue(); assert.notEqual(first, next);
    await page.getByRole('button', { name: 'Скопировать пароль', exact: true }).click();
    assert.equal(await page.evaluate(() => window.__qaClipboard), next);
    await page.getByRole('button', { name: 'Показать пароль', exact: true }).click(); assert.equal(await input.getAttribute('type'), 'text');
    await page.getByRole('button', { name: 'Скрыть пароль', exact: true }).click();
    for (const width of [1440, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 }); await input.scrollIntoViewIfNeeded();
      assert.ok(await page.locator('.account-form').evaluate(node => node.scrollWidth <= node.clientWidth + 1), `${engine} account form fits ${width}`);
      const path = resolve(output, `${engine}-password-${width}.png`); await page.screenshot({ path, mask: [input] }); report.screenshots.push(path);
    }
    await page.getByRole('button', { name: 'Сохранить пользователя', exact: true }).click();
    await expect(page.locator('.account-form')).toHaveCount(0);
    await call('/api/auth/login', 'POST', { login: 'trip.qa.staff', password: next });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator('.account-row').filter({ has: page.locator('.account-user-title strong', { hasText: 'Тестовый сотрудник' }) }).getByRole('button', { name: 'Изменить', exact: true }).click();
    await expect(input).toHaveValue('');
    await page.getByRole('button', { name: 'Сгенерировать пароль', exact: true }).click();
    await page.getByRole('button', { name: 'Отмена', exact: true }).click();
    await call('/api/auth/login', 'POST', { login: 'trip.qa.staff', password: next });
    await page.getByRole('button', { name: 'Добавить пользователя', exact: true }).click();
    for (const role of ['director','admin','employee','manager','logistician']) {
      await page.getByLabel('Полномочия', { exact: true }).selectOption(role);
      await expect(page.getByRole('button', { name: 'Сгенерировать пароль', exact: true })).toBeVisible();
    }
    await page.getByRole('button', { name: 'Отмена', exact: true }).click();
    report.checks.push(`${engine}: password generation, masking, visibility, clipboard handler, save/login, cancel and all staff roles`);
    await page.locator('.account-row').filter({ hasText: 'Личный кабинет водителя' }).getByRole('button', { name: 'Изменить', exact: true }).click();
    const login = page.getByLabel('Логин водителя', { exact: true });
    await expect(login).toBeEditable(); await login.fill('trip.qa.owner');
    await page.getByRole('button', { name: 'Сохранить логин', exact: true }).click();
    await expect(page.locator('.driver-access-error')).toContainText('Этот логин уже используется.'); await expect(login).toHaveValue('trip.qa.owner');
    driverLogin = `driver.${engine}`; await login.fill(driverLogin);
    await page.getByRole('button', { name: 'Сохранить логин', exact: true }).click();
    await expect(page.locator('.driver-access')).toContainText('Логин сохранён.');
    for (const width of [1440, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 }); await login.scrollIntoViewIfNeeded();
      assert.ok(await page.locator('.driver-access').evaluate(node => node.scrollWidth <= node.clientWidth + 1));
      const path = resolve(output, `${engine}-login-${width}.png`); await page.screenshot({ path }); report.screenshots.push(path);
    }
    const driverSession = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: driverLogin, password: driver.temporaryPassword }) });
    assert.equal(driverSession.status, 200);
    const driverCookie = driverSession.headers.get('set-cookie').split(';')[0];
    const driverContext = await browser.newContext({ viewport: { width: 390, height: 900 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    await driverContext.addCookies([{ name: driverCookie.split('=')[0], value: driverCookie.split('=').slice(1).join('='), url: base }]);
    await driverContext.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    const driverPage = await driverContext.newPage(); driverPage.on('pageerror', error => report.errors.push(error.message));
    for (const width of [1440, 768, 390, 320]) {
      await driverPage.setViewportSize({ width, height: 950 }); await driverPage.goto(base + '/#driver-trips');
      await driverPage.getByLabel('Поиск моих рейсов').fill('');
      await expect(driverPage.locator('.driver-trip-card')).toHaveCount(2);
      await driverPage.getByLabel('Поиск моих рейсов').fill('№2');
      await expect(driverPage.locator('.driver-trip-card')).toHaveCount(1); await expect(driverPage.locator('.driver-trip-card')).toContainText('Рейс №2');
      await driverPage.locator('.driver-trip-card').click();
      await expect(driverPage.getByRole('heading', { name: 'Рейс №2', exact: true })).toBeVisible();
      assert.ok(await driverPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      const path = resolve(output, `${engine}-driver-${width}.png`); await driverPage.screenshot({ path }); report.screenshots.push(path);
    }
    report.checks.push(`${engine}: driver login save, collision, same password, same trip identity at four widths`);
    await driverContext.close(); await context.close(); await browser.close(); browser = null;
  }
  assert.equal(report.providerCalls, 0); assert.deepEqual(report.errors, []);
  report.status = 'passed'; console.log(JSON.stringify({ status: report.status, checks: report.checks.length, screenshots: report.screenshots.length, providerCalls: 0 }));
} finally {
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
  await browser?.close(); await server?.close(); await rt.close();
}
