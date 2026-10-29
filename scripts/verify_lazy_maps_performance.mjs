// Real OpenLayers, authenticated synthetic CRM, local stub tiles; no provider/live-store claims.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium, webkit, expect } from '@playwright/test';
import { OperationsStore } from '../server/operations-store.ts';
import { loadSnapshot } from '../server/local-api.ts';
import { projectMapPoint, unprojectMapPoint } from '../web/src/yandex-map-coordinates.ts';
import { writeTripsQaSnapshot } from './qa-trips-runtime.mjs';
import { startOperatorQaServer } from './qa-operator-runtime.mjs';
import { authenticateContext } from './qa-auth.mjs';
const root = resolve(import.meta.dirname, '..'), output = resolve(process.env.ARTEL_MAP_QA_OUTPUT || resolve(root, '../frontend/maps-source'));
const temporary = await mkdtemp(resolve(tmpdir(), 'artel-yandex-'));
const snapshotDirectory = resolve(temporary, 'snapshot'), operationsDirectory = resolve(temporary, 'operations');
await mkdir(output, { recursive: true }); await writeTripsQaSnapshot(snapshotDirectory);
const snapshot = await loadSnapshot(snapshotDirectory), store = new OperationsStore(operationsDirectory);
const positions = [[55.6032093, 37.3583189], [55.643825, 37.851260], [56.1, 37.0]];
await store.mutate(snapshot.provenance.sourceSha256, data => {
  data.sourceOperationsCleared = true; data.shipments = {}; data.paymentAllocations = [];
  data.companies = positions.map((_, i) => ({ id: `customer-${i}`, name: `QA Компания ${i}`, roles: ['customer'], managerLabels: [], shipmentIds: [], paymentIds: [], flags: [] }));
  data.directories = { fleetSeedApplied: true, managers: [], products: [], paymentForms: [], drivers: [], vehicles: [], oilDepots: [], addresses: positions.map(([latitude, longitude], i) => ({ id: `address-${i}`, companyId: `customer-${i}`, kind: 'delivery', name: `QA Площадка ${i}`, address: `Синтетический адрес площадки ${i}`, latitude: String(latitude), longitude: String(longitude) })), customerManagers: [], defaults: { profit: 'template-payment-form' }, duplicates: [] };
  return { changed: true, result: null };
});
const report = { fixtureOnly: true, workingStoreAccessed: false, realOpenLayers: true, stubbedYandexApiTiles: true, realProviderVerified: false, externalRequests: [], errors: [], checks: [], screenshots: [], tileRequests: [], status: 'running' };
const check = name => { report.checks.push(name); console.log('PASS', name); };
const tileSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512" fill="#eaf0e5"/><path d="M0 150H512M130 0V512M0 380H512M388 0V512" stroke="#fff" stroke-width="24"/><text x="150" y="280" fill="#85917d" font-family="sans-serif" font-size="24">QA TILE</text></svg>';
let runtime, browser;
try {
  runtime = await startOperatorQaServer({ root, snapshotDirectory, operationsDirectory });
  const { cookie } = await runtime.bootstrap(), sources = [];
  for (let i = 0; i < 3; i++) {
    const response = await fetch(runtime.base + '/api/trip-requests', { method: 'POST', headers: { Cookie: cookie, Origin: runtime.base, 'Content-Type': 'application/json' }, body: JSON.stringify({ companyId: `customer-${i}`, addressId: `address-${i}`, quantityLitres: String((i + 1) * 3000), executionDate: new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(new Date()), comment: 'Въезд через северные ворота.\nТекст <img src=x onerror="window.__xss=1"> безопасен.', idempotencyKey: randomUUID() }) });
    assert.ok(response.ok); sources.push((await response.json()).request);
  }
  for (const [engine, driver] of [['chromium', chromium], ['webkit', webkit]]) {
    browser = await driver.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2, reducedMotion: 'reduce', serviceWorkers: 'block' });
    await authenticateContext(context, runtime.base, cookie);
    let scenario = 'group', failTiles = false;
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== runtime.base) { report.externalRequests.push(url.origin); return route.abort(); }
      if (url.pathname === '/api/maps/yandex/tiles') {
        assert.equal(url.searchParams.get('scale'), '2'); assert.ok(Number(url.searchParams.get('z')) <= 20); assert.equal([...url.searchParams.keys()].sort().join(','), 'scale,x,y,z');
        report.tileRequests.push(url.pathname + url.search);
        return failTiles ? route.fulfill({ status: 503, body: 'unavailable' }) : route.fulfill({ contentType: 'image/svg+xml', body: tileSvg });
      }
      if (url.pathname === '/api/trip-requests' && route.request().method() === 'GET') {
        const response = await route.fetch(), result = await response.json();
        const grouped = { ...sources[0], id: 'grouped', companyName: 'QA Общая точка', quantityLitres: '7500' };
        result.requests = scenario === 'single' ? sources.slice(0, 1) : scenario === 'empty' ? [] : scenario === 'unlocated' ? [{ ...sources[0], id: 'unknown', addressId: 'unknown', latitude: null, longitude: null, mapUrl: null, location: { status: 'not_found', message: 'Адрес не найден' } }] : [...sources, grouped];
        return route.fulfill({ json: result });
      }
      return route.continue();
    });
    const page = await context.newPage(); page.setDefaultTimeout(12000); page.on('pageerror', error => report.errors.push(`${engine}: ${error.message}`));
    const map = () => page.locator('.trip-map-canvas'), pins = () => page.locator('.trip-map-marker'), card = () => page.locator('.trip-map-details');
    const open = async () => { if (page.url() === runtime.base + '/#trips') await page.reload(); else await page.goto(runtime.base + '/#trips'); await page.locator('.trips-section-tabs').getByRole('button', { name: 'Карта', exact: true }).click(); await expect(map().locator('.ol-viewport')).toBeVisible(); await expect(page.locator('.trip-map-loading')).toHaveCount(0); };
    const signature = () => map().evaluate(e => [...e.querySelectorAll('.ol-overlay-container')].map(n => n.style.transform));
    const close = async () => { if (await card().count()) await page.getByRole('button', { name: 'Закрыть карточку точки', exact: true }).click(); await page.mouse.move(0, 0); };
    const shot = async name => { const path = resolve(output, `${engine}-${name}.png`); await page.screenshot({ path, animations: 'disabled' }); report.screenshots.push(path); };
    const allInside = async () => {
      const b = await map().boundingBox(); for (const p of await pins().all()) { const a = await p.boundingBox(); assert.ok(a && a.x >= b.x + 10 && a.y >= b.y + 10 && a.x + a.width <= b.x + b.width - 10 && a.y + a.height <= b.y + b.height - 30, 'every marker fits with padding'); }
    };
    await open(); await expect(pins()).toHaveCount(3); await expect(page.locator('.trip-map-summary')).toContainText('На карте 4 из 4');
    await expect(map().getByRole('link', { name: 'Яндекс Карты', exact: true })).toBeVisible(); await expect(map().getByRole('link', { name: '© Яндекс' })).toBeVisible(); await expect(map().getByRole('link', { name: 'Открыть в Картах' })).toHaveAttribute('href', /ll=.*&z=/);
    assert.ok(await map().locator('.yandex-map-logo img').evaluate(e => e.complete && e.naturalWidth > 0));
    const broad = await signature(); await page.getByRole('button', { name: 'Показать все', exact: true }).click(); await expect.poll(signature).not.toEqual(broad); await allInside(); const fitted = await signature();
    for (let repeat = 0; repeat < 3; repeat++) {
      const b = await map().boundingBox(); await page.mouse.move(b.x + b.width * .6, b.y + b.height * .5); await page.mouse.down(); await page.mouse.move(b.x + b.width * .35, b.y + b.height * .75, { steps: 10 }); await page.waitForTimeout(200); await page.mouse.up(); await page.waitForTimeout(350);
      await map().getByRole('button', { name: 'Приблизить карту', exact: true }).click(); await page.waitForTimeout(350); assert.notDeepEqual(await signature(), fitted);
      await page.getByRole('button', { name: 'Показать все', exact: true }).click(); await expect.poll(signature).toEqual(fitted); await allInside();
    }
    check(`${engine}: initial wide view, exact actual-points fit, three drag/zoom/show-all cycles, all markers padded`);
    const grouped = pins().filter({ hasText: '2' }); await grouped.hover(); await expect(card()).toBeVisible(); await expect(card()).toContainText('QA Общая точка'); await expect(card()).toContainText('7 500 л');
    assert.equal(await card().locator('img').count(), 0); assert.equal(await page.evaluate(() => window.__xss), undefined); assert.deepEqual(await signature(), fitted); await shot('desktop-group-card'); await close();
    await grouped.focus(); await page.keyboard.press('Enter'); await expect(card()).toBeVisible(); await page.keyboard.press('Escape'); await expect(card()).toHaveCount(0);
    await map().evaluate(e => { e.dataset.identity = 'retained'; }); const beforeRefresh = await signature(); await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await page.waitForTimeout(700); assert.equal(await map().getAttribute('data-identity'), 'retained'); assert.deepEqual(await signature(), beforeRefresh);
    check(`${engine}: grouped hover/keyboard safe details, source branding, refresh keeps mounted map/view`);
    for (const width of [320, 390, 768, 1920]) {
      await page.setViewportSize({ width, height: width === 320 ? 568 : width === 390 ? 844 : 1000 }); await page.waitForTimeout(100); await page.getByRole('button', { name: 'Показать все', exact: true }).click(); await page.waitForTimeout(100); await allInside(); await grouped.click(); await expect(card()).toBeVisible();
      const b = await map().boundingBox(), c = await card().boundingBox(); assert.ok(c.x >= b.x && c.x + c.width <= b.x + b.width + 1 && c.y >= b.y && c.y + c.height <= b.y + b.height - 42); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await expect(map().getByRole('link', { name: 'Яндекс Карты', exact: true })).toBeVisible(); await shot(`group-card-${width}`); await close();
    }
    check(`${engine}: 320/390/768/1920 touch-sized markers/cards, branding unobscured, no page overflow`);
    await page.setViewportSize({ width: 1440, height: 1000 }); scenario = 'single'; await open(); await expect(pins()).toHaveCount(1); const singleBroad = await signature(); await page.getByRole('button', { name: 'Показать все', exact: true }).click(); await expect.poll(signature).not.toEqual(singleBroad); await allInside(); await shot('single-fit');
    for (let level = 0; level < 10; level++) { await map().getByRole('button', { name: 'Приблизить карту', exact: true }).click(); await page.waitForTimeout(280); }
    await expect(map().getByRole('link', { name: 'Открыть в Картах' })).toHaveAttribute('href', /&z=20$/);
    assert.ok(report.tileRequests.some(url => new URL(url, runtime.base).searchParams.get('z') === '20'));
    check(`${engine}: maximum zoom capped at 20; all retina tile requests use standard XYZ z<=20`);
    scenario = 'unlocated'; await open(); await expect(pins()).toHaveCount(0); await expect(page.getByRole('button', { name: 'Показать все', exact: true })).toBeDisabled(); await expect(page.locator('.trip-map-list-static')).toBeVisible();
    scenario = 'empty'; await page.reload(); await page.locator('.trips-section-tabs').getByRole('button', { name: 'Карта', exact: true }).click(); await expect(page.getByText('Нет заявок на сегодня и завтра')).toBeVisible(); await expect(map()).toHaveCount(0);
    check(`${engine}: single actual point, no coordinates disables fit, empty active set has honest placeholder`);
    scenario = 'group'; failTiles = true; await open(); await expect(page.locator('.trip-map-load-error')).toBeVisible(); await expect(pins()).toHaveCount(3); failTiles = false; await page.locator('.trip-map-load-error').getByRole('button', { name: 'Повторить', exact: true }).click(); await expect(page.locator('.trip-map-load-error')).toHaveCount(0); await expect(page.locator('.trip-map-loading')).toHaveCount(0);
    check(`${engine}: failed Yandex tiles retain points, explicit retry succeeds without fallback`);
    await page.locator('.trip-map-list li').filter({ hasText: 'QA Компания 0' }).getByRole('button', { name: 'Изменить точку: QA Компания 0', exact: true }).click();
    const editor = page.getByRole('dialog', { name: 'Изменить заявку', exact: true }); await editor.getByRole('button', { name: 'Изменить точку на карте', exact: true }).click();
    const picker = editor.locator('.delivery-point-map'); await expect(picker.locator('.ol-viewport')).toBeVisible(); await expect(picker.getByRole('link', { name: 'Яндекс Карты', exact: true })).toBeVisible();
    const lat = editor.getByRole('textbox', { name: 'Широта точки', exact: true }), lon = editor.getByRole('textbox', { name: 'Долгота точки', exact: true });
    await lat.fill('55.643825'); await lon.fill('37.851260'); await editor.getByRole('button', { name: 'Применить координаты', exact: true }).click(); await expect(editor.locator('.delivery-point-summary')).toContainText('55.643825, 37.851260');
    const b = await picker.boundingBox(); await page.mouse.move(b.x + b.width / 2 + 8, b.y + b.height / 2 + 6); await page.mouse.down(); await page.mouse.move(b.x + b.width / 2 + 53, b.y + b.height / 2 + 41, { steps: 10 }); await page.mouse.up(); await expect(lat).not.toHaveValue('55.643825'); const dragged = await lat.inputValue();
    const projected = projectMapPoint([55.643825, 37.851260]), resolution = 2 * Math.PI * 6378137 / (256 * 2 ** 16);
    const expectedPoint = unprojectMapPoint([projected[0] + 45 * resolution, projected[1] - 35 * resolution]);
    assert.equal(dragged, expectedPoint[0].toFixed(6)); assert.equal(await lon.inputValue(), expectedPoint[1].toFixed(6));
    await picker.click({ position: { x: b.width * .7, y: b.height * .3 } }); await expect(lat).not.toHaveValue(dragged); await shot('picker-manual-drag-click');
    const live = await (await fetch(runtime.base + '/api/trip-requests', { headers: { Cookie: cookie } })).json(); assert.equal(live.requests.find(r => r.id === sources[0].id).latitude, sources[0].latitude); assert.equal(live.requests.find(r => r.id === sources[0].id).longitude, sources[0].longitude);
    await editor.getByRole('button', { name: 'Отмена', exact: true }).click(); await editor.getByRole('button', { name: 'Закрыть без сохранения', exact: true }).click(); await expect(editor).toHaveCount(0);
    check(`${engine}: Yandex picker manual coordinates, real vector drag, map click, cancellation preserves stored point`);
    const directoryBefore = (await (await fetch(runtime.base + '/api/trip-requests', { headers: { Cookie: cookie } })).json()).addresses;
    await page.goto(runtime.base + '/#directories');
    await page.getByRole('button', { name: 'Места погрузки и доставки', exact: true }).click();
    await page.getByRole('button', { name: 'Редактировать: QA Площадка 0', exact: true }).click();
    const directory = page.getByRole('dialog', { name: 'Карточка адреса', exact: true });
    await directory.getByRole('button', { name: 'Изменить точку на карте', exact: true }).click();
    await expect(directory.locator('.delivery-point-map .ol-viewport')).toBeVisible();
    await expect(directory.locator('.delivery-point-map').getByRole('link', { name: 'Яндекс Карты', exact: true })).toBeVisible();
    await expect(directory.getByRole('textbox', { name: 'Широта точки', exact: true })).toHaveValue(String(positions[0][0]));
    await expect(directory.getByRole('textbox', { name: 'Долгота точки', exact: true })).toHaveValue(String(positions[0][1]));
    await shot('directory-read-only-point'); await directory.getByRole('button', { name: 'Отмена', exact: true }).click(); await expect(directory).toHaveCount(0);
    const directoryAfter = (await (await fetch(runtime.base + '/api/trip-requests', { headers: { Cookie: cookie } })).json()).addresses;
    assert.deepEqual(directoryAfter, directoryBefore);
    check(`${engine}: directory Yandex picker shows exact persisted point, read-only open/cancel preserves all addresses`);
    await context.unrouteAll({ behavior: 'wait' });
    await context.close(); await browser.close(); browser = undefined;
  }
  assert.equal(report.externalRequests.length, 0); assert.equal(report.errors.length, 0); assert.ok(report.tileRequests.length > 0); report.status = 'passed'; report.passed = true;
} catch (error) { report.status = 'failed'; report.failure = String(error.stack || error); throw error; }
finally { await browser?.close(); await runtime?.server.close(); await rm(temporary, { recursive: true, force: true }); await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2)); }
