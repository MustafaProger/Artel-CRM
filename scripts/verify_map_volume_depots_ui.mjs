// Real OpenLayers and authenticated isolated API; tiles/geocoder are synthetic.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium, webkit, expect } from '@playwright/test';
import { OperationsStore } from '../server/operations-store.ts';
import { loadSnapshot } from '../server/local-api.ts';
import { startTripsQaServer, writeTripsQaSnapshot } from './qa-trips-runtime.mjs';
import { authenticateContext, bootstrapQaAuth } from './qa-auth.mjs';
const root = resolve(import.meta.dirname, '..'), output = resolve(root, 'qa/map-volume-depots-2026-10-15');
const temporary = await mkdtemp(resolve(tmpdir(), 'artel-map-volume-depots-'));
const snapshotDirectory = resolve(temporary, 'snapshot'), operationsDirectory = resolve(temporary, 'operations');
await mkdir(output, { recursive: true }); await writeTripsQaSnapshot(snapshotDirectory);
const snapshot = await loadSnapshot(snapshotDirectory), store = new OperationsStore(operationsDirectory);
const positions = [[55.60, 37.35], [55.7, 37.6], [55.9, 38.1], [55.4, 38], [56.1, 37], [55.9, 36.9]];
const quantities = ['1200', '2000', '6000', '11000', '14000', '5999.999999'];
await store.mutate(snapshot.provenance.sourceSha256, data => {
  data.sourceOperationsCleared = true; data.shipments = {}; data.paymentAllocations = [];
  data.companies = positions.map((_, i) => ({ id: `customer-${i}`, name: `QA Компания ${i}`, roles: ['customer'], managerLabels: [], shipmentIds: [], paymentIds: [], flags: [] }));
  data.directories = { fleetSeedApplied: true, managers: [], products: [], paymentForms: [], drivers: [], vehicles: [],
    oilDepots: [
      { id: 'manual-depot', name: 'QA Нефтебаза с координатами', address: 'QA Адрес нефтебазы', latitude: '55.3', longitude: '37.9' },
      { id: 'link-depot', name: 'QA Нефтебаза по ссылке', address: 'QA Адрес ссылки', mapUrl: 'https://yandex.ru/maps/?pt=37.4,56.25' },
      { id: 'auto-depot', name: 'QA Нефтебаза по адресу', address: 'QA Найденный адрес' },
      { id: 'missing-depot', name: 'QA Нефтебаза без результата', address: 'QA Неизвестный адрес' },
      { id: 'empty-depot', name: 'QA Нефтебаза без адреса' },
      { id: 'shared-depot', name: 'QA Нефтебаза в точке клиента', latitude: '55.60', longitude: '37.35' },
    ],
    addresses: positions.map(([latitude, longitude], i) => ({ id: `address-${i}`, companyId: `customer-${i}`, kind: 'delivery', name: `QA Площадка ${i}`, address: `QA Адрес ${i}`, latitude: String(latitude), longitude: String(longitude) })),
    customerManagers: [], defaults: { profit: 'template-payment-form' }, duplicates: [],
  };
  return { changed: true, result: null };
});
const report = { fixtureOnly: true, workingStoreAccessed: false, realOpenLayers: true, stubbedYandexApiTiles: true, realProviderVerified: false, externalRequests: [], errors: [], checks: [], screenshots: [], status: 'running' };
const check = name => { report.checks.push(name); console.log('PASS', name); };
const tileSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512" fill="#eaf0e5"/><path d="M0 150H512M130 0V512M0 380H512M388 0V512" stroke="#fff" stroke-width="24"/><text x="150" y="280" fill="#85917d" font-family="sans-serif" font-size="24">QA TILE</text></svg>';
let runtime, browser;
try {
  runtime = await startTripsQaServer({ root, snapshotDirectory, operationsDirectory, tripRequestGeocoder: async address => address === 'QA Найденный адрес' ? { status: 'found', latitude: 55.55, longitude: 38.45, source: 'geocoder', accuracy: 'building' } : { status: 'not_found', message: 'Адрес не найден' } });
  const { cookie } = await bootstrapQaAuth(runtime.base), sources = [];
  for (let i = 0; i < 7; i++) {
    const index = Math.min(i, 5);
    const response = await fetch(runtime.base + '/api/trip-requests', { method: 'POST', headers: { Cookie: cookie, Origin: runtime.base, 'Content-Type': 'application/json' }, body: JSON.stringify({ companyId: `customer-${index}`, addressId: `address-${index}`, quantityLitres: i === 6 ? '0.000001' : quantities[index], comment: 'Комментарий точки <img src=x onerror="window.__xss=1">', idempotencyKey: randomUUID() }) });
    assert.ok(response.ok, await response.clone().text()); sources.push((await response.json()).request);
  }
  const beforeStore = await readFile(store.path, 'utf8');
  for (const [engine, driver] of [['chromium', chromium], ['webkit', webkit]]) {
    browser = await driver.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    await authenticateContext(context, runtime.base, cookie);
    let scenario = 'full', releaseGeocode;
    const intercept = async route => {
      const url = new URL(route.request().url());
      if (url.origin !== runtime.base) { report.externalRequests.push(url.origin); return route.abort(); }
      if (url.pathname === '/api/maps/yandex/tiles') return route.fulfill({ contentType: 'image/svg+xml', body: tileSvg });
      if (url.pathname === '/api/trip-requests' && route.request().method() === 'GET' && scenario === 'empty') {
        const response = await route.fetch(), result = await response.json(); return route.fulfill({ json: { ...result, requests: [] } });
      }
      if (url.pathname === '/api/trip-requests/geocode' && scenario === 'late' && route.request().postDataJSON().oilDepotId === 'auto-depot') {
        await new Promise(resolve => { releaseGeocode = resolve; });
        return route.fulfill({ json: { status: 'found', latitude: 59.9, longitude: 30.3, source: 'geocoder', accuracy: 'building' } });
      }
      return route.continue();
    };
    await context.route('**/*', intercept);
    const page = await context.newPage(); page.setDefaultTimeout(12000); page.on('pageerror', error => report.errors.push(`${engine}: ${error.message}`));
    const map = () => page.locator('.trip-map-canvas'), pins = () => page.locator('.trip-map-marker'), depots = () => page.locator('.trip-map-depot-marker'), card = () => page.locator('.trip-map-details');
    const open = async () => { await page.goto('about:blank'); await page.goto(runtime.base + '/#trips'); await page.locator('.trips-section-tabs').getByRole('button', { name: 'Карта', exact: true }).click(); await expect(map().locator('.ol-viewport')).toBeVisible(); await expect(page.locator('.trip-map-loading')).toHaveCount(0); };
    const shot = async name => { const path = resolve(output, `${engine}-${name}.png`); await page.screenshot({ path, animations: 'disabled' }); report.screenshots.push(path); };
    const close = async () => { if (await card().count()) await page.getByRole('button', { name: 'Закрыть карточку точки', exact: true }).click(); await page.mouse.move(0, 0); await map().focus(); };
    const signature = () => pins().evaluateAll(elements => elements.map(element => element.parentElement.style.transform));
    const allInside = async () => {
      await expect.poll(async () => {
        const b = await map().boundingBox(), outside = [];
        for (const p of [...await pins().all(), ...await depots().all()]) { const a = await p.boundingBox(); if (!a || a.x < b.x || a.y < b.y || a.x + a.width > b.x + b.width || a.y + a.height > b.y + b.height - 25) outside.push(await p.getAttribute('aria-label')); }
        return outside;
      }, { message: `${engine}: all points fit map` }).toEqual([]);
    };
    await open(); await expect(pins()).toHaveCount(6); await expect(depots()).toHaveCount(4);
    for (const [band, count, color] of [['blue', 1, 'rgb(37, 99, 184)'], ['green', 1, 'rgb(33, 128, 75)'], ['yellow', 2, 'rgb(244, 197, 66)'], ['red', 1, 'rgb(214, 63, 54)'], ['burgundy', 1, 'rgb(127, 23, 53)']]) {
      const selected = page.locator(`.trip-map-marker[data-volume-band="${band}"]`);
      await expect(selected).toHaveCount(count); await expect(selected.first().locator('span')).toHaveCSS('background-color', color);
    }
    const group = () => pins().filter({ hasText: '2' });
    await expect(group()).toHaveAttribute('data-total-litres', '6000'); await expect(group()).toHaveAttribute('data-volume-band', 'yellow');
    await expect(group()).toHaveAttribute('aria-label', /Всего 6\s000 л/);
    assert.equal(await page.getByRole('list', { name: 'Цвет точки по сумме литров в заявках' }).locator('li').count(), 6);
    check(`${engine}: all five actual marker colors, exact boundaries and grouped decimal sum 6000; accessible labels and legend`);
    await group().hover(); await expect(card()).toContainText(/Всего 6\s000 л/); await page.waitForTimeout(1100); await expect(card()).toBeVisible();
    assert.equal(await card().locator('img').count(), 0); assert.equal(await page.evaluate(() => window.__xss), undefined); await close();
    check(`${engine}: grouped hover stays open with both requests, sum and safe comment`);
    const depotShape = await depots().first().locator('span').evaluate(element => ({ width: element.getBoundingClientRect().width, background: getComputedStyle(element).backgroundColor }));
    assert.ok(depotShape.width <= 18); assert.match(depotShape.background, /^rgba\(/);
    const shared = depots().filter({ hasText: '' }).and(page.getByRole('button', { name: 'Нефтебаза: QA Нефтебаза в точке клиента' }));
    await shared.click(); await expect(card()).toContainText('QA Нефтебаза в точке клиента'); await close();
    await page.locator('.trip-map-depots summary').click();
    await expect(page.locator('.trip-map-depots')).toContainText('Адрес не найден — уточните точку в справочнике нефтебаз');
    await expect(page.locator('.trip-map-depots')).toContainText('Укажите адрес или точку в справочнике нефтебаз');
    await page.locator('.trip-map-depots').getByRole('button', { name: 'QA Нефтебаза по адресу QA Найденный адрес' }).click();
    await expect(card()).toContainText('Найдено по адресу'); await close();
    check(`${engine}: small translucent depot markers, shared location remains clickable, automatic address point and honest missing-address list`);
    for (const [width, height] of [[1440, 1000], [768, 1000], [390, 844], [320, 568]]) {
      await page.setViewportSize({ width, height }); await page.getByRole('button', { name: 'Показать все', exact: true }).click(); await allInside();
      await group().focus(); await page.keyboard.press('Enter'); await expect(card()).toBeVisible();
      const bounds = await map().boundingBox(), detail = await card().boundingBox();
      assert.ok(detail.x >= bounds.x && detail.x + detail.width <= bounds.x + bounds.width + 1);
      assert.ok(detail.y >= bounds.y && detail.y + detail.height <= bounds.y + bounds.height + 1);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${engine} ${width}: document has no overflow`);
      await shot(`color-and-depots-${width}`); await page.keyboard.press('Escape'); await expect(card()).toHaveCount(0);
    }
    check(`${engine}: 320/390/768/1440 widths, Show all includes depots, bounded cards and keyboard Enter/Escape`);
    await page.setViewportSize({ width: 1440, height: 1000 }); await open(); await expect(depots()).toHaveCount(4);
    await map().evaluate(element => { element.dataset.qaIdentity = 'stable'; });
    const beforeRefresh = await signature(); await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await page.waitForTimeout(800);
    assert.equal(await map().getAttribute('data-qa-identity'), 'stable'); assert.deepEqual(await signature(), beforeRefresh);
    check(`${engine}: background refresh retains mounted map and geographical position`);
    scenario = 'empty'; await open(); await expect(pins()).toHaveCount(0); await expect(depots()).toHaveCount(4); await expect(page.locator('.trip-map-summary')).toContainText('Активных заявок нет');
    await page.getByRole('button', { name: 'Показать все', exact: true }).click(); await allInside(); await shot('depots-without-requests');
    check(`${engine}: map and Show all work with depots and no active requests`);
    scenario = 'late'; await open(); await expect(pins()).toHaveCount(6); await expect(depots()).toHaveCount(3); await expect.poll(() => typeof releaseGeocode).toBe('function');
    const beforeLate = await signature(); releaseGeocode(); await expect(depots()).toHaveCount(4); await expect(page.locator('.trip-map-outside')).toBeVisible(); assert.deepEqual(await signature(), beforeLate);
    await page.getByRole('button', { name: 'Показать все', exact: true }).click(); await expect(page.locator('.trip-map-outside')).toHaveCount(0); await allInside(); await shot('late-distant-depot');
    check(`${engine}: asynchronous distant depot preserves current view and is included by Show all`);
    scenario = 'full';
    const touchContext = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: 'reduce', serviceWorkers: 'block' });
    await authenticateContext(touchContext, runtime.base, cookie); await touchContext.route('**/*', intercept);
    const touchPage = await touchContext.newPage(); touchPage.on('pageerror', error => report.errors.push(`${engine}-touch: ${error.message}`));
    await touchPage.goto(runtime.base + '/#trips'); await touchPage.locator('.trips-section-tabs').getByRole('button', { name: 'Карта', exact: true }).tap();
    await expect(touchPage.locator('.trip-map-depot-marker')).toHaveCount(4);
    await touchPage.getByRole('button', { name: 'Показать все', exact: true }).tap();
    await touchPage.locator('.trip-map-marker').filter({ hasText: '2' }).tap();
    await expect(touchPage.locator('.trip-map-details')).toContainText(/Всего 6\s000 л/);
    await touchPage.getByRole('button', { name: 'Закрыть карточку точки', exact: true }).tap();
    await expect(touchPage.locator('.trip-map-details')).toHaveCount(0);
    await touchPage.getByRole('button', { name: 'Нефтебаза: QA Нефтебаза в точке клиента', exact: true }).tap();
    await expect(touchPage.getByRole('region', { name: 'Информация о нефтебазе', exact: true })).toBeVisible();
    await touchPage.getByRole('button', { name: 'Закрыть карточку точки', exact: true }).tap();
    await expect(touchPage.locator('.trip-map-details')).toHaveCount(0); await touchContext.close();
    check(`${engine}: real touch opens and closes both grouped requests and shared depot cards`);
    await context.close(); await browser.close(); browser = undefined;
  }
  assert.equal(await readFile(store.path, 'utf8'), beforeStore, 'map reads never modify business operations or directory coordinates');
  assert.deepEqual(report.externalRequests, []); assert.deepEqual(report.errors, []); report.status = 'passed'; report.passed = true;
} catch (error) { report.status = 'failed'; report.failure = String(error.stack || error); throw error; }
finally { await browser?.close(); await runtime?.server.close(); await rm(temporary, { recursive: true, force: true }); await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2)); }
