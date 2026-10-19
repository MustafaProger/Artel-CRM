// Real OpenLayers, authenticated synthetic CRM, local stub tiles; no provider/live-store claims.
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
const root = resolve(import.meta.dirname, '..'), output = resolve(root, 'qa/map-touch-2026-10-13');
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
  runtime = await startTripsQaServer({ root, snapshotDirectory, operationsDirectory });
  const { cookie } = await bootstrapQaAuth(runtime.base), sources = [];
  for (let i = 0; i < 3; i++) {
    const response = await fetch(runtime.base + '/api/trip-requests', { method: 'POST', headers: { Cookie: cookie, Origin: runtime.base, 'Content-Type': 'application/json' }, body: JSON.stringify({ companyId: `customer-${i}`, addressId: `address-${i}`, quantityLitres: String((i + 1) * 3000), comment: 'Длинный комментарий для проверки карточки. Въезд через северные ворота.\nТекст <img src=x onerror="window.__xss=1"> безопасен.', idempotencyKey: randomUUID() }) });
    assert.ok(response.ok); sources.push((await response.json()).request);
  }
  for (const [engine, driver] of [['chromium', chromium], ['webkit', webkit]]) {
    browser = await driver.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, reducedMotion: 'reduce', serviceWorkers: 'block' });
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
    const shot = async name => { const path = resolve(output, `${engine}-${name}.png`); await page.screenshot({ path, animations: 'disabled' }); report.screenshots.push(path); };
    const allInside = async () => {
      const b = await map().boundingBox(); for (const p of await pins().all()) { const a = await p.boundingBox(); assert.ok(a && a.x >= b.x + 10 && a.y >= b.y + 10 && a.x + a.width <= b.x + b.width - 10 && a.y + a.height <= b.y + b.height - 30, 'every marker fits with padding'); }
    };
    await open();
    assert.equal(await page.evaluate(() => matchMedia('(hover: hover) and (pointer: fine)').matches), false);
    const grouped = pins().filter({ hasText: '2' });
    await grouped.tap(); await expect(card()).toBeVisible(); await expect(card()).toHaveClass(/is-pinned/); await page.waitForTimeout(600); await expect(card()).toBeVisible();
    await shot('touch-group');
    await page.getByRole('button', { name: 'Закрыть карточку точки', exact: true }).tap(); await expect(card()).toHaveCount(0);
    await pins().filter({ hasText: /^$/ }).first().tap(); await expect(card()).toBeVisible();
    await page.getByRole('button', { name: 'Показать все', exact: true }).tap(); await expect(card()).toHaveCount(0); await allInside();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    check(`${engine}: actual touch emulation group/single tap, persistent pinned card, close and fit at 390px`);
    await context.close(); await browser.close(); browser = undefined;
  }
  assert.equal(report.externalRequests.length, 0); assert.equal(report.errors.length, 0); report.status = 'passed'; report.passed = true;
} catch (error) { report.status = 'failed'; report.failure = String(error.stack || error); throw error; }
finally { await browser?.close(); await runtime?.server.close(); await rm(temporary, { recursive: true, force: true }); await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2)); }
