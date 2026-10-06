// Synthetic browser acceptance only: no working snapshot, credentials or providers.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium, webkit, expect } from '@playwright/test';
import { OperationsStore } from '../server/operations-store.ts';
import { SabyClient, sabyConfigFromEnv } from '../server/saby-client.ts';
import { sberConnections } from '../server/banking/sber-connections.ts';
import { loadSnapshot } from '../server/local-api.ts';
import { startTripsQaServer, writeTripsQaSnapshot } from './qa-trips-runtime.mjs';
import { authenticateContext, bootstrapQaAuth } from './qa-auth.mjs';

const root = resolve(process.env.QA_ROOT || resolve(import.meta.dirname, '..'));
const useWebKit = process.env.QA_WEBKIT === '1';
const output = resolve(root, `qa/shipment-layout-20261006${useWebKit ? '-webkit' : ''}${process.env.QA_OUTPUT_SUFFIX || ''}`);
const temporary = await mkdtemp(resolve(tmpdir(), 'artel-shipment-layout-'));
const snapshotDirectory = resolve(temporary, 'snapshot'), operationsDirectory = resolve(temporary, 'operations');
const report = { status: 'running', browser: useWebKit ? 'webkit' : 'chromium', fixtureOnly: true, workingStoreAccessed: false, providerCalls: 0, checks: [], controls: [], layouts: [], gaps: [], screenshots: [], errors: [], consoleErrors: [], unexpectedRequests: [], mutationRequests: [] };
let runtime, browser;
await mkdir(output, { recursive: true });
try {
  await writeTripsQaSnapshot(snapshotDirectory);
  const snapshot = await loadSnapshot(snapshotDirectory), store = new OperationsStore(operationsDirectory);
  const company = (id, name, roles) => ({ id, name, roles, managerLabels: [], shipmentIds: [], paymentIds: [], flags: [] });
  await store.mutate(snapshot.provenance.sourceSha256, data => {
    data.sourceOperationsCleared = true;
    data.shipments = {}; data.paymentAllocations = [];
    data.companies = [company('qa-supplier', 'QA Поставщик', ['supplier']), company('qa-customer', 'QA Клиент', ['customer'])];
    data.directories = {
      fleetSeedApplied: true, managers: [{ id: 'qa-manager', name: 'QA Сотрудник' }],
      products: [{ id: 'qa-product', name: 'QA Дизельное топливо', transportProductKind: 'diesel', cargoPackaging: 'bulk' }],
      paymentForms: [{ id: 'qa-payment', name: 'б/нал' }], vehicles: [{ id: 'qa-vehicle', plate: 'Т000ЕЕ00', capacityLitres: '16000' }],
      drivers: [{ id: 'qa-driver', name: 'QA Водитель', vehicleId: 'qa-vehicle' }], oilDepots: [], addresses: [],
      customerManagers: [{ companyId: 'qa-customer', managerId: 'qa-manager' }], defaults: { profit: 'template-payment-form' }, duplicates: [],
    };
    return { changed: true, result: null };
  });
  // Replace source configuration identifiers only inside this synthetic process.
  for (const [index, connection] of Object.values(sberConnections).entries()) {
    connection.account = `${'0'.repeat(19)}${index + 1}`; connection.inn = `${'0'.repeat(9)}${index + 1}`;
  }
  const sabyClient = new SabyClient(sabyConfigFromEnv({}), async () => { report.providerCalls++; throw new Error('External Saby call forbidden'); });
  runtime = await startTripsQaServer({ root, snapshotDirectory, operationsDirectory, sabyClient });
  const { cookie } = await bootstrapQaAuth(runtime.base);
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const response = await fetch(runtime.base + '/api/shipment-trips', { method: 'POST', headers: { Cookie: cookie, Origin: runtime.base, 'Content-Type': 'application/json' }, body: JSON.stringify({
    idempotencyKey: randomUUID(), fields: { organization_id: 'artel', date: day, loading_at: day, supplier_id: 'qa-supplier', product_id: 'qa-product', purchase_price_unspecified_unit: '60000', quantity_tonnes: '8', driver_id: 'qa-driver', vehicle_id: 'qa-vehicle' },
    customers: [{ fields: { customer_id: 'qa-customer', manager_id: 'qa-manager', payment_form_id: 'qa-payment', quantity_litres: '10000', sale_price_per_litre: '75', transport_amount: '1000', invoice_not_required: 'true' } }],
  }) });
  assert.ok(response.ok, `Synthetic trip fixture: ${response.status} ${await response.clone().text()}`);
  browser = useWebKit ? await webkit.launch({ headless: true }) : await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', timezoneId: 'Europe/Moscow', serviceWorkers: 'block' });
  await authenticateContext(context, runtime.base, cookie);
  await context.route('**/*', route => {
    const request = route.request();
    if (new URL(request.url()).origin !== runtime.base) { report.unexpectedRequests.push(request.url()); return route.abort(); }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) { report.mutationRequests.push({ method: request.method(), url: request.url() }); return route.abort(); }
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', error => report.errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
  const visit = async route => {
    await page.goto(`${runtime.base}/#${route}`);
    await page.locator({ shipments: '.shipment-grid', directories: '.directory-list', accounts: '.account-panel', payments: '.banking-page' }[route]).waitFor();
    await expect(page.locator('.loading-state')).toHaveCount(0);
    if (route === 'shipments') await expect(page.getByTestId('shipment-row')).toHaveCount(1);
  };
  const widths = [320, 361, 390, 701, 767, 768, 769, 800, 1100, 1440, 1920];
  for (const width of widths) {
    await page.setViewportSize({ width, height: 1000 });
    await visit('shipments');
    const ledger = () => page.locator('.shipment-grid, .shipment-grid *').evaluateAll(elements => elements.map(element => {
      const style = getComputedStyle(element), r = element.getBoundingClientRect(), table = element.closest('.shipment-grid').getBoundingClientRect();
      return { tag: element.tagName, rect: [r.x - table.x, r.y - table.y, r.width, r.height].map(value => Math.round(value * 100) / 100), css: Object.fromEntries(['font', 'color', 'backgroundColor', 'border', 'borderRadius', 'padding', 'margin', 'boxShadow', 'display', 'gap'].map(key => [key, style[key]])) };
    }));
    const current = await ledger();
    const toolbarStyle = page.locator('style[data-vite-dev-id$="/shipments-toolbar.css"]');
    await expect(toolbarStyle).toHaveCount(1);
    await toolbarStyle.evaluate(element => { element.sheet.disabled = true; });
    const baseline = await ledger();
    await toolbarStyle.evaluate(element => { element.sheet.disabled = false; });
    assert.deepEqual(current, baseline, `Protected ledger CSS/relative geometry ${width}px`);
    const layout = await page.evaluate(() => {
      const box = selector => { const e = document.querySelector(selector), r = e.getBoundingClientRect(), s = getComputedStyle(e); return { x:r.x, y:r.y, right:r.right, bottom:r.bottom, width:r.width, height:r.height, background:s.backgroundColor, radius:parseFloat(s.borderRadius), paddingTop:parseFloat(s.paddingTop), paddingBottom:parseFloat(s.paddingBottom) }; };
      return { width:innerWidth, document:document.documentElement.scrollWidth, header:box('.shipment-toolbar'), title:box('.shipment-header h1'), menu:box('.shipment-menu'), row:box('.shipment-search-row'), search:box('.shipment-search-row .shipment-search'), add:box('.shipment-add'), strip:box('.shipment-template-row'), table:box('.shipment-grid-scroll'), labelVisible:getComputedStyle(document.querySelector('.shipment-add span')).display !== 'none', blocks:[...document.querySelector('.shipment-panel').children].slice(0,4).map(e => e.className) };
    });
    assert.deepEqual(layout.blocks, ['shipment-toolbar', 'shipment-search-row', 'shipment-template-row', 'shipment-grid-scroll']);
    assert.ok(layout.document <= width + 1, `Document overflow ${JSON.stringify(layout)}`);
    assert.ok(layout.header.paddingTop >= 24 && layout.header.paddingBottom >= 20, 'Spacious heading');
    assert.equal(layout.header.background, 'rgb(245, 245, 247)');
    assert.ok(layout.title.right < layout.menu.x && layout.title.y < layout.menu.bottom, 'Title and menu fit');
    assert.ok(layout.header.bottom <= layout.row.y && layout.row.bottom <= layout.strip.y && layout.strip.bottom <= layout.table.y, 'Four sequential blocks');
    assert.ok(Math.abs(layout.search.y - layout.add.y) < 2 && layout.search.right + 11 <= layout.add.x && layout.add.right <= width - 11 && layout.search.width >= 200, 'Search and add share a row without overlap');
    assert.ok(layout.search.radius >= layout.search.height / 2, 'Rounded search');
    assert.equal(layout.labelVisible, width > 768, 'Exact 768px boundary');
    if (width <= 768) assert.ok(Math.abs(layout.add.width - layout.add.height) < 1 && layout.add.width >= 44, 'Circular mobile action');
    await expect(page.locator('.shipment-toolbar button')).toHaveCount(1);
    await expect(page.locator('.shipment-toolbar a')).toHaveCount(0);
    const add = page.getByRole('button', { name:'Добавить отгрузку', exact:true });
    await expect(add).toHaveClass(/primary/);
    await add.click();
    await expect(page.getByRole('dialog')).toBeVisible();
    const form = await page.getByRole('dialog').evaluate(e => ({ left:e.getBoundingClientRect().left, right:e.getBoundingClientRect().right, client:e.clientWidth, scroll:e.scrollWidth }));
    assert.ok(form.left >= 0 && form.right <= width + 1 && form.scroll <= form.client + 1);
    await page.getByRole('button', { name:'Отмена', exact:true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    // WebKit pointer clicks do not focus buttons; enter by keyboard to verify return focus.
    await page.getByRole('button', { name:'Открыть меню', exact:true }).focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#app-navigation')).toBeVisible();
    await expect(page.locator('#app-navigation').getByRole('button', { name:'Справочники', exact:true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name:'Открыть меню', exact:true })).toBeFocused();
    const search = page.getByRole('textbox', { name:'Поиск отгрузок', exact:true });
    await search.fill('QA-no-matches');
    await expect(page.getByTestId('shipment-row')).toHaveCount(0);
    await page.getByRole('button', { name:'Очистить поиск', exact:true }).click();
    await expect(search).toHaveValue('');
    await expect(page.getByTestId('shipment-row')).toHaveCount(1);
    const strip = page.locator('.shipment-template-row');
    await strip.evaluate(e => { e.scrollLeft = e.scrollWidth; });
    const scroll = await strip.evaluate(e => ({ left:e.scrollLeft, width:e.clientWidth, full:e.scrollWidth }));
    if (scroll.full > scroll.width + 1) assert.ok(scroll.left > 0, 'Filter strip scrolls');
    await page.getByLabel('Вид таблицы', { exact:true }).selectOption('reduced');
    await expect(page.getByLabel('Вид таблицы', { exact:true })).toHaveValue('reduced');
    await page.getByLabel('Вид таблицы', { exact:true }).selectOption('expanded');
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name:'CSV', exact:true }).click()]);
    assert.ok(download.suggestedFilename().endsWith('.csv'));
    await strip.evaluate(e => { e.scrollLeft = 0; });
    await page.getByRole('tab', { name:'АЗС', exact:true }).click();
    await expect(page.getByLabel('Формат таблицы АЗС', { exact:true })).toBeVisible();
    await add.click(); await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name:'Отмена', exact:true }).click();
    await page.getByRole('tab', { name:'Бензовозы', exact:true }).click();
    await expect(page.getByTestId('shipment-row')).toHaveCount(1);
    await strip.evaluate(e => { e.scrollLeft = 0; });
    const path = resolve(output, `shipments-${width}.png`); await page.screenshot({ path, fullPage:true });
    report.screenshots.push(path); report.layouts.push(layout);
    report.checks.push(`${width}px: four blocks, 768px boundary, protected ${current.length} ledger elements, search/clear, menu, cancel tanker/AZS forms, filters/view/CSV/scroll`);
    console.log('PASS', report.checks.at(-1));
  }
  assert.equal(report.providerCalls, 0); assert.deepEqual(report.unexpectedRequests, []); assert.deepEqual(report.mutationRequests, []); assert.deepEqual(report.errors, []); assert.deepEqual(report.consoleErrors, []);
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.failure = String(error.stack || error); console.error(report.failure); process.exitCode = 1;
} finally {
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
  await browser?.close(); await runtime?.server.close(); await rm(temporary, { recursive:true, force:true });
}
