// Isolated UI acceptance: actual accepted driver actions plus synthetic exchange states.
// External providers are denied; the browser is read-only throughout.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium, webkit, expect } from '@playwright/test';
import { createSnapshotMiddleware } from '../server/local-api.ts';
import { integrationRuntime, integrationConfig, integrationSettings, integrationPrepare } from '../tests/helpers/trip-saby-integration.ts';
import { SabyClient } from '../server/saby-client.ts';
import { saveShipmentTrip } from '../server/shipment-trips.ts';
import { currentSnapshot } from '../server/shipment-operations.ts';
import { readDriverTrips, recordDriverTripAction } from '../server/driver-trips.ts';
import { enqueueAutomaticTripSaby } from '../server/trip-saby-workflow.ts';

const rt = await integrationRuntime(), root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'qa/driver-confirmation-20261008');
await mkdir(output, { recursive: true });
const report = { synthetic: true, providerCalls: 0, checks: [], errors: [], screenshots: [], browserApiRequests: [], blockedExternalRequests: [] };
const deny = async () => { report.providerCalls++; throw new Error('External provider forbidden'); };
const previousAutofill = process.env.SABY_AUTOFILL_PROFILE_JSON;
process.env.SABY_AUTOFILL_PROFILE_JSON = JSON.stringify(integrationSettings);
const config = integrationConfig();
config.automaticSigning = { id: 'synthetic-confirmation-policy', enabled: true, mode: 'deferred', approvedAt: '2026-10-01T00:00:00.000Z', sender: { ...config.customer, thumbprint: 'ab'.repeat(20) }, carrier: { ...config.carrier, thumbprint: 'cd'.repeat(20) } };
const middleware = createSnapshotMiddleware(rt.snapshotDirectory, { operationsStore: rt.store,
  sabyClient: new SabyClient(config, deny), sabyWorkflowMonitoringEnabled: false,
  bankEnvironment: { ARTEL_BANK_SYNC_ENABLED: 'false', ARTEL_BANK_REQUESTS_ENABLED: 'false' },
  bankRequest: deny, sberRequest: deny, fetcher: deny, checkoApiKey: '',
  pushConfig: { publicKey: '', privateKey: '', subject: '', schedule: false }, pushSender: deny });
