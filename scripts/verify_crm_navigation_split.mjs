// Built UI, synthetic API and temporary storage only. No provider or production calls.
import assert from 'node:assert/strict';
import { chromium, webkit, expect as baseExpect } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve, extname, relative, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createSnapshotMiddleware } from '../server/local-api.ts';
import { writeTripsQaSnapshot } from './qa-trips-runtime.mjs';

const expect = baseExpect.configure({ timeout: 15000 });
const root = resolve(import.meta.dirname, '..');
const output = process.env.ARTEL_SPLIT_QA_OUTPUT || resolve(root, 'qa/navigation-split');
await mkdir(output, { recursive: true });
const temp = await mkdtemp(resolve(tmpdir(), 'artel-navigation-split-'));
const snapshotDirectory = resolve(temp, 'snapshot'), operationsDirectory = resolve(temp, 'operations');
await writeTripsQaSnapshot(snapshotDirectory);
const denied = async () => { throw new Error('Provider call forbidden in navigation QA'); };
const middleware = createSnapshotMiddleware(snapshotDirectory, {
  operationsDirectory, requireAuthentication: true, checkoApiKey: '', setupToken: '',
  tripRequestGeocoder: async () => ({ status: 'unavailable', message: 'Synthetic QA' }),
  bankEnvironment: { ARTEL_BANK_REQUESTS_ENABLED: 'false', ARTEL_BANK_SYNC_ENABLED: 'false' },
  bankRequest: denied, sberRequest: denied, fetcher: denied,
  cabinetEnvironment: {}, pushConfig: { publicKey: '', privateKey: '', subject: '', schedule: false }, pushSender: denied,
});
const publicRoot = resolve(root, 'app-dist');
const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const server = createServer((request, response) => middleware(request, response, async () => {
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
await new Promise(done => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;
const report = { checks: [], initialScripts: [], initialScriptBytes: 0, errors: [], requestFailures: [], scriptResponses: [], screenshots: [] };
report.webPushExcluded = true;
const check = name => { report.checks.push(name); console.log('PASS', name); };
const pages = [
  ['overview', '.overview-page'], ['work', '.work-page'], ['shipments', '.shipments-workspace'],
  ['trips', '.trips-page'], ['payments', '.banking-page'], ['cabinet-balances', '.cabinet-page'],
  ['china', '.china-page'], ['accounts', '.account-management'], ['directories', '.directories-page'],
];
let browser, initialized = false;
try {
  for (const [engine, launch] of [['chromium', () => chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' })], ['webkit', () => webkit.launch({ headless: true })]].filter(([engine]) => !process.env.ARTEL_SPLIT_ONLY_WEBKIT || engine === 'webkit')) {
    browser = await launch();
    // Navigation QA has no push provider. Native WebKit getSubscription freezes
    // this headless runtime even with the unchanged baseline; exclude workers.
    const context = await browser.newContext({ ...(initialized ? { storageState: resolve(temp, 'session.json') } : {}), viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
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
      for (const path of initialScripts) report.initialScriptBytes += (await readFile(resolve(publicRoot, `.${path}`))).length;
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
      await cold.goto(`${base}/#${id}`);
      await expect(cold.locator(selector)).toBeVisible();
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
    check(`${engine}: all nine routes open directly; shared directory and China form styles survive cold load`);
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const [id, selector] of pages) {
        const titles = { overview: 'Обзор', work: 'Работа', shipments: 'Отгрузки', trips: 'Рейсы', payments: 'Платежи', 'cabinet-balances': 'Балансы кабинетов', china: 'Китай', accounts: 'Сотрудники и доступ', directories: 'Справочники' };
        const target = page.locator('.sidebar').getByRole('button', { name: titles[id], exact: true });
        if (!await target.isVisible() || await page.locator('.sidebar').evaluate(el => el.inert)) await page.getByRole('button', { name: 'Открыть меню', exact: true }).click();
        await page.bringToFront();
        await target.click();
        await expect(page.locator(selector)).toBeVisible();
        await expect(page.getByText('Не удалось открыть раздел', { exact: true })).toHaveCount(0);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${engine}/${id}/${width} horizontal overflow`);
      }
      const screenshot = resolve(output, `${engine}-${width}.png`);
      await page.screenshot({ path: screenshot, fullPage: true }); report.screenshots.push(screenshot);
      check(`${engine}: all nine pages load and fit at ${width}px`);
    }
    if (engine === 'chromium') {
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
    await browser.close(); browser = null;
  }
  assert.deepEqual(report.errors, []);
  check('Normal navigation has no browser JavaScript errors');
  report.passed = true;
} finally {
  await browser?.close();
  await new Promise(done => server.close(done));
  await rm(temp, { recursive: true, force: true });
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
}
