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
const output = resolve(root, 'qa/scrollable-segments');
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


  browser = process.env.QA_WEBKIT ? await webkit.launch({ headless: true }) : await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce', timezoneId: 'Europe/Moscow', serviceWorkers: 'block' });
  await authenticateContext(context, runtime.base, cookie);
  await context.route('**/*', route => {
    const request = route.request();
    if (new URL(request.url()).origin !== runtime.base) { report.unexpectedRequests.push(request.url()); return route.abort(); }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) { report.mutationRequests.push({ method: request.method(), url: request.url() }); return route.abort(); }
    return route.continue();
  });
  page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.on('pageerror', error => report.errors.push({ page: page.url(), message: error.message }));
  page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push({ page: page.url(), message: message.text() }); });

  for (const width of [1440, 760, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [route, selector] of [['directories', '.directory-tabs'], ['payroll', '.payroll-tabs'], ['payments', '.bank-source-tabs'], ['overview', '.overview-ledger-tabs']]) {
      await page.goto(`${runtime.base}/#${route}`);
      const strip = page.locator(selector);
      await strip.waitFor();
      const buttons = strip.locator('button');
      const layout = await strip.evaluate(element => ({
        pageWidth: document.documentElement.scrollWidth, viewport: innerWidth,
        height: element.clientHeight, width: element.clientWidth, scrollWidth: element.scrollWidth,
        rows: [...new Set([...element.querySelectorAll('button')].map(button => button.offsetTop))],
        touchSizes: [...element.querySelectorAll('button')].map(button => button.offsetHeight),
      }));
      assert.equal(layout.rows.length, 1, `${route} wraps at ${width}`);
      assert.ok(layout.height <= 56, `${route} grows vertically at ${width}`);
      assert.ok(layout.pageWidth <= layout.viewport + 1, `${route} page overflow`);
      assert.ok(layout.touchSizes.every(height => height >= 44), 'Touch targets');
      await buttons.first().focus();
      await page.keyboard.press('End');
      await expect(buttons.last()).toBeFocused();
      await expect(buttons.last()).toHaveAttribute(route === 'directories' || route === 'overview' ? 'aria-pressed' : 'aria-selected', 'true');
      await expect.poll(() => buttons.last().evaluate(button => {
        const a = button.getBoundingClientRect(), b = button.parentElement.getBoundingClientRect();
        return a.left >= b.left && a.right <= b.right;
      })).toBe(true);
      if (route === 'directories') {
        await expect(page.locator('.directory-record-main').first()).toContainText('QA Площадка клиента');
        await page.screenshot({ path: resolve(output, `directories-last-${width}.png`) });
        await page.keyboard.press('Home');
        await expect(buttons.first()).toHaveAttribute('aria-pressed', 'true');
        await expect(page.locator('.directory-record-main').first()).toContainText('QA Клиент');
        await page.screenshot({ path: resolve(output, `directories-first-${width}.png`) });
        // Scrolling itself must not change the selected category.
        await strip.evaluate(element => { element.scrollLeft = element.scrollWidth; });
        await expect(buttons.first()).toHaveAttribute('aria-pressed', 'true');
        await buttons.last().click();
        await expect(buttons.last()).toHaveAttribute('aria-pressed', 'true');
      }
      await buttons.last().focus();
      await page.keyboard.press('ArrowLeft');
      await expect(buttons.nth(await buttons.count() - 2)).toBeFocused();
      await page.keyboard.press('Home');
      await expect(buttons.first()).toBeFocused();
      console.log('PASS layout', route, width);
      report.layouts.push({ route, width, ...layout });
      report.checks.push(`${route}: ${width}px, keyboard and selected item visibility`);
    }
  }
  await page.goto(`${runtime.base}/#shipments`);
  await page.getByRole('button', { name: 'QA Клиент с длинным названием для проверки адаптивного интерфейса', exact: true }).click();
  const dialogTabs = page.locator('.dialog-tabs');
  await dialogTabs.waitFor();
  await dialogTabs.locator('button').first().focus();
  await page.keyboard.press('End');
  await expect(dialogTabs.locator('button').last()).toHaveAttribute('aria-pressed', 'true');
  assert.equal(await dialogTabs.evaluate(e => new Set([...e.querySelectorAll('button')].map(b => b.offsetTop)).size), 1);
  await page.screenshot({ path: resolve(output, 'company-dialog-320.png') });
  await page.keyboard.press('Escape');
  await page.goto(`${runtime.base}/#directories`);
  // Selected category survives resize and remains visible.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('.directory-tabs button').last().click();
  await page.setViewportSize({ width: 320, height: 900 });
  await expect.poll(() => page.locator('.directory-tabs button').last().evaluate(button => {
    const a = button.getBoundingClientRect(), b = button.parentElement.getBoundingClientRect();
    return a.left >= b.left && a.right <= b.right;
  })).toBe(true);
  await expect(page.locator('.scrollable-segments-selection')).toHaveCSS('transition-duration', '0s');
  const accessibility = await new AxeBuilder({ page }).include('.directory-tabs').withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze();
  assert.deepEqual(accessibility.violations, []);
  // With motion enabled, rapid re-selection still settles on the actual category.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.locator('.directory-tabs button').last().focus();
  await page.keyboard.press('Home'); await page.keyboard.press('End'); await page.keyboard.press('Home');
  await expect.poll(() => page.locator('.directory-tabs').evaluate(e => ({left: e.scrollLeft, active: e.querySelector('[aria-pressed=true]')?.textContent, offset: e.querySelector('[aria-pressed=true]')?.offsetLeft}))).toMatchObject({left: 0, active: 'Клиенты'});
  assert.equal(report.providerCalls, 0);
  assert.deepEqual(report.mutationRequests, []);
  assert.deepEqual(report.unexpectedRequests, []);
  assert.deepEqual(report.errors, []);
  await page.locator('.directory-tabs').hover();
  await page.mouse.wheel(240, 0);
  await expect.poll(() => page.locator('.directory-tabs').evaluate(e => e.scrollLeft > 100)).toBe(true);
  await expect(page.locator('.directory-tabs button').first()).toHaveAttribute('aria-pressed', 'true');
  if (!process.env.QA_WEBKIT) {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    await page.locator('.directory-tabs').evaluate(e => e.scrollTo({ left: 0, behavior: 'instant' }));
    const box = await page.locator('.directory-tabs').boundingBox();
    const y = box.y + box.height / 2;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 260, y }] });
    for (let x = 240; x >= 40; x -= 20) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
      await page.waitForTimeout(16);
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(() => page.locator('.directory-tabs').evaluate(e => e.scrollLeft > 100)).toBe(true);
    await expect(page.locator('.directory-tabs button').first()).toHaveAttribute('aria-pressed', 'true');
    await cdp.detach();
  }
  report.status = 'passed';
  console.log('PASS', report.checks.length, 'layout/interaction combinations; dialog, resize, reduced motion, axe, zero writes/providers');
} catch (error) {
  report.status = 'failed'; report.failure = String(error.stack || error); console.error(report.failure); process.exitCode = 1;
} finally {
  await writeFile(resolve(output, process.env.QA_WEBKIT ? 'webkit-verification.json' : 'chromium-verification.json'), JSON.stringify(report, null, 2));
  await browser?.close(); await runtime?.server.close(); await rm(temporary, { recursive: true, force: true });
}
