import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { bootstrapQaAuth, authenticateContext } from './qa-auth.mjs';
import { startTripsQaServer, writeTripsQaSnapshot } from './qa-trips-runtime.mjs';
import { enabledPages } from '../web/src/page-catalog.ts';
import { emptyDirectories } from '../server/directory-operations.ts';
import { loadSnapshot } from '../server/local-api.ts';
import { OperationsStore } from '../server/operations-store.ts';
const root = resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(resolve(tmpdir(), 'artel-employee-ui-'));
const snapshotDirectory = resolve(temporary, 'snapshot'), operationsDirectory = resolve(temporary, 'operations');
const output = resolve(process.env.ARTEL_EMPLOYEE_QA_OUTPUT || resolve(root, 'qa/employee-access')); await mkdir(output, { recursive: true });
const report = { synthetic: true, workingStoreAccessed: false, checks: [], errors: [], overflows: [], screenshots: [] };
let base;
const check = text => { report.checks.push(text); console.log('PASS', text); };
let server, browser, testPage;
try {
  await writeTripsQaSnapshot(snapshotDirectory);
  const source = await loadSnapshot(snapshotDirectory);
  await new OperationsStore(operationsDirectory).mutate(source.provenance.sourceSha256, data => {
    data.sourceOperationsCleared = true;
    const company = (id, name, role) => ({ id, name, roles: [role], managerLabels: [], shipmentIds: [], paymentIds: [], flags: [] });
    data.companies = [company('qa-customer', 'Учебный покупатель', 'customer'), company('qa-supplier', 'Учебный поставщик', 'supplier')];
    data.directories = { ...emptyDirectories(), fleetSeedApplied: true, products: [{ id: 'qa-product', name: 'Учебный ДТ', transportProductKind: 'diesel', cargoPackaging: 'bulk' }], paymentForms: [{ id: 'qa-payment', name: 'б/нал' }] };
    return { result: null, changed: true };
  });
  server = await startTripsQaServer({ root, snapshotDirectory, operationsDirectory }); base = server.base;
  const { cookie } = await bootstrapQaAuth(base);
  browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const admin = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  await authenticateContext(admin, base, cookie);
  const page = await admin.newPage(); testPage = page; page.on('pageerror', e => report.errors.push(e.message));
  await page.goto(base + '/#accounts');
  await expect(page.getByRole('heading', { name: 'Сотрудники и доступ', exact: true })).toBeVisible();
  const credentials = [];
  for (const [index, employeeName] of ['Айдар Browser QA', 'Зуфар Browser QA'].entries()) {
    let existingId;
    if (index) { const added = await admin.request.post(base + '/api/directories', { data: { kind: 'managers', name: employeeName } }); assert.equal(added.status(), 201); existingId = (await added.json()).entry.id; }
    if (index) await page.reload();
    await page.getByRole('button', { name: 'Добавить пользователя', exact: true }).click();
    if (!index) {
      await page.getByLabel('Новый сотрудник', { exact: true }).fill(employeeName);
      await page.getByRole('button', { name: 'Добавить сотрудника', exact: true }).click();
      await expect(page.getByLabel('Имя в приложении', { exact: true })).toHaveValue(employeeName);
    } else await page.getByLabel('Сотрудник справочника', { exact: true }).selectOption(existingId);
    const login = `browser-employee-${index}`, password = randomUUID(); credentials.push({ login, password });
    await page.getByLabel('Логин', { exact: true }).fill(login);
    await page.getByLabel('Пароль', { exact: true }).fill(password);
    for (const section of enabledPages.filter(item => item.id !== 'shipments')) await page.getByRole('checkbox', { name: section.title, exact: true }).uncheck();
    await expect(page.locator('.account-section-grid input')).toHaveCount(enabledPages.length);
    const invoices = page.getByRole('checkbox', { name: 'Счета', exact: true });
    await expect(invoices).not.toBeChecked(); await expect(invoices).toBeEnabled(); await invoices.check(); await invoices.uncheck();
    if (!index) for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      const dimensions = await page.evaluate(() => ({ width: innerWidth, content: document.documentElement.scrollWidth }));
      if (dimensions.content > width + 1) report.overflows.push(dimensions);
      const path = resolve(output, `account-form-${width}.png`); await page.screenshot({ path, fullPage: true }); report.screenshots.push(path);
    }
    await page.getByRole('button', { name: 'Сохранить пользователя', exact: true }).click();
    await expect(page.locator('.account-form')).toHaveCount(0);
    await expect(page.locator('.account-row').filter({ hasText: login })).toContainText('Отгрузки: только свои');
  }
  check('Administrator creates an employee and links an existing employee through the UI; all catalog permissions include an explicit, editable invoices checkbox; desktop and mobile forms save');
  const users = (await (await admin.request.get(base + '/api/auth/users')).json()).users.filter(user => user.role === 'manager');
  const snap = await (await admin.request.get(base + '/api/snapshot')).json();
  const directory = snap.directories;
  assert.equal(directory.managers.filter(row => row.name === 'Зуфар Browser QA').length, 1);
  const shipments = [];
  for (const [index, user] of users.entries()) {
    const response = await admin.request.post(base + '/api/shipments', { data: { fields: { shipment_type: 'azs', document_number: index ? 'ZUFAR-ONLY' : 'AIDAR-ONLY', date: '2026-09-01', customer_id: 'qa-customer', supplier_id: 'qa-supplier', manager_id: user.managerId, product_id: directory.products[0].id, payment_form_id: directory.paymentForms.find(p => p.name === 'б/нал').id, quantity_litres: '1000', customer_amount: index ? '777777' : '100000', purchase_amount: '80000' } } });
    assert.equal(response.status(), 201); shipments.push((await response.json()).shipment);
  }
  const contexts = [];
  for (const [index, credentialsEntry] of credentials.entries()) {
    const context = await browser.newContext({ viewport: { width: index ? 390 : 1440, height: 1000 }, serviceWorkers: 'block' }); contexts.push(context);
    const employee = await context.newPage(); employee.on('pageerror', e => report.errors.push(e.message));
    await employee.goto(base);
    await employee.getByLabel('Логин', { exact: true }).fill(credentialsEntry.login);
    await employee.getByLabel('Пароль', { exact: true }).fill(credentialsEntry.password);
    await employee.getByRole('button', { name: 'Войти', exact: true }).click();
    await expect(employee.getByRole('tab', { name: 'АЗС', exact: true })).toBeVisible();
    await employee.getByRole('tab', { name: 'АЗС', exact: true }).click();
    await expect(employee.locator('.shipment-grid tbody')).toContainText(index ? 'ZUFAR-ONLY' : 'AIDAR-ONLY');
    await expect(employee.locator('.shipment-grid tbody')).not.toContainText(index ? 'AIDAR-ONLY' : 'ZUFAR-ONLY');
    await expect(employee.getByRole('link', { name: 'Справочники', exact: true })).toHaveCount(0);
    assert.equal((await context.request.get(base + '/api/shipments/' + shipments[1 - index].id)).status(), 404);
    const downloadPromise = employee.waitForEvent('download');
    await employee.getByRole('button', { name: 'CSV', exact: true }).click();
    const download = await downloadPromise;
    const csv = await readFile(await download.path(), 'utf8');
    assert.ok(csv.includes(index ? 'ZUFAR-ONLY' : 'AIDAR-ONLY')); assert.ok(!csv.includes(index ? 'AIDAR-ONLY' : 'ZUFAR-ONLY'));
    for (const id of ['overview', 'work', 'china', 'stock', 'payments', 'operator', 'payroll', 'directories', 'accounts', 'invoices']) {
      await employee.goto(`${base}/#${id}`);
      await expect(employee.getByRole('alert')).toContainText('Раздел недоступен');
      await expect(employee.locator('.account-panel,.directories-page,.work-page,.china-page')).toHaveCount(0);
    }
    const labels = await employee.locator('#app-navigation nav button').allTextContents();
    assert.equal(labels.length, 1); assert.ok(labels[0].startsWith('Отгрузки'));
  }
  check('Two managers see only their own shipments in browser and downloaded CSV; all disabled URLs and navigation entries remain inaccessible');
  await page.setViewportSize({ width: 390, height: 1000 });
  await page.locator('.account-row').filter({ hasText: credentials[0].login }).getByRole('button', { name: 'Изменить', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Отгрузки', exact: true }).uncheck(); await page.getByRole('checkbox', { name: 'Работа', exact: true }).check();
  await page.getByRole('button', { name: 'Сохранить пользователя', exact: true }).click(); await expect(page.locator('.account-form')).toHaveCount(0);
  assert.equal((await contexts[0].request.get(base + '/api/shipments')).status(), 401);
  assert.equal((await contexts[0].request.post(base + '/api/auth/login', { data: credentials[0] })).status(), 200);
  assert.equal((await contexts[0].request.get(base + '/api/shipments')).status(), 403);
  const resetPassword = randomUUID();
  await page.locator('.account-row').filter({ hasText: credentials[0].login }).getByRole('button', { name: 'Изменить', exact: true }).click();
  await page.getByLabel('Новый пароль (если нужно)', { exact: true }).fill(resetPassword);
  await page.getByRole('button', { name: 'Сохранить пользователя', exact: true }).click(); await expect(page.locator('.account-form')).toHaveCount(0);
  assert.equal((await contexts[0].request.post(base + '/api/auth/login', { data: credentials[0] })).status(), 401);
  assert.equal((await contexts[0].request.post(base + '/api/auth/login', { data: { login: credentials[0].login, password: resetPassword } })).status(), 200);
  await page.locator('.account-row').filter({ hasText: credentials[0].login }).getByRole('button', { name: 'Изменить', exact: true }).click();
  await page.getByLabel('Активен', { exact: true }).uncheck();
  await page.getByRole('button', { name: 'Сохранить пользователя', exact: true }).click(); await expect(page.locator('.account-form')).toHaveCount(0);
  assert.equal((await contexts[0].request.get(base + '/api/work')).status(), 401);
  check('Mobile administration changes sections, resets the password and disables an account; stale sessions immediately fail');
  assert.deepEqual(report.errors, []); assert.deepEqual(report.overflows, []);
} catch (error) {
  if (testPage) { await testPage.screenshot({ path: resolve(output, 'failure.png'), fullPage: true }).catch(() => {}); console.error(await testPage.locator('body').innerText().catch(() => '')); }
  throw error;
} finally {
  await browser?.close();
  await server?.server.close();
  await rm(temporary, { recursive: true, force: true });
  await writeFile(resolve(output, 'browser.json'), JSON.stringify(report, null, 2));
}
