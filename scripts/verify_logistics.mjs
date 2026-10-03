// Browser -> authenticated local API -> temporary synthetic OperationsStore.
// Only the external Saby provider is synthetic. Never reads the working store,
// sends real Saby documents, or signs anything. Run: node --import tsx scripts/verify_logistics.mjs
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { SabyClient } from '../server/saby-client.ts';
import { integrationRuntime, integrationApi, integrationConfig, integrationSettings } from '../tests/helpers/trip-saby-integration.ts';
import { startTripsQaServer } from './qa-trips-runtime.mjs';

const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'qa/logistics');
await mkdir(output, { recursive: true });
const rt = await integrationRuntime(), transport = integrationApi(), config = integrationConfig();
const previousSettings = process.env.SABY_AUTOFILL_PROFILE_JSON;
process.env.SABY_AUTOFILL_PROFILE_JSON = JSON.stringify(integrationSettings);
const report = {
  fixtureOnly: true, workingStoreAccessed: false, realSabyRequests: 0, realSignaturesCreated: 0,
  syntheticProvider: true, mockedHttpResponses: false, checks: [], screenshots: [],
  browserErrors: [], unexpectedExternalRequests: [], logisticsApiRequests: [], providerMethods: {},
};
const check = name => { report.checks.push(name); console.log('PASS', name); };
const account = { name: 'QA Director', login: 'qa.logistics.director', password: randomUUID() };
const manager = { name: 'QA Manager', login: 'qa.logistics.manager', password: randomUUID(), role: 'manager', managerId: 'manager', sections: ['trips'] };
const denied = { name: 'QA Denied', login: 'qa.logistics.denied', password: randomUUID(), role: 'manager', managerId: 'denied-manager', sections: ['shipments'] };
const blobs = new Map(), downloads = [];
let releaseReservation = () => {}, enteredReservation, firstReservation = true;
const reservationStarted = new Promise(done => { enteredReservation = done; });
const reservationGate = new Promise(done => { releaseReservation = done; });
const provider = async (url, init) => {
  if (init?.method === 'GET') {
    assert.equal(new Headers(init.headers).get('X-SBISSessionID'), config.sessionId);
    downloads.push(String(url));
    return blobs.has(String(url)) ? new Response(blobs.get(String(url))) : transport.send(url, init);
  }
  const rpc = JSON.parse(String(init?.body));
  if (firstReservation && rpc.method === 'СБИС.ЗаписатьДокумент' && !rpc.params.Документ.Идентификатор) {
    firstReservation = false; enteredReservation(); await reservationGate;
  }
  const response = await transport.send(url, init);
  if (rpc.method === 'СБИС.ЗаписатьДокумент' && rpc.params.Документ.Вложение) {
    const document = rpc.params.Документ;
    blobs.set(`https://disk.saby.ru/${document.Идентификатор}.xml`, Buffer.from(document.Вложение[0].Файл.ДвоичныеДанные, 'base64'));
  }
  return response;
};
let runtime, browser, page;
try {
  await rt.store.mutate(rt.source, data => {
    Object.assign(data.companies.find(row => row.id === 'customer'), { bankName: 'QA-PRIVATE-BANK', settlementAccount: 'QA-PRIVATE-ACCOUNT', correspondentAccount: 'QA-PRIVATE-CORRESPONDENT', bik: 'QA-PRIVATE-BIK' });
    data.directories.managers.push({ id: 'foreign-manager', name: 'QA Другой сотрудник' }, { id: 'denied-manager', name: 'QA Без доступа' });
    data.directories.customerManagers = [{ companyId: 'customer', managerId: 'manager' }, { companyId: 'foreign-customer', managerId: 'foreign-manager' }];
    data.companies.push({ id: 'foreign-customer', name: 'QA ЧУЖОЙ КЛИЕНТ', roles: ['customer'], managerLabels: [], shipmentIds: [], paymentIds: [], flags: [] });
    return { result: null, changed: true };
  });
  runtime = await startTripsQaServer({ root, snapshotDirectory: rt.snapshotDirectory, operationsDirectory: resolve(rt.directory, 'store'), sabyClient: new SabyClient(config, provider) });
  const { base } = runtime;
  report.base = base;
  const setup = await fetch(`${base}/api/auth/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(account) });
  assert.equal(setup.status, 200);
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const context = async (width = 1440) => {
    const value = await browser.newContext({ viewport: { width, height: 1050 }, reducedMotion: 'reduce', serviceWorkers: 'block', timezoneId: 'Europe/Moscow' });
    await value.route('**/*', route => {
      if (new URL(route.request().url()).origin === base) return route.continue();
      report.unexpectedExternalRequests.push(route.request().url()); return route.abort();
    });
    value.on('page', tab => tab.on('pageerror', error => report.browserErrors.push(error.message)));
    return value;
  };
  const api = async (ctx, path, method = 'GET', data, status = 200) => {
    const response = await ctx.request.fetch(base + path, { method, ...(data === undefined ? {} : { data }) });
    assert.equal(response.status(), status, `${method} ${path}: ${response.status()} ${await response.text()}`);
    return response.json();
  };
  const login = async (tab, credentials, logistics = true) => {
    await tab.goto(base + (logistics ? '/logistics/' : '/'));
    await tab.getByLabel('Логин', { exact: true }).fill(credentials.login);
    await tab.getByLabel('Пароль', { exact: true }).fill(credentials.password);
    await tab.getByRole('button', { name: 'Войти', exact: true }).click();
  };
  const choose = async (scope, label, value) => {
    const input = scope.getByRole('combobox', { name: new RegExp(`^${label}`) });
    await input.fill(value); await scope.getByRole('listbox').getByRole('option', { name: new RegExp(value) }).first().click();
    await expect(input).toHaveValue(value);
  };
  const shot = async (tab, name) => {
    await tab.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); window.scrollTo({ top: 0, behavior: 'instant' }); });
    const path = resolve(output, `${name}.png`); await tab.screenshot({ path, fullPage: true }); report.screenshots.push(path);
  };
  const fit = async (tab, locator, label) => {
    const sizes = await locator.evaluate(node => ({ scroll: node.scrollWidth, client: node.clientWidth }));
    assert.ok(sizes.scroll <= sizes.client + 1, `${label} horizontal overflow: ${JSON.stringify(sizes)}`);
    assert.ok(await tab.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${label} page overflow`);
  };
  const versions = trip => Object.fromEntries(trip.customers.map(row => [row.id, row.version]));
  const editBody = (trip, changes = {}) => ({ fields: { ...trip.fields, ...changes }, customers: trip.customers.map(({ id, fields }) => ({ id, fields })), versions: versions(trip) });

  // Main CRM keeps its own login/session and unchanged routes.
  const main = await context(), mainPage = await main.newPage(); page = mainPage;
  await login(mainPage, account, false);
  await expect(mainPage.locator('#app-navigation')).toBeVisible();
  await api(main, '/api/auth/users', 'POST', manager, 201);
  await api(main, '/api/auth/users', 'POST', denied, 201);
  const foreignBody = {
    idempotencyKey: randomUUID(),
    fields: { organization_id: 'artel', date: '2025-04-01', supplier_id: 'supplier', oil_depot_id: 'depot', product_id: 'product', purchase_price_unspecified_unit: '50000', quantity_tonnes: '8', driver_id: 'driver', vehicle_id: 'vehicle', trip_notes: 'QA-FOREIGN-PRIVATE-TRIP' },
    customers: [{ fields: { customer_id: 'foreign-customer', manager_id: 'foreign-manager', payment_form_id: 'payment', quantity_litres: '8000', sale_price_per_litre: '60', transport_amount: '1000' } }],
  };
  const foreign = (await api(main, '/api/shipment-trips', 'POST', foreignBody, 201)).trip;
  await mainPage.goto(base + '/#trips'); await expect(mainPage.getByTestId('trip-card')).toHaveCount(2);
  await mainPage.goto(base + '/#shipments'); await expect(mainPage.locator('.shipment-grid')).toBeVisible();
  await mainPage.goto(base + '/#directories'); await expect(mainPage.getByRole('group', { name: 'Справочники', exact: true })).toBeVisible();
  await expect(mainPage.getByRole('button', { name: 'Очистка справочников', exact: true })).toHaveCount(0);
  await shot(mainPage, 'main-crm-directories-desktop');
  assert.equal((await main.request.get(base + '/api/logistics/context')).status(), 401);
  check('Main CRM login, navigation, trips, shipments and directories remain available; its cookie cannot authenticate logistics');
  for (const width of [390, 320]) {
    await mainPage.setViewportSize({ width, height: 1000 });
    await mainPage.goto(base + '/#trips'); await expect(mainPage.getByTestId('trip-card')).toHaveCount(2);
    await fit(mainPage, mainPage.locator('.trips-page'), `main CRM trips ${width}`); await shot(mainPage, `main-crm-trips-${width}`);
    await mainPage.goto(base + '/#shipments'); await expect(mainPage.locator('.shipment-grid')).toBeVisible();
    assert.ok(await mainPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `main CRM shipments page ${width}`);
    await mainPage.goto(base + '/#directories'); await expect(mainPage.getByRole('group', { name: 'Справочники', exact: true })).toBeVisible();
    await fit(mainPage, mainPage.locator('.directories-page'), `main CRM directories ${width}`);
  }
  await mainPage.setViewportSize({ width: 1440, height: 1050 });
  check('Main CRM trips, scrollable shipments table and directories regressions fit 390 and 320 px');

  const logistics = await context(); page = await logistics.newPage();
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/')) report.logisticsApiRequests.push({ path, method: request.method() });
  });
  await page.goto(base + '/logistics/');
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 }); await expect(page.getByRole('button', { name: 'Войти', exact: true })).toBeVisible();
    await fit(page, page.locator('.auth-screen'), `login ${width}`); await shot(page, `logistics-login-${width}`);
  }
  await page.setViewportSize({ width: 1440, height: 1050 });
  await login(page, account);
  await expect(page.getByRole('heading', { name: 'Рейсы', exact: true, level: 1 })).toBeVisible();
  await expect(page.getByTestId('trip-card')).toHaveCount(2);
  assert.equal((await logistics.request.get(base + '/api/snapshot')).status(), 401);
  assert.equal((await logistics.request.get(base + '/api/banking/connections')).status(), 401);
  const scoped = await api(logistics, '/api/logistics/context');
  assert.ok(scoped.companies && scoped.directories);
  assert.doesNotMatch(JSON.stringify(scoped), /QA-PRIVATE-|bankName|settlementAccount|correspondentAccount/);
  for (const key of ['shipments', 'payments', 'banking', 'accounts', 'payroll', 'stockSummaries']) assert.equal(scoped[key], undefined);
  for (const title of ['Платежи', 'Обзор', 'ЗП', 'Учётные записи', 'Компании', 'Перевозчики', 'Менеджеры', 'Формы оплаты', 'Клиенты и менеджеры']) await expect(page.getByRole('link', { name: title, exact: true })).toHaveCount(0);
  check('Standalone login yields a separate scoped session, loads only logistics context and cannot use full CRM/banking APIs');

  // A fresh trip is created through the actual shared editor, including two separate deliveries.
  await page.getByRole('button', { name: 'Новый рейс', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Сохранить рейс', exact: true }).click();
  await expect(dialog.getByRole('alert')).toBeVisible();
  await dialog.getByLabel('Дата отгрузки / погрузки', { exact: true }).fill('2026-10-02');
  await choose(dialog, 'Поставщик', 'Синтетический поставщик');
  await choose(dialog, 'Нефтебаза', 'Синтетическая нефтебаза');
  await choose(dialog, 'Товар', 'ДТ');
  await dialog.getByLabel('Цена поставщика за тонну, ₽', { exact: false }).fill('50000');
  await dialog.getByLabel('Плановая масса груза, т', { exact: false }).fill('8');
  for (const [index, litres] of ['6000', '4000'].entries()) {
    if (index) await dialog.getByRole('button', { name: 'Добавить клиента', exact: true }).click();
    const row = dialog.getByTestId('trip-customer').nth(index);
    await choose(row, 'Клиент', 'ИП ПолучательТестовый Тест'); await choose(row, 'Место выгрузки', 'Доставка');
    await row.getByLabel('Количество литров, л', { exact: false }).fill(litres);
    await row.getByLabel('Цена за литр, ₽', { exact: false }).fill('75');
    await row.getByLabel('Сумма перевозки, ₽', { exact: true }).fill('1000');
    await row.getByLabel('Примечание к доставке', { exact: true }).fill(`QA доставка ${index + 1}`);
  }
  await dialog.getByTestId('trip-customer').first().getByLabel('Счёт не нужен').check();
  await choose(dialog, 'Водитель', 'Тест'); await expect(dialog.getByRole('combobox', { name: 'Автомобиль *', exact: true })).toHaveValue('Т001ЕЕ777');
  await dialog.getByLabel('Примечание к рейсу', { exact: true }).fill('QA-LOGISTICS-CREATED');
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 }); await fit(page, dialog, `trip editor ${width}`); await shot(page, `logistics-editor-${width}`);
  }
  await page.setViewportSize({ width: 1440, height: 1050 });
  let dropped = false, initialBody, retryBody, createAttempts = 0;
  const createUrl = `${base}/api/logistics/shipment-trips`;
  await page.route(createUrl, async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    createAttempts++;
    if (dropped) { retryBody = route.request().postDataJSON(); return route.fallback(); }
    dropped = true; initialBody = route.request().postDataJSON();
    const response = await route.fetch(); assert.equal(response.status(), 201); await route.abort('connectionfailed');
  });
  await dialog.getByRole('button', { name: 'Сохранить рейс', exact: true }).evaluate(button => { button.click(); button.click(); });
  await expect(dialog.getByRole('button', { name: 'Повторить сохранение', exact: true })).toBeVisible();
  assert.equal(createAttempts, 1);
  await expect(dialog.getByLabel('Примечание к рейсу')).toBeDisabled();
  await dialog.getByRole('button', { name: 'Повторить сохранение', exact: true }).click(); await expect(dialog).toHaveCount(0);
  await page.unroute(createUrl);
  assert.deepEqual(retryBody, initialBody); assert.ok(initialBody.idempotencyKey);
  let trip = (await api(logistics, '/api/logistics/shipment-trips')).trips.find(row => row.fields.trip_notes === 'QA-LOGISTICS-CREATED');
  assert.ok(trip); assert.equal(trip.customers.length, 2);
  assert.equal((await api(main, '/api/shipments')).total, 5);
  assert.equal(transport.calls.length, 0);
  check('Validation and multi-delivery save work on desktop/mobile; lost successful POST retries identical payload/key and creates exactly two accounting rows without Saby writes');

  const card = page.getByTestId('trip-card').filter({ hasText: 'QA-LOGISTICS-CREATED' });
  await card.getByRole('button', { name: 'Изменить рейс', exact: true }).click(); dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Счёт не нужен').first()).toBeChecked();
  await dialog.getByLabel('Примечание к рейсу').fill('QA-LOGISTICS-UPDATED');
  const tripPath = `/api/logistics/shipment-trips/${trip.id}`;
  await page.route(base + tripPath, async route => {
    if (route.request().method() !== 'PATCH') return route.fallback();
    const response = await route.fetch(); assert.equal(response.status(), 200); await route.abort('connectionfailed');
  });
  await dialog.getByRole('button', { name: 'Сохранить рейс', exact: true }).click(); await expect(dialog).toHaveCount(0); await page.unroute(base + tripPath);
  trip = (await api(logistics, tripPath)).trip; assert.equal(trip.fields.trip_notes, 'QA-LOGISTICS-UPDATED');
  await page.getByTestId('trip-card').filter({ hasText: 'QA-LOGISTICS-UPDATED' }).getByRole('button', { name: 'Изменить рейс', exact: true }).click(); dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Примечание к рейсу')).toHaveValue('QA-LOGISTICS-UPDATED');
  await api(logistics, tripPath, 'PATCH', editBody(trip, { trip_notes: 'QA-REMOTE-CHANGE' }));
  await dialog.getByLabel('Примечание к рейсу').fill('QA-LOCAL-UNSAVED');
  await dialog.getByRole('button', { name: 'Сохранить рейс', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('изменён в другом окне');
  await expect(dialog.getByLabel('Примечание к рейсу')).toHaveValue('QA-LOCAL-UNSAVED');
  await expect(dialog.getByRole('button', { name: 'Сохранить рейс', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Загрузить актуальный рейс', exact: true }).click();
  await expect(dialog.getByLabel('Примечание к рейсу')).toHaveValue('QA-REMOTE-CHANGE');
  await dialog.getByRole('button', { name: 'Закрыть редактор', exact: true }).click();
  check('Lost PATCH response is reconciled without duplicates; stale version preserves local input and requires explicit reload of newer trip');

  // Same directory editor, now using the scoped context for fresh reads and writes.
  await page.getByRole('link', { name: 'Автомобили', exact: true }).click();
  await page.getByRole('button', { name: 'Добавить', exact: true }).click(); dialog = page.getByRole('dialog');
  await dialog.getByLabel('Автомобиль / номер', { exact: true }).fill('QA машина 991');
  await dialog.getByLabel('Подтверждённая грузоподъёмность, т', { exact: true }).fill('27,9');
  await dialog.getByLabel('Основание владения', { exact: true }).selectOption('3');
  await dialog.getByLabel('Номер договора', { exact: true }).fill('QA-INITIAL');
  await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click(); await expect(dialog).toHaveCount(0);
  const currentVehicle = async () => (await api(logistics, '/api/logistics/context')).directories.vehicles.find(row => row.plate === 'QA машина 991');
  const remoteVehicle = async changes => { const { id, version, ...fields } = await currentVehicle(); await api(logistics, `/api/logistics/directories/vehicles/${id}`, 'PATCH', { ...fields, ...changes, version: version ?? 0 }); };
  const editVehicle = async () => { await page.getByRole('button', { name: 'Редактировать: QA машина 991', exact: true }).click(); return page.getByRole('dialog'); };
  dialog = await editVehicle(); await dialog.getByLabel('Номер договора', { exact: true }).fill('QA-LOCAL');
  await remoteVehicle({ brand: 'QA-REMOTE-BRAND' });
  await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click(); await expect(dialog).toHaveCount(0);
  assert.equal((await currentVehicle()).brand, 'QA-REMOTE-BRAND'); assert.equal((await currentVehicle()).leaseDocumentNumber, 'QA-LOCAL');
  dialog = await editVehicle(); await dialog.getByLabel('Номер договора', { exact: true }).fill('QA-MINE');
  await remoteVehicle({ leaseDocumentNumber: 'QA-THEIRS', model: 'QA-REMOTE-MODEL' });
  await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
  const review = dialog.getByRole('region', { name: 'Сверка изменений' });
  await expect(review).toContainText('QA-THEIRS'); await expect(dialog.getByLabel('Номер договора', { exact: true })).toHaveValue('QA-MINE');
  for (const width of [390, 320]) { await page.setViewportSize({ width, height: 1000 }); await review.scrollIntoViewIfNeeded(); await fit(page, dialog, `directory conflict ${width}`); await shot(page, `directory-conflict-${width}`); }
  await review.getByRole('radio', { name: 'Моё значение: QA-MINE', exact: true }).check();
  await review.getByRole('button', { name: 'Применить выбор', exact: true }).click();
  await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click(); await expect(dialog).toHaveCount(0);
  const vehicle = await currentVehicle(); assert.equal(vehicle.leaseDocumentNumber, 'QA-MINE'); assert.equal(vehicle.model, 'QA-REMOTE-MODEL'); assert.equal(vehicle.payloadTonnes, '27.9');
  await page.setViewportSize({ width: 1440, height: 1050 });
  check('Scoped vehicle create/edit keeps 27.9 t; independent edits merge and same-field conflicts preserve input and require explicit choice at 390/320 px');

  await page.getByRole('link', { name: 'Водители', exact: true }).click();
  await page.getByRole('button', { name: 'Добавить', exact: true }).click(); dialog = page.getByRole('dialog');
  await dialog.getByLabel('ФИО водителя', { exact: true }).fill('QA Новый водитель');
  await dialog.getByLabel('Телефон водителя', { exact: true }).fill('+70000000991');
  await choose(dialog, 'Автомобиль по умолчанию', 'QA машина 991');
  await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click(); await expect(dialog).toHaveCount(0);
  const savedDriver = (await api(logistics, '/api/logistics/context')).directories.drivers.find(row => row.name === 'QA Новый водитель');
  assert.equal(savedDriver.vehicleId, vehicle.id);
  for (const [title, section] of [['Клиенты', 'customers'], ['Поставщики', 'suppliers'], ['Нефтебазы', 'oilDepots'], ['Товары', 'products'], ['Адреса доставки', 'addresses']]) {
    await page.getByRole('link', { name: title, exact: true }).click();
    await expect(page.getByRole('heading', { name: title, level: 1, exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Добавить', exact: true })).toBeVisible();
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect(page.getByRole('combobox', { name: 'Раздел логистики', exact: true })).toHaveValue(section);
      await fit(page, page.locator('.directories-page'), `${title} ${width}`);
    }
    await page.setViewportSize({ width: 1440, height: 1050 });
  }
  await page.setViewportSize({ width: 320, height: 1000 });
  await page.getByRole('combobox', { name: 'Раздел логистики', exact: true }).selectOption('trips');
  await expect(page.getByRole('heading', { name: 'Рейсы', level: 1, exact: true })).toBeVisible();
  await fit(page, page.locator('.trips-page'), 'trips 320'); await shot(page, 'logistics-trips-320');
  await page.setViewportSize({ width: 1440, height: 1050 });
  check('Driver creation binds the selected vehicle; all required reference screens and mobile navigation remain usable without banking or administration');
  await page.getByRole('link', { name: 'Клиенты', exact: true }).click();
  await page.getByRole('button', { name: 'Редактировать: ИП ПолучательТестовый Тест', exact: true }).click(); dialog = page.getByRole('dialog');
  for (const label of ['Банк', 'Расчётный счёт', 'Корреспондентский счёт', 'БИК']) await expect(dialog.getByLabel(label, { exact: true })).toHaveCount(0);
  await dialog.getByLabel('Юридический адрес', { exact: true }).fill('QA Обновлённый юридический адрес');
  await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click(); await expect(dialog).toHaveCount(0);
  const privateCompany = (await rt.store.read(rt.source)).companies.find(row => row.id === 'customer');
  assert.equal(privateCompany.address, 'QA Обновлённый юридический адрес');
  assert.deepEqual([privateCompany.bankName, privateCompany.settlementAccount, privateCompany.correspondentAccount, privateCompany.bik], ['QA-PRIVATE-BANK', 'QA-PRIVATE-ACCOUNT', 'QA-PRIVATE-CORRESPONDENT', 'QA-PRIVATE-BIK']);
  await page.getByRole('link', { name: 'Рейсы', exact: true }).click();
  check('Company editor hides banking fields; saving logistics details preserves every existing private bank field in the shared store');

  // Browser ownership restrictions are backed by real scoped API denials.
  const employee = await context(390), employeePage = await employee.newPage();
  await login(employeePage, manager); await expect(employeePage.getByTestId('trip-card')).toHaveCount(2);
  await expect(employeePage.locator('body')).not.toContainText('QA-FOREIGN-PRIVATE-TRIP');
  const managerContext = await api(employee, '/api/logistics/context');
  assert.ok(!JSON.stringify(managerContext).includes('QA ЧУЖОЙ КЛИЕНТ'));
  assert.equal((await employee.request.get(base + `/api/logistics/shipment-trips/${foreign.id}`)).status(), 404);
  assert.equal((await employee.request.patch(base + `/api/logistics/shipment-trips/${foreign.id}`, { data: editBody(foreign) })).status(), 404);
  assert.equal((await employee.request.post(base + '/api/logistics/directories', { data: { kind: 'vehicles', plate: 'FORBIDDEN' } })).status(), 403);
  assert.equal((await employee.request.delete(base + `/api/logistics/shipment-trips/${trip.id}`, { data: { versions: versions(trip) } })).status(), 403);
  await expect(employeePage.getByRole('button', { name: /^Удалить рейс/ })).toHaveCount(0);
  await expect(employeePage.getByRole('link', { name: 'Автомобили', exact: true })).toHaveCount(0);
  await employeePage.getByTestId('trip-card').first().getByRole('button', { name: 'Изменить рейс', exact: true }).click();
  await expect(employeePage.getByRole('dialog')).toBeVisible();
  await expect(employeePage.getByRole('button', { name: 'Новое место в справочнике' })).toHaveCount(0);
  await employeePage.getByRole('dialog').getByTestId('trip-customer').first().getByRole('textbox', { name: 'Примечание к доставке', exact: true }).fill('QA own-trip manager edit');
  await employeePage.getByRole('button', { name: 'Сохранить рейс', exact: true }).click();
  await expect(employeePage.getByRole('dialog')).toHaveCount(0);
  assert.equal((await api(employee, tripPath)).trip.customers[0].fields.delivery_notes, 'QA own-trip manager edit');
  await shot(employeePage, 'manager-own-trips-390');
  const deniedContext = await context(), deniedPage = await deniedContext.newPage();
  await login(deniedPage, denied); await expect(deniedPage.getByRole('alert')).toBeVisible();
  await expect(deniedPage.getByTestId('trip-card')).toHaveCount(0);
  assert.equal((await deniedContext.request.get(base + '/api/logistics/context')).status(), 401);
  check('Trips-only manager sees only own trips, cannot read/edit foreign trips or mutate directories/delete trips; account lacking trips permission is denied at login');

  // Real server workflow with a synthetic Saby transport, preserving signing boundaries.
  const sabyCard = page.getByTestId('trip-card').filter({ hasText: '01.04.2025' });
  await expect(sabyCard).toHaveCount(2);
  const ownSabyCard = sabyCard.filter({ hasNotText: 'QA-FOREIGN-PRIVATE-TRIP' });
  await ownSabyCard.getByRole('button', { name: 'Saby', exact: true }).click();
  const panel = ownSabyCard.getByRole('region', { name: 'Документы рейса в Saby', exact: true });
  const workflowPath = `/api/logistics/shipment-trips/${rt.tripId}/saby-workflow`;
  const etrnPath = `/api/logistics/shipment-trips/${rt.tripId}/etrn`;
  const beforeSabyAccounting = structuredClone((await rt.store.read(rt.source)).shipments);
  const send = panel.getByRole('button', { name: 'Создать заявку в Saby', exact: true });
  await expect(send).toBeEnabled(); await send.evaluate(button => { button.click(); button.click(); });
  await reservationStarted; await expect(send).toBeDisabled(); releaseReservation();
  await expect(panel).toContainText('АРТЕЛЬ · подпись и отправка');
  assert.equal(transport.reserves('TransportOrder').length, 1); assert.equal(transport.writes('TransportOrder').length, 2); assert.equal(transport.writes('ConsignmentNote').length, 0);
  assert.equal((await api(logistics, workflowPath)).phase, 'awaiting_carrier');
  await expect(panel.getByRole('heading', { name: 'Фактическая погрузка', exact: true })).toHaveCount(0);
  check('Scoped Saby action tolerates a double click, reserves one order and waits for carrier acceptance without presenting signing as complete');
  transport.accept(); await panel.getByRole('button', { name: 'Обновить из Saby', exact: true }).click();
  await expect(panel.getByRole('heading', { name: 'Фактическая погрузка', exact: true })).toBeVisible();
  const factsForm = panel.locator('.etrn-loading-facts');
  await expect(factsForm.getByRole('button', { name: 'Сохранить погрузку и продолжить', exact: true })).toBeDisabled();
  const facts = rt.facts();
  await factsForm.getByLabel('Прибытие на погрузку · Москва', { exact: true }).fill(facts.arrivedAt);
  await factsForm.getByLabel('Убытие с погрузки · Москва', { exact: true }).fill(facts.departedAt);
  for (const [index, row] of rt.trip.customers.entries()) {
    const delivery = factsForm.locator('fieldset').nth(index), value = facts.deliveries[row.id];
    await delivery.getByLabel('Фактическая масса груза, т', { exact: true }).fill(value.grossMassTonnes);
    await delivery.getByLabel('Способ определения массы').selectOption(value.massMethod);
  }
  await factsForm.getByRole('checkbox', { name: 'Подтверждаю фактические сведения погрузки всего рейса' }).check();
  await factsForm.getByRole('button', { name: 'Сохранить погрузку и продолжить', exact: true }).click();
  await expect(panel).toContainText('ЭТрН созданы · ожидают обработки'); await expect(panel.locator('.etrn-delivery')).toHaveCount(2);
  assert.equal(transport.reserves('ConsignmentNote').length, 2);
  const etrn = await api(logistics, etrnPath); assert.ok(etrn.deliveries.every(row => row.document.signatureStatus === 'not_signed'));
  await expect(panel.getByText(/Подпись: Пока не подтверждена/)).toHaveCount(2);
  assert.deepEqual((await rt.store.read(rt.source)).shipments, beforeSabyAccounting);
  for (const [index, row] of etrn.deliveries.entries()) {
    const file = row.document.files.find(entry => entry.extension === 'xml'); assert.ok(file);
    const link = panel.locator('.etrn-delivery').nth(index).getByRole('link', { name: file.name, exact: true });
    await expect(link).toBeVisible();
    const href = await link.getAttribute('href'); assert.equal(href, file.url.replace(/^\/api\//, '/api/logistics/')); assert.match(href, /^\/api\/logistics\/shipment-trips\//);
    assert.equal((await fetch(base + href)).status, 401);
    const response = await logistics.request.get(base + href); assert.equal(response.status(), 200);
    const bytes = await response.body(); assert.ok(bytes.equals(blobs.get(`https://disk.saby.ru/${row.document.id}.xml`)));
    const downloadCount = downloads.length; await logistics.request.get(base + href); assert.equal(downloads.length, downloadCount);
    const savedFile = (await api(logistics, etrnPath)).deliveries[index].document.files.find(entry => entry.id === file.id);
    assert.equal(savedFile.sha256, createHash('sha256').update(bytes).digest('hex'));
  }
  check('Synthetic carrier acceptance plus explicit actual-loading facts create two separate CNs; scoped authenticated XML links return exact bytes and cache hashes, anonymous access fails');

  const writesBefore = transport.writes().length;
  runtime.replaceMiddleware(new SabyClient(config, provider));
  await page.reload(); await page.getByTestId('trip-card').filter({ hasText: '01.04.2025', hasNotText: 'QA-FOREIGN-PRIVATE-TRIP' }).getByRole('button', { name: 'Saby', exact: true }).click();
  await expect(panel).toContainText('ЭТрН созданы · ожидают обработки');
  assert.equal((await api(logistics, workflowPath, 'POST', {})).phase, 'completed');
  assert.equal(transport.writes().length, writesBefore);
  assert.equal((await logistics.request.patch(base + `/api/logistics/shipment-trips/${rt.tripId}`, { data: editBody(rt.trip) })).status(), 409);
  assert.equal((await logistics.request.delete(base + `/api/logistics/shipment-trips/${rt.tripId}`, { data: { versions: versions(rt.trip) } })).status(), 409);
  await ownSabyCard.getByRole('button', { name: /^Удалить рейс/ }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Рейс связан с документами Saby');
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Удалить рейс', exact: true })).toBeDisabled();
  await page.getByRole('dialog').getByRole('button', { name: 'Отмена', exact: true }).click();
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 }); await fit(page, panel, `Saby panel ${width}`); await shot(page, `logistics-saby-${width}`);
  }
  const publicState = JSON.stringify({ workflow: await api(logistics, workflowPath), etrn: await api(logistics, etrnPath) });
  for (const secret of [config.sessionId, 'https://disk.saby.ru/', 'ДвоичныеДанные']) assert.ok(!publicState.includes(secret));
  check('Middleware/browser reload preserves Saby IDs and artifacts, repeat does not create documents, sent trip edits/deletion fail and provider secrets/URLs remain private');

  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.getByTestId('trip-card').filter({ hasText: 'QA-REMOTE-CHANGE' }).getByRole('button', { name: /^Удалить рейс/ }).click();
  const deletion = page.getByRole('dialog'); await expect(deletion).toBeVisible();
  await deletion.getByRole('button', { name: 'Удалить рейс', exact: true }).click(); await expect(deletion).toHaveCount(0);
  await expect(page.getByTestId('trip-card')).toHaveCount(2);
  assert.equal((await api(main, '/api/shipments')).total, 3);
  check('Administrator confirms deletion of an unsent trip and both associated accounting rows are removed atomically');

  await page.getByRole('button', { name: 'Выйти', exact: true }).click();
  await expect(page.getByLabel('Логин', { exact: true })).toBeVisible();
  assert.ok((await api(main, '/api/auth/session')).user);
  assert.equal((await logistics.request.get(base + '/api/logistics/context')).status(), 401);
  await mainPage.goto(base + '/#shipments'); await expect(mainPage.locator('.shipment-grid')).toBeVisible();
  check('Logging out of logistics revokes only its session; the original CRM remains authenticated and operational');

  assert.ok(report.logisticsApiRequests.length > 10);
  assert.deepEqual(report.logisticsApiRequests.filter(request => !request.path.startsWith('/api/logistics/')), []);
  assert.deepEqual(report.browserErrors, []); assert.deepEqual(report.unexpectedExternalRequests, []);
  check('Every browser API request from logistics uses /api/logistics; no full snapshot, bank requests, external network or browser exceptions');
} catch (error) {
  report.failure = error.message;
  await page?.screenshot({ path: resolve(output, 'failure.png'), fullPage: true }).catch(() => {});
  for (const [contextIndex, context] of (browser?.contexts() ?? []).entries()) for (const [pageIndex, tab] of context.pages().entries()) {
    await writeFile(resolve(output, `failure-${contextIndex}-${pageIndex}.txt`), await tab.locator('body').innerText().catch(() => '')).catch(() => {});
  }
  throw error;
} finally {
  releaseReservation();
  for (const call of transport.calls) report.providerMethods[call.method] = (report.providerMethods[call.method] ?? 0) + 1;
  await browser?.close(); await runtime?.server.close(); await rt.close();
  if (previousSettings === undefined) delete process.env.SABY_AUTOFILL_PROFILE_JSON;
  else process.env.SABY_AUTOFILL_PROFILE_JSON = previousSettings;
  await writeFile(resolve(output, 'browser.json'), JSON.stringify(report, null, 2));
}
