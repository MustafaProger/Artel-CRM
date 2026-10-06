// Synthetic browser acceptance only: no working snapshot, credentials or providers.
import assert from 'node:assert/strict';
import { verifyFocusFeedback } from './qa-focus-feedback.mjs';
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
const output = resolve(root, `qa/rounded-controls-20261006${useWebKit ? '-webkit' : ''}${process.env.QA_OUTPUT_SUFFIX || ''}`);
const temporary = await mkdtemp(resolve(tmpdir(), 'artel-rounded-controls-'));
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
  const pills = async (locator, name) => {
    const values = await locator.evaluateAll(elements => elements.filter(element => element.getBoundingClientRect().height > 0).map(element => {
      const surface = element.matches('input') ? element.closest('.company-combobox, .shipment-search, .bank-search') || element : element;
      const rect = surface.getBoundingClientRect(), style = getComputedStyle(surface);
      return { label: element.getAttribute('aria-label') || element.getAttribute('placeholder') || element.textContent?.trim().slice(0, 60), tag: element.tagName, type: element.type, height: rect.height, width: rect.width, radius: [style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomLeftRadius, style.borderBottomRightRadius].map(value => parseFloat(value)), appearance: style.appearance };
    }));
    assert.ok(values.length, `${name}: controls present`);
    assert.ok(values.every(value => value.radius.every(radius => radius >= Math.min(value.height, value.width) / 2 - 1)), `${name}: pill corners ${JSON.stringify(values.filter(value => value.radius.some(radius => radius < Math.min(value.height, value.width) / 2 - 1)))}`);
    assert.ok(values.filter(value => value.tag === 'SELECT').every(value => value.appearance === 'none'), `${name}: native selects have the styled trigger`);
    report.controls.push({ name, values });
  };
  const focusRing = async (locator, name) => {
    // Enter via a real Tab from the preceding control. Native date fields can
    // consume Tab inside their segmented editor, so a Tab/Shift+Tab round trip
    // on the target itself does not establish the keyboard entry path.
    await locator.evaluate(element => {
      const scope = element.closest('dialog') || document;
      const controls = [...scope.querySelectorAll('button, input, select, textarea, a[href], [tabindex]')].filter(control => !control.disabled && control.tabIndex >= 0 && control.getBoundingClientRect().height > 0);
      const index = controls.indexOf(element); controls[(index - 1 + controls.length) % controls.length]?.focus();
    });
    for (let attempts = 0; attempts < 12; attempts++) {
      await page.keyboard.press('Tab');
      if (await locator.evaluate(element => document.activeElement === element)) break;
    }
    await expect(locator).toBeFocused();
    const ring = await locator.evaluate(element => {
      const surface = element.closest('.company-combobox, .shipment-search, .bank-search') || element, style = getComputedStyle(surface);
      return { focused: document.activeElement === element, focusVisible: element.matches(':focus-visible'), temporal: ['date', 'time', 'datetime-local', 'month'].includes(element.type), style: style.outlineStyle, width: parseFloat(style.outlineWidth), shadow: style.boxShadow, border: style.borderTopColor, accent: style.getPropertyValue('--accent').trim() };
    });
    assert.ok(ring.focused && (ring.temporal || ring.focusVisible) && ring.width === 0 && ring.shadow === 'none', `${name}: single keyboard focus border ${JSON.stringify(ring)}`);
    report.checks.push(`${name}: keyboard focus visible`);
    (report.focusFeedback ||= []).push(await verifyFocusFeedback(page, locator, name));
  };
  const capture = async name => {
    const layout = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth, dialogs: [...document.querySelectorAll('dialog[open]')].map(element => { const rect = element.getBoundingClientRect(); return { left: rect.left, right: rect.right, client: element.clientWidth, scroll: element.scrollWidth }; }) }));
    assert.ok(Math.max(layout.document, layout.body) <= layout.viewport + 1, `${name}: page horizontal overflow ${JSON.stringify(layout)}`);
    assert.ok(layout.dialogs.every(dialog => dialog.left >= -1 && dialog.right <= layout.viewport + 1 && dialog.scroll <= dialog.client + 1), `${name}: dialog fits horizontally ${JSON.stringify(layout)}`);
    report.layouts.push({ name, ...layout });
    const path = resolve(output, `${name}.png`); await page.screenshot({ path, fullPage: true }); report.screenshots.push(path);
  };
  const cancelDirty = async dialog => {
    await dialog.getByRole('button', { name: 'Отмена', exact: true }).click();
    await dialog.getByRole('button', { name: /^(Не сохранять|Закрыть без сохранения)$/ }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  };
  const widths = process.env.QA_WIDTHS ? process.env.QA_WIDTHS.split(',').map(Number) : [320, 361, 390, 701, 768, 1100, 1440];
  for (const width of widths) {
    await page.setViewportSize({ width, height: 1000 });
    await visit('shipments');
    const ledger = () => page.locator('.shipment-grid, .shipment-grid *').evaluateAll(elements => elements.map(element => {
      const style = getComputedStyle(element), rect = element.getBoundingClientRect(), table = element.closest('.shipment-grid').getBoundingClientRect();
      return { tag: element.tagName, rect: [rect.x - table.x, rect.y - table.y, rect.width, rect.height].map(value => Math.round(value * 100) / 100), css: Object.fromEntries(['font', 'color', 'backgroundColor', 'border', 'borderRadius', 'padding', 'margin', 'boxShadow', 'display', 'gap'].map(key => [key, style[key]])) };
    }));
    const current = await ledger();
    const sharedStyles = page.locator('style[data-vite-dev-id$="/design-system.css"], style[data-vite-dev-id$="/shipments-toolbar.css"]');
    await expect(sharedStyles).toHaveCount(2);
    await sharedStyles.evaluateAll(elements => elements.forEach(element => { element.sheet.disabled = true; }));
    const baseline = await ledger();
    await sharedStyles.evaluateAll(elements => elements.forEach(element => { element.sheet.disabled = false; }));
    assert.deepEqual(current, baseline, `Protected ledger CSS/relative geometry ${width}px`);
    report.checks.push(`Protected ledger: ${current.length} elements unchanged at ${width}px`);
    const filters = page.locator('.shipment-template-row select');
    await pills(filters, `shipment-filters-${width}`);
    await page.getByLabel('Наша организация в отгрузках').selectOption('nk-artel'); await expect(page.getByTestId('shipment-row')).toHaveCount(0);
    await page.getByLabel('Наша организация в отгрузках').selectOption('all'); await expect(page.getByTestId('shipment-row')).toHaveCount(1);
    await focusRing(page.getByLabel('Вид таблицы'), `shipment-select-${width}`);
    await capture(`shipment-filters-${width}`);
    await page.getByRole('button', { name: 'Добавить отгрузку', exact: true }).click();
    const shipment = page.getByRole('dialog', { name: 'Добавить отгрузку', exact: true }); await expect(shipment).toBeVisible();
    await pills(shipment.locator('input:not([type="checkbox"]), select, .shipment-editor-footer .button'), `shipment-form-${width}`);
    const textareas = await shipment.locator('textarea').evaluateAll(elements => elements.map(element => ({ radius: parseFloat(getComputedStyle(element).borderRadius), height: element.getBoundingClientRect().height })));
    assert.ok(textareas.length && textareas.every(value => value.radius === 16 && value.height >= 60), `Multiline fields retain usable rounded rectangles ${width}px: ${JSON.stringify(textareas)}`);
    const date = shipment.getByLabel('Дата отгрузки / погрузки', { exact: true }), time = shipment.getByLabel('Дата отгрузки / погрузки — время', { exact: true });
    const dateLayout = await shipment.locator('.trip-date-controls').first().evaluate(element => {
      const controls = [...element.querySelectorAll('input')].map(input => { const rect = input.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom, width: rect.width }; });
      return { width: element.getBoundingClientRect().width, controls };
    });
    assert.ok(dateLayout.width > 320 || dateLayout.controls[1].top >= dateLayout.controls[0].bottom, `Date/time stack when their container is narrow ${width}px: ${JSON.stringify(dateLayout)}`);
    report.layouts.push({ name: `date-time-${width}`, ...dateLayout });
    await date.fill('2026-10-05'); await time.fill('14:35');
    await expect(date).toHaveValue('2026-10-05'); await expect(time).toHaveValue('14:35');
    const price = shipment.getByLabel('Цена поставщика за тонну, ₽', { exact: false }); await price.fill('61234.50'); await expect(price).toHaveValue('61234.50');
    await focusRing(price, `shipment-price-${width}`);
    const organization = shipment.getByRole('combobox', { name: 'Наша организация', exact: false });
    await organization.fill('АРТЕЛЬ'); await organization.press('Enter'); await expect(organization).not.toHaveValue('');
    await capture(`shipment-form-${width}`); await cancelDirty(shipment);
    await page.getByRole('button', { name: 'Добавить отгрузку', exact: true }).click();
    await expect(page.getByRole('dialog').getByLabel('Цена поставщика за тонну, ₽', { exact: false })).toHaveValue('');
    await page.getByRole('dialog').getByRole('button', { name: 'Отмена', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('tab', { name: 'АЗС', exact: true }).click();
    await page.getByRole('button', { name: 'Добавить отгрузку', exact: true }).click();
    const azs = page.locator('.shipment-azs-editor'); await expect(azs).toBeVisible();
    await pills(azs.locator('input:not([type="checkbox"]), select, .shipment-editor-footer .button'), `azs-form-${width}`);
    await capture(`azs-form-${width}`); await azs.getByRole('button', { name: 'Отмена', exact: true }).click();
    await expect(azs).toHaveCount(0);

    await visit('payments');
    await expect(page.getByLabel('Период с', { exact: true })).toBeVisible();
    await pills(page.locator('.bank-period input, .bank-heading-actions .button'), `bank-period-${width}`);
    await page.getByLabel('Период с', { exact: true }).fill('2026-10-01'); await expect(page.getByLabel('Период с', { exact: true })).toHaveValue('2026-10-01');
    await focusRing(page.getByLabel('Период с', { exact: true }), `bank-date-${width}`); await capture(`bank-period-${width}`);

    await visit('directories');
    (report.focusFeedback ||= []).push(await verifyFocusFeedback(page, page.locator('.directory-toolbar .shipment-search input'), `directory-search-${width}`));
    await page.getByRole('button', { name: 'Сотрудники', exact: true }).click();
    const roleFilters = page.locator('.directory-list .account-role-filters'); await expect(roleFilters).toBeVisible();
    await expect(roleFilters.locator('button').first()).toBeEnabled();
    const gap = await page.locator('.directory-list').evaluate(element => element.querySelector('.account-role-filters').getBoundingClientRect().top - element.querySelector('.directory-toolbar').getBoundingClientRect().bottom);
    assert.ok(gap >= 16, `Directory toolbar/roles gap ${width}px: ${gap}`); report.gaps.push({ name: `directory-${width}`, gap });
    // This fixture has a directory driver but no driver login, so its account
    // role is deliberately unlinked rather than inferred from the directory.
    await roleFilters.getByRole('button', { name: /^Водитель/ }).click(); await expect(page.locator('.directory-record')).toHaveCount(0);
    await roleFilters.getByRole('button', { name: /^Все / }).click(); await capture(`directory-employees-${width}`);
    await page.getByRole('button', { name: 'Товары', exact: true }).click();
    await page.getByRole('button', { name: 'Редактировать: QA Дизельное топливо', exact: true }).click();
    const directory = page.locator('.directory-editor'); await expect(directory).toBeVisible();
    await pills(directory.locator('input:not([type="checkbox"]), select, .directory-editor-footer .button'), `directory-form-${width}`);
    await directory.getByLabel('Название товара', { exact: true }).fill('QA Изменённое название');
    const packaging = directory.getByLabel('Способ перевозки груза', { exact: true }); await packaging.selectOption('packaged'); await expect(packaging).toHaveValue('packaged');
    await focusRing(packaging, `directory-select-${width}`); await capture(`directory-form-${width}`); await cancelDirty(directory);

    await visit('accounts'); await page.getByRole('button', { name: 'Изменить', exact: true }).click();
    await expect(page.locator('.account-editor')).toBeVisible();
    // Account editing intentionally moves focus on the next animation frame.
    // Let that transition finish before testing focus within the form.
    await expect(page.locator('.account-editor')).toBeFocused();
    await pills(page.locator('.account-form input:not([type="checkbox"]), .account-form select, .account-form-footer .button'), `account-form-${width}`);
    const accountGap = await page.locator('.account-panel').evaluate(element => element.querySelector('.account-list-heading').getBoundingClientRect().top - element.querySelector('.account-editor').getBoundingClientRect().bottom);
    assert.ok(accountGap >= 20, `Account editor/list gap ${width}px: ${accountGap}`); report.gaps.push({ name: `account-${width}`, gap: accountGap });
    const name = page.getByLabel('Имя в приложении', { exact: true }); await name.fill('QA Изменённое имя'); await expect(name).toHaveValue('QA Изменённое имя');
    await page.getByLabel('Полномочия', { exact: true }).selectOption('admin'); await expect(page.getByLabel('Полномочия', { exact: true })).toHaveValue('admin');
    await focusRing(name, `account-name-${width}`); await capture(`account-form-${width}`);
    await page.getByRole('button', { name: 'Отмена', exact: true }).click(); await expect(page.locator('.account-editor')).toHaveCount(0); await expect(page.locator('.account-user-title strong')).toHaveText('QA Директор');
    await page.getByRole('button', { name: 'Добавить пользователя', exact: true }).click(); await expect(page.locator('.account-editor')).toBeFocused(); await page.getByLabel('Полномочия', { exact: true }).selectOption('driver');
    await expect(page.locator('.account-driver-editor')).toBeVisible();
    await pills(page.locator('.account-driver-editor select, .account-driver-editor .button'), `driver-account-${width}`);
    const driverGap = await page.locator('.account-panel').evaluate(element => element.querySelector('.account-list-heading').getBoundingClientRect().top - element.querySelector('.account-editor').getBoundingClientRect().bottom);
    assert.ok(driverGap >= 20, `Driver editor/list gap ${width}px: ${driverGap}`); report.gaps.push({ name: `driver-account-${width}`, gap: driverGap });
    await capture(`driver-account-${width}`); await page.getByRole('button', { name: 'Закрыть доступ водителя', exact: true }).click();
    report.checks.push(`${width}px: rounded fields, dates, select triggers, save/cancel; editable drafts; cancellation; employee and account spacing; no page/dialog overflow`);
    console.log('PASS', report.checks.at(-1));
  }
  await page.goto(`${runtime.base}/#work`);
  await page.getByRole('button', { name: 'Новая задача', exact: true }).click();
  await expect(page.locator('.work-editor')).toBeVisible();
  for (const [index, field] of (await page.locator('.work-editor input:not([type="checkbox"]), .work-editor textarea, .work-editor select').all()).entries()) {
    if (await field.isVisible() && await field.isEnabled()) report.focusFeedback.push(await verifyFocusFeedback(page, field, `work-field-${index}`));
  }
  await page.getByLabel('Название', { exact: true }).focus();
  await page.screenshot({ path: resolve(output, 'work-border-focus.png'), fullPage: true });
  await page.locator('.work-editor').getByRole('button', { name: 'Отмена', exact: true }).click();
  // Include the optional team screen's own stylesheet and variable scope.
  await page.addStyleTag({ path: resolve(root, 'web/src/team.css') });
  // Additional shared surfaces use synthetic DOM, with the real loaded CSS.
  await page.evaluate(() => {
    const fixture = document.createElement('section'); fixture.id = 'focus-fixture';
    fixture.innerHTML = ['app-shell', 'driver-shell', 'auth-screen', 'shipment-filter-dialog'].map(shell => `<div class="${shell}">${['text', 'search', 'password', 'email', 'tel', 'number', 'date', 'time', 'datetime-local', 'month', 'file', 'checkbox', 'radio', 'range'].map(type => `<label class="shipment-field"><input type="${type}"></label>`).join('')}<label class="shipment-field"><select><option>QA</option></select></label><textarea></textarea>${['shipment-search', 'table-search', 'overview-search', 'bank-search', 'team-search', 'company-combobox', 'filter-search', 'driver-search'].filter(wrapper => wrapper !== 'driver-search' || shell === 'driver-shell').map(wrapper => `<div class="${wrapper === 'team-search' ? 'team-page' : ''}"><label class="${wrapper}"><input type="text"></label></div>`).join('')}</div>`).join('');
    document.body.append(fixture);
  });
  for (const [index, field] of (await page.locator('#focus-fixture input, #focus-fixture select, #focus-fixture textarea').all()).entries()) {
    // Portal dialogs only contain shipment-field controls and filter-search.
    const applicable = await field.evaluate(element => {
      const shell = element.closest('.shipment-filter-dialog, .auth-screen');
      return !shell || (shell.matches('.auth-screen') ? !element.closest('label:not(.shipment-field)') : !!element.closest('.shipment-field, .filter-search'));
    });
    if (applicable) report.focusFeedback.push(await verifyFocusFeedback(page, field, `shared-surface-${index}`));
  }
  const authContext = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  await authContext.route('**/*', route => {
    const request = route.request();
    assert.equal(new URL(request.url()).origin, runtime.base);
    assert.ok(['GET', 'HEAD', 'OPTIONS'].includes(request.method()));
    return route.continue();
  });
  const authPage = await authContext.newPage();
  await authPage.goto(runtime.base);
  for (const label of ['Логин', 'Пароль']) {
    const input = authPage.getByLabel(label, { exact: true });
    await expect(input).toBeVisible();
    report.focusFeedback.push(await verifyFocusFeedback(authPage, input, `real-auth-${label}`));
  }
  await authPage.screenshot({ path: resolve(output, 'auth-focus.png') });
  await authContext.close();
  assert.equal(report.providerCalls, 0); assert.deepEqual(report.unexpectedRequests, []); assert.deepEqual(report.mutationRequests, []); assert.deepEqual(report.errors, []); assert.deepEqual(report.consoleErrors, []);
  report.status = 'passed';
  report.checks.push('Zero external requests, UI mutations, page errors and console errors');
} catch (error) {
  report.status = 'failed'; report.failure = String(error.stack || error); console.error(report.failure); process.exitCode = 1;
} finally {
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
  await browser?.close(); await runtime?.server.close(); await rm(temporary, { recursive: true, force: true });
}
