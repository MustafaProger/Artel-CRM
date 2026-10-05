// Read-only browser acceptance against an isolated, synthetic CRM. No working snapshot/store.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium, webkit, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { OperationsStore } from '../server/operations-store.ts';
import { SabyClient, sabyConfigFromEnv } from '../server/saby-client.ts';
import { sberConnections } from '../server/banking/sber-connections.ts';
import { loadSnapshot } from '../server/local-api.ts';
import { startTripsQaServer, writeTripsQaSnapshot } from './qa-trips-runtime.mjs';
import { authenticateContext, bootstrapQaAuth } from './qa-auth.mjs';

const root = resolve(import.meta.dirname, '..');
const useWebKit = process.env.QA_WEBKIT === '1';
const output = resolve(root, `qa/shipment-filter-strip-20261005${useWebKit ? '-webkit' : ''}`);
const temporary = await mkdtemp(resolve(tmpdir(), 'artel-interface-refresh-'));
const snapshotDirectory = resolve(temporary, 'snapshot'), operationsDirectory = resolve(temporary, 'operations');
const report = { fixtureOnly: true, workingStoreAccessed: false, providerCalls: 0, status: 'running', checks: [], layouts: [], violations: [], errors: [], consoleErrors: [], unexpectedRequests: [], mutationRequests: [], screenshots: [] };
await mkdir(output, { recursive: true });
await writeTripsQaSnapshot(snapshotDirectory);
const snapshot = await loadSnapshot(snapshotDirectory), store = new OperationsStore(operationsDirectory);
const company = (id, name, roles) => ({ id, name, roles, managerLabels: [], shipmentIds: [], paymentIds: [], flags: [] });
await store.mutate(snapshot.provenance.sourceSha256, data => {
  data.sourceOperationsCleared = true;
  data.shipments = {};
  data.paymentAllocations = [];
  data.companies = [
    { ...company('qa-supplier', 'QA Поставщик — синтетические данные', ['supplier']), address: 'Синтетический город, Промышленная улица, дом 105' },
    company('qa-customer', 'QA Клиент с длинным названием для проверки адаптивного интерфейса', ['customer']),
  ];
  data.directories = {
    fleetSeedApplied: true,
    managers: [{ id: 'qa-manager', name: 'QA Менеджер' }],
    products: [{ id: 'qa-product', name: 'QA Дизельное топливо', transportProductKind: 'diesel', cargoPackaging: 'bulk' }],
    paymentForms: [{ id: 'qa-payment', name: 'б/нал' }],
    vehicles: [{ id: 'qa-vehicle', plate: 'Т000ЕЕ00', capacityLitres: '16000' }],
    drivers: [{ id: 'qa-driver', name: 'QA Водитель', vehicleId: 'qa-vehicle' }],
    oilDepots: [{ id: 'qa-depot', name: 'QA Нефтебаза', address: 'Синтетическая область, посёлок Проверки, промышленная площадка, 105', ownerCompanyId: 'qa-supplier', loadingActorCompanyId: 'qa-supplier', infrastructureOwnerCompanyId: 'qa-supplier' }],
    addresses: [{ id: 'qa-address', companyId: 'qa-customer', kind: 'delivery', name: 'QA Площадка клиента', address: 'Синтетический город, улица Проверки Длинных Адресов, дом 120, корпус 2' }],
    customerManagers: [{ companyId: 'qa-customer', managerId: 'qa-manager' }],
    defaults: { profit: 'template-payment-form' }, duplicates: [],
  };
  return { changed: true, result: null };
});
// The connection registry includes live account identifiers in source; replace them only in this isolated test process.
for (const [index, connection] of Object.values(sberConnections).entries()) {
  connection.account = `${'0'.repeat(19)}${index + 1}`;
  connection.inn = `${'0'.repeat(9)}${index + 1}`;
}
let runtime, browser, page;
try {
  const sabyClient = new SabyClient(sabyConfigFromEnv({}), async () => { report.providerCalls++; throw new Error('External Saby requests are forbidden in interface QA'); });
  runtime = await startTripsQaServer({ root, snapshotDirectory, operationsDirectory, sabyClient });
  const { cookie } = await bootstrapQaAuth(runtime.base);
  const fixture = async (path, body) => {
    const response = await fetch(runtime.base + path, { method: 'POST', headers: { Cookie: cookie, Origin: runtime.base, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.ok(response.ok, `Synthetic fixture ${path}: ${response.status} ${await response.clone().text()}`);
    return response.json();
  };
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  await fixture('/api/shipment-trips', {
    idempotencyKey: randomUUID(),
    fields: { organization_id: 'artel', date: day, loading_at: day, supplier_id: 'qa-supplier', oil_depot_id: 'qa-depot', product_id: 'qa-product', purchase_price_unspecified_unit: '60000', quantity_tonnes: '8', driver_id: 'qa-driver', vehicle_id: 'qa-vehicle', trip_notes: 'Синтетический рейс для проверки отображения. Внешняя отправка не выполняется.' },
    customers: [{ fields: { customer_id: 'qa-customer', manager_id: 'qa-manager', payment_form_id: 'qa-payment', quantity_litres: '10000', sale_price_per_litre: '75', transport_amount: '1000', invoice_not_required: 'true', unloading_address_id: 'qa-address', unloading_planned_at: day, unloading_actual_at: day } }],
  });
  await fixture('/api/work/tasks', { title: 'QA Проверить документы по синтетическому рейсу', description: 'Длинное описание для проверки переноса текста и доступности на узком экране.', companyId: 'qa-customer', dueDate: day, reminderAt: null });
  await fixture('/api/china/days', { date: day, fuels: [{ supplierId: 'qa-supplier', litres: '1200.25', amount: '85400.75' }] });
  await fixture('/api/china/payments', { date: day, amount: '90000' });

  browser = useWebKit ? await webkit.launch({ headless: true }) : await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce', timezoneId: 'Europe/Moscow', serviceWorkers: 'block' });
  await authenticateContext(context, runtime.base, cookie);
  await context.route('**/*', route => {
    const request = route.request();
    if (new URL(request.url()).origin !== runtime.base) { report.unexpectedRequests.push(request.url()); return route.abort(); }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) { report.mutationRequests.push({ method: request.method(), url: request.url() }); return route.abort(); }
    return route.continue();
  });
  page = await context.newPage();
  page.on('pageerror', error => report.errors.push({ page: page.url(), message: error.message }));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push({ page: page.url(), message: message.text() }); });
  const routes = {
    overview: ['Обзор', '.overview-page'], work: ['Работа', '.work-layout'], shipments: ['Отгрузки', '.shipment-grid'],
    payments: ['Платежи', '.banking-page'], stock: ['Склад', '.blank-workspace'], china: ['Китай', '.china-table'],
    operator: ['Операторская', '.soft-notice'], payroll: ['ЗП', '.payroll-tabs'], directories: ['Справочники', '.directory-list'], trips: ['Рейсы', '.trips-list'], accounts: ['Сотрудники и доступ', '.account-panel'],
  };
  const visit = async route => {
    await page.goto(`${runtime.base}/#${route}`);
    await expect(page.locator('h1').first()).toContainText(routes[route][0]);
    await page.locator(routes[route][1]).waitFor();
    await expect(page.locator('.loading-state')).toHaveCount(0);
    await expect(page.locator('.loading-state')).toHaveCount(0);
    if (route === 'shipments') await expect(page.getByTestId('shipment-row')).toHaveCount(1);
    if (route === 'trips') await expect(page.getByTestId('trip-card')).toHaveCount(1);
  };
  const capture = async name => {
    const path = resolve(output, name + '.png');
    await page.screenshot({ path, fullPage: true }); report.screenshots.push(path);
    const layout = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
    report.layouts.push({ page: name, ...layout, passed: Math.max(layout.document, layout.body) <= layout.viewport + 1 });
    const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
    report.violations.push(...result.violations.map(violation => ({ page: name, id: violation.id, impact: violation.impact, help: violation.help, nodes: violation.nodes.map(node => ({ target: node.target, failureSummary: node.failureSummary })) })));
    console.log('AUDIT', name, layout.document <= layout.viewport + 1 ? 'layout PASS' : 'OVERFLOW', `${result.violations.length} accessibility findings`);
  };
  // Header styling is now authorized. Compare table descendants in table-relative
  // coordinates: the taller header may move the table but must not restyle it.
  for (const width of [1440, 760, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await visit('shipments');
    await expect(page.locator('.shipment-grid-resizable')).toHaveCount(width >= 1100 ? 1 : 0);
    const readLedger = () => page.locator('.shipment-grid, .shipment-grid *').evaluateAll(elements => elements.map(element => {
      const s = getComputedStyle(element), r = element.getBoundingClientRect();
      const table = element.closest('.shipment-grid').getBoundingClientRect();
      return { tag: element.tagName, rect: [r.x - table.x, r.y - table.y, r.width, r.height].map(value => Math.round(value * 100) / 100), css: Object.fromEntries(['font', 'color', 'backgroundColor', 'border', 'borderRadius', 'padding', 'margin', 'boxShadow', 'display', 'gap'].map(key => [key, s[key]])) };
    }));
    const current = await readLedger();
    const styles = page.locator('style[data-vite-dev-id$="/design-system.css"], style[data-vite-dev-id$="/shipments-toolbar.css"]');
    await styles.evaluateAll(elements => elements.forEach(element => { element.sheet.disabled = true; }));
    const previous = await readLedger();
    await styles.evaluateAll(elements => elements.forEach(element => { element.sheet.disabled = false; }));
    assert.deepEqual(current, previous, `Protected ledger CSS/geometry at ${width}px`);
    report.checks.push(`Protected ledger: ${current.length} elements identical at ${width}px`);
    const controls = await page.locator('.shipment-toolbar, .shipment-template-row').evaluateAll(elements => elements.map(element => {
      const r = element.getBoundingClientRect();
      return { left: r.left, right: r.right, viewport: innerWidth };
    }));
    assert.ok(controls.every(r => r.left >= 0 && r.right <= r.viewport + 1), `Shipment controls fit at ${width}px`);
    await expect(page.locator('.shipment-width-toolbar')).toHaveCount(0);
    const strip = page.getByRole('group', { name: 'Тип и фильтры отгрузок', exact: true });
    const row = await strip.evaluate(element => {
      const r = element.getBoundingClientRect();
      const controls = [...element.querySelectorAll('select, button')].map(control => {
        const box = control.getBoundingClientRect();
        return { top: box.top, bottom: box.bottom, middle: box.top + box.height / 2 };
      });
      return { height: r.height, overflow: element.scrollWidth > element.clientWidth, controls };
    });
    assert.ok(row.height <= 66, `Filter strip stays compact at ${width}px`);
    assert.ok(row.controls.every(control => Math.abs(control.middle - row.controls[0].middle) <= 1), 'All filters, types and actions share one row');
    if (width <= 760) assert.ok(row.overflow, 'Narrow strip scrolls instead of wrapping');
    // Native focus must reveal controls without shifting the page/table.
    const csv = page.getByRole('button', { name: 'CSV', exact: true });
    await csv.focus();
    assert.ok(await csv.evaluate(element => {
      const r = element.getBoundingClientRect(), strip = element.closest('.shipment-template-row').getBoundingClientRect();
      return r.left >= strip.left && r.right <= strip.right + 1;
    }), 'Keyboard focus reveals CSV at the end of the strip');
    await expect(page.getByLabel('Вид таблицы')).toBeEnabled();
    await page.getByLabel('Вид таблицы').selectOption('expanded');
    await strip.evaluate(element => { element.scrollLeft = 0; });
    if (width <= 760) {
      await strip.hover(); await page.mouse.wheel(450, 0);
      await expect.poll(() => strip.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
      await strip.evaluate(element => { element.scrollLeft = 0; });
    }
    await capture(`shipment-toolbar-${width}`);
    const tanker = page.getByRole('tab', { name: 'Бензовозы', exact: true });
    const azs = page.getByRole('tab', { name: 'АЗС', exact: true });
    await tanker.focus(); await tanker.press('ArrowRight');
    await expect(azs).toHaveAttribute('aria-selected', 'true');
    await expect(azs).toBeFocused();
    await expect(page.getByLabel('Формат таблицы АЗС')).toBeVisible();
    await capture(`shipment-toolbar-azs-${width}`);
    await azs.press('Home'); await expect(tanker).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('shipment-row')).toHaveCount(1);
    if (width === 320 && !useWebKit) {
      const cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
      await strip.evaluate(element => { element.scrollLeft = 0; });
      const box = await strip.boundingBox(), y = box.y + box.height / 2;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 180, y }] });
      for (let x = 160; x >= 20; x -= 20) {
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
        await page.waitForTimeout(16);
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await expect.poll(() => strip.evaluate(element => element.scrollLeft)).toBeGreaterThan(50);
      await expect(tanker).toHaveAttribute('aria-selected', 'true');
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: false });
      await cdp.detach();
      report.checks.push('Native swipe over type tabs scrolls the filter strip without changing the selection');
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 }); await visit('shipments');
  await page.getByLabel('Поиск отгрузок').fill('no-matching-qa-shipment');
  await expect(page.getByTestId('shipment-row')).toHaveCount(0);
  await page.getByRole('button', { name: 'Очистить поиск', exact: true }).click();
  await expect(page.getByTestId('shipment-row')).toHaveCount(1);
  await page.getByLabel('Наша организация в отгрузках').selectOption('nk-artel');
  await expect(page.getByTestId('shipment-row')).toHaveCount(0);
  await page.getByRole('button', { name: 'Сбросить фильтры', exact: true }).click();
  await expect(page.getByTestId('shipment-row')).toHaveCount(1);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'CSV', exact: true }).click();
  assert.match((await download).suggestedFilename(), /\.csv$/);
  report.checks.push('Shipment header: keyboard tabs, search/clear, organization/reset and CSV download');
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1050 : 844 });
    for (const route of Object.keys(routes)) { await visit(route); await capture(`${route}-${width}`); }
    report.checks.push(`All 11 sections rendered with synthetic data at ${width}px`);
  }
  for (const width of [1440, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await visit('accounts');
    await page.getByRole('button', { name: 'Изменить', exact: true }).click();
    await capture(`account-form-${width}`);
    await page.getByRole('button', { name: 'Отмена', exact: true }).click();
    await visit('directories');
    await page.getByRole('button', { name: 'Товары', exact: true }).click();
    await page.getByRole('button', { name: 'Редактировать: QA Дизельное топливо', exact: true }).click();
    await capture(`product-form-${width}`);
    await page.keyboard.press('Escape');
  }
  await page.setViewportSize({ width: 320, height: 844 });
  await visit('work'); await page.getByRole('button', { name: 'Календарь', exact: true }).click(); await capture('work-calendar-320');
  await visit('payments'); await page.getByRole('tab', { name: 'Архив из файла', exact: true }).click(); await capture('payments-archive-320');
  await visit('trips'); await page.getByRole('button', { name: 'Saby', exact: true }).click(); await capture('trip-workflow-320');
  // WebKit intentionally does not focus buttons on pointer click. Exercise the
  // keyboard path explicitly when asserting restoration of keyboard focus.
  await page.getByRole('button', { name: 'Открыть меню', exact: true }).focus();
  await page.getByRole('button', { name: 'Открыть меню', exact: true }).press('Enter');
  const menu = page.getByRole('dialog', { name: 'Меню разделов', exact: true }); await expect(menu).toBeVisible(); await capture('navigation-320');
  await menu.getByRole('button', { name: 'Закрыть меню', exact: true }).focus(); await page.keyboard.press('Shift+Tab');
  assert.ok(await menu.evaluate(element => element.contains(document.activeElement)), 'Mobile menu must contain keyboard focus');
  await page.keyboard.press('Escape'); await expect(menu).toHaveCount(0); await expect(page.getByRole('button', { name: 'Открыть меню', exact: true })).toBeFocused();
  report.checks.push('Mobile navigation traps keyboard focus and restores its opener on Escape');
  for (const [route, button, name] of [['shipments', 'Добавить отгрузку', 'shipment-editor-320'], ['directories', 'Добавить', 'directory-editor-320'], ['work', 'Новая задача', 'work-editor-320']]) {
    await visit(route); await page.getByRole('button', { name: button, exact: true }).click(); await expect(page.getByRole('dialog')).toBeVisible(); await capture(name); await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toHaveCount(0);
  }
  assert.equal(report.providerCalls, 0, 'Read-only interface audit must not call Saby');
  assert.deepEqual(report.unexpectedRequests, [], 'Browser must not reach external services');
  assert.deepEqual(report.mutationRequests, [], 'Browser audit must not change CRM records');
  assert.deepEqual(report.errors, [], 'Browser runtime errors');
  assert.deepEqual(report.consoleErrors, [], 'Browser console errors');
  assert.ok(report.layouts.every(layout => layout.passed), 'Horizontal overflow: see interface-verification.json');
  assert.equal(report.violations.length, 0, 'Accessibility findings: see interface-verification.json');
  report.status = 'passed';
  report.checks.push('Zero external calls, writes, browser errors, horizontal page overflow and axe accessibility violations');
  console.log('PASS', report.checks.at(-1));
} catch (error) {
  report.status = 'failed'; report.failure = String(error.stack || error); console.error(report.failure); process.exitCode = 1;
} finally {
  await writeFile(resolve(output, 'interface-verification.json'), JSON.stringify(report, null, 2));
  await browser?.close(); await runtime?.server.close(); await rm(temporary, { recursive: true, force: true });
}
