// Synthetic authenticated CRM, local tiles, and controlled API results only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium, webkit, expect } from '@playwright/test';
import { OperationsStore } from '../server/operations-store.ts';
import { loadSnapshot } from '../server/local-api.ts';
import { startTripsQaServer, writeTripsQaSnapshot } from './qa-trips-runtime.mjs';
import { authenticateContext, bootstrapQaAuth } from './qa-auth.mjs';

const root = resolve(import.meta.dirname, '..'), output = resolve(root, 'qa/map-overview-ux-2026-10-12');
const temporary = await mkdtemp(resolve(tmpdir(), 'artel-map-overview-'));
const snapshotDirectory = resolve(temporary, 'snapshot'), operationsDirectory = resolve(temporary, 'operations');
await mkdir(output, { recursive: true }); await writeTripsQaSnapshot(snapshotDirectory);
const snapshot = await loadSnapshot(snapshotDirectory), store = new OperationsStore(operationsDirectory);
const positions = [[55.2, 36.8], [56.1, 37], [55.5, 38.5], [56.15, 38.3]];
const longAddress = 'Московская область, очень длинное название производственной площадки и проезда, владение 123, строение 456, корпус 789';
const longComment = 'Въезд через северные ворота.\nПозвонить диспетчеру перед разгрузкой.\nТекст <img src=x onerror="window.__xss=1"> отображается безопасно.';
await store.mutate(snapshot.provenance.sourceSha256, data => {
  data.sourceOperationsCleared = true; data.shipments = {}; data.paymentAllocations = [];
  data.companies = positions.map((_, i) => ({ id: `customer-${i}`, name: `QA Компания ${i}`, roles: ['customer'], managerLabels: [], shipmentIds: [], paymentIds: [], flags: [] }));
  data.directories = { fleetSeedApplied: true, managers: [], products: [], paymentForms: [], drivers: [], vehicles: [], oilDepots: [], addresses: positions.map(([latitude, longitude], i) => ({ id: `address-${i}`, companyId: `customer-${i}`, kind: 'delivery', name: `QA Площадка ${i}`, address: i === 0 ? longAddress : `Синтетический адрес ${i}`, latitude: String(latitude), longitude: String(longitude) })), customerManagers: [], defaults: { profit: 'template-payment-form' }, duplicates: [] };
  return { changed: true, result: null };
});
const report = { fixtureOnly: true, workingStoreAccessed: false, realLeaflet: true, stubbedTiles: true, realProviderVerified: false, externalRequests: [], errors: [], checks: [], screenshots: [], status: 'running' };
const check = name => { report.checks.push(name); console.log('PASS', name); };
const tileSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#eaf0e5"/><path d="M0 75H256M65 0V256M0 190H256M194 0V256" stroke="#fff" stroke-width="12"/><text x="80" y="142" fill="#85917d" font-family="sans-serif" font-size="12">QA TILE</text></svg>';
let runtime, browser;
try {
  runtime = await startTripsQaServer({ root, snapshotDirectory, operationsDirectory });
  const { cookie } = await bootstrapQaAuth(runtime.base);
  const sources = [];
  for (let i = 0; i < 4; i++) {
    const response = await fetch(runtime.base + '/api/trip-requests', { method: 'POST', headers: { Cookie: cookie, Origin: runtime.base, 'Content-Type': 'application/json' }, body: JSON.stringify({ companyId: `customer-${i}`, addressId: `address-${i}`, quantityLitres: String((i + 1) * 1000), comment: i === 0 ? longComment : `QA запрос ${i}`, idempotencyKey: randomUUID() }) });
    assert.ok(response.ok); sources.push((await response.json()).request);
  }
  const screenshot = async (page, name) => { const path = resolve(output, name + '.png'); await page.screenshot({ path, fullPage: false, animations: 'disabled' }); report.screenshots.push(path); };
  for (const [engine, driver] of [['chromium', chromium], ['webkit', webkit]]) {
    browser = await driver.launch({ headless: true });
    let scenario = 'four', refreshDelay = false, geocodeRelease;
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    await authenticateContext(context, runtime.base, cookie);
    const intercept = async route => {
      const url = new URL(route.request().url());
      if (url.hostname === 'tile.openstreetmap.org') return route.fulfill({ contentType: 'image/svg+xml', body: tileSvg });
      if (url.origin !== runtime.base) { report.externalRequests.push(url.origin); return route.abort(); }
      if (url.pathname === '/api/trip-requests/geocode') {
        if (scenario === 'live') return route.continue();
        await new Promise(resolve => { geocodeRelease = resolve; });
        return route.fulfill({ json: { status: 'found', latitude: 59.9, longitude: 30.3, source: 'geocoder', accuracy: 'building', label: 'Синтетическая дальняя площадка' } });
      }
      if (url.pathname === '/api/trip-requests' && route.request().method() === 'GET') {
        const response = await route.fetch(), result = await response.json();
        let requests = scenario === 'single' ? sources.slice(0, 1) : [...sources];
        if (scenario === 'group') requests.push({ ...sources[0], id: 'grouped', companyName: 'QA Соседняя компания', comment: 'Второй комментарий', quantityLitres: '5500' });
        if (scenario === 'pending') requests.push({ ...sources[0], id: 'pending', companyName: 'QA Поиск адреса', addressId: 'unlinked', address: 'Синтетическая дальняя площадка', latitude: null, longitude: null, mapUrl: null, location: { status: 'pending', message: 'Поиск' } });
        if (scenario === 'unknown') requests.push({ ...sources[0], id: 'unknown', companyName: 'QA Адрес не найден', addressId: 'unlinked', address: 'Неизвестный адрес', latitude: null, longitude: null, mapUrl: null, location: { status: 'not_found', message: 'Адрес не найден' } });
        if (scenario === 'far') requests.push({ ...sources[0], id: 'far', companyName: 'QA Дальняя площадка', latitude: '59.9', longitude: '30.3' });
        if (scenario !== 'live') result.requests = requests;
        if (refreshDelay) await new Promise(resolve => setTimeout(resolve, 400));
        return route.fulfill({ json: result });
      }
      return route.continue();
    };
    await context.route('**/*', intercept);
    const page = await context.newPage(); page.setDefaultTimeout(9000);
    page.on('pageerror', error => report.errors.push(`${engine}: ${error.message}`));
    const open = async () => { await page.goto('about:blank'); await page.goto(runtime.base + '/#trips'); await page.locator('.trips-section-tabs').getByRole('button', { name: 'Карта', exact: true }).click(); await expect(page.locator('.leaflet-tile-loaded').first()).toBeVisible(); };
    const pins = () => page.locator('.trip-map-marker');
    const canvas = () => page.locator('.trip-map-canvas');
    const details = () => page.locator('.trip-map-details');
    const close = async () => { if (await details().count()) await page.getByRole('button', { name: 'Закрыть карточку точки', exact: true }).click(); await page.mouse.move(0, 0); };
    const signature = () => canvas().evaluate(element => ({ pane: element.querySelector('.leaflet-map-pane').style.transform, tilePane: element.querySelector('.leaflet-tile-container').style.transform, tiles: [...element.querySelectorAll('.leaflet-tile')].map(tile => tile.src).sort() }));
    const inside = async () => {
      const map = await canvas().boundingBox(), card = await details().boundingBox(); assert.ok(map && card);
      assert.ok(card.width >= Math.min(260, map.width - 26), `${engine}: readable width ${card.width}`);
      assert.ok(card.x >= map.x && card.x + card.width <= map.x + map.width + 1, `${engine}: horizontal card containment`);
      assert.ok(card.y >= map.y && card.y + card.height <= map.y + map.height + 1, `${engine}: vertical card containment`);
      assert.ok(await details().evaluate(e => e.scrollWidth <= e.clientWidth + 1), `${engine}: no card overflow`);
    };
    await open(); await expect(pins()).toHaveCount(4);
    await expect(page.locator('.trip-map-summary')).toContainText('На карте 4 из 4');
    const broadSignature = await signature();
    await pins().first().hover(); await expect(details()).toBeVisible(); await inside();
    await expect(details()).toContainText(longAddress); await expect(details()).toContainText(longComment);
    assert.equal(await details().locator('img').count(), 0); assert.equal(await page.evaluate(() => window.__xss), undefined);
    assert.deepEqual(await signature(), broadSignature, 'hover never pans/zooms');
    await screenshot(page, `${engine}-desktop-hover-long-address-comment`); await close();
    check(`${engine}: four initial points, readable actual hover with long address and multiline safe comment, no hover map movement`);
    // Move a known marker to each screen edge using ordinary map dragging, then hover it.
    for (const [edge, xFraction, yFraction] of [['left', .06, .5], ['right', .94, .5], ['top', .5, .06], ['bottom', .5, .94]]) {
      await page.getByRole('button', { name: 'Показать все', exact: true }).click();
      const box = await canvas().boundingBox(), pin = await pins().first().boundingBox();
      const dx = box.x + box.width * xFraction - (pin.x + pin.width / 2), dy = box.y + box.height * yFraction - (pin.y + pin.height / 2);
      const startX = box.x + box.width / 2 - dx / 2, startY = box.y + box.height / 2 - dy / 2;
      await page.mouse.move(startX, startY); await page.mouse.down(); await page.mouse.move(startX + dx, startY + dy, { steps: 12 }); await page.waitForTimeout(250); await page.mouse.up();
      await page.mouse.move(0, 0); await page.waitForTimeout(350);
      const before = await signature();
      await pins().first().hover(); await expect(details()).toBeVisible(); await inside(); assert.deepEqual(await signature(), before, `${edge} hover remains still`);
      await screenshot(page, `${engine}-hover-${edge}-edge`); await close();
    }
    check(`${engine}: hover at four edges keeps fixed card width inside map without auto-pan`);
    // Background refresh must preserve this actual mounted map and the user's chosen view.
    await canvas().evaluate(element => { element.dataset.qaIdentity = 'same-map'; });
    const beforeRefresh = await signature(); refreshDelay = true;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await page.waitForTimeout(180); assert.equal(await canvas().getAttribute('data-qa-identity'), 'same-map');
    await page.waitForTimeout(700); assert.equal(await canvas().getAttribute('data-qa-identity'), 'same-map'); assert.deepEqual(await signature(), beforeRefresh);
    refreshDelay = false;
    check(`${engine}: focus/background request reload preserves mounted map and manual viewport`);
    for (const width of [320, 390, 768, 1920]) {
      await page.setViewportSize({ width, height: width === 320 ? 568 : width === 390 ? 844 : 1000 });
      await page.getByRole('button', { name: 'Показать все', exact: true }).click();
      await page.locator('.trip-map-list-location').first().click(); await expect(details()).toBeVisible(); await inside();
      const box = await canvas().boundingBox(); assert.ok(box.height >= (width === 320 ? 350 : width === 390 ? 580 : 690));
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      if (width >= 768) { await close(); await pins().first().focus(); await page.keyboard.press('Enter'); await expect(details()).toBeVisible(); await page.keyboard.press('Escape'); await expect(details()).toHaveCount(0); await pins().first().focus(); await page.keyboard.press(' '); await expect(details()).toBeVisible(); }
      await screenshot(page, `${engine}-card-${width}`); await close();
    }
    check(`${engine}: 320/390 mobile bottom card, 768/1920 keyboard Enter/Space/Escape, useful map height and no overflow`);
    await page.setViewportSize({ width: 1440, height: 1000 }); scenario = 'single'; await open(); await expect(pins()).toHaveCount(1);
    assert.deepEqual(await signature(), broadSignature, 'single local pin retains four-pin region overview');
    await screenshot(page, `${engine}-single-broad-overview`);
    scenario = 'group'; await open(); await expect(pins()).toHaveCount(4);
    await pins().filter({ hasText: '2' }).hover(); await expect(details()).toContainText('QA Соседняя компания'); await expect(details()).toContainText('Второй комментарий'); await inside();
    await screenshot(page, `${engine}-grouped-hover`); await close();
    check(`${engine}: single pin keeps regional zoom; colocated requests retain count and both hover details`);
    scenario = 'pending'; await open(); await expect(pins()).toHaveCount(4); await expect(page.locator('.trip-map-summary')).toContainText('Ищем адреса: 1');
    await expect.poll(() => typeof geocodeRelease).toBe('function');
    const beforeAsync = await signature(); geocodeRelease();
    await expect(pins()).toHaveCount(5); await expect(page.locator('.trip-map-outside')).toBeVisible(); assert.deepEqual(await signature(), beforeAsync);
    await page.getByRole('button', { name: 'Показать все', exact: true }).click(); await expect(page.locator('.trip-map-outside')).toHaveCount(0);
    assert.notDeepEqual(await signature(), beforeAsync); await screenshot(page, `${engine}-all-includes-late-outlier`);
    check(`${engine}: known markers render immediately while pending; late far pin never recenters, explicit Show all includes it`);
    scenario = 'unknown'; await open(); await expect(pins()).toHaveCount(4); await expect(page.locator('.trip-map-summary')).toContainText('Адресов без точки: 1');
    await expect(page.locator('.trip-map-list-static')).toContainText('QA Адрес не найден');
    check(`${engine}: unresolved address remains visible and honest, with no guessed pin`);
    scenario = 'far'; await open(); await expect(pins()).toHaveCount(5); await expect(page.locator('.trip-map-outside')).toHaveCount(0);
    await screenshot(page, `${engine}-initial-outlier-included`);
    check(`${engine}: initial known outlying point expands initial bounds before tiles appear`);
    scenario = 'live'; await open();
    const original = sources[0];
    await page.locator('.trip-map-list li').filter({ hasText: original.companyName }).getByRole('button', { name: `Изменить точку: ${original.companyName}`, exact: true }).click();
    let editor = page.getByRole('dialog', { name: 'Изменить заявку', exact: true });
    const corrected = `Синтетический уточнённый адрес ${engine}, дом 8`;
    await editor.getByRole('textbox', { name: 'Адрес доставки *', exact: true }).fill(corrected);
    await expect(editor.getByText('Найдём уточнённый адрес после сохранения.', { exact: true })).toBeVisible();
    await editor.getByRole('button', { name: 'Выбрать точку на карте', exact: true }).click();
    await expect(editor.locator('.delivery-point-marker')).toHaveCount(0);
    let live = await (await fetch(runtime.base + '/api/trip-requests', { headers: { Cookie: cookie } })).json();
    assert.equal(live.requests.find(row => row.id === original.id).address, original.address, 'typing does not persist or mutate request');
    await editor.getByRole('button', { name: 'Сохранить заявку', exact: true }).click(); await expect(editor).toHaveCount(0);
    live = await (await fetch(runtime.base + '/api/trip-requests', { headers: { Cookie: cookie } })).json();
    const updated = live.requests.find(row => row.id === original.id);
    assert.equal(updated.address, corrected); assert.equal(updated.latitude, null); assert.equal(updated.longitude, null); assert.equal(updated.mapUrl, null);
    assert.equal(updated.quantityLitres, original.quantityLitres); assert.equal(updated.comment, original.comment);
    assert.equal(live.addresses.find(row => row.id === original.addressId).address, original.address);
    assert.equal(live.addresses.find(row => row.id === original.addressId).latitude, original.latitude);
    await page.locator('.trip-map-list li').filter({ hasText: original.companyName }).getByRole('button', { name: `Уточнить адрес: ${original.companyName}`, exact: true }).click();
    editor = page.getByRole('dialog', { name: 'Изменить заявку', exact: true });
    await expect(editor.getByRole('textbox', { name: 'Адрес доставки *', exact: true })).toHaveValue(corrected);
    await expect(editor.getByRole('button', { name: 'Сохранить заявку', exact: true })).toBeDisabled();
    await screenshot(page, `${engine}-address-refinement-form`); await editor.getByRole('button', { name: 'Отмена', exact: true }).click();
    const restored = await fetch(runtime.base + `/api/trip-requests/${original.id}`, { method: 'PATCH', headers: { Cookie: cookie, Origin: runtime.base, 'Content-Type': 'application/json' }, body: JSON.stringify({ version: updated.version, quantityLitres: original.quantityLitres, comment: original.comment, address: original.address, latitude: original.latitude, longitude: original.longitude }) });
    assert.ok(restored.ok); sources[0] = (await restored.json()).request;
    check(`${engine}: request address refinement is editable, clears old pin, saves only own snapshot, preserves catalog/quantity/comment and reopens unchanged-save disabled`);
    await page.goto(runtime.base + '/#directories');
    await page.getByRole('button', { name: 'Редактировать: QA Компания 0', exact: true }).click();
    let directoryEditor = page.getByRole('dialog');
    const nestedAddress = `Синтетический адрес компании ${engine}, дом 9`;
    await directoryEditor.getByLabel('Адрес отгрузки клиента 1', { exact: true }).fill(nestedAddress);
    await expect(directoryEditor.getByText('Точка доставки ещё не выбрана', { exact: true })).toBeVisible();
    await directoryEditor.getByRole('button', { name: 'Сохранить', exact: true }).click(); await expect(directoryEditor).toHaveCount(0);
    live = await (await fetch(runtime.base + '/api/trip-requests', { headers: { Cookie: cookie } })).json();
    let catalogAddress = live.addresses.find(row => row.id === original.addressId);
    assert.equal(catalogAddress.address, nestedAddress); assert.equal(catalogAddress.name, nestedAddress);
    assert.ok(!catalogAddress.latitude && !catalogAddress.longitude && !catalogAddress.mapUrl);
    assert.equal(live.requests.find(row => row.id === original.id).address, original.address);
    assert.equal(live.requests.find(row => row.id === original.id).latitude, original.latitude);
    await page.getByRole('button', { name: 'Места погрузки и доставки', exact: true }).click();
    await page.getByRole('button', { name: `Редактировать: ${nestedAddress}`, exact: true }).click();
    directoryEditor = page.getByRole('dialog');
    const standaloneAddress = `Синтетический уточнённый справочник ${engine}, дом 10`;
    await directoryEditor.getByLabel('Фактический адрес площадки', { exact: true }).fill(standaloneAddress);
    await expect(directoryEditor.getByLabel('Широта', { exact: true })).toHaveValue('');
    await expect(directoryEditor.getByLabel('Долгота', { exact: true })).toHaveValue('');
    await directoryEditor.getByLabel('Широта', { exact: true }).fill(original.latitude);
    await directoryEditor.getByLabel('Долгота', { exact: true }).fill(original.longitude);
    await directoryEditor.getByRole('button', { name: 'Сохранить', exact: true }).click(); await expect(directoryEditor).toHaveCount(0);
    live = await (await fetch(runtime.base + '/api/trip-requests', { headers: { Cookie: cookie } })).json();
    catalogAddress = live.addresses.find(row => row.id === original.addressId);
    assert.equal(catalogAddress.address, standaloneAddress); assert.equal(catalogAddress.latitude, original.latitude); assert.equal(catalogAddress.longitude, original.longitude);
    const directorySnapshot = await (await fetch(runtime.base + '/api/snapshot?shipments=omit', { headers: { Cookie: cookie } })).json();
    const directoryVersion = directorySnapshot.directories.addresses.find(row => row.id === original.addressId).version;
    const directoryRestored = await fetch(runtime.base + `/api/directories/addresses/${original.addressId}`, { method: 'PATCH', headers: { Cookie: cookie, Origin: runtime.base, 'Content-Type': 'application/json' }, body: JSON.stringify({ version: directoryVersion, name: 'QA Площадка 0', companyId: original.companyId, addressKind: 'delivery', address: original.address, latitude: original.latitude, longitude: original.longitude, pointAddress: original.address }) });
    assert.ok(directoryRestored.ok, await directoryRestored.text());
    check(`${engine}: nested directory address edits update effective text and clear stale pin; standalone text/manual point save works without moving existing request`);
    scenario = 'four';
    const touchContext = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: 'reduce', serviceWorkers: 'block' });
    await authenticateContext(touchContext, runtime.base, cookie); await touchContext.route('**/*', intercept);
    const touchPage = await touchContext.newPage(); touchPage.on('pageerror', error => report.errors.push(`${engine}-touch: ${error.message}`));
    await touchPage.goto(runtime.base + '/#trips'); await touchPage.locator('.trips-section-tabs').getByRole('button', { name: 'Карта', exact: true }).tap();
    await expect(touchPage.locator('.trip-map-marker')).toHaveCount(4);
    await touchPage.locator('.trip-map-marker').first().tap();
    await expect(touchPage.locator('.trip-map-details')).toBeVisible(); await expect(touchPage.locator('.trip-map-details')).toContainText(longComment);
    const touchMap = await touchPage.locator('.trip-map-canvas').boundingBox(), touchCard = await touchPage.locator('.trip-map-details').boundingBox();
    assert.ok(touchCard.width >= 300); assert.ok(touchCard.y + touchCard.height <= touchMap.y + touchMap.height);
    await screenshot(touchPage, `${engine}-real-touch-card`);
    await touchPage.getByRole('button', { name: 'Закрыть карточку точки', exact: true }).tap(); await expect(touchPage.locator('.trip-map-details')).toHaveCount(0);
    await touchContext.close(); check(`${engine}: touch-capable mobile tap opens readable bottom card and close tap dismisses it`);
    await context.close(); await browser.close(); browser = null;
  }
  assert.deepEqual(report.externalRequests, []); assert.deepEqual(report.errors, []); report.status = 'passed';
} catch (error) { report.status = 'failed'; report.failure = String(error); throw error; }
finally { await browser?.close(); await runtime?.server.close(); await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2)); await rm(temporary, { recursive: true, force: true }); }
