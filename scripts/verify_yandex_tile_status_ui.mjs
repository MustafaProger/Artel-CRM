import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, relative } from 'node:path';
import { chromium, webkit, expect } from '@playwright/test';
import { OperationsStore } from '../server/operations-store.ts';
import { loadSnapshot } from '../server/local-api.ts';
import { startTripsQaServer, writeTripsQaSnapshot } from './qa-trips-runtime.mjs';
import { authenticateContext, bootstrapQaAuth } from './qa-auth.mjs';
const root = resolve(import.meta.dirname, '..'), output = resolve(root, 'qa/yandex-tile-status');
await mkdir(output, { recursive: true });
const sourcePaths = ['web/src', 'web/index.html', 'package.json', 'package-lock.json', 'vite.config.ts', 'tsconfig.json'];
async function manifest(paths) {
  const files = {};
  async function walk(path) { const items = await readdir(path, { withFileTypes: true }); for (const item of items) { const full = resolve(path, item.name); if (item.isDirectory()) await walk(full); else if (item.isFile()) files[relative(root, full)] = createHash('sha256').update(await readFile(full)).digest('hex'); } }
  for (const path of paths) { const full = resolve(root, path); try { await walk(full); } catch (error) { if (error.code !== 'ENOTDIR') throw error; files[path] = createHash('sha256').update(await readFile(full)).digest('hex'); } }
  const ordered = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
  return { sha256: createHash('sha256').update(JSON.stringify(ordered)).digest('hex'), files: ordered };
}
const beforeSource = await manifest(sourcePaths);
const report = { passed: false, fixtureOnly: true, productionAccessed: false, actualProviderVerified: false, realOpenLayers: true, stubbedTiles: true, usedBuiltAssets: false, testedVia: 'Vite source runtime', sourceBefore: beforeSource, checks: [], errors: [], externalRequests: [], screenshots: [], contexts: [], tileRequests: [] };
const check = name => { report.checks.push(name); console.log('PASS', name); };
const temporary = await mkdtemp(resolve(tmpdir(), 'artel-yandex-touch-'));
const snapshotDirectory = resolve(temporary, 'snapshot'), operationsDirectory = resolve(temporary, 'operations');
await writeTripsQaSnapshot(snapshotDirectory);
const snapshot = await loadSnapshot(snapshotDirectory), store = new OperationsStore(operationsDirectory);
const positions = [[55.6032093, 37.3583189], [55.643825, 37.851260]];
await store.mutate(snapshot.provenance.sourceSha256, data => {
  data.sourceOperationsCleared = true; data.shipments = {}; data.paymentAllocations = [];
  data.companies = positions.map((_, i) => ({ id: `touch-customer-${i}`, name: `QA Touch Компания ${i}`, roles: ['customer'], managerLabels: [], shipmentIds: [], paymentIds: [], flags: [] }));
  data.directories = { fleetSeedApplied: true, managers: [], products: [], paymentForms: [], drivers: [], vehicles: [], oilDepots: [], addresses: positions.map(([latitude, longitude], i) => ({ id: `touch-address-${i}`, companyId: `touch-customer-${i}`, kind: 'delivery', name: `QA Touch Площадка ${i}`, address: `Синтетическая площадка ${i}`, latitude: String(latitude), longitude: String(longitude) })), customerManagers: [], defaults: { profit: 'template-payment-form' }, duplicates: [] };
  return { changed: true, result: null };
});
const tileSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="512" height="512" fill="#eaf0e5"/><path d="M0 150H512M130 0V512M0 380H512M388 0V512" stroke="#fff" stroke-width="24"/><text x="100" y="280" fill="#85917d" font-family="sans-serif" font-size="24">QA TOUCH TILE</text></svg>';
let runtime, browser;
try {
  runtime = await startTripsQaServer({ root, snapshotDirectory, operationsDirectory });
  const { cookie } = await bootstrapQaAuth(runtime.base), sources = [];
  for (const [i, litres] of [[0, 3000], [1, 7000], [0, 11000]]) {
    const response = await fetch(runtime.base + '/api/trip-requests', { method: 'POST', headers: { Cookie: cookie, Origin: runtime.base, 'Content-Type': 'application/json' }, body: JSON.stringify({ companyId: `touch-customer-${i}`, addressId: `touch-address-${i}`, quantityLitres: String(litres), comment: 'Синтетическая мобильная проверка. Без сохранения изменений формы.', idempotencyKey: randomUUID() }) });
    assert.ok(response.ok); sources.push((await response.json()).request);
  }
  for (const [engine, driver] of [['chromium', chromium], ['webkit', webkit]]) {
    browser = await driver.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2, serviceWorkers: 'block' });
    await authenticateContext(context, runtime.base, cookie);
    let releaseOld, oldZoom, newZoomLoads = 0, mode = 'late-old', outstanding = 0, successful = 0;
    const held = [];
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== runtime.base) { report.externalRequests.push(url.origin); return route.abort(); }
      if (url.pathname !== '/api/maps/yandex/tiles') return route.continue();
      const z = Number(url.searchParams.get('z')); outstanding++;
      try {
        if (mode === 'late-old' && !releaseOld) {
          oldZoom = z;
          await new Promise(resolve => { releaseOld = async () => { await route.fulfill({ status: 503, body: 'synthetic late old-zoom error' }); resolve(); }; }); return;
        }
        if (mode === 'hold') { await new Promise(resolve => held.push(async () => { await route.fulfill({ contentType: 'image/svg+xml', body: tileSvg }).catch(() => {}); resolve(); })); return; }
        if (mode === 'fail-one' || mode === 'fail-all') { if (mode === 'fail-one') mode = 'good'; return await route.fulfill({ status: 503, body: 'synthetic current visible error' }); }
        if (z !== oldZoom) newZoomLoads++;
        successful++;
        return await route.fulfill({ contentType: 'image/svg+xml', body: tileSvg });
      } finally { outstanding--; }
    });
    const page = await context.newPage(); page.setDefaultTimeout(18000); page.on('pageerror', e => report.errors.push(`${engine}: ${e.message}`));
    const map = page.locator('.trip-map-canvas'), banner = page.locator('.trip-map-load-error');
    const zoom = async () => { await map.getByRole('button', { name: 'Приблизить карту', exact: true }).click(); await page.waitForTimeout(350); };
    const idle = async () => { await expect.poll(() => outstanding).toBe(0); await page.waitForTimeout(200); };
    const drag = async fraction => { const b = await map.boundingBox(); await page.mouse.move(b.x + b.width * (fraction > 0 ? .2 : .8), b.y + b.height * .5); await page.mouse.down(); await page.mouse.move(b.x + b.width * (fraction > 0 ? .8 : .2), b.y + b.height * .5, { steps: 10 }); await page.waitForTimeout(200); await page.mouse.up(); await page.waitForTimeout(300); };
    await page.goto(runtime.base + '/#trips'); await page.locator('.trips-section-tabs').getByRole('button', { name: 'Карта', exact: true }).click();
    await expect(page.locator('.trip-map-loading')).toHaveCount(0); await expect(page.locator('.trip-map-marker')).toHaveCount(2); await expect.poll(() => typeof releaseOld).toBe('function');
    await page.getByRole('button', { name: 'Показать все', exact: true }).click(); await expect.poll(() => newZoomLoads).toBeGreaterThan(0); await page.waitForTimeout(400);
    await expect(banner).toHaveCount(0); await releaseOld(); mode = 'good'; await idle(); await expect(banner).toHaveCount(0);
    check(`${engine}: late HTTP503 from the old zoom is ignored after successful current-zoom tiles`);

    mode = 'fail-one'; const successBefore = successful; await zoom(); await idle(); await expect(banner).toBeVisible(); assert.ok(successful > successBefore);
    await page.waitForTimeout(400); await expect(banner).toBeVisible();
    check(`${engine}: one current visible failure stays visible despite successful neighbouring tiles`);
    for (let i = 0; i < 3; i++) await drag(-1);
    await idle(); await expect(banner).toHaveCount(0);
    for (let i = 0; i < 3; i++) await drag(1);
    await idle(); await expect(banner).toBeVisible();
    check(`${engine}: pan to healthy tiles clears warning; returning to failed cached tile restores it`);
    mode = 'good'; await banner.getByRole('button', { name: 'Повторить', exact: true }).click(); await idle(); await expect(banner).toHaveCount(0); await expect(page.locator('.trip-map-loading')).toHaveCount(0);
    check(`${engine}: explicit retry replaces failed source and recovers`);

    mode = 'fail-all'; await zoom(); await expect(banner).toBeVisible(); mode = 'hold'; await banner.getByRole('button', { name: 'Повторить', exact: true }).click();
    await expect(page.locator('.trip-map-loading')).toBeVisible(); await expect(banner).toBeVisible({ timeout: 15000 });
    mode = 'good'; await banner.getByRole('button', { name: 'Повторить', exact: true }).click();
    for (const release of held) await release(); held.length = 0;
    await idle(); await expect(banner).toHaveCount(0); await expect(page.locator('.trip-map-loading')).toHaveCount(0);
    check(`${engine}: initial 12-second timeout still warns; dispose aborts pending tiles and retry recovers`);

    await page.locator('.trip-map-list li').filter({ hasText: 'QA Touch Компания 0' }).getByRole('button', { name: 'Изменить точку: QA Touch Компания 0', exact: true }).first().click();
    const editor = page.getByRole('dialog', { name: 'Изменить заявку', exact: true });
    mode = 'late-old'; releaseOld = undefined; oldZoom = undefined; newZoomLoads = 0;
    await editor.getByRole('button', { name: 'Изменить точку на карте', exact: true }).click();
    const picker = editor.locator('.delivery-point-map'), pickerError = editor.locator('.delivery-point-error');
    await expect.poll(() => typeof releaseOld).toBe('function'); await expect(picker.locator('.ol-viewport')).toBeVisible(); await page.waitForTimeout(250);
    await picker.getByRole('button', { name: 'Приблизить карту', exact: true }).click(); await expect.poll(() => newZoomLoads).toBeGreaterThan(0); await page.waitForTimeout(350);
    await releaseOld(); mode = 'good'; await idle(); await expect(pickerError).toHaveCount(0);
    mode = 'fail-one'; await picker.getByRole('button', { name: 'Приблизить карту', exact: true }).click(); await idle(); await expect(pickerError).toBeVisible();
    await pickerError.getByRole('button', { name: 'Повторить загрузку карты', exact: true }).click(); await idle(); await expect(pickerError).toHaveCount(0);
    check(`${engine}: picker ignores late old-zoom failure, reports current failure, and retries`);
    const shot = resolve(output, `${engine}-healthy-picker.png`); await page.screenshot({ path: shot }); report.screenshots.push(shot);
    await editor.getByRole('button', { name: 'Отмена', exact: true }).click();
    await context.unrouteAll({ behavior: 'wait' }); await context.close(); await browser.close(); browser = undefined;
  }
  assert.equal(report.errors.length, 0); assert.equal(report.externalRequests.length, 0);
  report.sourceAfter = await manifest(sourcePaths); report.sourceUnchanged = report.sourceAfter.sha256 === report.sourceBefore.sha256; assert.ok(report.sourceUnchanged); report.passed = true;
} catch(error) { report.failure = String(error.stack || error); throw error; }
finally { await browser?.close(); await runtime?.server.close(); await rm(temporary, { recursive: true, force: true }); await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2)); }
