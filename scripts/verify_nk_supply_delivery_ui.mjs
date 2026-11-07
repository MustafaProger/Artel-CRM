// Built candidate UI + real candidate API on synthetic data. No production/provider access.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { chromium, webkit, expect } from '@playwright/test';
import { createSnapshotMiddleware } from '../server/local-api.ts';
import { SabyClient } from '../server/saby-client.ts';
import { integrationRuntime, integrationConfig } from '../tests/helpers/trip-saby-integration.ts';
import { bootstrapQaAuth, authenticateContext } from './qa-auth.mjs';

const root = resolve(import.meta.dirname, '..');
const output = process.env.ARTEL_QA_OUTPUT;
if (!output || !output.startsWith('/')) throw new Error('ARTEL_QA_OUTPUT must be an absolute private output directory');
await mkdir(output, { recursive: true });
const rt = await integrationRuntime();
const report = { syntheticOnly: true, builtUi: true, realCandidateApi: true, bundledBackendBrowser: false, workingStoreAccessed: false, providerCalls: 0, checks: [], screenshots: [], browserErrors: [], externalRequests: [], apiHttpErrors: [] };
const check = name => { report.checks.push(name); console.log('PASS', name); };
const denied = async () => { report.providerCalls++; throw new Error('External provider forbidden in synthetic NK UI QA'); };
const client = new SabyClient(integrationConfig(), denied);
const api = () => createSnapshotMiddleware(rt.snapshotDirectory, {
  operationsDirectory: resolve(rt.directory, 'store'), sabyClient: client, checkoApiKey: '', setupToken: '',
  tripRequestGeocoder: async () => ({ status: 'unavailable', message: 'Синтетический геокодер отключён.' }),
  bankEnvironment: { ARTEL_BANK_SYNC_ENABLED: 'false', ARTEL_BANK_REQUESTS_ENABLED: 'false' },
  bankRequest: denied, sberRequest: denied, fetcher: denied,
  pushConfig: { publicKey: '', privateKey: '', subject: '', schedule: false }, pushSender: denied,
});
let middleware = api(), browser;
const staticRoot = resolve(root, 'app-dist');
const server = createServer((request, response) => middleware(request, response, () => {
  const path = new URL(request.url, 'http://localhost').pathname;
  const file = resolve(staticRoot, path === '/' ? 'index.html' : `.${decodeURIComponent(path)}`);
  if (!file.startsWith(staticRoot + sep)) { response.writeHead(404).end(); return; }
  void readFile(file).then(bytes => {
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
    response.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' }); response.end(bytes);
  }).catch(() => response.writeHead(404).end());
}));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
try {
  const { cookie } = await bootstrapQaAuth(base);
  const call = async (path, method = 'GET', body) => {
    const response = await fetch(base + path, { method, headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const result = await response.json(); assert.ok([200, 201].includes(response.status), `${method} ${path}: ${result.error || response.status}`); return result;
  };
  await rt.store.mutate(rt.source, data => {
    const customer = data.companies.find(row => row.id === 'customer');
    data.companies.push({ ...customer, id: 'customer-two', name: 'Второй синтетический клиент', inn: '7736050003', kpp: '773601001' });
    const delivery = data.directories.addresses.find(row => row.id === 'delivery');
    data.directories.addresses.push({ ...delivery, id: 'delivery-two', companyId: 'customer-two', address: 'Вторая синтетическая доставка' });
    return { result: null, changed: true };
  });
  const credential = await call('/api/drivers/driver/access', 'POST', { action: 'issue', version: 0 });
  for (const [engine, launcher] of [['chromium', chromium], ['webkit', webkit]]) {
    const note = `QA NK supply ${engine}`;
    const fields = Object.fromEntries(['supplier_id', 'carrier_id', 'oil_depot_id', 'product_id', 'purchase_price_unspecified_unit', 'driver_id', 'vehicle_id', 'additional_costs'].map(key => [key, rt.trip.fields[key]]));
    Object.assign(fields, { organization_id: 'nk-artel', trip_flow_version: 'driver-v1', loading_at: '2026-10-20T09:15', trip_notes: note });
    const customers = rt.trip.customers.map((row, index) => ({ fields: {
      ...Object.fromEntries(['customer_id', 'manager_id', 'payment_form_id', 'sale_price_per_litre', 'transport_amount', 'unloading_address_id'].map(key => [key, row.fields[key]])),
      customer_id: index ? 'customer-two' : 'customer', unloading_address_id: index ? 'delivery-two' : 'delivery',
      quantity_litres: index ? '9500' : '8000', invoice_not_required: index ? 'true' : 'false', etrn_not_required: 'false',
    } }));
    const created = await call('/api/shipment-trips', 'POST', { fields, customers, idempotencyKey: randomUUID() });
    const tripId = created.trip.id;
    assert.equal(created.trip.fields.trip_document_policy, 'supply-delivery-v1');
    browser = await launcher.launch({ headless: true, ...(engine === 'chromium' ? { executablePath: process.env.PLAYWRIGHT_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' } : {}) });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce', serviceWorkers: 'block', timezoneId: 'Europe/Moscow' });
    const monitor = async ctx => {
      await ctx.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin !== base) { report.externalRequests.push(url.href); return route.abort(); }
        return route.continue();
      });
      ctx.on('response', response => { if (response.url().startsWith(base + '/api/') && response.status() >= 400) report.apiHttpErrors.push({ engine, url: response.url(), status: response.status() }); });
      ctx.on('page', page => page.on('pageerror', error => report.browserErrors.push(`${engine}: ${error.message}`)));
    };
    await monitor(context); await authenticateContext(context, base, cookie);
    const page = await context.newPage();
    const trips = async () => { await page.goto(base + '/#trips'); await page.locator('.trips-section-tabs').getByRole('button', { name: 'Рейсы', exact: true }).click(); await page.getByLabel('Поиск рейса', { exact: true }).fill(note); };
    await trips();
    await page.getByRole('button', { name: 'Новый рейс', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('checkbox', { name: 'Собственный клиент НК Артэль — НК отправитель и перевозчик', exact: true }).check();
    await expect(dialog).toContainText('доставляет его по договору поставки');
    await expect(dialog).toContainText('Заявка на перевозку и ЭТрН в Saby не создаются');
    await expect(dialog).not.toContainText('До убытия водителя заявка остаётся неподписанной');
    await shotNewForm();
    async function shotNewForm() {
      const path = resolve(output, `${engine}-new-nk-form.png`); await dialog.screenshot({ path }); report.screenshots.push(path);
    }
    await dialog.getByRole('button', { name: 'Закрыть редактор', exact: true }).click();
    await dialog.getByRole('button', { name: 'Закрыть без сохранения', exact: true }).click();
    await expect(dialog).toHaveCount(0); check(`${engine}: new NK checkbox explains supply-contract delivery without creating a trip`);
    const card = page.getByTestId('trip-card').filter({ hasText: note });
    await expect(card).toHaveCount(1);
    await card.getByRole('button', { name: 'Изменить рейс', exact: true }).click();
    await expect(dialog.getByTestId('trip-customer')).toHaveCount(2);
    const own = dialog.getByRole('checkbox', { name: 'Собственный клиент НК Артэль — НК отправитель и перевозчик', exact: true });
    await expect(own).toBeChecked();
    await expect(dialog).toContainText('Сохранённая схема документов и состояние обмена показаны в блоке Saby');
    await expect(dialog).not.toContainText('До убытия водителя заявка остаётся неподписанной');
    for (const index of [0, 1]) await expect(dialog.getByTestId('trip-customer').nth(index).getByRole('checkbox', { name: 'ЭТрН не нужна', exact: true })).not.toBeChecked();
    await own.uncheck(); await expect(dialog).not.toContainText('Сохранённая схема документов и состояние обмена показаны в блоке Saby');
    await own.check();
    const shot = async (name, locator) => { const path = resolve(output, `${engine}-${name}.png`); await locator.screenshot({ path }); report.screenshots.push(path); };
    for (const width of [320, 390, 1440]) {
      await page.setViewportSize({ width, height: 1050 }); await own.scrollIntoViewIfNeeded();
      assert.ok(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1), `${engine}: editor overflow ${width}`);
      await shot(`editor-${width}`, dialog); check(`${engine}: own-NK editor and two distinct clients fit ${width}px`);
    }
    await dialog.getByRole('button', { name: 'Закрыть редактор', exact: true }).click();
    // Toggling back leaves the original draft intact.
    await expect(dialog).toHaveCount(0);
    const sabyButton = card.getByRole('button', { name: 'Saby', exact: true });
    if (await sabyButton.getAttribute('aria-expanded') !== 'true') await sabyButton.click();
    const panel = card.getByRole('region', { name: 'Документы рейса в Saby', exact: true });
    await expect(panel.getByRole('heading', { name: 'Доставка НК по договору поставки', exact: true })).toBeVisible();
    await expect(panel.getByRole('button')).toHaveCount(1);
    await expect(panel.getByRole('button', { name: 'Обновить состояние', exact: true })).toBeVisible();
    await expect(panel).not.toContainText('АРТЭЛЬ → НК АРТЭЛЬ');
    await expect(panel.locator('.workflow-steps')).toHaveCount(0);
    await panel.getByRole('button', { name: 'Обновить состояние', exact: true }).click();
    for (const width of [320, 390, 1440]) {
      await page.setViewportSize({ width, height: 1050 }); await panel.scrollIntoViewIfNeeded();
      assert.ok(await panel.evaluate(node => node.scrollWidth <= node.clientWidth + 1), `${engine}: panel overflow ${width}`);
      await shot(`documents-${width}`, panel); check(`${engine}: honest no-transport-documents status with GET refresh fits ${width}px`);
    }
    const driver = await browser.newContext({ viewport: { width: 390, height: 1050 }, reducedMotion: 'reduce', serviceWorkers: 'block', timezoneId: 'Europe/Moscow' });
    await monitor(driver);
    const login = await driver.request.post(base + '/api/auth/login', { data: { login: credential.access.login, password: credential.temporaryPassword } }); assert.equal(login.status(), 200);
    const driverPage = await driver.newPage(); await driverPage.goto(base + `/#driver-trip/${tripId}`);
    const actions = driverPage.getByRole('region', { name: 'Действия на погрузке', exact: true });
    await actions.getByRole('button', { name: 'Прибыл', exact: true }).click();
    await actions.getByLabel('Масса нетто доставки 1, т', { exact: true }).fill('6,745');
    await actions.getByLabel('Масса нетто доставки 2, т', { exact: true }).fill('7,985');
    await actions.getByRole('button', { name: 'Убыл', exact: true }).click();
    await expect(actions).toContainText('ЭТрН для этого рейса не нужна');
    await expect(actions).not.toContainText('CRM продолжает обработку документов');
    await expect(actions.getByRole('button', { name: 'Убыл', exact: true })).toHaveCount(0);
    const driverState = (await (await driver.request.get(base + `/api/driver/trips/${tripId}`)).json()).trip;
    assert.equal(driverState.etrnRequired, false); assert.equal(driverState.archived, true);
    assert.deepEqual(driverState.deliveries.map(item => item.netTonnes), ['6.745', '7.985']);
    for (const width of [320, 390, 1440]) {
      await driverPage.setViewportSize({ width, height: 1050 }); await actions.scrollIntoViewIfNeeded();
      assert.ok(await driverPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${engine}: driver overflow ${width}`);
      await shot(`driver-${width}`, actions); check(`${engine}: arrive, decimal-comma masses and local departure completion at ${width}px`);
    }
    middleware = api(); await trips();
    const afterButton = card.getByRole('button', { name: 'Saby', exact: true });
    if (await afterButton.getAttribute('aria-expanded') !== 'true') await afterButton.click();
    await expect(panel).toContainText('Данные подтверждены водителем');
    const projection = await call(`/api/shipment-trips/${tripId}/saby-workflow`);
    assert.equal(projection.documentMode, 'nk_supply_delivery'); assert.equal(projection.notRequired, true);
    assert.equal(projection.order, null); assert.equal(projection.phase, 'preparation'); assert.equal(projection.status, 'not_sent');
    assert.ok(projection.driverConfirmation.confirmedAt); assert.ok(!projection.stage6CompletedAt);
    const persisted = (await call(`/api/shipment-trips/${tripId}`)).trip;
    assert.deepEqual(persisted.customers.map(item => item.fields.etrn_not_required), ['false', 'false']);
    assert.deepEqual(persisted.customers.map(item => item.fields.invoice_not_required), ['false', 'true']);
    const stored = await rt.store.read(rt.source);
    assert.equal(stored.tripSaby?.trips[tripId], undefined); assert.equal(stored.saby?.trips[tripId], undefined);
    assert.equal(Object.keys(stored.etrn.trips[tripId].deliveries).length, 0);
    check(`${engine}: persisted facts survive API restart; flags preserved; no order, signatures or ETRN records`);
    await page.waitForLoadState('networkidle'); await driverPage.waitForLoadState('networkidle');
    await driver.close(); await context.close(); await browser.close(); browser = null;
  }
  assert.equal(report.providerCalls, 0); assert.deepEqual(report.externalRequests, []); assert.deepEqual(report.browserErrors, []); assert.deepEqual(report.apiHttpErrors, []);
  report.passed = true;
} catch (error) { report.passed = false; report.error = error.message; throw error; }
finally {
  await browser?.close(); await new Promise(resolve => server.close(resolve)); await rt.close();
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
}
