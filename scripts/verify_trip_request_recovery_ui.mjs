// Recovery checks use isolated synthetic stores and the real local API only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium, webkit, expect } from '@playwright/test';
import { OperationsStore } from '../server/operations-store.ts';
import { SabyClient, sabyConfigFromEnv } from '../server/saby-client.ts';
import { startTripsQaServer, writeTripsQaSnapshot } from './qa-trips-runtime.mjs';
import { bootstrapQaAuth, authenticateContext } from './qa-auth.mjs';

const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'qa/trip-request-recovery-2026-10-08');
await mkdir(output, { recursive: true });
const report = { fixtureOnly: true, workingStoreAccessed: false, providerCalls: 0, stubbedTileRequests: 0, checks: [], browserErrors: [] };
const check = message => { report.checks.push(message); console.log('PASS', message); };
const company = (id, name, role) => ({ id, name, roles: [role], managerLabels: [], shipmentIds: [], paymentIds: [], flags: [] });
async function fixture() {
  const temporary = await mkdtemp(resolve(tmpdir(), 'artel-request-recovery-'));
  const snapshotDirectory = resolve(temporary, 'snapshot'), operationsDirectory = resolve(temporary, 'operations');
  const source = await writeTripsQaSnapshot(snapshotDirectory), store = new OperationsStore(operationsDirectory);
  await store.mutate(source, data => {
    data.sourceOperationsCleared = true;
    data.companies = [company('qa-supplier', 'Учебный поставщик', 'supplier'), company('qa-client', 'Учебный клиент', 'customer')];
    data.directories = {
      fleetSeedApplied: true, managers: [{ id: 'qa-manager', name: 'Учебный сотрудник' }], products: [{ id: 'qa-product', name: 'Дизель', transportProductKind: 'diesel', cargoPackaging: 'bulk' }], paymentForms: [{ id: 'qa-payment', name: 'б/нал' }],
      vehicles: [{ id: 'qa-vehicle', plate: 'Т000ЕЕ00', capacityLitres: '20000' }], drivers: [{ id: 'qa-driver', name: 'Учебный водитель', vehicleId: 'qa-vehicle' }],
      oilDepots: [{ id: 'qa-depot', name: 'Учебный терминал', address: 'Учебная погрузка, 1', ownerCompanyId: 'qa-supplier', loadingActorCompanyId: 'qa-supplier', infrastructureOwnerCompanyId: 'qa-supplier' }],
      addresses: [{ id: 'qa-place', companyId: 'qa-client', kind: 'delivery', name: 'Учебная база', address: 'Учебный адрес, 1' }], customerManagers: [{ companyId: 'qa-client', managerId: 'qa-manager' }], defaults: { profit: 'template-payment-form' }, duplicates: [],
    };
    return { result: null, changed: true };
  });
  const runtime = await startTripsQaServer({ root, snapshotDirectory, operationsDirectory, sabyClient: new SabyClient(sabyConfigFromEnv({}), async () => { report.providerCalls++; throw new Error('External provider requests forbidden'); }) });
  const { cookie } = await bootstrapQaAuth(runtime.base);
  const call = async (path, method = 'GET', body, credential = cookie) => {
    const response = await fetch(runtime.base + path, { method, headers: { Cookie: credential, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const result = await response.json(); assert.ok(response.ok, `${method} ${path}: ${response.status} ${result.error ?? ''}`); return result;
  };
  const newRequest = async (comment = 'Одинаковая заявка') => (await call('/api/trip-requests', 'POST', { companyId: 'qa-client', addressId: 'qa-place', quantityLitres: '1000', comment, idempotencyKey: randomUUID() })).request;
  const customer = request => ({ sourceRequestId: request.id, sourceRequestVersion: request.version, fields: { customer_id: request.companyId, manager_id: 'qa-manager', payment_form_id: 'qa-payment', quantity_litres: request.quantityLitres, sale_price_per_litre: '75', transport_amount: '0', unloading_address_id: request.addressId, delivery_notes: request.comment } });
  const tripBody = requests => ({ idempotencyKey: randomUUID(), fields: { trip_flow_version: 'driver-v1', loading_at: '2099-10-08T09:00', organization_id: 'artel', supplier_id: 'qa-supplier', oil_depot_id: 'qa-depot', product_id: 'qa-product', purchase_price_unspecified_unit: '60000', driver_id: 'qa-driver', vehicle_id: 'qa-vehicle', additional_costs: '0', trip_notes: 'Сохранённый общий ввод' }, customers: requests.map(customer) });
  return { ...runtime, source, store, cookie, call, newRequest, tripBody, async close() { await runtime.server.close(); await rm(temporary, { recursive: true, force: true }); } };
}
const choose = async (scope, label, text) => {
  await scope.getByRole('combobox', { name: new RegExp('^' + label) }).fill(text);
  await scope.getByRole('listbox').getByRole('option', { name: new RegExp(text) }).first().click();
};
async function openPage(browser, fixture, credential = fixture.cookie) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
  await context.route('**/api/trip-requests/geocode', route => route.fulfill({ json: { status: 'not_found', message: 'Synthetic fixture has no geocode result.' } }));
  await authenticateContext(context, fixture.base, credential);
  await context.route('https://tile.openstreetmap.org/**', route => {
    report.stubbedTileRequests++;
    return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#e9eee5"/></svg>' });
  });
  const page = await context.newPage(); page.on('pageerror', error => report.browserErrors.push(error.message));
  return { context, page };
}
async function choosePoint(dialog, latitude, longitude) {
  await dialog.getByRole('button', { name: /^(Выбрать|Изменить) точку на карте$/ }).click();
  await dialog.getByLabel('Широта точки', { exact: true }).fill(latitude);
  await dialog.getByLabel('Долгота точки', { exact: true }).fill(longitude);
  await dialog.getByRole('button', { name: 'Применить координаты', exact: true }).click();
}

let browser, current;
try {
  for (const [engine, launcher] of [['chromium', chromium], ['webkit', webkit]]) {
    browser = await launcher.launch({ headless: true });
    current = await fixture();
    {
      const { page, context } = await openPage(browser, current);
      await page.goto(current.base + '/#trips');
      await page.getByRole('button', { name: 'Новая заявка', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await choose(dialog, 'Компания', 'Учебный клиент'); await choose(dialog, 'Место доставки', 'Учебная база');
      await dialog.getByLabel('Количество литров, л', { exact: false }).fill('1000');
      await choosePoint(dialog, '55.712345', '37.623456');
      const bodies = []; let committed;
      await page.route('**/api/trip-requests', async route => {
        if (route.request().method() !== 'POST') { await route.continue(); return; }
        bodies.push(route.request().postData());
        const response = await route.fetch();
        if (bodies.length === 1) { committed = (await response.json()).request; await route.abort('failed'); }
        else await route.fulfill({ response });
      });
      await dialog.getByRole('button', { name: 'Сохранить заявку', exact: true }).click();
      await expect(dialog.getByRole('button', { name: 'Повторить сохранение', exact: true })).toBeVisible();
      assert.ok(committed?.id);
      await current.call('/api/shipment-trips', 'POST', current.tripBody([committed]));
      // A legitimate catalog change after consumption hides the company from active lookup.
      await current.store.mutate(current.source, data => { data.companies.find(row => row.id === 'qa-client').directoryArchived = true; return { result: null, changed: true }; });
      // Focus refresh was deliberately removed from TripsPage. Retry must still
      // replay the stored body after authoritative server-side catalog archival.
      await dialog.getByRole('button', { name: 'Повторить сохранение', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      assert.equal(bodies.length, 2); assert.equal(bodies[0], bodies[1]);
      assert.equal(JSON.parse(bodies[0]).latitude, '55.712345'); assert.equal(JSON.parse(bodies[0]).longitude, '37.623456');
      const stored = await current.store.read(current.source);
      assert.equal(Object.keys(stored.tripRequests).length, 1); assert.equal(stored.tripRequests[committed.id].status, 'consumed');
      assert.equal(stored.tripRequests[committed.id].latitude, '55.712345');
      assert.equal(stored.directories.addresses[0].latitude, undefined);
      check(`${engine}: lost creation reply replays byte-identical selected point after company archival; consumed request is not duplicated and directory is unchanged`);
      await context.close();
    }
    await current.close(); current = await fixture();
    for (const mode of ['same-point', 'different-point', 'omitted-point', 'different-date']) {
      const source = await current.newRequest(`PATCH recovery ${mode}`);
      const { page, context } = await openPage(browser, current);
      await page.goto(current.base + '/#trips');
      await page.getByTestId('trip-request-card').filter({ hasText: source.comment }).getByRole('button', { name: /^Изменить заявку:/ }).click();
      const dialog = page.getByRole('dialog');
      if (mode === 'omitted-point') await dialog.getByLabel('Количество литров, л', { exact: false }).fill('1001');
      else await choosePoint(dialog, '55.712345', '37.623456');
      const bodies = [];
      await page.route(`**/api/trip-requests/${source.id}`, async route => {
        if (route.request().method() !== 'PATCH') { await route.continue(); return; }
        bodies.push(route.request().postData());
        const submitted = route.request().postDataJSON();
        const actual = bodies.length === 1 && mode === 'different-date' ? { ...submitted, executionDate: '2099-11-01' } : bodies.length === 1 && mode !== 'same-point' ? { ...submitted, latitude: '55.8', longitude: '37.9' } : submitted;
        const response = await route.fetch({ postData: JSON.stringify(actual) });
        if (bodies.length === 1) { assert.equal(response.status(), 200); await route.abort('failed'); }
        else await route.fulfill({ response });
      });
      await dialog.getByRole('button', { name: 'Сохранить заявку', exact: true }).click();
      await expect(dialog.getByRole('button', { name: 'Повторить сохранение', exact: true })).toBeVisible();
      await dialog.getByRole('button', { name: 'Повторить сохранение', exact: true }).click();
      if (mode === 'same-point') await expect(dialog).toHaveCount(0);
      else {
        await expect(dialog.getByRole('button', { name: 'Загрузить актуальную заявку', exact: true })).toBeVisible();
        await expect(dialog).toBeVisible();
        await dialog.getByRole('button', { name: 'Загрузить актуальную заявку', exact: true }).click();
        if (mode === 'different-date') await expect(dialog.getByLabel('Дата выполнения', { exact: true })).toHaveValue('2099-11-01');
        else await expect(dialog.getByText('Точка выбрана: 55.800000, 37.900000', { exact: true })).toBeVisible();
        await expect(dialog.getByRole('button', { name: 'Сохранить заявку', exact: true })).toBeDisabled();
        await dialog.getByRole('button', { name: 'Отмена', exact: true }).click();
        await expect(dialog).toHaveCount(0);
      }
      assert.equal(bodies.length, 2); assert.equal(bodies[0], bodies[1]);
      const stored = (await current.store.read(current.source)).tripRequests[source.id];
      assert.equal(stored.latitude, ['same-point', 'different-date'].includes(mode) ? '55.712345' : '55.8');
      assert.equal(new URL(stored.mapUrl).searchParams.get('pt'), ['same-point', 'different-date'].includes(mode) ? '37.623456,55.712345' : '37.9,55.8');
      check(`${engine}: lost PATCH ${mode} replays identical body; recovery validates point and navigation URL alongside litres/comment`);
      await context.close();
    }
    await current.close(); current = await fixture();
    {
      const initial = await current.newRequest('Исходная доставка'), a = await current.newRequest(), b = await current.newRequest();
      const original = (await current.call('/api/shipment-trips', 'POST', current.tripBody([initial]))).trip;
      const { page, context } = await openPage(browser, current);
      await page.goto(current.base + '/#trips');
      await page.getByRole('group', { name: 'Разделы рейсов', exact: true }).getByRole('button', { name: 'Рейсы', exact: true }).click();
      await page.getByRole('button', { name: 'Изменить рейс', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('button', { name: 'Добавить клиента', exact: true }).click();
      const row = dialog.getByTestId('trip-customer').nth(1);
      await choose(row, 'Заявка на доставку', 'Учебный клиент');
      await row.getByLabel('Цена за литр, ₽', { exact: false }).fill('75');
      let requestedSource, committedSource, intercepted = 0;
      await page.route(`**/api/shipment-trips/${original.id}`, async route => {
        if (route.request().method() !== 'PATCH') { await route.continue(); return; }
        intercepted++;
        const body = route.request().postDataJSON();
        const added = body.customers.find(customer => !customer.id);
        requestedSource = added.sourceRequestId;
        const other = requestedSource === a.id ? b : a; committedSource = other.id;
        added.sourceRequestId = other.id; added.sourceRequestVersion = other.version;
        const response = await route.fetch({ postData: JSON.stringify(body) });
        assert.equal(response.status(), 200, (await response.text()));
        await route.abort('failed');
      });
      await dialog.getByRole('button', { name: 'Сохранить рейс', exact: true }).click();
      await expect(dialog.getByRole('alert')).toContainText('Рейс изменён в другом окне');
      await expect(dialog.getByRole('button', { name: 'Загрузить актуальный рейс', exact: true })).toBeVisible();
      await expect(dialog.locator('.trip-notes textarea')).toHaveValue('Сохранённый общий ввод');
      assert.equal(intercepted, 1);
      const stored = await current.store.read(current.source);
      assert.equal(stored.tripRequests[requestedSource].status, 'active'); assert.equal(stored.tripRequests[committedSource].status, 'consumed');
      check(`${engine}: PATCH recovery rejects identical business fields from a different source request and preserves common input`);
      await context.close();
    }
    {
      const password = randomUUID();
      await current.call('/api/auth/users', 'POST', { name: 'Только отгрузки', login: 'shipments-only', password, role: 'employee', managerId: 'qa-manager', sections: ['shipments'] });
      const login = await fetch(current.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: 'shipments-only', password }) });
      assert.equal(login.status, 200);
      const credential = login.headers.get('set-cookie').split(';')[0];
      const { page, context } = await openPage(browser, current, credential);
      await page.goto(current.base + '/#shipments');
      await page.getByRole('button', { name: 'Добавить отгрузку', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog.getByRole('alert')).toContainText('нужен доступ к разделу «Рейсы»');
      await expect(dialog.getByRole('button', { name: 'Повторить загрузку заявок', exact: true })).toHaveCount(0);
      check(`${engine}: shipments-only account sees explicit trips permission requirement, without futile reload`);
      await context.close();
    }
    await current.close(); current = null; await browser.close(); browser = null;
  }
  assert.equal(report.providerCalls, 0); assert.deepEqual(report.browserErrors, []); report.passed = true;
} catch (error) { report.passed = false; report.error = error.message; throw error; }
finally { await browser?.close(); await current?.close(); await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2)); }
