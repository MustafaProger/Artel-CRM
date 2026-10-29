import { frontendCases } from './frontend-performance-cases.mjs';
// Built UI, synthetic API and temporary storage only. No provider or production calls.
import assert from 'node:assert/strict';
import { chromium, webkit, expect as baseExpect } from '@playwright/test';
import { createServer } from 'node:http';
import { createServer as createViteServer } from 'vite';
import react from '@vitejs/plugin-react';
import { readFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve, extname, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createSnapshotMiddleware } from '../server/local-api.ts';
import { writeTripsQaSnapshot } from './qa-trips-runtime.mjs';

const expect = baseExpect.configure({ timeout: 15000 });
const root = resolve(import.meta.dirname, '..');
const output = process.env.ARTEL_FRONTEND_QA_OUTPUT || resolve(root, '../frontend/performance-built');
await mkdir(output, { recursive: true });
const temp = await mkdtemp(resolve(tmpdir(), 'artel-navigation-split-'));
const snapshotDirectory = resolve(temp, 'snapshot'), operationsDirectory = resolve(temp, 'operations');
await writeTripsQaSnapshot(snapshotDirectory);
const denied = async () => { throw new Error('Provider call forbidden in navigation QA'); };
// Exercise the real CRM invoice authorization/proxy route against an injected
// worker response. No 1C provider, PDF creation or external request is involved.
const invoiceWorkspace = {
  integration: { status: 'read_only', message: 'Синтетические справочники QA', checkedAt: '2026-10-28T10:00:00Z' },
  organizations: [{ id: 'qa-seller', name: 'Учебный продавец', connectionId: 'qa-connection' }],
  buyers: [{ id: 'qa-buyer', name: 'Учебный покупатель', inn: '0000000000', connectionId: 'qa-connection' }],
  defaultUnitPrice: '79', settings: { defaultUnitPrice: '79', revision: 1, updatedAt: null, updatedBy: null },
  product: { name: 'Предоплата за дизельное топливо', unit: 'л', vatRate: '22', vatMode: 'included' },
  canCreate: false, canPrepare: false, canEditDefaultPrice: false, history: { status: 'ready', items: [] },
};
const middleware = createSnapshotMiddleware(snapshotDirectory, {
  operationsDirectory, requireAuthentication: true, checkoApiKey: '', setupToken: '',
  tripRequestGeocoder: async () => ({ status: 'unavailable', message: 'Synthetic QA' }),
  bankEnvironment: { ARTEL_BANK_REQUESTS_ENABLED: 'false', ARTEL_BANK_SYNC_ENABLED: 'false' },
  bankRequest: denied, sberRequest: denied, fetcher: denied,
  cabinetEnvironment: {}, pushConfig: { publicKey: '', privateKey: '', subject: '', schedule: false }, pushSender: denied,
  invoiceBridge: { request: async (path, method, body, identity) => {
    assert.equal(path, '/api/invoices'); assert.equal(method, 'GET');
    assert.equal(body.length, 0); assert.ok(identity?.crmUserId);
    return { status: 200, contentType: 'application/json', body: Buffer.from(JSON.stringify(invoiceWorkspace)) };
  } },
});
const publicRoot = resolve(process.env.ARTEL_FRONTEND_BASELINE_DIST || resolve(root, 'app-dist'));
const sourceMode = process.env.ARTEL_FRONTEND_SOURCE === '1';
const baseline = !!process.env.ARTEL_FRONTEND_BASELINE_DIST;
const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const staticServer = createServer((request, response) => middleware(request, response, async () => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const path = resolve(publicRoot, `.${pathname === '/' ? '/index.html' : pathname}`);
    const rel = relative(publicRoot, path);
    if (rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('Outside public directory');
    const bytes = await readFile(path);
    response.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    response.end(bytes);
  } catch { response.writeHead(404); response.end(); }
}));
let vite;
if (sourceMode) {
  vite = await createViteServer({ configFile: false, envDir: false, cacheDir: resolve(temp, 'vite-cache'), root: resolve(root, 'web'), plugins: [react(), { name: 'synthetic-api', configureServer(server) { server.middlewares.use(middleware); } }], server: { host: '127.0.0.1', port: 0, cors: false, fs: { strict: true, allow: [resolve(root, 'web'), resolve(root, 'node_modules'), resolve(temp, 'vite-cache')] } } });
  await vite.listen();
} else await new Promise(done => staticServer.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${(vite?.httpServer ?? staticServer).address().port}`;
const report = { checks: [], initialScripts: [], initialScriptBytes: 0, errors: [], apiErrors: [], apiResponses: [], requestFailures: [], scriptResponses: [], screenshots: [] };
report.webPushExcluded = true; report.synthetic = true; report.mode = sourceMode ? 'source' : 'built'; report.baseline = baseline; report.readiness = []; report.growth = []; report.axe = []; report.polling = []; report.maps = [];
report.invoiceWorkerSynthetic = true;
const check = name => { report.checks.push(name); console.log('PASS', name); };
const pages = [
  ['overview', '.overview-page'], ['work', '.work-page'], ['shipments', '.shipments-workspace'],
  ['trips', '.trips-page'], ['payments', '.banking-page'], ['cabinet-balances', '.cabinet-page'],
  ['china', '.china-page'], ['accounts', '.account-management'], ['directories', '.directories-page'],
  ['invoices', '.invoice-workspace'], ['operator', '.operator-workspace'],
];
report.routes = pages.map(([id]) => id);
const primaryApi = {
  overview: '/api/settlements', work: '/api/work', shipments: '/api/shipments', trips: '/api/trip-requests',
  payments: '/api/banking', 'cabinet-balances': '/api/cabinets', china: '/api/china', accounts: '/api/auth/users',
  directories: '/api/snapshot', invoices: '/api/invoices', operator: '/api/operator',
};
const waitForData = (page, id) => page.waitForResponse(response => new URL(response.url()).pathname === primaryApi[id] && response.request().method() === 'GET' && response.status() === 200);
async function loaded(page, id, selector) {
  await expect(page.locator(selector)).toBeVisible();
  if (id === 'invoices') {
    await expect(page.getByRole('combobox', { name: 'Продавец', exact: true })).toBeEnabled();
    await expect(page.getByRole('combobox', { name: 'Продавец', exact: true }).locator('option')).toContainText(['Выберите продавца', 'Учебный продавец']);
    await expect(page.getByRole('heading', { name: 'История счетов', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Обновить счета', exact: true })).toBeEnabled();
  }
  if (id === 'operator') {
    await expect(page.getByRole('heading', { name: /^Операции по водителям/ })).toBeVisible();
    await expect(page.getByLabel('Поиск операций', { exact: true })).toBeEnabled();
    await expect(page.locator('.operator-workspace').getByRole('button', { name: 'Обновить', exact: true })).toBeEnabled();
    await expect(page.getByText('Операций пока нет', { exact: true })).toBeVisible();
  }
}
let browser, initialized = false;
try {
  for (const [engine, launch] of [['chromium', () => chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' })], ['webkit', () => webkit.launch({ headless: true })]].filter(([engine]) => !process.env.ARTEL_SPLIT_ONLY_WEBKIT || engine === 'webkit')) {
    browser = await launch();
    // Navigation QA has no push provider. Native WebKit getSubscription freezes
    // this headless runtime even with the unchanged baseline; exclude workers.
    const context = await browser.newContext({ ...(initialized ? { storageState: resolve(temp, 'session.json') } : {}), viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    await context.addInitScript(() => {
      window.__qaLongTasks = []; window.__qaLongTaskSupported = PerformanceObserver.supportedEntryTypes?.includes('longtask') ?? false;
      if (PerformanceObserver.supportedEntryTypes?.includes('longtask')) new PerformanceObserver(list => { window.__qaLongTasks.push(...list.getEntries().map(entry => ({ start: entry.startTime, ms: entry.duration }))); }).observe({ type: 'longtask', buffered: true });
    });
    context.on('response', response => {
      const path = new URL(response.url()).pathname;
      if (!path.startsWith('/api/')) return;
      const row = { engine, path, status: response.status() };
      report.apiResponses.push(row);
      if (row.status >= 400) report.apiErrors.push(row);
    });
    const page = await context.newPage();
    await page.bringToFront();
    page.on('response', response => { if (response.request().resourceType() === 'script' || response.request().resourceType() === 'stylesheet') report.scriptResponses.push({ engine, url: response.url(), status: response.status() }); });
    page.on('requestfailed', request => report.requestFailures.push({ engine, url: request.url(), error: request.failure()?.errorText }));
    page.on('pageerror', error => report.errors.push({ engine, message: error.message }));
    const initialScripts = new Set();
    page.on('request', request => { if (request.resourceType() === 'script') initialScripts.add(new URL(request.url()).pathname); });
    await page.goto(base);
    if (!initialized) {
      await expect(page.getByRole('heading', { name: 'Первый вход', exact: true })).toBeVisible();
      report.initialScripts = [...initialScripts];
      for (const path of sourceMode ? [] : initialScripts) report.initialScriptBytes += (await readFile(resolve(publicRoot, `.${path}`))).length;
      assert.ok(!report.initialScripts.some(path => /TripsPage|DeliveryPointPicker|BankingPage/.test(path)));
      await page.getByLabel('Имя', { exact: true }).fill('Директор QA');
      await page.getByLabel('Логин', { exact: true }).fill('navigation-split');
      const password = randomUUID();
      await page.getByLabel('Пароль', { exact: true }).fill(password);
      await page.getByRole('button', { name: 'Создать директора', exact: true }).click();
      await expect(page.locator('.overview-page')).toBeVisible();
      await context.storageState({ path: resolve(temp, 'session.json') });
      initialized = true;
      check('Login downloads no trips, maps or banking modules');
    } else {
      await expect(page.locator('.overview-page')).toBeVisible();
    }
    // A new document for every route catches styles accidentally inherited from
    // previously visited pages, even when browser assets are cached.
    for (const [id, selector] of pages) {
      const cold = await context.newPage();
      cold.on('pageerror', error => report.errors.push({ engine, route: id, message: error.message }));
      const ready = waitForData(cold, id);
      await cold.goto(`${base}/#${id}`);
      await ready;
      await loaded(cold, id, selector);
      await cold.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
      report.readiness.push({ engine, route: id, ...(await cold.evaluate(() => ({ contentReadyMs: performance.now(), domNodes: document.getElementsByTagName('*').length, longTaskSupported: window.__qaLongTaskSupported, longTasks: window.__qaLongTasks, waterfall: performance.getEntriesByType('resource').map(row => ({ path: new URL(row.name).pathname, start: row.startTime, ms: row.duration, bytes: row.decodedBodySize })) }))) });

      if (id === 'directories') {
        await cold.getByRole('button', { name: 'Добавить', exact: true }).click();
        const dialog = cold.locator('.directory-editor');
        await expect(dialog).toBeVisible();
        for (const width of [1440, 390, 320]) {
          await cold.setViewportSize({ width, height: 1000 });
          const picker = dialog.locator('.company-picker').first();
          assert.equal(await picker.evaluate(el => getComputedStyle(el).position), 'relative');
          assert.equal(await picker.locator('.company-combobox').evaluate(el => getComputedStyle(el).display), 'flex');
          assert.ok((await picker.locator('input').boundingBox()).width > 40);
          assert.equal(await dialog.locator('.shipment-field-grid').first().evaluate(el => getComputedStyle(el).display), 'grid');
          assert.ok(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1));
        }
      }
      if (id === 'china') {
        await cold.getByRole('button', { name: 'Добавить день', exact: true }).click();
        const dialog = cold.locator('.china-editor');
        await expect(dialog).toBeVisible();
        for (const width of [1440, 390, 320]) {
          await cold.setViewportSize({ width, height: 1000 });
          assert.equal(await dialog.locator('form').evaluate(el => getComputedStyle(el).display), 'flex');
          assert.equal(await dialog.locator('.work-editor-body').evaluate(el => getComputedStyle(el).overflowY), 'auto');
          assert.equal(await dialog.locator('.work-field-grid').evaluate(el => getComputedStyle(el).display), 'grid');
          assert.ok(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1));
        }
        const screenshot = resolve(output, `${engine}-china-cold-320.png`);
        await cold.screenshot({ path: screenshot, fullPage: true }); report.screenshots.push(screenshot);
      }
      await cold.close();
    }
    check(`${engine}: all eleven routes open directly with successful data APIs; shared directory and China form styles survive cold load`);
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const [id, selector] of pages) {
        const titles = { overview: 'Обзор', work: 'Работа', shipments: 'Отгрузки', trips: 'Рейсы', payments: 'Платежи', 'cabinet-balances': 'Балансы кабинетов', china: 'Китай', accounts: 'Сотрудники и доступ', directories: 'Справочники', invoices: 'Счета', operator: 'Операторская' };
        const target = page.locator('.sidebar').getByRole('button', { name: titles[id], exact: true });
        if (!await target.isVisible() || await page.locator('.sidebar').evaluate(el => el.inert)) await page.getByRole('button', { name: 'Открыть меню', exact: true }).click();
        await page.bringToFront();
        const ready = new URL(page.url()).hash === `#${id}` ? Promise.resolve() : waitForData(page, id);
        await target.click();
        await ready;
        await loaded(page, id, selector);
        await expect(page.getByText('Не удалось открыть раздел', { exact: true })).toHaveCount(0);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${engine}/${id}/${width} horizontal overflow`);
      }
      const screenshot = resolve(output, `${engine}-${width}.png`);
      await page.screenshot({ path: screenshot, fullPage: true }); report.screenshots.push(screenshot);
      check(`${engine}: all eleven pages load and fit at ${width}px`);
    }
    if (engine === 'chromium' && !sourceMode) {
      const broken = await context.newPage();
      await broken.route('**/assets/WorkPage-*.js', route => route.abort());
      await broken.goto(`${base}/#work`);
      await expect(broken.getByText('Не удалось открыть раздел', { exact: true })).toBeVisible();
      await broken.unroute('**/assets/WorkPage-*.js');
      await broken.getByRole('button', { name: 'Обновить страницу', exact: true }).click();
      await expect(broken.locator('.work-page')).toBeVisible();
      await broken.close();
      check('A failed page-module download offers reload and recovers');
    }
    await frontendCases({ context, base, engine, report, baseline, output });
    await browser.close(); browser = null;
  }
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.apiErrors, []);
  check('Normal navigation has no browser JavaScript or API errors across eleven routes');
  report.passed = true;
} finally {
  await browser?.close();
  if (vite) await vite.close(); else await new Promise(done => staticServer.close(done));
  await rm(temp, { recursive: true, force: true });
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
}
