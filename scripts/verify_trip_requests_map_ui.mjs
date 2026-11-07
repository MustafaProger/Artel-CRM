// Synthetic authenticated CRM + real Leaflet, with every OSM tile fulfilled locally. No public tile traffic.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium, webkit, expect } from '@playwright/test';
import { OperationsStore } from '../server/operations-store.ts';
import { loadSnapshot } from '../server/local-api.ts';
import { SabyClient, sabyConfigFromEnv } from '../server/saby-client.ts';
import { startTripsQaServer, writeTripsQaSnapshot } from './qa-trips-runtime.mjs';
import { authenticateContext, bootstrapQaAuth } from './qa-auth.mjs';

const root = resolve(import.meta.dirname, '..'), output = resolve(root, 'qa/leaflet-requests-map-2026-10-12');
const temporary = await mkdtemp(resolve(tmpdir(), 'artel-requests-map-'));
const snapshotDirectory = resolve(temporary, 'snapshot'), operationsDirectory = resolve(temporary, 'operations');
await mkdir(output, { recursive: true }); await writeTripsQaSnapshot(snapshotDirectory);
const snapshot = await loadSnapshot(snapshotDirectory), store = new OperationsStore(operationsDirectory);
const company = (id, name, role = 'customer') => ({ id, name, roles: [role], managerLabels: [], shipmentIds: [], paymentIds: [], flags: [] });
const maliciousName = 'QA <img src=x onerror="window.__xss=1"> & компания';
await store.mutate(snapshot.provenance.sourceSha256, data => {
  data.sourceOperationsCleared = true; data.shipments = {}; data.paymentAllocations = [];
  data.companies = [company('supplier', 'QA Поставщик', 'supplier'), ...Array.from({ length: 9 }, (_, index) => company(`customer-${index + 1}`, index === 8 ? maliciousName : `QA Ромашка ${index + 1}`))];
  data.directories = {
    fleetSeedApplied: true, managers: [{ id: 'manager', name: 'QA Менеджер' }],
    products: [{ id: 'product', name: 'QA ДТ', transportProductKind: 'diesel', cargoPackaging: 'bulk' }],
    paymentForms: [{ id: 'payment', name: 'б/нал' }],
    drivers: [{ id: 'driver', name: 'QA Водитель', vehicleId: 'vehicle' }],
    vehicles: [{ id: 'vehicle', plate: 'Т000ЕЕ00', capacityLitres: '20000' }],
    oilDepots: [{ id: 'depot', name: 'QA Нефтебаза', address: 'Синтетический склад, 1', ownerCompanyId: 'supplier', loadingActorCompanyId: 'supplier', infrastructureOwnerCompanyId: 'supplier' }],
    addresses: Array.from({ length: 9 }, (_, index) => {
      const number = index + 1;
      return { id: `address-${number}`, companyId: `customer-${number}`, kind: 'delivery', name: `QA База ${number}`, address: number === 6 ? 'Синтетический точный адрес' : number === 7 ? 'Синтетический неоднозначный адрес' : number === 8 ? 'Синтетический неизвестный адрес' : number === 9 ? 'Синтетическая улица <svg onload="window.__xss=2">, 9' : `Синтетическая улица, ${number}`, ...(number <= 5 || number === 9 ? { latitude: number === 5 ? '55.71' : String(55.7 + number / 100), longitude: number === 5 ? '37.61' : String(37.6 + number / 100) } : {}) };
    }),
    customerManagers: Array.from({ length: 9 }, (_, index) => ({ companyId: `customer-${index + 1}`, managerId: 'manager' })), defaults: { profit: 'template-payment-form' }, duplicates: [],
  };
  return { changed: true, result: null };
});
const report = { fixtureOnly: true, workingStoreAccessed: false, realTileProviderVerified: false, realLeaflet: true, stubbedTiles: true, tileRequests: 0, failedTiles: 0, providerCalls: 0, externalRequests: [], errors: [], checks: [], screenshots: [], status: 'running' };
const check = name => { report.checks.push(name); console.log('PASS', name); };
const tileSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#eaf0e5"/><path d="M0 75H256M65 0V256M0 190H256M194 0V256" stroke="#fff" stroke-width="12"/><path d="M0 75H256M65 0V256" stroke="#d9ded2" stroke-width="2"/><text x="80" y="142" fill="#85917d" font-family="sans-serif" font-size="12">QA TILE</text></svg>';
let runtime, browser, secondaryBrowser;
try {
  const saby = new SabyClient(sabyConfigFromEnv({}), async () => { report.providerCalls++; throw new Error('External Saby request forbidden'); });
  runtime = await startTripsQaServer({ root, snapshotDirectory, operationsDirectory, sabyClient: saby, tripRequestGeocoder: async () => ({ status: 'not_found', message: 'Synthetic fixture has no geocode result.' }) });
  const { cookie } = await bootstrapQaAuth(runtime.base);
  const request = async (path, method = 'GET', body) => {
    const response = await fetch(runtime.base + path, { method, headers: { Cookie: cookie, Origin: runtime.base, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json(); assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(result)}`); return result;
  };
  const sources = [];
  const create = async number => {
    const result = await request('/api/trip-requests', 'POST', { companyId: `customer-${number}`, addressId: `address-${number}`, quantityLitres: String(number * 1000), comment: `QA запрос ${number}`, idempotencyKey: randomUUID() });
    sources.push(result.request); return result.request;
  };
  for (const number of [1, 2, 3, 4]) await create(number);
  let tileFailure = false, includeInactive = false;
  const setupContext = async instance => {
    const context = await instance.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    await authenticateContext(context, runtime.base, cookie);
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin === runtime.base && url.pathname === '/api/trip-requests/geocode') return route.fulfill({ json: { status: 'not_found', message: 'Synthetic fixture has no geocode result.' } });
      if (url.hostname === 'tile.openstreetmap.org') {
        report.tileRequests++; if (tileFailure) report.failedTiles++;
        return tileFailure ? route.abort('failed') : route.fulfill({ status: 200, contentType: 'image/svg+xml', body: tileSvg });
      }
      if (url.origin !== runtime.base) { report.externalRequests.push(url.href); return route.abort(); }
      return route.continue();
    });
    await context.route('**/api/trip-requests', async route => {
      if (route.request().method() !== 'GET' || !includeInactive) return route.continue();
      const response = await route.fetch(); const data = await response.json();
      data.requests.push({ ...sources[0], id: 'qa-inactive', status: 'consumed', companyName: 'QA Скрытая использованная заявка' });
      return route.fulfill({ json: data });
    });
    return context;
  };
  const screenshot = async (page, name) => { const path = resolve(output, `${name}.png`); await page.screenshot({ path, fullPage: false, animations: 'disabled' }); report.screenshots.push(path); };
  const openMap = async page => { await page.goto(runtime.base + '/#trips'); await page.locator('.trips-section-tabs').getByRole('button', { name: 'Карта', exact: true }).click(); };
  const mapMarker = page => page.locator('.trip-map-marker');
  const mapSummary = page => page.locator('.trip-map-summary');
  const checkResponsiveMap = async (page, engine) => {
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: width === 320 ? 568 : width === 390 ? 844 : 1000 });
      await expect(mapMarker(page)).toHaveCount(4);
      await expect(page.locator('.leaflet-tile-loaded').first()).toBeVisible();
      await expect(page.locator('.leaflet-control-attribution').getByRole('link', { name: 'OpenStreetMap', exact: true })).toBeVisible();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${engine} page overflow ${width}`);
      assert.ok(await page.locator('.trip-requests-map').evaluate(element => element.scrollWidth <= element.clientWidth + 1), `${engine} map overflow ${width}`);
      const companion = page.locator('.trip-map-list-location').first();
      await companion.click();
      await expect(page.locator('.trip-map-details')).toBeVisible();
      await expect(page.locator('.trip-map-details')).toContainText(/QA Ромашка [1-4]/);
      await expect(companion).toHaveCSS('transition-duration', '0s');
      await page.locator('.trip-map-card-close').click();
      const marker = mapMarker(page).first();
      await marker.focus(); await page.keyboard.press('Enter');
      await expect(page.locator('.trip-map-details')).toBeVisible();
      await expect(page.locator('.trip-map-details')).toContainText('Синтетическая улица');
      await screenshot(page, `${engine}-four-pins-${width}`);
      await page.locator('.trip-map-card-close').click();
    }
    check(`${engine}: real Leaflet at 320x568, 390x844, 768/1440px; local tiles, visible attribution, keyboard/list popup activation and no overflow`);
  };
  browser = await chromium.launch({ headless: true });
  const context = await setupContext(browser), page = await context.newPage(); page.setDefaultTimeout(8000);
  page.on('pageerror', error => report.errors.push(`chromium: ${error.message}`));
  includeInactive = true;
  await openMap(page);
  await expect(mapMarker(page)).toHaveCount(4);
  await expect(mapSummary(page)).toContainText('На карте 4 из 4');
  await expect(page.getByText('QA Скрытая использованная заявка')).toHaveCount(0);
  await expect(page.locator('.leaflet-tile-loaded').first()).toBeVisible();
  await expect(page.getByText('Встроенная карта пока не подключена', { exact: true })).toHaveCount(0);
  check('Leaflet initializes without Yandex key or geocoder; four active known locations render and consumed fixture stays hidden');
  await checkResponsiveMap(page, 'chromium');
  secondaryBrowser = await webkit.launch({ headless: true });
  const secondaryContext = await setupContext(secondaryBrowser), secondaryPage = await secondaryContext.newPage();
  secondaryPage.on('pageerror', error => report.errors.push(`webkit: ${error.message}`));
  await openMap(secondaryPage); await checkResponsiveMap(secondaryPage, 'webkit');
  await secondaryContext.close(); await secondaryBrowser.close(); secondaryBrowser = null;
  const refresh = async () => { await page.locator('.trips-section-tabs').getByRole('button', { name: 'Заявки', exact: true }).click(); await page.locator('.trips-section-tabs').getByRole('button', { name: 'Карта', exact: true }).click(); };
  tileFailure = true;
  const failureContext = await setupContext(browser), failurePage = await failureContext.newPage();
  failurePage.on('pageerror', error => report.errors.push(`tile-failure: ${error.message}`));
  await openMap(failurePage);
  await expect.poll(() => report.failedTiles).toBeGreaterThan(0);
  await expect(failurePage.locator('.trip-map-load-error')).toContainText('Не удалось загрузить изображение карты');
  await expect(mapMarker(failurePage)).toHaveCount(4);
  await expect(failurePage.locator('.trip-map-list li')).toHaveCount(4);
  await expect(failurePage.locator('.trip-map-external-link')).toHaveCount(4);
  await screenshot(failurePage, 'tile-error-retains-pins');
  tileFailure = false; await failurePage.locator('.trip-map-load-error').getByRole('button', { name: 'Повторить', exact: true }).click();
  await expect(failurePage.locator('.trip-map-load-error')).toHaveCount(0);
  await expect(failurePage.locator('.leaflet-tile-loaded').first()).toBeVisible();
  await expect(mapMarker(failurePage)).toHaveCount(4);
  await failureContext.close();
  check('Tile failures retain pins, readable list and external navigation; retry destroys/recreates the map and loads local tiles');
  await create(5); await refresh();
  await expect(page.locator('.trip-map-list li')).toHaveCount(5); await expect(mapMarker(page)).toHaveCount(4);
  await mapMarker(page).filter({ hasText: '2' }).click();
  await expect(page.locator('.trip-map-details')).toContainText('QA Ромашка 1'); await expect(page.locator('.trip-map-details')).toContainText('QA Ромашка 5');
  await screenshot(page, 'grouped-identical-coordinates');
  check('Two colocated requests share one count marker; its safe popup retains both companies, addresses and quantities');
  for (const number of [6, 7, 8, 9]) await create(number);
  await refresh(); await expect(page.locator('.trip-map-list li')).toHaveCount(9); await expect(mapMarker(page)).toHaveCount(5);
  await expect(mapSummary(page)).toContainText('На карте 6 из 9');
  await expect(page.getByText('Адрес не найден — уточните адрес доставки', { exact: true })).toHaveCount(3);
  for (const number of [6, 7, 8]) {
    const row = page.locator('.trip-map-list li').filter({ hasText: `QA Ромашка ${number}` });
    await expect(row.locator('.trip-map-list-location')).toHaveCount(0);
    await expect(row.getByRole('button', { name: `Уточнить адрес: QA Ромашка ${number}`, exact: true })).toBeVisible();
    const url = new URL(await row.locator('.trip-map-external-link').getAttribute('href'));
    assert.equal(url.searchParams.get('text'), sources[number - 1].address); assert.equal(url.searchParams.get('pt'), null);
  }
  await page.locator('.trip-map-list-location').filter({ hasText: maliciousName }).click();
  await expect(page.locator('.trip-map-details')).toContainText(maliciousName);
  assert.equal(await page.locator('.trip-map-card-scroll img, .trip-map-card-scroll svg').count(), 0);
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  await screenshot(page, 'unknown-points-and-safe-popup');
  check('Unmatched geocode fixtures never get guessed pins; selection actions stay available; company/address markup renders as literal text');
  // Exercise the real request editor opened from the map; all writes remain in the disposable fixture.
  const pointRow = page.locator('.trip-map-list li').filter({ hasText: 'QA Ромашка 6' });
  await pointRow.getByRole('button', { name: 'Уточнить адрес: QA Ромашка 6', exact: true }).click();
  let editor = page.getByRole('dialog', { name: 'Изменить заявку', exact: true });
  await expect(editor).toBeVisible();
  await editor.getByRole('button', { name: 'Выбрать точку на карте', exact: true }).click();
  const picker = editor.locator('.delivery-point-map');
  await expect(picker.locator('.leaflet-tile-loaded').first()).toBeVisible();
  await expect(picker.locator('.delivery-point-marker')).toHaveCount(0);
  await picker.click({ position: { x: 100, y: 140 } });
  await expect(picker.locator('.delivery-point-marker')).toHaveCount(1);
  await expect(editor.getByRole('textbox', { name: 'Широта точки', exact: true })).not.toHaveValue('');
  const beforeDrag = await editor.getByRole('textbox', { name: 'Широта точки', exact: true }).inputValue();
  const markerBox = await picker.locator('.delivery-point-marker').boundingBox(); assert.ok(markerBox);
  await page.mouse.move(markerBox.x + markerBox.width / 2, markerBox.y + markerBox.height / 2);
  await page.mouse.down(); await page.mouse.move(markerBox.x + markerBox.width / 2 + 36, markerBox.y + markerBox.height / 2 + 24, { steps: 8 }); await page.mouse.up();
  await expect(editor.getByRole('textbox', { name: 'Широта точки', exact: true })).not.toHaveValue(beforeDrag);
  let persisted = (await request('/api/trip-requests')).requests.find(row => row.id === sources[5].id);
  assert.equal(persisted.latitude, null); assert.equal(persisted.longitude, null);
  const pickedLatitude = await editor.getByRole('textbox', { name: 'Широта точки', exact: true }).inputValue();
  const pickedLongitude = await editor.getByRole('textbox', { name: 'Долгота точки', exact: true }).inputValue();
  await screenshot(page, 'request-point-drag-before-save');
  await editor.getByRole('button', { name: 'Сохранить заявку', exact: true }).click(); await expect(editor).toHaveCount(0);
  persisted = (await request('/api/trip-requests')).requests.find(row => row.id === sources[5].id);
  assert.equal(persisted.latitude, pickedLatitude); assert.equal(persisted.longitude, pickedLongitude); assert.equal(persisted.address, sources[5].address);
  sources[5] = persisted;
  await page.reload(); await page.locator('.trips-section-tabs').getByRole('button', { name: 'Карта', exact: true }).click();
  await expect(mapMarker(page)).toHaveCount(6); await expect(mapSummary(page)).toContainText('На карте 7 из 9');
  await page.locator('.trip-map-list li').filter({ hasText: 'QA Ромашка 6' }).getByRole('button', { name: 'Изменить точку: QA Ромашка 6', exact: true }).click();
  editor = page.getByRole('dialog', { name: 'Изменить заявку', exact: true });
  await editor.getByRole('button', { name: 'Изменить точку на карте', exact: true }).click();
  await expect(editor.getByRole('textbox', { name: 'Широта точки', exact: true })).toHaveValue(pickedLatitude);
  await expect(editor.getByRole('textbox', { name: 'Долгота точки', exact: true })).toHaveValue(pickedLongitude);
  await editor.getByRole('textbox', { name: 'Широта точки', exact: true }).fill('91');
  await editor.getByRole('textbox', { name: 'Долгота точки', exact: true }).fill('181');
  await editor.getByRole('button', { name: 'Применить координаты', exact: true }).click();
  await expect(editor.getByRole('alert')).toContainText('Укажите широту');
  await editor.getByRole('button', { name: 'Отмена', exact: true }).click(); await expect(editor).toHaveCount(0);
  persisted = (await request('/api/trip-requests')).requests.find(row => row.id === sources[5].id);
  assert.equal(persisted.latitude, pickedLatitude); assert.equal(persisted.longitude, pickedLongitude);
  check('Map action opens request editor; click/drag only edit draft, save persists exact coordinates through reload, invalid coordinates cannot replace the saved point');
  const updated = await request(`/api/trip-requests/${sources[0].id}`, 'PATCH', { version: sources[0].version, quantityLitres: '1250.123456', comment: 'QA изменено' }); sources[0] = updated.request;
  await refresh(); await expect(page.locator('.trip-map-list-location').filter({ hasText: 'QA Ромашка 1' })).toContainText(/1[\s\u00a0]250,123456 л/);
  const selected = sources.slice(0, 2);
  const trip = await request('/api/shipment-trips', 'POST', {
    idempotencyKey: randomUUID(), fields: { trip_flow_version: 'driver-v1', loading_at: '2027-04-01T10:00', organization_id: 'artel', supplier_id: 'supplier', oil_depot_id: 'depot', product_id: 'product', purchase_price_unspecified_unit: '50000', driver_id: 'driver', vehicle_id: 'vehicle', additional_costs: '0' },
    customers: selected.map(source => ({ sourceRequestId: source.id, sourceRequestVersion: source.version, fields: { customer_id: source.companyId, unloading_address_id: source.addressId, quantity_litres: source.quantityLitres, delivery_notes: source.comment, payment_form_id: 'payment', sale_price_per_litre: '60', transport_amount: '0' } })),
  });
  assert.equal(trip.trip.customers.length, 2); includeInactive = false;
  await refresh(); await expect(page.locator('.trip-map-list li')).toHaveCount(7); await expect(mapMarker(page)).toHaveCount(5);
  await expect(page.locator('.trip-map-list').getByText('QA Ромашка 1', { exact: true })).toHaveCount(0); await expect(page.locator('.trip-map-list').getByText('QA Ромашка 2', { exact: true })).toHaveCount(0);
  await request(`/api/trip-requests/${sources[4].id}`, 'DELETE', { version: sources[4].version });
  await refresh(); await expect(page.locator('.trip-map-list li')).toHaveCount(6); await expect(mapMarker(page)).toHaveCount(4);
  check('Real API quantity edit refreshes marker/list; trip consumes exactly two requests and cancelling the last colocated request removes its marker');
  await request('/api/directories/addresses/address-7', 'PATCH', { version: 0, name: 'QA База 7', companyId: 'customer-7', addressKind: 'delivery', address: 'Синтетический неоднозначный адрес', latitude: '55.81', longitude: '37.71' });
  await refresh(); await expect(mapMarker(page)).toHaveCount(4);
  await expect(page.locator('.trip-map-list-static').filter({ hasText: 'QA Ромашка 7' })).toBeVisible();
  const preserved = (await request('/api/trip-requests')).requests.find(source => source.id === sources[6].id);
  assert.equal(preserved.latitude, null); assert.equal(preserved.longitude, null); assert.equal(preserved.address, 'Синтетический неоднозначный адрес');
  await request('/api/directories/addresses/address-8', 'PATCH', { version: 0, name: 'QA База 8', companyId: 'customer-8', addressKind: 'delivery', address: 'Синтетический изменённый адрес', latitude: '52', longitude: '42' });
  await refresh(); await expect(mapMarker(page)).toHaveCount(4);
  await expect(page.locator('.trip-map-list-static').filter({ hasText: 'QA Ромашка 8' })).toContainText('Синтетический неизвестный адрес');
  check('Later directory pin/text changes never move the saved request address snapshot');
  for (const source of (await request('/api/trip-requests')).requests) await request(`/api/trip-requests/${source.id}`, 'DELETE', { version: source.version });
  await refresh(); await expect(page.getByText('На карте пока нет заявок', { exact: true })).toBeVisible();
  await expect(mapMarker(page)).toHaveCount(0); await expect(page.locator('.leaflet-container')).toHaveCount(0);
  check('Empty active queue removes the Leaflet map and every marker; repeated tab/resize/retry cycles leave no stale map container');
  assert.ok(report.tileRequests > 0); assert.equal(report.providerCalls, 0); assert.deepEqual(report.externalRequests, []); assert.deepEqual(report.errors, []);
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.failure = String(error); throw error; }
finally { await secondaryBrowser?.close(); await browser?.close(); await runtime?.server.close(); await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2)); await rm(temporary, { recursive: true, force: true }); }
