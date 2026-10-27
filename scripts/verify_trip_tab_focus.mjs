// Synthetic authenticated CRM, local tiles, and controlled API results only.
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium, webkit, expect } from '@playwright/test';
import { OperationsStore } from '../server/operations-store.ts';
import { loadSnapshot } from '../server/local-api.ts';
import { startTripsQaServer, writeTripsQaSnapshot } from './qa-trips-runtime.mjs';
import { authenticateContext, bootstrapQaAuth } from './qa-auth.mjs';

const root = resolve(import.meta.dirname, '..'), output = resolve(root, '.local/tab-focus', process.argv.includes('--built') ? 'built' : 'source');
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

const built = process.argv.includes('--built');
const report = { synthetic: true, passed: false, errors: [], checks: [] };
async function manifest(dir, prefix = '') {
 const value = {};
 for (const e of await readdir(dir, { withFileTypes: true })) {
  const name = prefix + e.name, path = resolve(dir, e.name);
  if (e.isDirectory()) Object.assign(value, await manifest(path, name + '/'));
  else value[name] = createHash('sha256').update(await readFile(path)).digest('hex');
 } return value;
}
let runtime, browser;
try {
 runtime = await startTripsQaServer({ root, snapshotDirectory, operationsDirectory });
 if (built) {
  runtime.server.middlewares.stack.unshift({ route: '', handle(req, res, next) {
   const path = new URL(req.url, runtime.base).pathname;
   if (path.startsWith('/api/')) return next();
   const relative = path === '/' ? 'index.html' : path.slice(1);
   if (relative.includes('..')) return next();
   readFile(resolve(root, 'app-dist', relative)).then(body => {
    res.setHeader('Content-Type', relative.endsWith('.js') ? 'text/javascript' : relative.endsWith('.css') ? 'text/css' : relative.endsWith('.svg') ? 'image/svg+xml' : 'text/html');res.end(body);
   }).catch(() => next());
  }});
  report.artifacts = { frontend: await manifest(resolve(root, 'app-dist'), 'app-dist/'), serverBundleSha256: createHash('sha256').update(await readFile(resolve(root, 'server-render/production.mjs'))).digest('hex') };
 }
 const { cookie } = await bootstrapQaAuth(runtime.base);
 const response = await fetch(runtime.base + '/api/trip-requests', { method: 'POST', headers: { Cookie: cookie, Origin: runtime.base, 'Content-Type': 'application/json' }, body: JSON.stringify({ companyId: 'customer-0', addressId: 'address-0', quantityLitres: '1000', comment: 'QA focus', idempotencyKey: randomUUID() }) });
 assert.ok(response.ok);
 for (const [engine, driver] of [['chromium', chromium], ['webkit', webkit]]) {
  browser = await driver.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  await authenticateContext(context, runtime.base, cookie);
  await context.route('**/*', route => new URL(route.request().url()).origin === runtime.base ? route.continue() : route.abort());
  const page = await context.newPage();page.setDefaultTimeout(15000);
  page.on('pageerror', e => report.errors.push(engine + ': ' + e.message));
  const reads = { '/api/shipment-trips': 0, '/api/trip-requests': 0 };
  page.on('request', req => { const path = new URL(req.url()).pathname;if (req.method() === 'GET' && path in reads) reads[path]++; });
  await page.goto(runtime.base + '/#trips');
  const tabs = page.getByRole('group', { name: 'Разделы рейсов', exact: true });
  await expect(tabs).toBeVisible();
  for (const view of ['Заявки', 'Рейсы', 'Карта']) {
   await tabs.getByRole('button', { name: view, exact: true }).click();await page.waitForTimeout(800);
   if (view === 'Рейсы') await page.getByRole('textbox', { name: 'Поиск рейса', exact: true }).fill('сохранённый поиск');
   const before = { ...reads };
   await page.evaluate(() => { window.dispatchEvent(new Event('blur'));document.dispatchEvent(new Event('visibilitychange')); });
   await page.waitForTimeout(1000);
   await page.evaluate(() => { window.dispatchEvent(new Event('focus'));document.dispatchEvent(new Event('visibilitychange'));window.dispatchEvent(new Event('focus')); });
   await page.waitForTimeout(800);assert.deepEqual(reads, before, engine + ': focus must not reload ' + view);
   await expect(tabs.getByRole('button', { name: view, exact: true })).toHaveAttribute('aria-pressed','true');
   if (view === 'Рейсы') await expect(page.getByRole('textbox', { name: 'Поиск рейса', exact: true })).toHaveValue('сохранённый поиск');
   report.checks.push({ engine, view, focusDoesNotReload: true, viewPreserved: true });
  }
  const before = { ...reads };
  await tabs.getByRole('button', { name: 'Заявки', exact: true }).click();
  await expect.poll(() => reads['/api/trip-requests']).toBeGreaterThan(before['/api/trip-requests']);
  await expect.poll(() => reads['/api/shipment-trips']).toBeGreaterThan(before['/api/shipment-trips']);
  await page.getByRole('button', { name: 'Новая заявка', exact: true }).click();await expect(page.getByRole('dialog')).toBeVisible();
  const formReads = { ...reads };await page.evaluate(() => window.dispatchEvent(new Event('focus')));await page.waitForTimeout(600);
  await expect(page.getByRole('dialog')).toBeVisible();assert.deepEqual(reads,formReads);
  report.checks.push({ engine, explicitNavigationRefresh: true, openFormPreserved: true });
  await browser.close();browser = null;
 }
 assert.deepEqual(report.errors, []);report.passed = true;
} finally {
 await browser?.close();await runtime?.server.close();await writeFile(resolve(output,'result.json'),JSON.stringify(report,null,2));await rm(temporary,{recursive:true,force:true});
}
console.log(JSON.stringify(report));
