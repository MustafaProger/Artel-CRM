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
const output = resolve(root, `qa/screenshot-polish-20261005${useWebKit ? '-webkit' : ''}`);
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
  const assertSearchPills = async name => {
    const searches = await page.locator('input[aria-label*="Поиск"], input[aria-label*="поиск"], input[placeholder*="Найти"], input[placeholder="Контрагент или назначение…"]').evaluateAll(inputs => inputs.filter(input => input.getBoundingClientRect().height > 0).map(input => {
      const surface = input.closest('.shipment-search, .overview-search, .bank-search, .team-search, .table-search, .company-combobox, .filter-search, .driver-search') || input;
      const rect = surface.getBoundingClientRect(), style = getComputedStyle(surface);
      const radius = value => value.split(' ').map(part => part.endsWith('%') ? parseFloat(part) * rect.height / 100 : parseFloat(part));
      return { label: input.getAttribute('aria-label') || input.getAttribute('placeholder'), height: rect.height, radius: [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomLeftRadius, style.borderBottomRightRadius].flatMap(radius) };
    }));
    assert.ok(searches.every(search => search.radius.every(radius => radius >= search.height / 2 - 1)), `${name}: all search surfaces are pill shaped: ${JSON.stringify(searches)}`);
  };
  const assertEqualActions = async (selector, name) => {
    const actions = page.locator(`${selector} > .button`);
    await expect(actions).toHaveCount(2);
    const boxes = await actions.evaluateAll(elements => elements.map(element => {
      const r = element.getBoundingClientRect(); return { width: r.width, height: r.height, scroll: element.scrollWidth, client: element.clientWidth };
    }));
    assert.ok(Math.abs(boxes[0].width - boxes[1].width) <= 1 && Math.abs(boxes[0].height - boxes[1].height) <= 1, `${name}: paired actions have equal width and height: ${JSON.stringify(boxes)}`);
    assert.ok(boxes.every(box => box.height >= 44 && box.scroll <= box.client + 1), `${name}: action text fits its touch target`);
  };
  const capture = async name => {
    await assertSearchPills(name);
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
    await expect(page.locator('h1')).toHaveCount(1);
    await expect(page.locator('.shipment-header-actions > *')).toHaveCount(3);
    const add = page.getByRole('button', { name: 'Добавить отгрузку', exact: true });
    await expect(add).toHaveText('');
    await expect(add).toHaveClass(/primary/);
    await expect(page.getByRole('link', { name: 'Справочники', exact: true })).toHaveAttribute('href', '#directories');
    await expect(page.getByRole('button', { name: 'Открыть меню', exact: true })).toHaveCount(1);
    const headingRow = await page.locator('.shipment-header').evaluate(header => {
      const title = header.querySelector('h1').getBoundingClientRect();
      return [...header.querySelectorAll('.shipment-header-actions > *')].map(element => {
        const r = element.getBoundingClientRect();
        return { width: r.width, height: r.height, afterTitle: r.left >= title.right, sameRow: r.top < title.bottom && r.bottom > title.top };
      });
    });
    assert.ok(headingRow.every(action => action.afterTitle && action.sameRow && action.width >= 44 && action.height >= 44 && Math.abs(action.width - action.height) <= 1), `Shipment title and three square actions share a row at ${width}px: ${JSON.stringify(headingRow)}`);
    assert.ok(headingRow.every(action => Math.abs(action.height - headingRow[0].height) <= 1), 'Shipment action sizes match');
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
    const selects = await strip.locator('select').evaluateAll(elements => elements.map(element => ({ label: element.getAttribute('aria-label'), height: element.getBoundingClientRect().height, appearance: getComputedStyle(element).appearance })));
    assert.ok(selects.every(select => select.height >= 44 && select.appearance === 'none'), `Shipment selects keep styled 44px controls in both engines at ${width}px: ${JSON.stringify(selects)}`);
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
  for (const width of [1440, 760, 390, 320]) {
    await page.setViewportSize({ width, height: width === 1440 ? 1050 : 844 });
    for (const route of Object.keys(routes)) {
      await visit(route);
      if (route === 'payments') await assertEqualActions('.bank-heading-actions', `Bank actions at ${width}px`);
      if (route === 'work') await assertEqualActions('.work-toolbar-actions', `Work actions at ${width}px`);
      if (route === 'trips') {
        const trip = await page.locator('.trip-card-heading').evaluate(header => {
          const title = header.querySelector('h2').getBoundingClientRect(), button = header.querySelector('button').getBoundingClientRect();
          return { titleRight: title.right, buttonLeft: button.left, titleTop: title.top, titleBottom: title.bottom, buttonTop: button.top, buttonBottom: button.bottom, headerHeight: header.getBoundingClientRect().height };
        });
        assert.ok(trip.buttonLeft >= trip.titleRight && trip.buttonTop < trip.titleBottom && trip.buttonBottom > trip.titleTop && trip.headerHeight < 120, `Trip date and edit action share a compact row at ${width}px: ${JSON.stringify(trip)}`);
      }
      if (route === 'china') {
        const date = await page.locator('.china-date').first().evaluate(element => {
          const range = document.createRange(); range.selectNodeContents(element);
          const lines = [...range.getClientRects()].map(rect => ({ top: rect.top, bottom: rect.bottom }));
          return { text: element.textContent, lines: [...new Set(lines.map(line => Math.round(line.top)))] };
        });
        assert.match(date.text, /^\d{2}\.\d{2}\.\d{4}$/);
        assert.equal(date.lines.length, 1, `China date remains on one line at ${width}px: ${JSON.stringify(date)}`);
      }
      if (route === 'accounts') {
        const gap = await page.locator('.account-panel').evaluate(panel => panel.querySelector('.account-list-heading').getBoundingClientRect().top - panel.getBoundingClientRect().top);
        assert.ok(gap <= 30, `Accounts first heading has compact top inset at ${width}px: ${gap}`);
      }
      await capture(`${route}-${width}`);
    }
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
  // Screenshot regressions: verify active states too, with motion enabled.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 1440, height: 1000 });
  for (const [route, label] of [['shipments', 'Поиск отгрузок'], ['directories', 'Поиск в справочнике']]) {
    await visit(route);
    const input = page.getByLabel(label, { exact: true });
    await input.focus();
    assert.equal(await input.evaluate(el => getComputedStyle(el).outlineStyle), 'none', `${route}: no inner ring`);
    assert.equal(await input.evaluate(el => getComputedStyle(el.parentElement).outlineStyle), 'solid', `${route}: wrapper focus ring`);
    await capture(`search-focused-${route}`);
  }
  const row = page.locator('.directory-record').first();
  await page.mouse.move(0, 0);
  await page.getByLabel('Поиск в справочнике').focus();
  await row.hover();
  await expect(row).toHaveCSS('background-color', 'rgb(245, 245, 247)');
  await expect(row.locator('.directory-record-open')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await row.locator('.directory-delete').hover();
  await expect(row).toHaveCSS('background-color', 'rgb(245, 245, 247)');
  const hoverFrames = await row.evaluate(async el => {
    const frames = [];
    for (let i = 0; i < 12; i++) { await new Promise(requestAnimationFrame); frames.push(getComputedStyle(el).backgroundColor); }
    return frames;
  });
  assert.ok(hoverFrames.every(color => color === 'rgb(245, 245, 247)'), 'Hover stays one colour across nested controls');
  await capture('directory-hover');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(row).toHaveCSS('transition-duration', '0s');
  await visit('overview'); await expect(page.getByRole('heading', { name: 'Наши организации', exact: true })).toHaveCount(0);
  await visit('accounts'); await expect(page.getByRole('heading', { name: 'Учётные записи', exact: true })).toHaveCount(0);
  assert.equal(await page.getByRole('button', { name: 'Добавить пользователя', exact: true }).evaluate(el => !!el.closest('.account-panel')), false);
  report.checks.push('Single search focus ring; stable neutral directory hover across nested controls; reduced motion; headings removed; account action outside panel');

  for (const company of ['НК АРТЕЛЬ', 'АРТЕЛЬ']) {
    await visit('overview'); await visit('payments');
    await page.getByRole('button', { name: `Открыть СберБизнес — ${company}`, exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Выписки по дням', exact: true })).toBeVisible();
    const from = page.getByLabel('Начало периода выписки Сбера'), to = page.getByLabel('Конец периода выписки Сбера');
    await expect(from).toHaveValue(`${day.slice(0, 7)}-01`); await expect(to).toHaveValue(day);
    await expect(page.getByText('Не удалось загрузить сохранённые данные', { exact: true })).toHaveCount(0);
    await from.fill('2026-01-01');
    await expect(page.getByRole('button', { name: 'Показать период', exact: true })).toBeDisabled();
    await expect(page.getByRole('alert')).toContainText('31 дня');
    await expect(page.getByRole('heading', { name: 'Выписки по дням', exact: true })).toBeVisible();
    await from.fill(`${day.slice(0, 7)}-01`);
    await expect(page.getByRole('button', { name: 'Показать период', exact: true })).toBeEnabled();
    await capture(`bank-default-${company === 'АРТЕЛЬ' ? 'artel' : 'nk'}`);
  }
  report.checks.push('Both Sber connections open with a valid current-month period; invalid drafts cannot replace the saved statement');

  let fillState = 'saved';
  const workflowRoute = '**/api/shipment-trips/*/saby-workflow';
  await page.route(workflowRoute, async route => {
    assert.equal(route.request().method(), 'GET');
    const response = await route.fetch(); const result = await response.json();
    Object.assign(result, { locked: true, status: 'sent', phase: 'awaiting_carrier', carrierConfirmed: false,
      carrierFill: { state: fillState, driverSaved: true, vehicleSaved: fillState === 'saved', responsibleSaved: fillState === 'saved', blockers: fillState === 'saved' ? [] : ['Проверьте данные автомобиля.'], checkedAt: '2026-10-05T09:16:00Z' } });
    await route.fulfill({ response, json: result });
  });
  for (const state of ['saved', 'partial']) {
    fillState = state;
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      await visit('overview'); await visit('trips'); await page.getByRole('button', { name: 'Saby', exact: true }).click();
      const panel = page.getByRole('region', { name: 'Заполнение ответа НК' });
      await expect(panel).toBeVisible();
      await expect(panel.locator('.workflow-fill-statuses li')).toHaveCount(3);
      await expect(panel.locator('.is-saved')).toHaveCount(state === 'saved' ? 3 : 1);
      await expect(panel.locator('.workflow-fill-next')).toHaveCount(state === 'saved' ? 1 : 0);
      await capture(`saby-carrier-${state}-${width}`);
    }
  }
  await page.unroute(workflowRoute);
  report.checks.push('Saby carrier status: saved and partial data remain distinct at desktop, 390px and 320px; no document writes');

  // All filter interaction stays client-side; facets are synthetic read responses.
  // The real isolated API still evaluates the applied blank, number and date filters.
  const facetRoute = url => url.origin === runtime.base && url.pathname === '/api/shipments' && url.searchParams.get('facet') === 'document_number';
  const manyValues = ['', ...Array.from({ length: 80 }, (_, index) => `QA-${String(index + 1).padStart(4, '0')}`)];
  const openFilter = async title => {
    const opener = page.getByRole('button', { name: `Фильтр: ${title}`, exact: true });
    await opener.focus(); await opener.press('Enter');
    const dialog = page.getByRole('dialog', { name: `Фильтр: ${title}`, exact: true });
    await expect(dialog).toBeVisible(); await expect(dialog.getByRole('button', { name: 'Применить', exact: true })).toBeEnabled();
    return { dialog, opener };
  };
  const filterResponse = (key, condition) => page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.pathname === '/api/shipments' && !url.searchParams.has('facet') && condition(JSON.parse(url.searchParams.get('filters') || '{}')[key]);
  });
  for (const width of [1440, 760, 390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await visit('overview'); await visit('shipments');
    await page.getByLabel('Вид таблицы').selectOption('expanded');
    let { dialog, opener } = await openFilter('УПД');
    await expect(dialog.getByRole('checkbox')).toHaveCount(1);
    const compact = await dialog.locator('.filter-values').evaluate(element => element.getBoundingClientRect().height);
    assert.ok(compact <= 120, `One filter value does not leave a tall empty panel at ${width}px: ${compact}`);
    await capture(`filter-one-value-${width}`);
    await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(opener).toBeFocused();

    await page.route(facetRoute, async route => {
      assert.equal(route.request().method(), 'GET');
      const response = await route.fetch(), result = await response.json();
      await route.fulfill({ response, json: { ...result, facetValues: manyValues } });
    });
    ({ dialog, opener } = await openFilter('УПД'));
    await expect(dialog.getByRole('checkbox')).toHaveCount(manyValues.length);
    const longList = await dialog.locator('.filter-values').evaluate(element => ({ height: element.clientHeight, content: element.scrollHeight, overflow: getComputedStyle(element).overflowY }));
    assert.ok(longList.content > longList.height && ['auto', 'scroll'].includes(longList.overflow), `Many values scroll inside the filter at ${width}px: ${JSON.stringify(longList)}`);
    const dialogBox = await dialog.boundingBox();
    assert.ok(dialogBox.x >= 0 && dialogBox.x + dialogBox.width <= width + 1 && dialogBox.y >= 0 && dialogBox.y + dialogBox.height <= 845, `Filter fits the ${width}px viewport`);
    await dialog.getByRole('button', { name: 'Снять найденные', exact: true }).click();
    await expect(dialog.locator('input[type="checkbox"]:checked')).toHaveCount(0);
    const search = dialog.getByLabel('Поиск значений колонки', { exact: true });
    await search.fill('QA-0042');
    await expect(dialog.getByRole('checkbox')).toHaveCount(1);
    await dialog.getByRole('button', { name: 'Выбрать найденные', exact: true }).click();
    await expect(dialog.getByRole('checkbox', { name: 'QA-0042', exact: true })).toBeChecked();
    await search.fill(''); await expect(dialog.getByRole('checkbox')).toHaveCount(manyValues.length);
    await expect(dialog.locator('input[type="checkbox"]:checked')).toHaveCount(1);
    await dialog.getByRole('button', { name: 'Снять найденные', exact: true }).click();
    await dialog.getByRole('checkbox', { name: '(Пустые)', exact: true }).check();
    await capture(`filter-many-values-${width}`);
    const appliedValues = filterResponse('document_number', filter => filter?.op === 'values' && filter.values.length === 1 && filter.values[0] === '');
    await dialog.getByRole('button', { name: 'Применить', exact: true }).click(); await appliedValues;
    await expect(dialog).toHaveCount(0); await expect(page.getByTestId('shipment-row')).toHaveCount(1);
    ({ dialog } = await openFilter('УПД'));
    await expect(dialog.locator('input[type="checkbox"]:checked')).toHaveCount(1);
    const resetValues = filterResponse('document_number', filter => !filter);
    await dialog.getByRole('button', { name: 'Сбросить', exact: true }).click(); await resetValues;
    await expect(dialog).toHaveCount(0); await expect(page.getByTestId('shipment-row')).toHaveCount(1);
    await page.unroute(facetRoute);

    for (const [title, key, from, to] of [['Кол-во, л', 'quantity_litres', '9000', '11000'], ['Дата', 'date', day, day]]) {
      ({ dialog, opener } = await openFilter(title));
      await dialog.getByLabel('Условие фильтра', { exact: true }).selectOption('range');
      await dialog.getByRole('button', { name: 'Применить', exact: true }).click();
      await expect(dialog.getByRole('alert')).toContainText('Укажите хотя бы одну границу');
      await dialog.getByLabel('От', { exact: true }).fill(from); await dialog.getByLabel('До', { exact: true }).fill(to);
      await capture(`filter-${key}-range-${width}`);
      const appliedRange = filterResponse(key, filter => filter?.op === 'range' && filter.value === from && filter.to === to);
      await dialog.getByRole('button', { name: 'Применить', exact: true }).click(); await appliedRange;
      await expect(dialog).toHaveCount(0); await expect(page.getByTestId('shipment-row')).toHaveCount(1);
      ({ dialog } = await openFilter(title));
      await expect(dialog.getByLabel('От', { exact: true })).toHaveValue(from); await expect(dialog.getByLabel('До', { exact: true })).toHaveValue(to);
      const resetRange = filterResponse(key, filter => !filter);
      await dialog.getByRole('button', { name: 'Сбросить', exact: true }).click(); await resetRange;
      await expect(dialog).toHaveCount(0); await expect(page.getByTestId('shipment-row')).toHaveCount(1);
    }
    report.checks.push(`Filter dialog at ${width}px: compact single value, scrollable many values, search, selection, apply/reset, Escape/focus, numeric/date ranges`);
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
