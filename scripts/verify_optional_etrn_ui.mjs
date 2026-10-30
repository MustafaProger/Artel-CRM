// Synthetic snapshots, real local UI/API and loopback only. Provider requests are rejected.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, webkit, expect } from '@playwright/test';
import { SabyClient } from '../server/saby-client.ts';
import { saveShipmentTrip } from '../server/shipment-trips.ts';
import { integrationRuntime, integrationConfig } from '../tests/helpers/trip-saby-integration.ts';
import { bootstrapQaAuth, authenticateContext } from './qa-auth.mjs';
import { startTripsQaServer } from './qa-trips-runtime.mjs';

const root = resolve(import.meta.dirname, '..');
const built = process.argv.includes('--built');
const output = resolve(root, '.local/optional-etrn-ui', built ? 'built' : 'source');
await mkdir(output, { recursive: true });
const rt = await integrationRuntime();
const report = { syntheticOnly: true, workingStoreAccessed: false, providerCalls: 0, checks: [], screenshots: [], browserErrors: [], externalRequests: [], fetchFailures: [], expectedAborts: [], apiHttpErrors: [], drains: [] };
const check = name => { report.checks.push(name); console.log('PASS', name); };
const widths = [320, 390, 1440];
let runtime, browser;
async function trackApi(context, label) {
  const isApi = request => { const url = new URL(request.url()); return url.origin === runtime.base && url.pathname.startsWith('/api/'); };
  context.on('response', response => { if (isApi(response.request()) && response.status() >= 400) report.apiHttpErrors.push({ label, url: response.url(), status: response.status() }); });
  await context.addInitScript(() => {
    const fetch = window.fetch.bind(window);
    window.optionalEtrnQa = { failures: [], aborts: [] };
    window.fetch = async (input, init) => {
      const record = error => {
        const signal = init?.signal ?? (input instanceof Request ? input.signal : null);
        // Only an explicitly aborted caller signal is an expected cleanup.
        window.optionalEtrnQa[signal?.aborted ? 'aborts' : 'failures'].push({ url: input instanceof Request ? input.url : String(input), error: String(error) });
      };
      try {
        const response = await fetch(input, init);
        // StrictMode can abandon a successful response after unmount. Drain a
        // clone so networkidle observes its body; the app receives the original.
        void response.clone().arrayBuffer().catch(record);
        return response;
      } catch (error) { record(error); throw error; }
    };
  });
  return async stage => {
    for (const page of context.pages()) {
      await page.waitForLoadState('networkidle', { timeout: 15_000 });
      const events = await page.evaluate(() => { const state = window.optionalEtrnQa; return { failures: state?.failures.splice(0) ?? [], aborts: state?.aborts.splice(0) ?? [] }; });
      report.fetchFailures.push(...events.failures.map(event => ({ label, stage, ...event })));
      report.expectedAborts.push(...events.aborts.map(event => ({ label, stage, ...event })));
    }
    report.drains.push(`${label}: ${stage}`);
  };
}
try {
  const client = new SabyClient(integrationConfig(), async () => { report.providerCalls++; throw new Error('External provider forbidden in optional ETRN UI QA'); });
  runtime = await startTripsQaServer({ root, snapshotDirectory: rt.snapshotDirectory, operationsDirectory: resolve(rt.directory, 'store'), sabyClient: client });
  if (built) runtime.server.middlewares.stack.unshift({ route: '', handle(req, res, next) {
    const path = new URL(req.url, runtime.base).pathname; if (path.startsWith('/api/')) return next();
    const relative = path === '/' ? 'index.html' : path.slice(1); if (relative.includes('..')) return next();
    readFile(resolve(root, 'app-dist', relative)).then(body => { res.setHeader('Content-Type', relative.endsWith('.js') ? 'text/javascript' : relative.endsWith('.css') ? 'text/css' : 'text/html'); res.end(body); }).catch(() => next());
  } });
  const { cookie } = await bootstrapQaAuth(runtime.base);
  const call = async (path, method = 'GET', body) => {
    const response = await fetch(runtime.base + path, { method, headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const result = await response.json(); assert.ok([200, 201].includes(response.status), `${method} ${path}: ${result.error || response.status}`); return result;
  };
  const credential = await call('/api/drivers/driver/access', 'POST', { action: 'issue', version: 0 });
  for (const [engine, launcher] of [['chromium', chromium], ['webkit', webkit]]) {
    const note = `QA optional ETRN ${engine}`;
    const created = await rt.store.mutate(rt.source, data => {
      const fields = Object.fromEntries(['organization_id', 'supplier_id', 'carrier_id', 'oil_depot_id', 'product_id', 'purchase_price_unspecified_unit', 'driver_id', 'vehicle_id', 'additional_costs'].map(key => [key, rt.trip.fields[key]]));
      Object.assign(fields, { trip_flow_version: 'driver-v1', loading_at: '2026-10-15T09:15', trip_notes: note });
      const customers = rt.trip.customers.map((row, index) => ({ fields: { ...Object.fromEntries(['customer_id', 'manager_id', 'payment_form_id', 'quantity_litres', 'sale_price_per_litre', 'transport_amount', 'unloading_address_id'].map(key => [key, row.fields[key]])), invoice_not_required: index ? 'true' : 'false', etrn_not_required: 'false' } }));
      return { result: saveShipmentTrip(rt.base, data, { fields, customers, idempotencyKey: randomUUID() }), changed: true };
    });
    const tripId = created.trip.id;
    browser = await launcher.launch({ headless: true, ...(engine === 'chromium' ? { executablePath: process.env.PLAYWRIGHT_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' } : {}) });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce', serviceWorkers: 'block', timezoneId: 'Europe/Moscow' });
    const drain = await trackApi(context, engine);
    const restrict = async scope => scope.route('**/*', route => { const url = new URL(route.request().url()); if (url.origin !== runtime.base) { report.externalRequests.push(url.href); return route.abort(); } return route.continue(); });
    await restrict(context); await authenticateContext(context, runtime.base, cookie);
    const page = await context.newPage(); page.on('pageerror', error => report.browserErrors.push(`${engine}: ${error.message}`));
    const trips = async () => { await drain('trip navigation'); await page.goto(runtime.base + '/#trips'); await page.locator('.trips-section-tabs').getByRole('button', { name: 'Рейсы', exact: true }).click(); await page.getByLabel('Поиск рейса', { exact: true }).fill(note); };
    await trips();
    const card = page.getByTestId('trip-card').filter({ hasText: note });
    await expect(card).toHaveCount(1);
    const dialog = page.getByRole('dialog');
    const open = async () => { await card.getByRole('button', { name: 'Изменить рейс', exact: true }).click(); await expect(dialog.getByTestId('trip-customer')).toHaveCount(2); };
    const row = index => dialog.getByTestId('trip-customer').nth(index);
    const etrn = index => row(index).getByRole('checkbox', { name: 'ЭТрН не нужна', exact: true });
    const invoice = index => row(index).getByRole('checkbox', { name: 'Счёт не нужен', exact: true });
    const save = async () => { await dialog.getByRole('button', { name: 'Сохранить рейс', exact: true }).click(); await expect(dialog).toHaveCount(0); await drain('saved trip read-back'); };
    const shot = async (name, locator) => { const path = resolve(output, `${engine}-${name}.png`); await locator.screenshot({ path }); report.screenshots.push(path); };
    await open();
    await expect(etrn(0)).not.toBeChecked(); await expect(etrn(1)).not.toBeChecked();
    await expect(invoice(0)).not.toBeChecked(); await expect(invoice(1)).toBeChecked();
    await etrn(0).check();
    await expect(invoice(0)).not.toBeChecked(); await expect(invoice(1)).toBeChecked(); await expect(etrn(1)).not.toBeChecked();
    await invoice(0).check(); await expect(etrn(0)).toBeChecked(); await invoice(0).uncheck();
    for (const width of widths) {
      await page.setViewportSize({ width, height: 1050 }); await etrn(0).scrollIntoViewIfNeeded();
      assert.ok(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1), `${engine}: editor overflow ${width}`);
      await expect(etrn(0)).toBeVisible(); await expect(invoice(0)).toBeVisible();
      await shot(`mixed-options-${width}`, row(0).locator('.shipment-trip-delivery-fields'));  check(`${engine}: independent checkbox labels and mixed selection fit ${width}px`);
    }
    await save();
    let persisted = (await call(`/api/shipment-trips/${tripId}`)).trip;
    assert.deepEqual(persisted.customers.map(item => item.fields.etrn_not_required), ['true', 'false']);
    assert.deepEqual(persisted.customers.map(item => item.fields.invoice_not_required), ['false', 'true']);
    await drain('middleware replacement'); runtime.replaceMiddleware(client); await trips();
    await open(); await expect(etrn(0)).toBeChecked(); await expect(etrn(1)).not.toBeChecked();
    await expect(invoice(0)).not.toBeChecked(); await expect(invoice(1)).toBeChecked();
    check(`${engine}: mixed flags saved through real API, survived middleware replacement and reopened independently`);
    await etrn(1).check(); await save();
    persisted = (await call(`/api/shipment-trips/${tripId}`)).trip;
    assert.deepEqual(persisted.customers.map(item => item.fields.etrn_not_required), ['true', 'true']);
    await open(); await expect(etrn(0)).toBeChecked(); await expect(etrn(1)).toBeChecked();
    await dialog.getByRole('button', { name: 'Закрыть редактор', exact: true }).click(); await expect(dialog).toHaveCount(0);
    const sabyButton = card.getByRole('button', { name: 'Saby', exact: true });
    if (await sabyButton.getAttribute('aria-expanded') !== 'true') await sabyButton.click();
    const panel = card.getByRole('region', { name: 'Документы рейса в Saby', exact: true });
    await expect(panel.getByRole('heading', { name: 'ЭТрН не нужна', exact: true })).toBeVisible();
    await expect(panel).toContainText('Задание водителя и факты погрузки сохраняются в CRM');
    await expect(panel.getByRole('button')).toHaveCount(0);
    assert.equal((await call(`/api/shipment-trips/${tripId}/saby-workflow`)).notRequired, true);
    for (const width of widths) {
      await page.setViewportSize({ width, height: 1050 }); await panel.scrollIntoViewIfNeeded();
      assert.ok(await panel.evaluate(node => node.scrollWidth <= node.clientWidth + 1), `${engine}: excluded status overflow ${width}`);
      await shot(`all-excluded-${width}`, panel); check(`${engine}: all-excluded status omits sending controls at ${width}px`);
    }

    const driver = await browser.newContext({ viewport: { width: 390, height: 1050 }, reducedMotion: 'reduce', serviceWorkers: 'block', timezoneId: 'Europe/Moscow' });
    const drainDriver = await trackApi(driver, `${engine} driver`);
    await restrict(driver);
    const login = await driver.request.post(runtime.base + '/api/auth/login', { data: { login: credential.access.login, password: credential.temporaryPassword } }); assert.equal(login.status(), 200);
    const driverPage = await driver.newPage(); driverPage.on('pageerror', error => report.browserErrors.push(`${engine} driver: ${error.message}`));
    await driverPage.goto(runtime.base + `/#driver-trip/${tripId}`);
    const actions = driverPage.getByRole('region', { name: 'Действия на погрузке', exact: true });
    await actions.getByRole('button', { name: 'Прибыл', exact: true }).click();
    await expect(actions.getByLabel('Масса нетто доставки 1, т', { exact: true })).toBeVisible();
    await expect(actions.getByLabel('Масса нетто доставки 2, т', { exact: true })).toBeVisible();
    await actions.getByLabel('Масса нетто доставки 1, т', { exact: true }).fill('2.5');
    await actions.getByLabel('Масса нетто доставки 2, т', { exact: true }).fill('3.25');
    await actions.getByRole('button', { name: 'Убыл', exact: true }).click();
    await expect(actions).toContainText('ЭТрН для этого рейса не нужна');
    await expect(actions).toContainText('сохранены в CRM');
    await expect(actions).not.toContainText('CRM продолжает обработку документов');
    await expect(actions.getByRole('button', { name: 'Убыл', exact: true })).toHaveCount(0);
    const driverState = (await (await driver.request.get(runtime.base + `/api/driver/trips/${tripId}`)).json()).trip;
    assert.equal(driverState.etrnRequired, false); assert.equal(driverState.archived, false);
    assert.deepEqual(driverState.deliveries.map(item => item.netTonnes), ['2.5', '3.25']);
    for (const width of widths) {
      await driverPage.setViewportSize({ width, height: 1050 }); await actions.scrollIntoViewIfNeeded();
      assert.ok(await driverPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${engine}: driver overflow ${width}`);
      await shot(`driver-local-complete-${width}`, actions); check(`${engine}: complete CRM-only driver task and both masses visible at ${width}px`);
    }
    const stored = await rt.store.read(rt.source);
    assert.equal(stored.tripSaby?.trips[tripId], undefined); assert.equal(stored.saby?.trips[tripId], undefined);
    assert.equal(Object.keys(stored.etrn.trips[tripId].deliveries).length, 0);
    await drainDriver('driver context close'); await driver.close(); await drain('employee context close'); await context.close(); await browser.close(); browser = null;
  }
  assert.equal(report.providerCalls, 0); assert.deepEqual(report.externalRequests, []); assert.deepEqual(report.browserErrors, []); assert.deepEqual(report.apiHttpErrors, []); assert.deepEqual(report.fetchFailures, []); report.passed = true;
} catch (error) { report.passed = false; report.error = error.message; throw error; }
finally { await browser?.close(); await runtime?.server.close(); await rt.close(); await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2)); }
