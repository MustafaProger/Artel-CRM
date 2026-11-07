// Real OpenLayers/forms with deterministic same-origin geocode responses and Yandex API tile fixtures; zero public geocoding or tile traffic.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium, webkit, expect } from '@playwright/test';
import { OperationsStore } from '../server/operations-store.ts';
import { SabyClient, sabyConfigFromEnv } from '../server/saby-client.ts';
import { startTripsQaServer, writeTripsQaSnapshot } from './qa-trips-runtime.mjs';
import { authenticateContext, bootstrapQaAuth } from './qa-auth.mjs';
const root = resolve(import.meta.dirname, '..'), output = resolve(process.env.ARTEL_GEOCODING_QA_OUTPUT || resolve(root, 'qa/trip-request-geocoding-2026-10-12'));
await mkdir(output, { recursive: true });
const temporary = await mkdtemp(resolve(tmpdir(), 'artel-geocoding-ui-'));
const snapshotDirectory = resolve(temporary, 'snapshot'), operationsDirectory = resolve(temporary, 'operations');
const source = await writeTripsQaSnapshot(snapshotDirectory), store = new OperationsStore(operationsDirectory);
await store.mutate(source, data => {
  data.sourceOperationsCleared = true;
  data.companies = Array.from({ length: 6 }, (_, i) => ({ id: `qa-${i+1}`, name: `QA Авто ${i+1}`, roles: ['customer'], managerLabels: [], shipmentIds: [], paymentIds: [], flags: [] }));
  data.directories = { fleetSeedApplied: true, managers: [], products: [], paymentForms: [], drivers: [], vehicles: [], oilDepots: [], customerManagers: [], defaults: { profit: 'template-payment-form' }, duplicates: [], addresses: data.companies.map((company, i) => ({ id: `place-${i+1}`, companyId: company.id, kind: 'delivery', name: `Место ${i+1}`, address: i === 0 ? 'Москва, улица Бианки, 2к1' : `Учебный адрес ${i+1}`, ...(i === 4 ? { latitude: '55.71', longitude: '37.61' } : {}) })) };
  return { changed: true, result: null };
});
const report = { fixtureOnly: true, realOpenLayers: true, stubbedYandexApiTiles: true, realGeocodeApi: true, injectedGeocodeProvider: true, publicGeocodingVerified: false, tileRequests: 0, providerCalls: 0, externalRequests: [], browserErrors: [], checks: [], screenshots: [] };
const check = text => { report.checks.push(text); console.log('PASS', text); };
const tileSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#e8eee5"/><path d="M0 90H256M120 0V256" stroke="#fff" stroke-width="15"/></svg>';
let runtime, browser, fixtureGeocode;
try {
  runtime = await startTripsQaServer({ root, snapshotDirectory, operationsDirectory, tripRequestGeocoder: address => fixtureGeocode(address), sabyClient: new SabyClient(sabyConfigFromEnv({}), async () => { report.providerCalls++; throw new Error('Public provider forbidden'); }) });
  const { cookie } = await bootstrapQaAuth(runtime.base);
  const call = async (path, method='GET', body) => { const response = await fetch(runtime.base+path, { method, headers: { Cookie: cookie, Origin: runtime.base, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result; };
  const found = { status: 'found', source: 'geocoder', latitude: 55.596501, longitude: 37.352801, accuracy: 'building', label: 'Москва, улица Бианки, 2к1' };
  for (const [engine, launcher] of [['chromium', chromium], ['webkit', webkit]]) {
    const sources = [];
    const create = async n => { const item = (await call('/api/trip-requests', 'POST', { companyId: `qa-${n}`, addressId: `place-${n}`, quantityLitres: '1000', comment: `QA ${n}`, idempotencyKey: randomUUID() })).request; sources.push(item); return item; };
    browser = await launcher.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    await authenticateContext(context, runtime.base, cookie);
    let releaseFirst, releaseLate, unavailable = true;
    const firstGate = new Promise(resolve => { releaseFirst = resolve; }), lateGate = new Promise(resolve => { releaseLate = resolve; });
    const addressFor = n => (n === 1 ? 'Москва, улица Бианки, 2к1' : `Учебный адрес ${n}`) + ` (${engine})`;
    // Each engine owns distinct fixture addresses, so the persistent cache does not bypass its gates.
    await store.mutate(source, data => { for (const [i, place] of data.directories.addresses.entries()) place.address = addressFor(i + 1); return { changed: true, result: null }; });
    const fixtureLookups = new Map();
    fixtureGeocode = async input => {
      fixtureLookups.set(input, (fixtureLookups.get(input) ?? 0) + 1);
      const address = input.replace(/ \((?:chromium|webkit)\)$/, '');
      if (address === 'Москва, улица Бианки, 2к1') { await firstGate; return found; }
      if (address === 'Учебный адрес 6') { await lateGate; return { ...found, latitude: 54, longitude: 36 }; }
      if (address === 'Учебный адрес 3') return { status: 'ambiguous', message: 'Несколько совпадений' };
      if (address === 'Учебный адрес 4') return unavailable ? { status: 'unavailable', message: 'Временный сбой' } : { ...found, latitude: 55.69, longitude: 37.48, accuracy: 'street' };
      return { status: 'not_found', message: 'Не найдено' };
    };
    // Start the real create-time queue only after installing its deterministic provider.
    for (const n of [1,2,3,4,5]) await create(n);
    const apiCalls = [], inflight = new Map(), maxInflight = new Map();
    const finishGeocode = request => { if (new URL(request.url()).pathname !== '/api/trip-requests/geocode') return; const id = request.postDataJSON()?.requestId; if (id) inflight.set(id, Math.max(0, (inflight.get(id) ?? 0) - 1)); };
    context.on('requestfinished', finishGeocode); context.on('requestfailed', finishGeocode);
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin === runtime.base && url.pathname === '/api/maps/yandex/tiles') { report.tileRequests++; return route.fulfill({ contentType: 'image/svg+xml', body: tileSvg }); }
      if (url.origin !== runtime.base) { report.externalRequests.push(url.href); return route.abort(); }
      if (url.pathname === '/api/trip-requests/geocode') { const body = route.request().postDataJSON(); apiCalls.push(body); if (body.requestId) { const count = (inflight.get(body.requestId) ?? 0) + 1; inflight.set(body.requestId, count); maxInflight.set(body.requestId, Math.max(maxInflight.get(body.requestId) ?? 0, count)); } }
      return route.continue();
    });
    const page = await context.newPage(); page.on('pageerror', error => report.browserErrors.push(`${engine}: ${error.message}`));
    const screenshot = async name => { const path = resolve(output, `${engine}-${name}.png`); await page.screenshot({ path, fullPage: false }); report.screenshots.push(path); };
    const row = n => page.locator('.trip-map-list li').filter({ hasText: `QA Авто ${n}` });
    const tabs = page.getByRole('group', { name: 'Разделы рейсов', exact: true });
    await page.goto(runtime.base+'/#trips'); await tabs.getByRole('button', { name: 'Карта', exact: true }).click();
    await expect(row(1).getByRole('status')).toHaveText('Ищем адрес…');
    await expect(page.locator('.trip-map-marker')).toHaveCount(1);
    await row(1).getByRole('button', { name: 'Уточнить адрес: QA Авто 1', exact: true }).click();
    let editor = page.getByRole('dialog', { name: 'Изменить заявку', exact: true });
    await expect(editor.locator('.trip-request-geocode-status')).toHaveText('Ищем адрес…');
    await editor.getByRole('button', { name: 'Выбрать точку на карте', exact: true }).click();
    releaseFirst();
    await expect(editor.locator('.trip-request-geocode-status')).toHaveText('Найдено по адресу');
    await expect(editor.getByRole('button', { name: 'Сохранить заявку', exact: true })).toBeDisabled();
    await expect(editor.getByLabel('Широта точки', { exact: true })).toHaveValue(String(found.latitude));
    const picker = editor.locator('.delivery-point-map');
    await expect(picker.locator('.ol-viewport')).toBeVisible();
    await expect(picker.getByRole('link', { name: 'Яндекс Карты', exact: true })).toBeVisible();
    // OpenLayers draws the point on a vector canvas; there is no Leaflet DOM marker.
    // Inspect its rendered fill, not internal map state, to prove that the late point
    // is actually painted inside the picker and recentered without a dirty draft.
    const markerPixels = () => picker.evaluate(element => {
      const viewport = element.getBoundingClientRect();
      return [...element.querySelectorAll('canvas')].map(canvas => {
        const context = canvas.getContext('2d'); if (!context || !canvas.width || !canvas.height) return null;
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        let count = 0, xSum = 0, ySum = 0;
        for (let index = 0; index < pixels.length; index += 4) {
          if (Math.abs(pixels[index] - 23) > 3 || Math.abs(pixels[index + 1] - 110) > 3 || Math.abs(pixels[index + 2] - 80) > 3 || pixels[index + 3] < 240) continue;
          count++; xSum += index / 4 % canvas.width; ySum += Math.floor(index / 4 / canvas.width);
        }
        if (!count) return null;
        const box = canvas.getBoundingClientRect();
        return { count, x: (box.x + xSum / count / canvas.width * box.width - viewport.x) / viewport.width, y: (box.y + ySum / count / canvas.height * box.height - viewport.y) / viewport.height };
      }).filter(Boolean);
    });
    await expect.poll(async () => (await markerPixels()).some(point => point.count > 50 && Math.abs(point.x - .5) < .05 && Math.abs(point.y - .5) < .05)).toBe(true);
    assert.equal(maxInflight.get(sources[0].id), 1, 'Map/editor share one in-flight request, including bounded sequential polling');
    assert.equal(fixtureLookups.get(addressFor(1)), 1, 'Map/editor and create-time queue share one provider lookup');
    await screenshot('automatic-point-editor');
    await editor.getByRole('button', { name: 'Отмена', exact: true }).click(); await expect(editor).toHaveCount(0);
    await expect(page.locator('.trip-map-marker')).toHaveCount(2);
    await expect(row(1).getByRole('status')).toHaveText('Найдено по адресу');
    await expect(row(2).getByRole('status')).toHaveText('Адрес не найден — уточните адрес доставки');
    await expect(row(3).getByRole('status')).toHaveText('Не удалось точно определить место — уточните адрес доставки');
    await expect(row(4).getByRole('status')).toHaveText('Поиск адреса временно недоступен');
    assert.equal(apiCalls.filter(body => body.requestId === sources[4].id).length, 0, 'Explicit point bypasses geocoder');
    assert.equal((await call('/api/trip-requests')).requests.find(item => item.id === sources[0].id).latitude, null);
    for (const width of [320,390,1440]) { await page.setViewportSize({ width, height: 1000 }); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth+1)); await screenshot(`statuses-${width}`); }
    unavailable = false; await row(4).getByRole('button', { name: 'Повторить поиск адреса', exact: true }).click();
    await expect(row(4).getByRole('status')).toHaveText('Найдена улица — уточните точку доставки');
    await expect(page.locator('.trip-map-marker')).toHaveCount(3);
    check(`${engine}: auto address lookup shares map/editor request, shows exact pending/missing/ambiguous/unavailable states, supports retry and street precision; no dirty state or snapshot mutation`);
    await page.reload(); await tabs.getByRole('button', { name: 'Карта', exact: true }).click();
    await expect(row(1).getByRole('status')).toHaveText('Найдено по адресу');
    await expect(page.locator('.trip-map-marker')).toHaveCount(3);
    await create(6); await tabs.getByRole('button', { name: 'Заявки', exact: true }).click(); await expect(page.getByRole('button', { name: 'Обновить заявки', exact: true })).toHaveCount(0); await expect(page.getByTestId('trip-request-card').filter({ hasText: 'QA Авто 6' })).toBeVisible(); await tabs.getByRole('button', { name: 'Карта', exact: true }).click();
    await expect(row(6).getByRole('status')).toHaveText('Ищем адрес…');
    await row(6).getByRole('button', { name: 'Уточнить адрес: QA Авто 6', exact: true }).click();
    editor = page.getByRole('dialog', { name: 'Изменить заявку', exact: true });
    await editor.getByRole('button', { name: 'Выбрать точку на карте', exact: true }).click();
    await editor.getByLabel('Широта точки', { exact: true }).fill('55.7'); await editor.getByLabel('Долгота точки', { exact: true }).fill('37.6'); await editor.getByRole('button', { name: 'Применить координаты', exact: true }).click();
    await expect(editor.getByLabel('Широта точки', { exact: true })).toHaveValue('55.7');
    releaseLate(); await expect(row(6).getByRole('status')).toHaveText('Найдено по адресу');
    await expect(editor.getByLabel('Широта точки', { exact: true })).toHaveValue('55.7');
    await editor.getByRole('button', { name: 'Сохранить заявку', exact: true }).click(); await expect(editor).toHaveCount(0);
    const manual = (await call('/api/trip-requests')).requests.find(item => item.id === sources[5].id); assert.equal(manual.latitude, '55.7'); assert.equal(manual.longitude, '37.6');
    await page.reload(); await tabs.getByRole('button', { name: 'Карта', exact: true }).click();
    await expect(row(6).getByRole('status')).toHaveCount(0); await expect(row(6).getByRole('button', { name: 'Изменить точку: QA Авто 6', exact: true })).toBeVisible();
    check(`${engine}: automatic point returns after reload; manual draft and persisted point always beat late geocode response`);
    await tabs.getByRole('button', { name: 'Заявки', exact: true }).click(); await page.getByRole('button', { name: 'Новая заявка', exact: true }).click();
    editor = page.getByRole('dialog', { name: 'Новая заявка', exact: true });
    const choose = async (label, name) => { await editor.getByRole('combobox', { name: new RegExp('^'+label) }).fill(name); await editor.getByRole('listbox').getByRole('option', { name: new RegExp(name) }).first().click(); };
    await choose('Компания', 'QA Авто 1'); await choose('Место доставки', 'Место 1');
    await expect(editor.locator('.trip-request-geocode-status')).toHaveText('Найдено по адресу');
    assert.equal(apiCalls.filter(body => body.companyId === 'qa-1' && body.addressId === 'place-1').length, 0, 'Enriched directory location avoids another geocode POST');
    await editor.getByLabel('Количество литров, л', { exact: false }).fill('700'); await editor.getByRole('button', { name: 'Сохранить заявку', exact: true }).click(); await expect(editor).toHaveCount(0);
    const added = (await call('/api/trip-requests')).requests.find(item => item.quantityLitres === '700'); assert.equal(added.latitude, String(found.latitude)); assert.equal(added.longitude, String(found.longitude)); assert.equal(added.address, addressFor(1));
    check(`${engine}: new request reuses enriched directory result without another lookup; save captures found coordinates and preserves selected address`);
    await context.close(); await browser.close(); browser = null;
    for (const item of (await call('/api/trip-requests')).requests) await call(`/api/trip-requests/${item.id}`, 'DELETE', { version: item.version });
  }
  assert.deepEqual(report.externalRequests, []); assert.deepEqual(report.browserErrors, []); assert.equal(report.providerCalls, 0); assert.ok(report.tileRequests > 0); report.passed = true;
} catch (error) { report.passed = false; report.error = error.message; throw error; }
finally { await browser?.close(); await runtime?.server.close(); await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2)); await rm(temporary, { recursive: true, force: true }); }
