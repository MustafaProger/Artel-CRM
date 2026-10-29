import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium, webkit, expect } from '@playwright/test';
import { startTripsQaServer, writeTripsQaSnapshot } from './qa-trips-runtime.mjs';
import { authenticateContext, bootstrapQaAuth } from './qa-auth.mjs';
const root = resolve(import.meta.dirname, '..'), built = process.argv.includes('--built');
const output = resolve(root, '.local/directory-access', built ? 'built-ui' : 'source-ui');
const temporary = await mkdtemp(resolve(tmpdir(), 'artel-directory-access-'));
const snapshotDirectory = resolve(temporary, 'snapshot'), operationsDirectory = resolve(temporary, 'operations');
await mkdir(output, { recursive: true }); await writeTripsQaSnapshot(snapshotDirectory);
const report = { synthetic: true, passed: false, errors: [], checks: [] };
let runtime, browser;
try {
  runtime = await startTripsQaServer({ root, snapshotDirectory, operationsDirectory });
  if (built) runtime.server.middlewares.stack.unshift({ route: '', handle(req, res, next) {
    const path = new URL(req.url, runtime.base).pathname; if (path.startsWith('/api/')) return next();
    const relative = path === '/' ? 'index.html' : path.slice(1); if (relative.includes('..')) return next();
    readFile(resolve(root, 'app-dist', relative)).then(body => { res.setHeader('Content-Type', relative.endsWith('.js') ? 'text/javascript' : relative.endsWith('.css') ? 'text/css' : 'text/html'); res.end(body); }).catch(() => next());
  } });
  const { cookie } = await bootstrapQaAuth(runtime.base);
  const api = async (path, method = 'GET', body) => {
    const response = await fetch(runtime.base + path, { method, headers: { cookie, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result;
  };
  const password = randomUUID(), users = [], clients = [], shipments = [];
  const supplier = (await api('/api/directories', 'POST', { kind: 'companies', name: 'Поставщик QA', roles: ['supplier'], addresses: [] })).entry;
  const product = (await api('/api/directories', 'POST', { kind: 'products', name: 'Топливо QA' })).entry;
  const payment = (await api('/api/snapshot')).directories.paymentForms.find(row => row.name === 'б/нал');
  for (const [index, name] of ['Айдар QA', 'Зуфар QA'].entries()) {
    const employee = (await api('/api/directories', 'POST', { kind: 'managers', name })).entry;
    const user = (await api('/api/auth/users', 'POST', { name, login: `scopes-${index}`, password, role: 'employee', managerId: employee.id, sections: ['overview', 'shipments', 'work', 'directories', 'trips'] })).user;
    users.push(user);
    const customer = (await api('/api/directories', 'POST', { kind: 'companies', name: `Клиент ${name}`, roles: ['customer'], managerId: employee.id, addresses: [] })).entry;
    clients.push(customer);
    shipments.push((await api('/api/shipments', 'POST', { fields: { shipment_type: 'azs', date: '2026-10-26', customer_id: customer.id, supplier_id: supplier.id, manager_id: employee.id, product_id: product.id, payment_form_id: payment.id, quantity_litres: '1000', customer_amount: index ? '777777' : '100000', purchase_amount: '80000' } })).shipment);
  }
  await api('/api/work/tasks', 'POST', { title: 'Задача Зуфара QA', assigneeId: users[1].id, companyId: clients[1].id });
  for (const [engine, driver] of [['chromium', chromium], ['webkit', webkit]]) {
    browser = await driver.launch({ headless: true });
    for (const width of [1440, 320]) {
      const admin = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
      await authenticateContext(admin, runtime.base, cookie);
      await admin.route('**/*', route => new URL(route.request().url()).origin === runtime.base ? route.continue() : route.abort());
      const page = await admin.newPage(); page.on('pageerror', error => report.errors.push({ engine, width, url: page.url(), message: error.message }));
      await page.goto(runtime.base + '/#accounts');
      await page.locator('.account-row').filter({ hasText: 'scopes-0' }).getByRole('button', { name: 'Изменить', exact: true }).click();
      await expect(page.getByLabel('Справочник: Нефтебазы', { exact: true })).toHaveAttribute('type', 'checkbox');
      await page.getByLabel('Справочник: Нефтебазы', { exact: true }).check();
      await page.getByLabel('Справочник: Поставщики', { exact: true }).uncheck();
      await expect(page.locator('.account-directory-access select')).toHaveCount(0);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.screenshot({ path: resolve(output, `${engine}-${width}-settings.png`), fullPage: true });
      await page.getByRole('button', { name: 'Сохранить пользователя', exact: true }).click();
      await expect(page.locator('.account-form')).toHaveCount(0);
      const saved = (await api('/api/auth/users')).users.find(user => user.id === users[0].id);
      assert.deepEqual(saved.directoryGrants, ['oilDepots']);
      const employee = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
      await employee.route('**/*', route => new URL(route.request().url()).origin === runtime.base ? route.continue() : route.abort());
      assert.equal((await employee.request.post(runtime.base + '/api/auth/login', { data: { login: users[0].login, password } })).status(), 200);
      const staffPage = await employee.newPage(); staffPage.on('pageerror', error => report.errors.push({ engine, width, url: staffPage.url(), message: error.message }));
      await staffPage.goto(runtime.base + '/#directories');
      await expect(staffPage.getByText(clients[0].name, { exact: true })).toBeVisible();
      await expect(staffPage.getByText(clients[1].name, { exact: true })).toHaveCount(0);
      await expect(staffPage.locator('.directory-tabs').getByRole('button', { name: 'Поставщики', exact: true })).toHaveCount(0);
      assert.ok(await staffPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await staffPage.screenshot({ path: resolve(output, `${engine}-${width}-customers.png`), fullPage: true });
      await staffPage.goto(runtime.base + '/#shipments');
      const shipmentResponse = await employee.request.get(runtime.base + '/api/shipments');
      assert.equal((await shipmentResponse.json()).total, 1);
      await expect(staffPage.getByRole('heading', { name: 'Отгрузки', exact: true })).toBeVisible();
      await staffPage.getByRole('tab', { name: 'АЗС', exact: true }).click();
      await expect(staffPage.locator('tbody').getByText(clients[0].name, { exact: true })).toBeVisible();
      await expect(staffPage.locator('tbody').getByText(clients[1].name, { exact: true })).toHaveCount(0);
      await staffPage.goto(runtime.base + '/#directories');
      await staffPage.locator('.directory-tabs').getByRole('button', { name: 'Нефтебазы', exact: true }).click();
      await staffPage.getByRole('button', { name: 'Добавить', exact: true }).click();
      const depotName = `Нефтебаза QA ${engine} ${width}`;
      await staffPage.getByLabel('Наименование нефтебазы', { exact: true }).fill(depotName);
      await staffPage.locator('dialog[open]').getByRole('button', { name: 'Сохранить', exact: true }).click();
      await expect(staffPage.locator('dialog[open]')).toHaveCount(0);
      await staffPage.getByRole('button', { name: `Редактировать: ${depotName}`, exact: true }).click();
      await staffPage.getByLabel('Наименование нефтебазы', { exact: true }).fill(depotName+' изменена');
      await staffPage.locator('dialog[open]').getByRole('button', { name: 'Сохранить', exact: true }).click();
      await expect(staffPage.locator('dialog[open]')).toHaveCount(0);
      await staffPage.getByRole('button', { name: `Удалить: ${depotName} изменена`, exact: true }).click();
      await staffPage.locator('dialog[open]').getByRole('button', { name: 'Удалить', exact: true }).click();
      await expect(staffPage.locator('dialog[open]')).toHaveCount(0);
      await expect(staffPage.getByText(depotName+' изменена', { exact: true })).toHaveCount(0);
      await staffPage.goto(runtime.base + '/#work');
      await expect(staffPage.getByRole('button', { name: 'Задача: Задача Зуфара QA', exact: true })).toHaveCount(0);
      await api('/api/auth/users/' + saved.id, 'PATCH', { name:saved.name, login:saved.login, role:saved.role, managerId:saved.managerId, active:saved.active, version:saved.version, sections:saved.sections, directoryGrants:[] });
      assert.equal((await employee.request.get(runtime.base+'/api/directories')).status(),401);
      assert.equal((await employee.request.post(runtime.base + '/api/auth/login', { data: { login: users[0].login, password } })).status(), 200);
      await staffPage.goto(runtime.base+'/#directories'); await staffPage.reload();
      await expect(staffPage.getByText(clients[0].name, {exact:true})).toBeVisible();
      await expect(staffPage.locator('.directory-tabs').getByRole('button', {name:'Нефтебазы',exact:true})).toHaveCount(0);
      await employee.close(); await admin.close();
      report.checks.push({ engine, width, ownClientsAndShipments:true, hiddenSupplierTab:true, depotCrud:true, foreignTaskHidden:true, revokedGrant:true, noOverflow:true });
    }
    await browser.close(); browser = null;
  }
  assert.deepEqual(report.errors, []); report.passed = true;
} finally {
  await browser?.close(); await runtime?.server.close();
  await writeFile(resolve(output, 'result.json'), JSON.stringify(report, null, 2));
  await rm(temporary, { recursive: true, force: true });
}
console.log(JSON.stringify(report));