let server, browser;
try {
  server = await createServer({ configFile: false, envDir: false, root: resolve(root, 'web'), cacheDir: resolve(rt.directory, 'vite'), plugins: [react(), { name: 'synthetic-api', configureServer(vite) { vite.middlewares.use(middleware); } }], server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  const base = `http://127.0.0.1:${server.httpServer.address().port}`;
  const setup = await fetch(base + '/api/auth/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Тестовый директор', login: 'confirmation.qa.owner', password: randomUUID(), managerId: 'manager' }) });
  assert.equal(setup.status, 200);
  const { user: owner } = await setup.json();
  const cookie = setup.headers.get('set-cookie').split(';')[0];
  const readApi = async path => {
    const response = await fetch(base + path, { headers: { cookie } });
    const value = await response.json(); assert.ok(response.ok, value.error || `HTTP ${response.status}`); return value;
  };
  const trip = await rt.store.mutate(rt.source, data => {
    data.directories.drivers[0].name = 'Тестовый водитель';
    const fields = Object.fromEntries(['organization_id', 'supplier_id', 'carrier_id', 'oil_depot_id', 'product_id', 'purchase_price_unspecified_unit', 'driver_id', 'vehicle_id', 'additional_costs'].map(key => [key, rt.trip.fields[key]]));
    Object.assign(fields, { trip_flow_version: 'driver-v1', loading_at: '2026-10-08T12:00', trip_notes: 'Синтетическая проверка подтверждения водителя' });
    const customers = rt.trip.customers.map(row => ({ fields: Object.fromEntries(['customer_id', 'manager_id', 'payment_form_id', 'quantity_litres', 'sale_price_per_litre', 'transport_amount', 'unloading_address_id'].map(key => [key, row.fields[key]])) }));
    const created = saveShipmentTrip(rt.base, data, { fields, customers, idempotencyKey: randomUUID() }, undefined, owner.id).trip;
    const queued = enqueueAutomaticTripSaby({ base: rt.base, data, tripId: created.id, actorId: owner.id, config, prepare: integrationPrepare });
    assert.equal(queued.enqueued, true, JSON.stringify(queued.blockers));
    const workflow = data.tripSaby.trips[created.id];
    workflow.phase = 'awaiting_driver';
    Object.assign(workflow.order, { id: 'synthetic-confirmation-order', number: '420', revision: 'synthetic-revision', status: 'draft', remoteStatus: 'Синтетический черновик', signatureStatus: 'not_signed', exchangeStage: 'sender_action_required', url: 'https://online.saby.ru/document/synthetic-confirmation-order' });
    return { result: created, changed: true };
  });
  const endpoint = `/api/shipment-trips/${encodeURIComponent(trip.id)}/saby-workflow`;
  const waiting = await readApi(endpoint);
  assert.deepEqual(waiting.driverConfirmation, { arrivedAt: null, confirmedAt: null });
  const driver = { id: 'synthetic-confirmation-driver', name: 'Тестовый водитель', login: 'synthetic.driver', role: 'driver', driverId: 'driver', active: true, version: 1, managerId: null };
  const action = async actionName => rt.store.mutate(rt.source, data => {
    const current = readDriverTrips(currentSnapshot(rt.base, data), driver, trip.id, '', data).trip;
    return recordDriverTripAction(rt.base, data, driver, trip.id, actionName, { versions: current.versions, ...(actionName === 'depart' ? { masses: current.deliveries.map((row, index) => ({ deliveryId: row.id, netTonnes: index ? '5.2' : '7' })) } : {}) });
  });
  await action('arrive');
  const arrived = await readApi(endpoint);
  assert.ok(arrived.driverConfirmation.arrivedAt);
  assert.equal(arrived.driverConfirmation.confirmedAt, null);
  await action('depart');
  const confirmed = await readApi(endpoint);
  assert.ok(confirmed.driverConfirmation.confirmedAt);
  assert.equal(confirmed.driverFlow.state, 'waiting_driver', 'Persisted workflow deliberately lags behind actual driver action');
  const clone = (value, patch) => ({ ...structuredClone(value), ...patch, monitoring: { enabled: true, intervalSeconds: 60 }, automation: { enabled: true, enrolled: true }, lastCheckedAt: '2026-10-08T05:14:00Z' });
  const cases = {
    waiting: { result: clone(waiting, {}), title: 'Черновик заявки · ожидаем водителя', step: 1, driver: false },
    arrived: { result: clone(arrived, {}), title: 'Черновик заявки · ожидаем водителя', step: 1, driver: false },
    confirmed: { result: clone(confirmed, {}), title: 'Данные водителя получены · ожидают обработки', step: 2, driver: true },
    mass: { result: clone(confirmed, { driverFlow: { state: 'mass_pending', processingAllowanceHours: 10 } }), title: 'Массы получены · дополняем заявку', step: 2, driver: true },
    sender: { result: clone(confirmed, { phase: 'awaiting_carrier', driverFlow: { state: 'ready', processingAllowanceHours: 10 }, signing: { state: 'active', mode: 'automatic', requestedAt: confirmed.driverConfirmation.confirmedAt, sender: { state: 'waiting' }, carrier: { state: 'not_started' } } }), title: 'АРТЭЛЬ · ожидаем подпись', step: 2, driver: true },
    manual: { result: { ...clone(confirmed, { phase: 'awaiting_carrier', driverFlow: { state: 'ready', processingAllowanceHours: 10 } }), automation: { enabled: false, enrolled: false } }, title: 'АРТЭЛЬ · подпись и отправка', step: 2, driver: true },
    legacy: { result: clone(confirmed, { phase: 'sending_etrn', driverFlow: undefined, driverConfirmation: null }), title: 'ЭТрН созданы · отправка клиентам', step: 6, driver: false },
    completed: { result: clone(confirmed, { phase: 'completed', driverFlow: { state: 'ready', processingAllowanceHours: 10 }, stage6CompletedAt: '2026-10-08T06:00:00Z' }), title: 'Все этапы рейса завершены', step: 7, driver: true },
  };
  const before = await rt.store.read(rt.source);
  const preview = { order: confirmed.order, previewToken: null, ready: false, blockers: [], checkedAt: '2026-10-08T05:20:00Z', sender: { organization: 'ООО «АРТЕЛЬ»', signatures: [] }, carrier: { organization: 'ООО «НК АРТЕЛЬ»', signatures: [] } };
  const originalPreview = JSON.stringify(preview);
  let activeScenario = 'waiting';
  for (const [engine, launcher] of [['chromium', chromium], ['webkit', webkit]]) {
    browser = await launcher.launch({ headless: true, ...(engine === 'chromium' ? { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' } : {}) });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    await context.addCookies([{ name: cookie.split('=')[0], value: cookie.split('=').slice(1).join('='), url: base }]);
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== base) { report.blockedExternalRequests.push({ engine, url: url.href }); return route.abort(); }
      if (url.pathname === endpoint && route.request().method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(cases[activeScenario].result) });
      if (url.pathname === `${endpoint}/signing` && route.request().method() === 'GET') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(preview) });
      return route.continue();
    });
    const page = await context.newPage();
    page.on('pageerror', error => report.errors.push(`${engine}: ${error.message}`));
    page.on('console', message => { if (message.type() === 'error') report.errors.push(`${engine}: ${message.text()}`); });
    page.on('request', request => { const path = new URL(request.url()).pathname; if (path.startsWith('/api/')) report.browserApiRequests.push({ engine, method: request.method(), path }); });
    for (const width of [1440, 1024, 900, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      activeScenario = 'waiting';
      await page.goto(base + `/?qaWidth=${width}#trips`);
      await page.getByLabel('Поиск рейса', { exact: true }).fill(`№${trip.number}`);
      await expect(page.getByTestId('trip-card')).toHaveCount(1);
      await page.getByRole('button', { name: 'Saby', exact: true }).click();
      const panel = page.getByRole('region', { name: 'Документы рейса в Saby', exact: true });
      for (const [scenario, expected] of Object.entries(cases)) {
        activeScenario = scenario;
        await panel.getByRole('button', { name: 'Обновить сохранённое состояние', exact: true }).click();
        await expect(panel.locator('.workflow-current strong')).toHaveText(expected.title);
        const steps = panel.locator('.workflow-steps > li');
        await expect(steps).toHaveCount(7);
        await expect(steps.nth(1)).toContainText('Подтверждение водителя');
        await expect(steps.nth(2)).toContainText('Отправка АРТЭЛЬ');
        await expect(steps.nth(1)).toHaveClass(expected.driver ? 'is-done' : scenario === 'legacy' ? 'is-unconfirmed' : 'is-current');
        await expect(panel.locator('.workflow-steps [aria-current="step"]')).toHaveCount(expected.step < 7 ? 1 : 0);
        if (expected.step < 7) await expect(steps.nth(expected.step)).toHaveAttribute('aria-current', 'step');
        await expect(panel.locator('.workflow-driver-confirmation')).toHaveCount(expected.driver ? 1 : 0);
        if (expected.driver) {
          await expect(panel.locator('.workflow-driver-confirmation strong')).toHaveText('Данные подтверждены водителем');
          await expect(panel.locator('.workflow-driver-confirmation time')).toHaveAttribute('datetime', confirmed.driverConfirmation.confirmedAt);
        }
        if (scenario === 'arrived') await expect(panel.locator('.workflow-current')).toContainText('зафиксировал прибытие');
        if (scenario === 'manual') {
          await panel.getByRole('button', { name: 'Проверить доступные подписи', exact: true }).click();
          await expect(panel.locator('.workflow-signing-side > strong').nth(0)).toHaveText('ООО «АРТЭЛЬ»');
          await expect(panel.locator('.workflow-signing-side > strong').nth(1)).toHaveText('ООО «НК АРТЭЛЬ»');
          assert.equal(JSON.stringify(preview), originalPreview, 'Display spelling must not mutate the raw provider fixture');
          await expect(panel.getByRole('button', { name: 'Подписать и продолжить обмен', exact: true })).toBeDisabled();
        }
        await expect(panel).not.toContainText('Проверка Saby каждую минуту');
        await expect(panel.locator('.workflow-monitor')).toContainText('Последняя успешная проверка Saby: 08.10, 08:14');
        await expect(panel.locator('.workflow-monitor')).toContainText('данные водителя и документы Saby');
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${engine} ${scenario} ${width}: document overflow`);
        assert.ok(await panel.evaluate(node => node.scrollWidth <= node.clientWidth + 1), `${engine} ${scenario} ${width}: panel overflow`);
        if (['waiting', 'confirmed', 'sender', 'legacy'].includes(scenario) && [1440, 768, 320].includes(width)) {
          const path = resolve(output, `${engine}-${scenario}-${width}.png`);
          // Full-element screenshots of tall panels can capture a fixed skip link
          // above the viewport inside the expanded crop. Verify normal visibility,
          // then take the full page from its top without altering application CSS.
          await panel.locator('.workflow-current strong').click();
          const skip = await page.locator('.skip-link').evaluate(node => ({ focused: document.activeElement === node, bottom: node.getBoundingClientRect().bottom }));
          assert.equal(skip.focused, false);
          assert.ok(skip.bottom < 0, `Unfocused skip link must stay above viewport: ${JSON.stringify(skip)}`);
          await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
          await page.screenshot({ path, fullPage: true }); report.screenshots.push(path);
        }
        report.checks.push(`${engine} ${width} ${scenario}: seven steps, precise confirmation, unchanged signature evidence, honest background read, no overflow`);
      }
    }
    for (const width of [1440, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(base + `/?branding=${width}#shipments`);
      await expect(page.getByLabel('Наша организация в отгрузках').locator('option')).toHaveText(['Все наши организации', 'НК АРТЭЛЬ', 'АРТЭЛЬ', 'Организация не указана']);
      await page.getByRole('button', { name: 'Открыть меню', exact: true }).click();
      await expect(page.getByRole('link', { name: 'Артэль — обзор', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'О приложении', exact: true }).click();
      await expect(page.getByRole('dialog', { name: 'О приложении Артэль', exact: true })).toContainText('Артэль — CRM');
      await page.getByRole('button', { name: 'Закрыть карточку', exact: true }).click();
      await page.goto(base + `/?brandingTrip=${width}#trips`);
      await page.getByRole('button', { name: 'Новый рейс', exact: true }).click();
      const editor = page.getByRole('dialog', { name: 'Новый рейс', exact: true });
      await expect(editor.getByRole('combobox', { name: /^Наша организация/ })).toHaveValue('АРТЭЛЬ');
      await expect(editor).toContainText('Собственный клиент НК Артэль');
      await editor.getByRole('checkbox', { name: /Собственный клиент НК Артэль/ }).check();
      await expect(editor.getByRole('combobox', { name: /^Наша организация/ })).toHaveValue('НК АРТЭЛЬ');
      await editor.getByRole('button', { name: 'Закрыть редактор', exact: true }).click();
      await page.goto(base + `/?brandingBank=${width}#payments`);
      await expect(page.locator('.bank-card .bank-company')).toHaveText(['НК АРТЭЛЬ', 'АРТЭЛЬ', 'НК АРТЭЛЬ']);
      report.checks.push(`${engine} ${width}: Артэль branding in app/about, own-organization selectors, trip form and three bank cards`);
    }
    await context.close(); await browser.close(); browser = null;
  }
  const after = await rt.store.read(rt.source);
  assert.deepEqual(after.tripSaby, before.tripSaby);
  assert.deepEqual(after.etrn, before.etrn);
  assert.deepEqual(after.driverTripProgress, before.driverTripProgress);
  assert.equal(report.providerCalls, 0);
  assert.ok(report.browserApiRequests.every(request => request.method === 'GET'));
  assert.deepEqual(report.errors, []);
  report.status = 'passed';
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, screenshots: report.screenshots.length, providerCalls: report.providerCalls, browserWrites: 0 }));
} catch (error) {
  report.status = 'failed'; report.failure = error instanceof Error ? error.message : String(error); throw error;
} finally {
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
  await browser?.close(); await server?.close(); await rt.close();
  if (previousAutofill === undefined) delete process.env.SABY_AUTOFILL_PROFILE_JSON;
  else process.env.SABY_AUTOFILL_PROFILE_JSON = previousAutofill;
}
