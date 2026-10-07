// New driver flow against an isolated synthetic API/store. No external provider writes.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium, webkit, expect } from '@playwright/test';
import { OperationsStore } from '../server/operations-store.ts';
import { SabyClient, sabyConfigFromEnv } from '../server/saby-client.ts';
import { startTripsQaServer, writeTripsQaSnapshot } from './qa-trips-runtime.mjs';
import { authenticateContext, bootstrapQaAuth } from './qa-auth.mjs';

const root = resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(resolve(tmpdir(), 'artel-driver-flow-ui-'));
const output = resolve(root, 'qa/driver-trip-flow-2026-10-07');
await mkdir(output, { recursive: true });
const snapshotDirectory = resolve(temporary, 'snapshot'), operationsDirectory = resolve(temporary, 'operations');
const source = await writeTripsQaSnapshot(snapshotDirectory), store = new OperationsStore(operationsDirectory);
const company = (id, name, role) => ({ id, name, roles: [role], managerLabels: [], shipmentIds: [], paymentIds: [], flags: [] });
await store.mutate(source, data => {
  data.sourceOperationsCleared = true; data.shipments = {}; data.paymentAllocations = [];
  data.companies = [company('qa-supplier', 'QA Нефтепродукты', 'supplier'), company('qa-a', 'QA Клиент А', 'customer'), company('qa-b', 'QA Клиент Б', 'customer')];
  data.directories = {
    fleetSeedApplied: true, managers: [{ id: 'qa-manager', name: 'QA Менеджер' }],
    products: [{ id: 'qa-product', name: 'QA Дизель', transportProductKind: 'diesel', cargoPackaging: 'bulk' }], paymentForms: [{ id: 'qa-payment', name: 'б/нал' }],
    vehicles: [{ id: 'qa-vehicle', plate: 'Т000ЕЕ00', capacityLitres: '20000' }], drivers: [{ id: 'qa-driver', name: 'QA Водитель', vehicleId: 'qa-vehicle' }],
    oilDepots: [{ id: 'qa-depot', name: 'QA Нефтебаза', address: 'Синтетическая нефтебаза, 1', ownerCompanyId: 'qa-supplier', loadingActorCompanyId: 'qa-supplier', infrastructureOwnerCompanyId: 'qa-supplier' }],
    addresses: [['qa-place-a', 'qa-a', 'QA Первая точка', 'Синтетическая улица, 1'], ['qa-place-a2', 'qa-a', 'QA Вторая точка', 'Синтетическая улица, 2'], ['qa-place-b', 'qa-b', 'QA Общий адрес', 'Синтетическая улица, 1']].map(([id, companyId, name, address]) => ({ id, companyId, kind: 'delivery', name, address })),
    customerManagers: ['qa-a', 'qa-b'].map(companyId => ({ companyId, managerId: 'qa-manager' })), defaults: { profit: 'template-payment-form' }, duplicates: [],
  };
  return { changed: true, result: null };
});
const report = { fixtureOnly: true, workingStoreAccessed: false, providerCalls: 0, mockedArchivePresentation: true, checks: [], screenshots: [], browserErrors: [] };
const check = name => { report.checks.push(name); console.log('PASS', name); };
let runtime, browser;
try {
  const client = new SabyClient(sabyConfigFromEnv({}), async () => { report.providerCalls++; throw new Error('External requests forbidden'); });
  runtime = await startTripsQaServer({ root, snapshotDirectory, operationsDirectory, sabyClient: client });
  const { cookie } = await bootstrapQaAuth(runtime.base);
  const call = async (path, method = 'GET', body) => {
    const response = await fetch(runtime.base + path, { method, headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const result = await response.json(); assert.ok([200, 201].includes(response.status), `${method} ${path}: ${result.error || response.status}`); return result;
  };
  const credential = await call('/api/drivers/qa-driver/access', 'POST', { action: 'issue', version: 0 });
  for (const [engine, launcher] of [['chromium', chromium], ['webkit', webkit]]) {
    browser = await launcher.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'America/Los_Angeles', serviceWorkers: 'block', reducedMotion: 'reduce' });
    await authenticateContext(context, runtime.base, cookie);
    const page = await context.newPage(); page.on('pageerror', error => report.browserErrors.push(`${engine}: ${error.message}`));
    const choose = async (scope, label, name) => { const picker = scope.getByRole('combobox', { name: new RegExp('^' + label) }); await picker.fill(name); await scope.getByRole('listbox').getByRole('option', { name: new RegExp('^' + name) }).first().click(); };
    await page.goto(runtime.base + '/#trips');
    await page.getByRole('button', { name: 'Новый рейс', exact: true }).click();
    const dialog = page.getByRole('dialog');
    for (const label of ['Плановая масса груза, т', 'Плановая масса брутто по документам, т', 'Плановая выгрузка', 'Фактическая выгрузка']) await expect(dialog.getByLabel(label, { exact: true })).toHaveCount(0);
    await dialog.getByLabel('Плановая дата рейса · Москва', { exact: true }).fill('2099-10-08');
    await choose(dialog, 'Поставщик', 'QA Нефтепродукты'); await choose(dialog, 'Нефтебаза', 'QA Нефтебаза'); await choose(dialog, 'Товар', 'QA Дизель');
    await dialog.getByLabel('Цена поставщика за тонну, ₽', { exact: false }).fill('60000');
    for (const [index, customer, place] of [[0, 'QA Клиент А', 'QA Первая точка'], [1, 'QA Клиент А', 'QA Вторая точка'], [2, 'QA Клиент Б', 'QA Общий адрес']]) {
      if (index) await dialog.getByRole('button', { name: 'Добавить клиента', exact: true }).click();
      const row = dialog.getByTestId('trip-customer').nth(index);
      await choose(row, 'Клиент', customer); await choose(row, 'Место выгрузки', place);
      await row.getByLabel('Количество литров, л', { exact: false }).fill('4000'); await row.getByLabel('Цена за литр, ₽', { exact: false }).fill('75');
      await expect(row.getByRole('status', { name: 'Прибыль, ₽', exact: true })).toHaveText('—');
      await expect(row.getByRole('status', { name: 'Сумма клиента, ₽', exact: true })).toHaveText(/300/);
    }
    await choose(dialog, 'Водитель', 'QA Водитель');
    await dialog.getByRole('button', { name: 'Сохранить рейс', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('плановые дату и время');
    await dialog.getByLabel('Плановая дата рейса · Москва — время', { exact: true }).fill('09:00');
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.ok(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1), `${engine} editor fits ${width}`);
      const screenshot = resolve(output, `${engine}-editor-${width}.png`); await page.screenshot({ path: screenshot }); report.screenshots.push(screenshot);
    }
    let saveBody;
    page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/shipment-trips') saveBody = request.postDataJSON(); });
    await dialog.getByRole('button', { name: 'Сохранить рейс', exact: true }).click(); await expect(dialog).toHaveCount(0);
    assert.equal(saveBody.fields.loading_at, '2099-10-08T09:00'); assert.equal(saveBody.fields.trip_flow_version, 'driver-v1');
    for (const key of ['quantity_tonnes', 'quantity_gross_tonnes', 'loading_actual_at', 'unloading_planned_at', 'unloading_actual_at']) assert.equal(saveBody.fields[key], undefined);
    assert.ok(saveBody.customers.every(row => row.fields.quantity_tonnes === undefined && row.fields.unloading_planned_at === undefined && row.fields.unloading_actual_at === undefined));
    const trip = (await call('/api/shipment-trips')).trips.find(item => item.customers.every(row => row.version === 1));
    assert.ok(trip); assert.equal(trip.customers.length, 3); assert.equal(new Set(trip.customers.map(row => row.id)).size, 3);
    assert.equal(trip.fields.quantity_tonnes, null); assert.equal(trip.fields.loading_planned_at, '2099-10-08T09:00'); assert.equal(trip.fields.loading_actual_at, null);
    check(`${engine}: future plan requires time; no mass/facts/unload fields; three separate deliveries and accounting rows saved`);

    const driver = await browser.newContext({ viewport: { width: 390, height: 1000 }, timezoneId: 'America/Los_Angeles', serviceWorkers: 'block' });
    const login = await driver.request.post(runtime.base + '/api/auth/login', { data: { login: credential.access.login, password: credential.temporaryPassword } }); assert.equal(login.status(), 200);
    const drivePage = await driver.newPage(); drivePage.on('pageerror', error => report.browserErrors.push(`${engine}: ${error.message}`));
    await drivePage.goto(runtime.base + `/#driver-trip/${trip.id}`);
    const actions = drivePage.getByRole('region', { name: 'Действия на погрузке', exact: true });
    await expect(actions.getByRole('button', { name: 'Прибыл', exact: true })).toBeVisible();
    await expect(drivePage.getByText('Плановое время', { exact: true })).toHaveCount(0);
    await expect(actions.locator('input')).toHaveCount(0); await expect(actions.getByRole('button', { name: 'Убыл', exact: true })).toHaveCount(0);
    let arrivalRequests = 0, departRequests = 0;
    drivePage.on('request', request => { if (request.method() !== 'POST') return; if (request.url().endsWith('/arrive')) arrivalRequests++; if (request.url().endsWith('/depart')) departRequests++; });
    let stateUnavailable = true;
    await drivePage.route(`**/api/driver/trips/${trip.id}/arrive`, route => route.abort('connectionfailed'));
    await drivePage.route(`**/api/driver/trips/${trip.id}`, route => stateUnavailable ? route.abort('connectionfailed') : route.continue());
    await actions.getByRole('button', { name: 'Прибыл', exact: true }).click();
    await expect(actions.getByRole('alert')).toContainText('Ответ не подтверждён');
    await expect(actions.getByRole('button', { name: 'Прибыл', exact: true })).toBeDisabled();
    assert.equal(arrivalRequests, 1);
    stateUnavailable = false;
    await actions.getByRole('button', { name: 'Проверить состояние', exact: true }).click();
    await expect(actions).toContainText('Прибытие ещё не сохранено');
    await drivePage.unroute(`**/api/driver/trips/${trip.id}/arrive`);
    await drivePage.unroute(`**/api/driver/trips/${trip.id}`);
    arrivalRequests = 0;
    await actions.getByRole('button', { name: 'Прибыл', exact: true }).evaluate(node => { node.click(); node.click(); });
    await expect(actions).toContainText('Прибытие сохранено'); assert.equal(arrivalRequests, 1);
    let actual = (await (await driver.request.get(runtime.base + `/api/driver/trips/${trip.id}`)).json()).trip;
    assert.ok(actual.arrivedAt); assert.equal(actual.departedAt, null);
    const expectedTime = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' }).format(new Date(actual.arrivedAt));
    await expect(actions).toContainText(expectedTime + ' МСК');
    await drivePage.reload(); await expect(actions.getByRole('button', { name: 'Прибыл', exact: true })).toHaveCount(0);
    const depart = actions.getByRole('button', { name: 'Убыл', exact: true }); await expect(depart).toBeDisabled();
    await actions.getByLabel('Масса нетто доставки 1, т', { exact: true }).fill('0'); await expect(depart).toBeDisabled();
    await actions.getByLabel('Масса нетто доставки 1, т', { exact: true }).fill('2,123456'); await expect(depart).toBeDisabled();
    await actions.getByLabel('Масса нетто доставки 2, т', { exact: true }).fill('3,5'); await actions.getByLabel('Масса нетто доставки 3, т', { exact: true }).fill('4'); await expect(depart).toBeEnabled();
    await store.mutate(source, data => { data.shipments[trip.customers[0].id].version++; data.shipments[trip.customers[0].id].fields.delivery_notes = 'QA уточнение'; return { changed: true, result: null }; });
    await drivePage.getByRole('button', { name: 'Обновить мои рейсы', exact: true }).click();
    await expect(actions.getByRole('alert')).toContainText('Рейс изменён'); await expect(depart).toBeDisabled();
    await actions.getByRole('button', { name: 'Проверить состав и начать ввод заново', exact: true }).click();
    for (const [index, value] of ['2,123456', '3,5', '4'].entries()) await actions.getByLabel(`Масса нетто доставки ${index + 1}, т`, { exact: true }).fill(value);
    for (const width of [320, 390, 768, 1440]) {
      await drivePage.setViewportSize({ width, height: 1000 });
      assert.ok(await drivePage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${engine} driver fits ${width}`);
      const screenshot = resolve(output, `${engine}-driver-${width}.png`); await drivePage.screenshot({ path: screenshot, fullPage: true }); report.screenshots.push(screenshot);
    }
    let lost = false;
    await drivePage.route(`**/api/driver/trips/${trip.id}/depart`, async route => { if (lost) return route.continue(); lost = true; const result = await route.fetch(); assert.equal(result.status(), 200); await route.abort('connectionfailed'); });
    await depart.evaluate(node => { node.click(); node.click(); });
    await expect(actions).toContainText('Убытие и все массы сохранены'); await expect(actions.locator('input')).toHaveCount(0); assert.equal(departRequests, 1);
    actual = (await (await driver.request.get(runtime.base + `/api/driver/trips/${trip.id}`)).json()).trip;
    assert.deepEqual(actual.deliveries.map(row => row.netTonnes), ['2.123456', '3.5', '4']); assert.equal(actual.archived, false);
    const savedDeparture = actual.departedAt;
    await drivePage.reload(); await expect(actions.locator('input')).toHaveCount(0); await expect(actions).toContainText('Массы и убытие сохранены');
    actual = (await (await driver.request.get(runtime.base + `/api/driver/trips/${trip.id}`)).json()).trip; assert.equal(actual.departedAt, savedDeparture);
    assert.equal((await call(`/api/shipment-trips/${trip.id}`)).trip.fields.quantity_tonnes, '9.623456');
    check(`${engine}: arrival survives reload, Moscow time is device-independent, invalid/incomplete/stale drafts blocked, complete decimal departure readback recovers lost response with one write`);

    // Archive presentation is deliberately injected; server evidence gating is
    // covered by driver API tests, not fabricated external document signatures.
    await drivePage.route('**/api/driver/trips', async route => { const response = await route.fetch(); const body = await response.json(); body.trips = body.trips.map(item => ({ ...item, archived: item.id === trip.id })); await route.fulfill({ response, json: body }); });
    await drivePage.goto(runtime.base + '/#driver-trips'); await drivePage.getByRole('button', { name: 'Обновить мои рейсы', exact: true }).click();
    await drivePage.getByRole('button', { name: 'Архивные', exact: true }).click();
    await expect(drivePage.locator(`a[href="#driver-trip/${trip.id}"]`)).toHaveCount(1);
    await drivePage.getByRole('button', { name: 'Активные', exact: true }).click();
    await expect(drivePage.locator(`a[href="#driver-trip/${trip.id}"]`)).toHaveCount(0);
    check(`${engine}: Active/Archive presentation follows server archive evidence flag only`);

    const oldFields = { ...saveBody.fields, date: '2020-10-02', loading_planned_at: '2020-10-02T09:00', loading_actual_at: '2020-10-02T10:00', quantity_tonnes: '12', trip_notes: `QA исторический ${engine}` };
    delete oldFields.trip_flow_version; delete oldFields.loading_at;
    const historical = (await call('/api/shipment-trips', 'POST', { fields: oldFields, customers: saveBody.customers.map(row => ({ fields: { ...row.fields, unloading_planned_at: '2020-10-02T12:00', unloading_actual_at: '2020-10-02T12:30' } })) })).trip;
    await page.reload();
    const oldCard = page.getByTestId('trip-card').filter({ hasText: `QA исторический ${engine}` });
    await oldCard.getByRole('button', { name: 'Изменить рейс', exact: true }).click();
    await expect(dialog.getByLabel('Плановая масса груза, т', { exact: false })).toHaveValue('12');
    await expect(dialog.getByTestId('trip-customer').first().getByLabel('Фактическая выгрузка — время', { exact: true })).toHaveValue('12:30');
    await dialog.getByLabel('Дата отгрузки / погрузки', { exact: true }).fill('2020-10-03');
    await expect(dialog.getByTestId('trip-customer').first().getByLabel('Плановая выгрузка', { exact: true })).toHaveValue('2020-10-02');
    await dialog.getByRole('button', { name: 'Сохранить рейс', exact: true }).click(); await expect(dialog).toHaveCount(0);
    const edited = (await call(`/api/shipment-trips/${historical.id}`)).trip;
    assert.equal(edited.fields.loading_planned_at, '2020-10-03T09:00'); assert.equal(edited.fields.loading_actual_at, '2020-10-02T10:00');
    assert.equal(edited.fields.quantity_tonnes, '12'); assert.equal(edited.customers[0].fields.unloading_actual_at, '2020-10-02T12:30'); assert.equal(edited.fields.trip_flow_version, null);
    check(`${engine}: historical editor retains masses and independent actual/unload dates when plan changes`);
    await context.close(); await driver.close(); await browser.close(); browser = null;
  }
  assert.equal(report.providerCalls, 0); assert.deepEqual(report.browserErrors, []); report.passed = true;
} catch (error) { report.passed = false; report.error = error.message; throw error; }
finally { await browser?.close(); await runtime?.server.close(); await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2)); await rm(temporary, { recursive: true, force: true }); }
