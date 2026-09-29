// Regression: the empty customer directory can reuse retained company identities.
// Browser -> authenticated HTTP -> temporary OperationsStore; all records are synthetic.
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { OperationsStore } from '../server/operations-store.ts';
import { emptyDirectories } from '../server/directory-operations.ts';
import { bootstrapQaAuth, authenticateContext } from './qa-auth.mjs';
import { writeTripsQaSnapshot, startTripsQaServer } from './qa-trips-runtime.mjs';

const root = resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(resolve(tmpdir(), 'artel-customer-create-ui-'));
const snapshotDirectory = resolve(temporary, 'snapshot'), operationsDirectory = resolve(temporary, 'store');
const output = resolve(root, 'qa/customer-creation-2026-09-29');
await mkdir(output, { recursive: true });
const source = await writeTripsQaSnapshot(snapshotDirectory), store = new OperationsStore(operationsDirectory);
const company = (id, name, roles, details = {}) => ({ id, name, roles, managerLabels: [], shipmentIds: [], paymentIds: [], flags: [], ...details });
const archived = company('qa-archived', 'QA Архивный клиент', [], { inn: '9900000000', directoryArchived: true });
const supplier = company('qa-supplier', 'QA Поставщик и перевозчик', ['supplier', 'carrier'], { inn: '9900000017', phone: '+7 (900) 000-00-00' });
const paymentCounterparty = company('qa-payment', 'QA Контрагент без ИНН', ['payment_counterparty']);
const sameNameHistory = company('qa-name-history', 'QA Клиент из реестра', ['payment_counterparty'], { phone: '+7 (900) 000-00-01' });
await store.mutate(source, data => {
  data.sourceOperationsCleared = true;
  data.companies = [archived, supplier, paymentCounterparty, sameNameHistory];
  data.directories = {
    ...emptyDirectories(), fleetSeedApplied: true,
    managers: [{ id: 'qa-manager', name: 'QA Менеджер' }],
    products: [{ id: 'qa-product', name: 'QA Товар' }],
    addresses: [{ id: 'qa-loading', companyId: supplier.id, kind: 'loading', name: 'QA Погрузка', address: 'QA Площадка' }],
    customerManagers: [{ companyId: supplier.id, managerId: 'qa-manager' }],
  };
  return { result: undefined, changed: true };
});
const report = { fixtureOnly: true, workingStoreAccessed: false, checks: [], errors: [], unexpectedRequests: [] };
const check = name => { report.checks.push(name); console.log('PASS', name); };
let runtime, browser, page;
try {
  runtime = await startTripsQaServer({ root, snapshotDirectory, operationsDirectory });
  const { base } = runtime, { cookie } = await bootstrapQaAuth(base);
  browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin === base) return route.continue();
    report.unexpectedRequests.push(route.request().url()); return route.abort();
  });
  await authenticateContext(context, base, cookie);
  page = await context.newPage();
  page.on('pageerror', error => report.errors.push(error.message));
  const snapshot = async () => {
    const response = await context.request.get(base + '/api/snapshot');
    assert.equal(response.status(), 200); return response.json();
  };
  const openNew = async row => {
    await page.getByRole('button', { name: 'Добавить', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Наименование', { exact: true }).fill(row.name);
    await dialog.getByLabel('ИНН', { exact: true }).fill(row.inn ?? '');
    return dialog;
  };
  const save = async dialog => {
    const pending = page.waitForResponse(response => response.url() === base + '/api/directories' && response.request().method() === 'POST');
    await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
    return pending;
  };
  await page.goto(base + '/#directories');
  await expect(page.locator('.directory-record-count')).toHaveText('Записей: 0');
  check('Empty customer list while archived and other-role companies remain in the store');

  for (const row of [archived, supplier, paymentCounterparty]) {
    const response = await save(await openNew(row));
    assert.equal(response.status(), 200, await response.text());
    const result = await response.json(); assert.equal(result.created, false); assert.equal(result.entry.id, row.id);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('button', { name: `Редактировать: ${row.name}`, exact: true })).toBeVisible();
    const current = await snapshot(), saved = current.companies.find(entry => entry.id === row.id);
    assert.ok(saved.roles.includes('customer')); assert.ok(!saved.directoryArchived);
    assert.equal(current.companies.length, 4); assert.equal(current.shipments.length, 0);
    for (const role of row.roles) assert.ok(saved.roles.includes(role));
    check(`Add existing company as customer: ${row.id}; closes, refreshes, retains ID and roles`);
  }
  const afterPromotion = await snapshot();
  assert.equal(afterPromotion.companies.find(row => row.id === supplier.id).phone, supplier.phone);
  assert.equal(afterPromotion.directories.addresses.find(row => row.id === 'qa-loading').companyId, supplier.id);
  assert.equal(afterPromotion.directories.customerManagers.find(row => row.companyId === supplier.id).managerId, 'qa-manager');
  check('Unfilled new-client fields preserve supplier details, loading address and assigned manager');

  runtime.replaceMiddleware();
  await page.reload(); await expect(page.locator('.directory-record-count')).toHaveText('Записей: 3');
  assert.equal((await snapshot()).shipments.length, 0);
  check('Customers remain visible after server middleware restart and browser reload; no historic shipments return');

  const duplicate = await openNew(archived), duplicateResponse = await save(duplicate);
  assert.equal(duplicateResponse.status(), 409);
  await expect(duplicate.getByRole('alert')).toContainText('уже');
  await expect(duplicate).toBeVisible(); assert.equal((await snapshot()).companies.length, 4);
  await duplicate.getByRole('button', { name: 'Отмена', exact: true }).click();
  await duplicate.getByRole('button', { name: 'Не сохранять', exact: true }).click();
  check('True company duplicate stays in the editor with the server error and creates no extra card');

  const fresh = company('unused', 'QA Новый клиент', []), freshResponse = await save(await openNew(fresh));
  assert.equal(freshResponse.status(), 201); assert.equal((await freshResponse.json()).created, true);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: `Редактировать: ${fresh.name}`, exact: true })).toBeVisible();
  check('A brand-new client still creates and appears normally');

  const historyBefore = (await store.read(source)).companies.find(row => row.id === sameNameHistory.id);
  const registryCompany = { name: sameNameHistory.name, inn: '9900000024', fullName: 'QA Полное имя клиента из реестра' };
  const registryDialog = await openNew({ inn: registryCompany.inn, name: '' });
  await page.route('**/api/companies/lookup', route => route.fulfill({ json: { company: registryCompany } }));
  await registryDialog.getByRole('button', { name: 'Заполнить из Чекко', exact: true }).click();
  await expect(registryDialog.getByLabel('Наименование', { exact: true })).toHaveValue(registryCompany.name);
  await expect(registryDialog.getByRole('status')).toContainText('заполнены из Чекко');
  await page.unroute('**/api/companies/lookup');
  const registryResponse = await save(registryDialog);
  assert.equal(registryResponse.status(), 201, await registryResponse.text());
  const registryResult = await registryResponse.json(); assert.equal(registryResult.created, true);
  assert.notEqual(registryResult.entry.id, sameNameHistory.id); assert.equal(registryResult.entry.inn, registryCompany.inn);
  assert.deepEqual(registryResult.entry.roles, ['customer']); assert.ok(!registryResult.entry.phone);
  assert.deepEqual(registryResult.entry.shipmentIds, []); assert.deepEqual(registryResult.entry.paymentIds, []);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: `Редактировать: ${registryCompany.name}`, exact: true })).toBeVisible();
  assert.deepEqual((await store.read(source)).companies.find(row => row.id === sameNameHistory.id), historyBefore);
  assert.equal((await snapshot()).companies.length, 6);
  check('Checko-filled new INN client creates beside same-name hidden no-INN history, leaving historical card unchanged (lookup mocked)');

  const registryDuplicate = await openNew(registryCompany), registryDuplicateResponse = await save(registryDuplicate);
  assert.equal(registryDuplicateResponse.status(), 409);
  await expect(registryDuplicate.getByRole('alert')).toContainText('уже');
  assert.equal((await snapshot()).companies.length, 6);
  await registryDuplicate.getByRole('button', { name: 'Отмена', exact: true }).click();
  await registryDuplicate.getByRole('button', { name: 'Не сохранять', exact: true }).click();
  runtime.replaceMiddleware();
  await page.reload(); await expect(page.locator('.directory-record-count')).toHaveText('Записей: 5');
  await expect(page.getByRole('button', { name: `Редактировать: ${registryCompany.name}`, exact: true })).toBeVisible();
  assert.deepEqual((await store.read(source)).companies.find(row => row.id === sameNameHistory.id), historyBefore);
  assert.equal((await snapshot()).companies.find(row => row.id === registryResult.entry.id).inn, registryCompany.inn);
  check('New INN identity rejects duplicate submissions and persists after restart alongside unchanged name-only history');

  const activeNameCollision = await openNew({ name: paymentCounterparty.name, inn: '9900000031' });
  const activeCollisionResponse = await save(activeNameCollision); assert.equal(activeCollisionResponse.status(), 409);
  await expect(activeNameCollision.getByRole('alert')).toContainText('уже');
  assert.equal((await snapshot()).companies.length, 6);
  await activeNameCollision.getByRole('button', { name: 'Отмена', exact: true }).click();
  await activeNameCollision.getByRole('button', { name: 'Не сохранять', exact: true }).click();
  check('An already-active customer without INN still blocks a same-name new INN duplicate');
  await page.screenshot({ path: resolve(output, 'customers-created.png'), fullPage: true });

  await page.getByRole('group', { name: 'Справочники', exact: true }).getByRole('button', { name: 'Товары', exact: true }).click();
  await page.getByRole('button', { name: 'Добавить', exact: true }).click();
  const productDialog = page.getByRole('dialog');
  await productDialog.getByLabel('Название товара', { exact: true }).fill('QA Товар');
  const productResponse = await save(productDialog); assert.equal(productResponse.status(), 200);
  assert.equal((await productResponse.json()).created, false);
  await expect(productDialog.getByRole('alert')).toContainText('Такая запись уже есть');
  check('Other directories retain their existing created:false duplicate handling');
  assert.deepEqual(report.errors, []); assert.deepEqual(report.unexpectedRequests, []);
} catch (error) {
  report.failure = String(error);
  if (page) await page.screenshot({ path: resolve(output, 'failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await browser?.close(); await runtime?.server.close();
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
  await rm(temporary, { recursive: true, force: true });
}
