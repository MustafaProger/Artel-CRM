// Built candidate UI + real candidate API on synthetic data. No production/provider access.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { chromium, webkit, expect } from '@playwright/test';
import { createSnapshotMiddleware } from '../server/local-api.ts';
import { SabyClient } from '../server/saby-client.ts';
import { integrationRuntime, integrationConfig, integrationSettings } from '../tests/helpers/trip-saby-integration.ts';
import { syntheticLoadingDetails } from '../tests/helpers/loading-details-fixture.ts';
import { bootstrapQaAuth, authenticateContext } from './qa-auth.mjs';

const root = resolve(import.meta.dirname, '..');
const output = process.env.ARTEL_QA_OUTPUT;
if (!output || !output.startsWith('/')) throw new Error('ARTEL_QA_OUTPUT must be an absolute private output directory');
await mkdir(output, { recursive: true });
const rt = await integrationRuntime();
const report = { syntheticOnly: true, builtUi: true, realCandidateApi: true, bundledBackendBrowser: false, workingStoreAccessed: false, schedulerDisabled: true, providerCalls: 0, workflowPosts: [], presentationFixtures: [], checks: [], screenshots: [], browserErrors: [], externalRequests: [], apiHttpErrors: [] };
const check = name => { report.checks.push(name); console.log('PASS', name); };
const denied = async () => { report.providerCalls++; throw new Error('External provider forbidden in synthetic NK UI QA'); };
const config = integrationConfig();
config.nkConsignmentSigner = { surname: 'НКПодписантТестовый', name: 'Тест', patronymic: '', position: 'Директор' };
config.nkRegulatoryInstructions = 'Синтетические подтверждённые указания НК для проверки интерфейса.';
config.automaticSigning = { id: 'synthetic-direct-ui', enabled: true, mode: 'deferred', approvedAt: '2026-10-01T00:00:00.000Z', sender: { ...config.customer, thumbprint: 'ab'.repeat(20) }, carrier: { ...config.carrier, thumbprint: 'cd'.repeat(20) } };
const client = new SabyClient(config, denied);
const previousAutofill = process.env.SABY_AUTOFILL_PROFILE_JSON;
process.env.SABY_AUTOFILL_PROFILE_JSON = JSON.stringify(integrationSettings);
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
    const note = `QA NK direct ${engine}`;
    const fields = Object.fromEntries(['supplier_id', 'carrier_id', 'oil_depot_id', 'product_id', 'purchase_price_unspecified_unit', 'driver_id', 'vehicle_id', 'additional_costs'].map(key => [key, rt.trip.fields[key]]));
    Object.assign(fields, { organization_id: 'nk-artel', trip_flow_version: 'driver-v1', loading_at: '2026-10-20T09:15', trip_notes: note });
    const customers = rt.trip.customers.map((row, index) => ({ fields: {
      ...Object.fromEntries(['customer_id', 'manager_id', 'payment_form_id', 'sale_price_per_litre', 'transport_amount', 'unloading_address_id'].map(key => [key, row.fields[key]])),
      customer_id: index ? 'customer-two' : 'customer', unloading_address_id: index ? 'delivery-two' : 'delivery',
      quantity_litres: index ? '9500' : '8000', invoice_not_required: index ? 'true' : 'false', etrn_not_required: String(engine === 'webkit' && index === 1),
    } }));
    const created = await call('/api/shipment-trips', 'POST', { fields, customers, idempotencyKey: randomUUID() });
    const tripId = created.trip.id;
    assert.equal(created.trip.fields.trip_document_policy, 'nk-direct-autostart-v1');
    const loadingEndpoint = `/api/shipment-trips/${tripId}/etrn/loading-details`, loading = await call(loadingEndpoint);
    assert.equal(loading.details, null); assert.equal(loading.required, true); assert.equal(loading.editable, true);
    const savedLoading = await call(loadingEndpoint, 'PUT', { details: syntheticLoadingDetails(), version: loading.version });
    assert.deepEqual(savedLoading.details, syntheticLoadingDetails()); assert.equal(report.providerCalls, 0);
    browser = await launcher.launch({ headless: true, ...(engine === 'chromium' ? { executablePath: process.env.PLAYWRIGHT_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' } : {}) });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce', serviceWorkers: 'block', timezoneId: 'Europe/Moscow' });
    const monitor = async ctx => {
      await ctx.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin !== base) { report.externalRequests.push(url.href); return route.abort(); }
        if (url.pathname.includes('/saby-workflow') && route.request().method() !== 'GET') report.workflowPosts.push({ engine, method: route.request().method(), path: url.pathname });
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
    await expect(dialog).toContainText('оформляет ЭТрН напрямую как отправитель и перевозчик');
    await expect(dialog).toContainText('CRM автоматически запускает подписание и отправку');
    await expect(dialog).toContainText('ЭТрН можно отключить отдельно у каждой доставки');
    await expect(dialog).not.toContainText('ЭТрН в Saby не создаются');
    await expect(dialog).not.toContainText('До убытия водителя заявка остаётся неподписанной');
    await shotNewForm();
    async function shotNewForm() {
      const path = resolve(output, `${engine}-new-nk-form.png`); await dialog.screenshot({ path }); report.screenshots.push(path);
    }
    await dialog.getByRole('button', { name: 'Закрыть редактор', exact: true }).click();
    await dialog.getByRole('button', { name: 'Закрыть без сохранения', exact: true }).click();
    await expect(dialog).toHaveCount(0); check(`${engine}: new NK checkbox explains direct ETRN and independent delivery exclusions without creating a trip`);
    const card = page.getByTestId('trip-card').filter({ hasText: note });
    await expect(card).toHaveCount(1);
    await card.getByRole('button', { name: 'Изменить рейс', exact: true }).click();
    await expect(dialog.getByTestId('trip-customer')).toHaveCount(2);
    const own = dialog.getByRole('checkbox', { name: 'Собственный клиент НК Артэль — НК отправитель и перевозчик', exact: true });
    await expect(own).toBeChecked();
    await expect(dialog).toContainText('Сохранённая схема документов и состояние обмена показаны в блоке Saby');
    await expect(dialog).not.toContainText('До убытия водителя заявка остаётся неподписанной');
    for (const index of [0, 1]) await expect(dialog.getByTestId('trip-customer').nth(index).getByRole('checkbox', { name: 'ЭТрН не нужна', exact: true })).toBeChecked({ checked: engine === 'webkit' && index === 1 });
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
    await expect(panel.getByRole('heading', { name: 'НК АРТЭЛЬ → Клиенты', exact: true })).toBeVisible();
    await expect(panel.getByRole('button')).toHaveCount(2);
    await expect(panel.getByRole('button', { name: 'Обновить состояние', exact: true })).toBeVisible();
    const loadingForm = panel.getByRole('region', { name: 'Сведения о погрузке', exact: true });
    await expect(loadingForm.getByLabel('Фамилия', { exact: true })).toHaveValue(syntheticLoadingDetails().worker.surname);
    await expect(loadingForm.getByRole('button', { name: 'Сохранить сведения', exact: true })).toBeDisabled();
    await expect(panel).not.toContainText('АРТЭЛЬ → НК АРТЭЛЬ');
    await expect(panel).toContainText('Черновик ЭТрН: нужны сведения');
    await expect(panel.locator('.workflow-steps')).toHaveCount(0);
    await panel.getByRole('button', { name: 'Обновить состояние', exact: true }).click();
    for (const width of [320, 390, 1440]) {
      await page.setViewportSize({ width, height: 1050 }); await panel.scrollIntoViewIfNeeded();
      assert.ok(await panel.evaluate(node => node.scrollWidth <= node.clientWidth + 1), `${engine}: panel overflow ${width}`);
      await shot(`documents-${width}`, panel); check(`${engine}: direct ETRN status with individual delivery scope and GET refresh fits ${width}px`);
    }
    const beforeDeparture = (await rt.store.read(rt.source)).etrn.trips[tripId];
    assert.ok(beforeDeparture.directAutostart);
    assert.equal(beforeDeparture.direct, undefined);
    assert.equal(Object.keys(beforeDeparture.deliveries).length, 0);
    assert.deepEqual(beforeDeparture.loadingDetails, syntheticLoadingDetails());
    check(`${engine}: creation and repeated card reads preserve enrollment without authorizing documents before driver departure`);
    const driver = await browser.newContext({ viewport: { width: 390, height: 1050 }, reducedMotion: 'reduce', serviceWorkers: 'block', timezoneId: 'Europe/Moscow' });
    await monitor(driver);
    const login = await driver.request.post(base + '/api/auth/login', { data: { login: credential.access.login, password: credential.temporaryPassword } }); assert.equal(login.status(), 200);
    const driverPage = await driver.newPage(); await driverPage.goto(base + `/#driver-trip/${tripId}`);
    const actions = driverPage.getByRole('region', { name: 'Действия на погрузке', exact: true });
    await actions.getByRole('button', { name: 'Прибыл', exact: true }).click();
    await actions.getByLabel('Масса нетто доставки 1, т', { exact: true }).fill('6,745');
    await actions.getByLabel('Масса нетто доставки 2, т', { exact: true }).fill('7,985');
    await actions.getByRole('button', { name: 'Убыл', exact: true }).click();
    await expect(actions).not.toContainText('ЭТрН для этого рейса не нужна');
    await expect(actions).toContainText('CRM автоматически обрабатывает прямые ЭТрН от НК');
    await expect(actions).not.toContainText('Сотрудник запускает');
    await expect(actions).not.toContainText('CRM продолжает обработку документов');
    await expect(actions.getByRole('button', { name: 'Убыл', exact: true })).toHaveCount(0);
    const driverState = (await (await driver.request.get(base + `/api/driver/trips/${tripId}`)).json()).trip;
    assert.equal(driverState.etrnRequired, true); assert.equal(driverState.archived, false);
    assert.equal(driverState.documentAutomation, 'after_driver_departure');
    assert.deepEqual(driverState.deliveries.map(item => item.netTonnes), ['6.745', '7.985']);
    for (const width of [320, 390, 1440]) {
      await driverPage.setViewportSize({ width, height: 1050 }); await actions.scrollIntoViewIfNeeded();
      assert.ok(await driverPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${engine}: driver overflow ${width}`);
      await shot(`driver-${width}`, actions); check(`${engine}: arrive, decimal-comma masses and active trip pending document dispatch at ${width}px`);
    }
    const afterDeparture = (await rt.store.read(rt.source)).etrn.trips[tripId];
    assert.ok(afterDeparture.direct?.authorization);
    assert.deepEqual(afterDeparture.loadingDetails, syntheticLoadingDetails());
    for (const delivery of afterDeparture.direct.deliveries) {
      assert.equal(delivery.snapshot.loadingDetailsVersion, 1);
      assert.deepEqual(delivery.snapshot.profile.loadingActor.basis, syntheticLoadingDetails().basis);
      assert.deepEqual(delivery.snapshot.profile.loadingActor.worker, syntheticLoadingDetails().worker);
    }
    const durableGrant = JSON.stringify(afterDeparture.direct);
    middleware = api(); await trips();
    const afterButton = card.getByRole('button', { name: 'Saby', exact: true });
    if (await afterButton.getAttribute('aria-expanded') !== 'true') await afterButton.click();
    await expect(panel).toContainText('Данные подтверждены водителем');
    await expect(panel.getByRole('button', { name: 'Запустить подписание и отправку', exact: true })).toHaveCount(0);
    await expect(panel).toContainText('ЭТрН в очереди отправки');
    for (const width of [320, 390, 1440]) {
      await page.setViewportSize({ width, height: 1050 }); await panel.scrollIntoViewIfNeeded();
      assert.ok(await panel.evaluate(node => node.scrollWidth <= node.clientWidth + 1), `${engine}: queued panel overflow ${width}`);
      await shot(`direct-queued-${width}`, panel);
    }
    check(`${engine}: saved driver departure queues direct NK documents without a separate start button at 320, 390 and 1440px`);
    const projection = await call(`/api/shipment-trips/${tripId}/saby-workflow`);
    assert.equal(projection.documentMode, 'nk_direct_etrn'); assert.notEqual(projection.notRequired, true);
    assert.equal(projection.order, null); assert.equal(projection.phase, 'creating_etrn'); assert.equal(projection.status, 'not_sent');
    assert.ok(projection.driverConfirmation.confirmedAt); assert.ok(!projection.stage6CompletedAt);
    assert.equal(projection.start, undefined); assert.equal(projection.locked, true);
    assert.equal(projection.automation.mode, 'after_driver_departure'); assert.equal(projection.automation.enrolled, true);
    const persisted = (await call(`/api/shipment-trips/${tripId}`)).trip;
    assert.deepEqual(persisted.customers.map(item => item.fields.etrn_not_required), ['false', String(engine === 'webkit')]);
    assert.equal(projection.deliveries.length, engine === 'webkit' ? 1 : 2);
    if (engine === 'webkit') await expect(panel).toContainText('ЭТрН не нужна для этой доставки');
    assert.deepEqual(persisted.customers.map(item => item.fields.invoice_not_required), ['false', 'true']);
    const stored = await rt.store.read(rt.source);
    assert.equal(stored.tripSaby?.trips[tripId], undefined); assert.equal(stored.saby?.trips[tripId], undefined);
    assert.equal(Object.keys(stored.etrn.trips[tripId].deliveries).length, 0);
    assert.equal(JSON.stringify(stored.etrn.trips[tripId].direct), durableGrant);
    check(`${engine}: atomic queue and grant survive API restart and GET refresh unchanged; delivery and invoice flags stay independent; no provider call or fabricated signature`);
    // Isolated response fixtures exercise presentation only; provider lifecycle is
    // verified separately by backend tests and no fixture changes the saved queue.
    const workflowUrl = `${base}/api/shipment-trips/${tripId}/saby-workflow`;
    const present = async (name, overrides, expected, forbidden) => {
      const body = { ...projection, ...overrides };
      const handler = route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      await page.route(workflowUrl, handler);
      await panel.getByRole('button', { name: 'Обновить состояние', exact: true }).click();
      await expect(panel).toContainText(expected);
      if (forbidden) await expect(panel).not.toContainText(forbidden);
      await expect(panel.getByRole('button', { name: 'Запустить подписание и отправку', exact: true })).toHaveCount(0);
      await page.setViewportSize({ width: 390, height: 1050 });
      await shot(`presentation-${name}`, panel); report.presentationFixtures.push(`${engine}: ${name}`);
      await page.unroute(workflowUrl, handler);
    };
    const dispatched = (sender, carrier, completedAt = null, recipientAcceptedAt = null) => projection.deliveries.map(delivery => ({ ...delivery, id: `synthetic-${delivery.shipmentId}`, status: 'draft', dispatch: { sender: { state: sender }, carrier: { state: carrier }, completedAt, recipientAcceptedAt } }));
    await present('sender-pending', { phase: 'sending_etrn', deliveries: dispatched('waiting', 'not_started') }, 'Подписание ЭТрН от имени НК', 'Подпись НК как отправителя: подтверждена Saby');
    await present('carrier-pending', { phase: 'sending_etrn', deliveries: dispatched('confirmed', 'waiting') }, 'Подписание титула перевозчика', 'Подпись НК как перевозчика: подтверждена Saby');
    await present('dispatch-pending', { phase: 'sending_etrn', deliveries: dispatched('confirmed', 'confirmed') }, 'Передача ЭТрН клиентам', 'ЭТрН переданы клиентам');
    const completedAt = new Date().toISOString();
    await present('transmitted-not-accepted', { phase: 'completed', stage6CompletedAt: completedAt, deliveries: dispatched('confirmed', 'confirmed', completedAt) }, 'Передано клиенту. Приёмка клиентом пока не подтверждена.', 'Приёмка клиентом подтверждена');
    await present('recipient-accepted', { phase: 'completed', stage6CompletedAt: completedAt, deliveries: dispatched('confirmed', 'confirmed', completedAt, completedAt) }, 'Приёмка клиентом подтверждена');
    await present('unknown', { phase: 'unknown', lastError: 'Синтетическая неопределённость: ожидается сверка с Saby.' }, 'Сверяем результат обмена с Saby');
    await present('blocked-auto', { phase: 'preparation', locked: false, blockers: ['Синтетическая блокировка: настройка подписи изменилась.'], automation: { ...projection.automation, enabled: false }, start: { mode: 'sign_and_send', previewToken: 'synthetic-forbidden-start' } }, 'Черновик ЭТрН: нужны сведения');
    check(`${engine}: presentation fixtures distinguish pending signatures, transmission, client acceptance, unknown result and blocked auto mode without a launch action`);
    assert.equal(JSON.stringify((await rt.store.read(rt.source)).etrn.trips[tripId].direct), durableGrant);
    const allSkip = await call('/api/shipment-trips', 'POST', { fields: { ...fields, trip_notes: `QA NK all skip ${engine}` }, customers: customers.map(row => ({ fields: { ...row.fields, etrn_not_required: 'true' } })), idempotencyKey: randomUUID() });
    const skipTripId = allSkip.trip.id;
    await driverPage.goto(base + `/#driver-trip/${skipTripId}`);
    await actions.getByRole('button', { name: 'Прибыл', exact: true }).click();
    await actions.getByLabel('Масса нетто доставки 1, т', { exact: true }).fill('6,745');
    await actions.getByLabel('Масса нетто доставки 2, т', { exact: true }).fill('7,985');
    await expect(actions).not.toContainText('CRM автоматически запустит подписание');
    await actions.getByRole('button', { name: 'Убыл', exact: true }).click();
    await expect(actions).toContainText('ЭТрН для этого рейса не нужна.');
    const skipState = (await (await driver.request.get(base + `/api/driver/trips/${skipTripId}`)).json()).trip;
    assert.equal(skipState.archived, true); assert.equal(skipState.etrnRequired, false);
    const skipProjection = await call(`/api/shipment-trips/${skipTripId}/saby-workflow`);
    assert.equal(skipProjection.notRequired, true); assert.equal(skipProjection.start, undefined);
    assert.equal((await rt.store.read(rt.source)).etrn.trips[skipTripId].direct, undefined);
    check(`${engine}: all-skip driver departure saves every mass and finishes locally without a direct authorization or provider call`);
    await page.waitForLoadState('networkidle'); await driverPage.waitForLoadState('networkidle');
    await driver.close(); await context.close(); await browser.close(); browser = null;
  }
  assert.equal(report.providerCalls, 0); assert.deepEqual(report.workflowPosts, []); assert.deepEqual(report.externalRequests, []); assert.deepEqual(report.browserErrors, []); assert.deepEqual(report.apiHttpErrors, []);
  report.passed = true;
} catch (error) { report.passed = false; report.error = error.message; throw error; }
finally {
  if (previousAutofill === undefined) delete process.env.SABY_AUTOFILL_PROFILE_JSON; else process.env.SABY_AUTOFILL_PROFILE_JSON = previousAutofill;
  await browser?.close(); await new Promise(resolve => server.close(resolve)); await rt.close();
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
}
