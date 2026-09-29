import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { tsImport } from 'tsx/esm/api';
import { bootstrapQaAuth, authenticateContext } from './qa-auth.mjs';
import { writeTripsQaSnapshot, startTripsQaServer } from './qa-trips-runtime.mjs';

const root = resolve(import.meta.dirname, '..'), port = 5199, base = `http://127.0.0.1:${port}`;
const temporary = await mkdtemp(resolve(tmpdir(), 'artel-trips-ui-'));
const output = resolve(root, 'qa/trips-2026-09-28'); await mkdir(output, { recursive: true });
const { OperationsStore } = await tsImport('../server/operations-store.ts', import.meta.url);
const { loadSnapshot } = await tsImport('../server/local-api.ts', import.meta.url);
const snapshotDirectory = resolve(temporary, 'snapshot'), operationsDirectory = resolve(temporary, 'store');
await writeTripsQaSnapshot(snapshotDirectory);
const snapshot = await loadSnapshot(snapshotDirectory);
const company = (id, name, role) => ({ id, name, roles: [role], managerLabels: [], shipmentIds: [], paymentIds: [], flags: [] });
await new OperationsStore(operationsDirectory).mutate(snapshot.provenance.sourceSha256, data => {
  data.sourceOperationsCleared = true; data.shipments = {}; data.paymentAllocations = [];
  data.companies = [company('qa-supplier', 'QA Склад', 'supplier'), company('qa-customer-a', 'QA Клиент А', 'customer'), company('qa-customer-b', 'QA Клиент Б', 'customer')];
  data.directories = {
    fleetSeedApplied: true, managers: [{ id: 'qa-manager', name: 'QA Сотрудник' }], products: [{ id: 'qa-product', name: 'QA Топливо' }], paymentForms: [{ id: 'qa-cashless', name: 'б/нал' }],
    vehicles: [{ id: 'qa-vehicle', plate: 'Т000ЕЕ00', capacityLitres: '15000', compartmentsLitres: ['5000', '5000', '5000'] }],
    drivers: [{ id: 'qa-driver', name: 'QA Водитель', phone: '+79000000000', vehicleId: 'qa-vehicle' }],
    addresses: [{ id: 'qa-delivery-a', name: 'QA Площадка А', companyId: 'qa-customer-a', kind: 'delivery', address: 'Синтетический проезд, 1', mapUrl: 'https://yandex.ru/maps/?text=QA' }, { id: 'qa-delivery-b', name: 'QA Площадка Б', companyId: 'qa-customer-b', kind: 'delivery', address: 'Синтетический проезд, 2' }],
    customerManagers: [{ companyId: 'qa-customer-a', managerId: 'qa-manager' }, { companyId: 'qa-customer-b', managerId: 'qa-manager' }], defaults: { profit: 'template-payment-form' }, duplicates: [],
  };
  return { result: null, changed: true };
});
const report = { fixtureOnly: true, workingStoreAccessed: false, checks: [], errors: [], screenshots: [], overflows: [] };
const check = text => { report.checks.push(text); console.log('PASS', text); };
let server, browser, page;
try {
  await assert.rejects(fetch(base, { signal: AbortSignal.timeout(500) }));
  // An explicitly unconfigured injected client prevents ambient Saby credentials from being read.
  const { SabyClient, sabyConfigFromEnv } = await tsImport('../server/saby-client.ts', import.meta.url);
  const sabyClient = new SabyClient(sabyConfigFromEnv({}), async () => { throw new Error('No Saby network allowed in unconfigured UI QA'); });
  ({ server } = await startTripsQaServer({ root, snapshotDirectory, operationsDirectory, sabyClient, port }));
  const { cookie } = await bootstrapQaAuth(base);
  browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const admin = await browser.newContext({ viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  await authenticateContext(admin, base, cookie); page = await admin.newPage(); page.on('pageerror', error => report.errors.push(error.message));
  const choose = async (scope, label, name) => { const input = scope.getByRole('combobox', { name: new RegExp('^' + label) }); await input.fill(name); await scope.getByRole('listbox').getByRole('option').first().click(); await expect(input).toHaveValue(name); };
  const shot = async name => { const path = resolve(output, name + '.png'); await page.screenshot({ path, fullPage: true }); report.screenshots.push(path); };
  await page.goto(base + '/#trips'); await expect(page.getByRole('heading', { name: 'Рейсов пока нет' })).toBeVisible();
  await page.getByRole('button', { name: 'Новый рейс', exact: true }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Сохранить рейс', exact: true }).click(); await expect(dialog.getByRole('alert')).toContainText('Выберите нашу организацию');
  await choose(dialog, 'Наша организация', 'НК АРТЕЛЬ'); await dialog.getByLabel('Дата отгрузки', { exact: false }).fill('2026-09-28');
  await choose(dialog, 'Поставщик', 'QA Склад');
  await dialog.getByRole('button', { name: 'Новое место в справочнике' }).first().click();
  await dialog.getByLabel('Название нового места').fill('QA Погрузка'); await dialog.getByLabel('Адрес новой площадки').fill('Синтетическая улица, 10');
  await dialog.getByLabel('Ссылка нового места на Яндекс.Карты').fill('https://yandex.ru/maps/?text=QA-loading');
  await dialog.getByRole('button', { name: 'Добавить место', exact: true }).click(); await expect(dialog.getByRole('combobox', { name: 'Место загрузки', exact: true })).toHaveValue('QA Погрузка');
  await dialog.getByLabel('Плановая погрузка', { exact: true }).fill('2026-09-28T10:30');
  await dialog.getByLabel('Цена поставщика за тонну, ₽', { exact: false }).fill('90000'); await dialog.getByLabel('Тоннаж всей машины, т', { exact: false }).fill('8'); await choose(dialog, 'Товар', 'QA Топливо');
  for (const [index, name, litres, delivery] of [[0, 'QA Клиент А', '6000', '8000'], [1, 'QA Клиент Б', '4000', '6000']]) {
    if (index) await dialog.getByRole('button', { name: 'Добавить клиента', exact: true }).click();
    const row = dialog.getByTestId('trip-customer').nth(index);
    await choose(row, 'Клиент', name); await row.getByLabel('Количество литров, л', { exact: false }).fill(litres); await row.getByLabel('Цена за литр, ₽', { exact: false }).fill('85'); await row.getByLabel('Сумма перевозки, ₽', { exact: true }).fill(delivery);
    await choose(row, 'Место выгрузки', index ? 'QA Площадка Б' : 'QA Площадка А'); await row.getByLabel('Плановая выгрузка').fill(`2026-09-28T${index ? '14' : '12'}:30`);
    await row.getByLabel('Примечание к доставке').fill(`Пометка клиента ${index + 1}`); if (!index) await row.getByLabel('Счёт не нужен').check();
  }
  await choose(dialog, 'Перевозчик / водитель', 'QA Водитель'); await dialog.getByLabel('Примечание к рейсу').fill('Синтетический рейс для проверки');
  for (const width of [1440, 390, 320]) { await page.setViewportSize({ width, height: 1000 }); const sizes = await dialog.evaluate(node => ({ width: innerWidth, scroll: node.scrollWidth, client: node.clientWidth })); if (sizes.scroll > sizes.client + 1) report.overflows.push(sizes); await shot(`editor-${width}`); }
  await page.setViewportSize({ width: 1440, height: 1050 });
  // The server commits the first request, then the response is deliberately lost.
  let dropped = false, firstBody;
  await page.route('**/api/shipment-trips', async route => {
    if (route.request().method() !== 'POST' || dropped) return route.continue();
    dropped = true; firstBody = route.request().postDataJSON(); const response = await route.fetch(); assert.equal(response.status(), 201); await route.abort('connectionfailed');
  });
  await dialog.getByRole('button', { name: 'Сохранить рейс', exact: true }).click(); await expect(dialog.getByRole('button', { name: 'Повторить сохранение', exact: true })).toBeVisible();
  await expect(dialog.getByLabel('Примечание к рейсу')).toBeDisabled();
  await dialog.getByRole('button', { name: 'Повторить сохранение', exact: true }).click(); await expect(dialog).toHaveCount(0); await page.unroute('**/api/shipment-trips');
  await expect(page.getByTestId('trip-card')).toHaveCount(1); await expect(page.getByTestId('trip-card')).toContainText('Счёт не нужен');
  let trips = (await (await admin.request.get(base + '/api/shipment-trips')).json()).trips; assert.equal(trips.length, 1); let trip = trips[0];
  assert.equal(trip.customers.length, 2); assert.equal(trip.fields.loading_planned_at, '2026-09-28T10:30'); assert.equal(trip.fields.loading_actual_at, null);
  assert.equal(trip.customers[0].fields.invoice_not_required, 'true'); assert.equal(trip.customers[0].fields.transport_amount, '8000'); assert.equal(trip.customers[1].fields.transport_amount, '6000');
  assert.equal((await (await admin.request.get(base + '/api/shipments')).json()).total, 2); assert.ok(firstBody.idempotencyKey);
  check('Multi-customer trip creates two accounting rows once, even when the successful first response is lost; retry keeps the same key and payload');
  const loadingId = trip.fields.loading_address_id;
  await page.goto(base + '/#directories'); await page.getByRole('button', { name: 'Места погрузки и доставки', exact: true }).click(); await page.getByRole('button', { name: 'Редактировать: QA Погрузка', exact: true }).click();
  dialog = page.getByRole('dialog'); await dialog.getByLabel('Фактический адрес площадки', { exact: true }).fill('Другой синтетический адрес, 99'); await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click(); await expect(dialog).toHaveCount(0);
  await page.goto(base + '/#trips'); await expect(page.getByTestId('trip-card')).toContainText('Синтетическая улица, 10'); await expect(page.getByTestId('trip-card')).not.toContainText('Другой синтетический адрес');
  let savedPatchBody;
  await page.route('**/api/shipment-trips/*', async route => {
    if (route.request().method() !== 'PATCH') return route.continue();
    savedPatchBody = route.request().postDataJSON(); const response = await route.fetch(); assert.equal(response.status(), 200); await route.abort('connectionfailed');
  });
  await page.getByRole('button', { name: 'Изменить рейс', exact: true }).click(); dialog = page.getByRole('dialog'); await expect(dialog.getByLabel('Счёт не нужен').first()).toBeChecked(); await expect(dialog.getByLabel('Плановая погрузка')).toHaveValue('2026-09-28T10:30'); await dialog.getByLabel('Примечание к рейсу').fill('Рейс после редактирования'); await dialog.getByRole('button', { name: 'Сохранить рейс', exact: true }).click(); await expect(dialog).toHaveCount(0);
  await page.unroute('**/api/shipment-trips/*');
  trip = (await (await admin.request.get(base + '/api/shipment-trips')).json()).trips[0]; assert.equal(trip.fields.loading_address, 'Синтетическая улица, 10'); assert.equal(trip.fields.loading_address_id, loadingId); assert.equal((await (await admin.request.get(base + '/api/shipments')).json()).total, 2);
  check('A lost PATCH response is reconciled against all saved fields and customer IDs without duplicating or overwriting the trip');
  await page.getByRole('button', { name: 'Изменить рейс', exact: true }).click(); dialog = page.getByRole('dialog'); await expect(dialog.getByLabel('Примечание к рейсу')).toHaveValue('Рейс после редактирования');
  const concurrent = { ...savedPatchBody, fields: { ...savedPatchBody.fields, trip_notes: 'Изменено другим сотрудником' }, versions: Object.fromEntries(trip.customers.map(row => [row.id, row.version])) };
  assert.equal((await admin.request.patch(base + '/api/shipment-trips/' + trip.id, { data: concurrent })).status(), 200);
  await dialog.getByLabel('Примечание к рейсу').fill('Несохранённое изменение'); await dialog.getByRole('button', { name: 'Сохранить рейс', exact: true }).click(); await expect(dialog.getByRole('alert')).toContainText('изменён в другом окне'); await expect(dialog.getByRole('button', { name: 'Сохранить рейс', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Загрузить актуальный рейс', exact: true }).click(); await expect(dialog.getByLabel('Примечание к рейсу')).toHaveValue('Изменено другим сотрудником'); await dialog.getByRole('button', { name: 'Закрыть редактор', exact: true }).click();
  check('Concurrent PATCH conflicts require an explicit reload and cannot silently overwrite newer changes');
  check('Reusable locations are created in the editor and edited in Directories; historical route snapshots survive both directory and trip edits');
  await page.goto(base + '/#trips'); if (await page.getByRole('button', { name: 'Saby', exact: true }).getAttribute('aria-expanded') !== 'true') await page.getByRole('button', { name: 'Saby', exact: true }).click();
  const etrnPanel = page.getByRole('region', { name: 'ЭТрН в Saby', exact: true });
  await expect(etrnPanel).toContainText('Подключение не настроено');
  for (const button of await etrnPanel.getByRole('button', { name: 'Создать ЭТрН в Saby', exact: true }).all()) await expect(button).toBeDisabled();
  const syntheticEtrn = await (await admin.request.get(base + `/api/shipment-trips/${trip.id}/etrn`)).json();
  syntheticEtrn.configured = true; syntheticEtrn.configurationBlockers = [];
  syntheticEtrn.deliveries[0].document = { id: null, revision: null, status: 'unknown', url: null, remoteStatus: null, lastError: null, updatedAt: new Date().toISOString(), files: [], signatureStatus: 'unknown', gisStatus: null, availableActions: [] };
  let reconciliations = 0;
  await page.route('**/api/shipment-trips/*/etrn**', async route => {
    if (route.request().method() === 'POST') {
      assert.ok(route.request().url().endsWith('/refresh')); assert.equal(route.request().postDataJSON().shipmentId, trip.customers[0].id); reconciliations++;
      syntheticEtrn.deliveries[0].document = { ...syntheticEtrn.deliveries[0].document, id: 'synthetic-document', revision: 'synthetic-revision', status: 'draft', remoteStatus: 'Черновик', signatureStatus: 'not_signed', url: 'https://saby.ru/' };
    }
    await route.fulfill({ json: syntheticEtrn });
  });
  await page.getByRole('button', { name: 'Saby', exact: true }).click(); await page.getByRole('button', { name: 'Saby', exact: true }).click();
  await etrnPanel.getByRole('button', { name: 'Сверить с Saby', exact: true }).click(); await expect(etrnPanel).toContainText('Создано в Saby'); await expect(etrnPanel).toContainText('Подпись не получена'); assert.equal(reconciliations, 1);
  await expect(etrnPanel.getByTestId('etrn-delivery').first().getByRole('button', { name: 'Создать ЭТрН в Saby', exact: true })).toHaveCount(0);
  await page.unroute('**/api/shipment-trips/*/etrn**');
  check('ETRN UI exposes configuration blockers and reconciles an unknown result without another creation; synthetic draft, signature and GIS are displayed separately');
  for (const width of [1440, 390, 320]) { await page.setViewportSize({ width, height: 1000 }); const dimensions = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth })); if (dimensions.scroll > width + 1) report.overflows.push(dimensions); await shot(`trips-${width}`); }
  await page.setViewportSize({ width: 1440, height: 1050 }); await page.goto(base + '/#accounts'); await page.getByRole('button', { name: 'Добавить пользователя', exact: true }).click();
  const credentials = { login: 'qa.trips', password: randomUUID() };
  await page.getByLabel('Сотрудник справочника', { exact: true }).selectOption('qa-manager'); await page.getByLabel('Логин', { exact: true }).fill(credentials.login); await page.getByLabel('Пароль', { exact: true }).fill(credentials.password);
  for (const checkbox of await page.locator('.account-section-grid input').all()) await checkbox.uncheck(); await page.getByRole('checkbox', { name: 'Рейсы', exact: true }).check(); await page.getByRole('button', { name: 'Сохранить пользователя', exact: true }).click(); await expect(page.locator('.account-form')).toHaveCount(0);
  const employee = await browser.newContext({ viewport: { width: 390, height: 1000 }, serviceWorkers: 'block' }); const employeePage = await employee.newPage(); employeePage.on('pageerror', error => report.errors.push(error.message));
  await employeePage.goto(base); await employeePage.getByLabel('Логин', { exact: true }).fill(credentials.login); await employeePage.getByLabel('Пароль', { exact: true }).fill(credentials.password); await employeePage.getByRole('button', { name: 'Войти', exact: true }).click(); await expect(employeePage.getByRole('heading', { name: 'Рейсы', exact: true })).toBeVisible(); await expect(employeePage.getByTestId('trip-card')).toHaveCount(1);
  assert.equal((await employee.request.get(base + '/api/shipment-trips')).status(), 200); assert.equal((await employee.request.get(base + '/api/shipments')).status(), 403);
  await employeePage.getByRole('button', { name: 'Изменить рейс', exact: true }).click(); await expect(employeePage.getByRole('button', { name: 'Новое место в справочнике' })).toHaveCount(0); await employeePage.getByRole('button', { name: 'Закрыть редактор', exact: true }).click();
  await page.locator('.account-row').filter({ hasText: credentials.login }).getByRole('button', { name: 'Изменить', exact: true }).click(); await page.getByRole('checkbox', { name: 'Рейсы', exact: true }).uncheck(); await page.getByRole('button', { name: 'Сохранить пользователя', exact: true }).click(); await expect(page.locator('.account-form')).toHaveCount(0);
  assert.equal((await employee.request.get(base + '/api/shipment-trips')).status(), 401); assert.equal((await employee.request.post(base + '/api/auth/login', { data: credentials })).status(), 200); assert.equal((await employee.request.get(base + '/api/shipment-trips')).status(), 403);
  await employeePage.goto(base + '/#trips'); await employeePage.reload(); await expect(employeePage.getByRole('alert')).toContainText('Раздел недоступен'); await expect(employeePage.getByTestId('trip-card')).toHaveCount(0);
  check('Administrator grants and revokes Trips independently; trips-only employee starts on Trips, sees only allowed data, cannot access Shipments or manage directory places, and loses direct/API access on revoke');
  assert.deepEqual(report.errors, []); assert.deepEqual(report.overflows, []);
} catch (error) {
  if (page) { await page.screenshot({ path: resolve(output, 'failure.png'), fullPage: true }).catch(() => {}); console.error(await page.locator('body').innerText().catch(() => '')); }
  throw error;
} finally {
  await browser?.close(); await server?.close();
  await rm(temporary, { recursive: true, force: true }); await writeFile(resolve(output, 'browser.json'), JSON.stringify(report, null, 2));
}
