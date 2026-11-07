// Synthetic acceptance for saved loading facts and honest Saby workflow messages.
// All fixtures live in an isolated OperationsStore; external providers are denied.
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
const output = resolve(root, 'qa/saby-allowance-20261008');
await mkdir(output, { recursive: true });
const report = { synthetic: true, providerCalls: 0, checks: [], errors: [], screenshots: [], browserApiRequests: [], blockedExternalRequests: [] };
const deny = async () => { report.providerCalls++; throw new Error('External provider forbidden'); };
const previousAutofill = process.env.SABY_AUTOFILL_PROFILE_JSON;
process.env.SABY_AUTOFILL_PROFILE_JSON = JSON.stringify(integrationSettings);
const config = integrationConfig();
config.automaticSigning = { id: 'synthetic-allowance-policy', enabled: true, mode: 'deferred', approvedAt: '2026-10-01T00:00:00.000Z', sender: { ...config.customer, thumbprint: 'ab'.repeat(20) }, carrier: { ...config.carrier, thumbprint: 'cd'.repeat(20) } };
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
  const setup = await fetch(base + '/api/auth/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Тестовый директор', login: 'allowance.qa.owner', password: randomUUID(), managerId: 'manager' }) });
  assert.equal(setup.status, 200);
  const { user: owner } = await setup.json();
  const cookie = setup.headers.get('set-cookie').split(';')[0];
  const readApi = async path => {
    const response = await fetch(base + path, { headers: { cookie } });
    const value = await response.json(); assert.ok(response.ok, value.error || `HTTP ${response.status}`); return value;
  };
  const fixtures = await rt.store.mutate(rt.source, data => {
    data.directories.drivers[0].name = 'Тестовый водитель';
    data.directories.products.push({ ...data.directories.products[0], id: 'blocked-product', name: 'Тестовый товар без реквизита', documentName: '' });
    const created = {};
    for (const scenario of ['facts', 'facts-blocked', 'no-facts', 'known']) {
      const fields = Object.fromEntries(['organization_id', 'supplier_id', 'carrier_id', 'oil_depot_id', 'product_id', 'purchase_price_unspecified_unit', 'driver_id', 'vehicle_id', 'additional_costs'].map(key => [key, rt.trip.fields[key]]));
      Object.assign(fields, { trip_flow_version: 'driver-v1', loading_at: '2026-10-08T12:00', trip_notes: `Синтетическая проверка: ${scenario}` });
      if (scenario === 'facts-blocked') fields.product_id = 'blocked-product';
      const customers = rt.trip.customers.map(row => ({ fields: Object.fromEntries(['customer_id', 'manager_id', 'payment_form_id', 'quantity_litres', 'sale_price_per_litre', 'transport_amount', 'unloading_address_id'].map(key => [key, row.fields[key]])) }));
      created[scenario] = saveShipmentTrip(rt.base, data, { fields, customers, idempotencyKey: randomUUID() }, undefined, owner.id).trip;
    }
    for (const tripId of [rt.tripId, created.known.id]) {
      const queued = enqueueAutomaticTripSaby({ base: rt.base, data, tripId, actorId: owner.id, config, prepare: integrationPrepare });
      assert.equal(queued.enqueued, true, JSON.stringify(queued.blockers));
    }
    const known = data.tripSaby.trips[created.known.id];
    known.phase = 'awaiting_driver';
    Object.assign(known.order, { id: 'synthetic-known-order', number: '419', revision: 'synthetic-revision', status: 'draft', remoteStatus: 'Синтетический черновик', signatureStatus: 'not_signed', exchangeStage: 'sender_action_required', url: 'https://online.saby.ru/document/synthetic-known-order' });
    return { result: { ...created, queued: rt.trip }, changed: true };
  });
  const driver = { id: 'synthetic-allowance-driver', name: 'Тестовый водитель', login: 'synthetic.driver', role: 'driver', driverId: 'driver', active: true, version: 1, managerId: null };
  for (const scenario of ['facts', 'facts-blocked']) {
    for (const action of ['arrive', 'depart']) {
      await rt.store.mutate(rt.source, data => {
        const trip = readDriverTrips(currentSnapshot(rt.base, data), driver, fixtures[scenario].id, '', data).trip;
        return recordDriverTripAction(rt.base, data, driver, trip.id, action, { versions: trip.versions, ...(action === 'depart' ? { masses: trip.deliveries.map((row, index) => ({ deliveryId: row.id, netTonnes: index ? '5.2' : '7' })) } : {}) });
      });
    }
  }
  const before = await rt.store.read(rt.source);
  for (const scenario of ['facts', 'facts-blocked']) {
    assert.ok(before.etrn.trips[fixtures[scenario].id].loadingFacts);
    assert.equal(before.tripSaby.trips[fixtures[scenario].id], undefined);
  }
  const responses = {};
  for (const [scenario, trip] of Object.entries(fixtures)) responses[scenario] = await readApi(`/api/shipment-trips/${encodeURIComponent(trip.id)}/saby-workflow`);
  assert.equal(responses.facts.phase, 'preparation');
  assert.equal(responses.facts.order, null);
  assert.equal(responses.facts.automation.enrolled, false);
  assert.equal(responses.facts.ready, true, JSON.stringify(responses.facts.blockers));
  assert.equal(responses['no-facts'].loadingFacts, null);
  assert.equal(responses['no-facts'].ready, true, JSON.stringify(responses['no-facts'].blockers));
  assert.ok(responses['facts-blocked'].blockers.length);
  assert.equal(responses.queued.automation.enrolled, true);
  assert.equal(responses.known.order.id, 'synthetic-known-order');
  const expectedHeadings = {
    facts: 'Факты погрузки сохранены · нужна сверка Saby',
    'facts-blocked': 'Факты погрузки сохранены · нужна сверка Saby',
    'no-facts': 'Автоматический обмен не запущен',
    queued: 'Автоматическая отправка в очереди',
    known: 'Черновик заявки · ожидаем водителя',
  };
  for (const [engine, launcher] of [['chromium', chromium], ['webkit', webkit]]) {
    browser = await launcher.launch({ headless: true, ...(engine === 'chromium' ? { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' } : {}) });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    await context.addCookies([{ name: cookie.split('=')[0], value: cookie.split('=').slice(1).join('='), url: base }]);
    await context.route('**/*', route => {
      if (new URL(route.request().url()).origin === base) return route.continue();
      report.blockedExternalRequests.push({ engine, url: route.request().url() }); return route.abort();
    });
    const page = await context.newPage();
    page.on('pageerror', error => report.errors.push(`${engine}: ${error.message}`));
    page.on('console', message => { if (message.type() === 'error') report.errors.push(`${engine}: ${message.text()}`); });
    page.on('request', request => {
      const path = new URL(request.url()).pathname;
      if (path.startsWith('/api/')) report.browserApiRequests.push({ engine, method: request.method(), path });
    });
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const scenario of ['facts', 'facts-blocked', 'no-facts', 'queued', 'known']) {
        await page.goto(base + '/#trips');
        await page.getByLabel('Поиск рейса', { exact: true }).fill('');
        await expect(page.getByTestId('trip-card')).toHaveCount(5);
        await page.getByLabel('Поиск рейса', { exact: true }).fill(`№${fixtures[scenario].number}`);
        await expect(page.getByTestId('trip-card')).toHaveCount(1);
        await page.getByRole('button', { name: 'Saby', exact: true }).click();
        const panel = page.getByRole('region', { name: 'Документы рейса в Saby', exact: true });
        await expect(panel.locator('.workflow-current strong')).toHaveText(expectedHeadings[scenario]);
        await expect(panel).not.toContainText('Согласованный срок обработки документов');
        await expect(panel).not.toContainText('Исправления документов выполняются в Saby');
        await expect(panel).not.toContainText('10 часов');
        if (scenario.startsWith('facts')) {
          await expect(panel.getByText('Подтверждение водителя и факты погрузки сохранены в CRM.', { exact: true })).toBeVisible();
          await expect(panel).not.toContainText('При сохранении рейса заявка отправится');
          await expect(panel.getByRole('button', { name: 'Создать заявку в Saby', exact: true })).toHaveCount(0);
          for (const blocker of responses[scenario].blockers) await expect(panel.locator('.trip-saby-blockers')).toContainText(blocker);
          const path = `/api/shipment-trips/${encodeURIComponent(fixtures[scenario].id)}/saby-workflow`;
          const beforeRefresh = report.browserApiRequests.length;
          const refreshed = page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'GET');
          await panel.getByRole('button', { name: 'Обновить сохранённое состояние', exact: true }).click();
          assert.equal((await refreshed).status(), 200);
          const calls = report.browserApiRequests.slice(beforeRefresh).filter(request => request.path.startsWith(`/api/shipment-trips/${encodeURIComponent(fixtures[scenario].id)}/`));
          assert.ok(calls.some(request => request.path === path && request.method === 'GET'));
          assert.ok(calls.every(request => request.method === 'GET'));
        } else {
          await expect(panel.locator('.workflow-current')).not.toContainText('нужна сверка Saby');
          if (scenario === 'known') await expect(panel.getByRole('link', { name: 'Открыть заявку в Saby', exact: true })).toHaveAttribute('href', 'https://online.saby.ru/document/synthetic-known-order');
        }
        await panel.locator('.workflow-current').scrollIntoViewIfNeeded();
        const path = resolve(output, `${engine}-${scenario}-${width}.png`);
        await page.screenshot({ path }); report.screenshots.push(path);
        const panelLayout = await panel.evaluate(node => ({ width: node.clientWidth, scrollWidth: node.scrollWidth, overflow: [...node.querySelectorAll('*')].filter(child => child.getBoundingClientRect().right > node.getBoundingClientRect().right + 1).map(child => ({ tag: child.tagName, className: child.className, text: child.textContent?.slice(0, 100), width: child.clientWidth, scrollWidth: child.scrollWidth })) }));
        if (panelLayout.scrollWidth > panelLayout.width + 1) report.panelOverflow = { engine, scenario, width, ...panelLayout };
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${engine} ${scenario} ${width}: document overflow`);
        assert.ok(panelLayout.scrollWidth <= panelLayout.width + 1, `${engine} ${scenario} ${width}: panel overflow`);
        report.checks.push(`${engine} ${width} ${scenario}: expected status, honest facts, preserved blockers, GET refresh and no overflow`);
      }
    }
    await context.close(); await browser.close(); browser = null;
  }
  const after = await rt.store.read(rt.source);
  assert.deepEqual(after.tripSaby, before.tripSaby, 'Browser acceptance must not mutate workflow records');
  assert.deepEqual(after.etrn, before.etrn, 'Browser acceptance must not mutate facts or documents');
  assert.deepEqual(after.driverTripProgress, before.driverTripProgress, 'Browser acceptance must not mutate driver events');
  assert.equal(report.providerCalls, 0);
  assert.ok(report.browserApiRequests.every(request => request.method === 'GET'), 'Browser acceptance must remain read-only');
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
