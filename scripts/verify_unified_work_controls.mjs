// Read-only browser acceptance against an isolated, synthetic CRM. No working snapshot/store.
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

const root = resolve(import.meta.dirname, '..');
const useWebKit = process.env.QA_WEBKIT === '1';
const output = resolve(root, `qa/unified-work-controls-20261005${useWebKit ? '-webkit' : ''}`);
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

  for (const width of [320, 390, 768, 900, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const section of ['trips', 'accounts', 'work']) {
      await page.goto(`${runtime.base}/#${section}`);
      const selector = section === 'work' ? '.work-action-toolbar' : '.search-add-toolbar';
      await expect(page.locator(selector)).toBeVisible();
      if (section === 'work') {
        const bell = page.getByRole('button', { name: /^Напоминания/ });
        await expect(bell).toBeVisible();
        await expect(page.locator('.work-reminders')).toHaveCount(0);
        const views = await page.locator('.work-view-toolbar').boundingBox();
        const actions = await page.locator(selector).boundingBox();
        assert.ok(actions.y >= views.y + views.height + 8);
        const filter = await page.getByLabel('Фильтр исполнителя').boundingBox();
        const add = await page.getByRole('button', { name: 'Новая задача', exact: true }).boundingBox();
        assert.ok(add.y >= filter.y + filter.height, JSON.stringify({width, filter, add}));
        await bell.click();
        const dialog = page.getByRole('dialog', { name: 'Напоминания', exact: true });
        await expect(dialog).toBeVisible();
        await expect(dialog.getByText('Напоминаний пока нет.')).toBeVisible();
        const bounds = await dialog.boundingBox();
        assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
        await page.screenshot({path: resolve(output, `reminders-${width}.png`)});
        await page.keyboard.press('Escape');
        await expect(dialog).not.toBeVisible();
        await expect(bell).toBeFocused();
        await bell.click();
        await page.getByRole('button', {name:'Закрыть настройки уведомлений'}).click();
        await expect(bell).toBeFocused();
      } else {
        const boxes = await page.locator(`${selector} > *`).evaluateAll(nodes => nodes.map(n => {const r=n.getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right};}));
        assert.ok(Math.abs(boxes[0].height - boxes[1].height) <= 2, JSON.stringify(boxes));
        assert.ok(Math.abs(boxes[1].x - boxes[0].right - 12) <= 1, JSON.stringify(boxes));
      }
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${section} ${width} overflow`);
      await page.screenshot({path: resolve(output, `${section}-${width}.png`)});
      report.checks.push(`${section} ${width}px`);
    }
  }
  await fixture('/api/work/tasks', { title: 'QA Напоминание', reminderAt: `${day}T12:00:00.000Z` });
  await page.goto(`${runtime.base}/#work`);
  const reminderBell = page.getByRole('button', { name: /^Напоминания, 1/ });
  await reminderBell.click();
  await page.locator('.work-reminder').filter({ hasText: 'QA Напоминание' }).click();
  await expect(page.locator('.driver-notifications-dialog')).not.toBeVisible();
  await expect(page.locator('.work-editor')).toBeVisible();
  await expect(page.getByLabel('Название', {exact:true})).toHaveValue('QA Напоминание');
  await page.getByRole('button', {name:'Отмена', exact:true}).click();
  report.checks.push('Reminder count and opening its task editor');
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.mutationRequests, []);
  report.status = 'passed';
  console.log('PASS', report.checks.join(', '));
} catch (error) {
  report.status = 'failed'; report.failure = String(error.stack || error); console.error(report.failure); process.exitCode = 1;
} finally {
  await writeFile(resolve(output, 'interface-verification.json'), JSON.stringify(report, null, 2));
  await browser?.close(); await runtime?.server.close(); await rm(temporary, { recursive: true, force: true });
}
