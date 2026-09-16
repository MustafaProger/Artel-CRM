import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { bootstrapQaAuth, authenticateContext } from './qa-auth.mjs';
import { loadSnapshot } from '../server/local-api.ts';
import { OperationsStore } from '../server/operations-store.ts';
const root = resolve(import.meta.dirname, '..'), port = 5198, base = `http://127.0.0.1:${port}`;
const temporary = await mkdtemp(resolve(tmpdir(), 'artel-employee-ui-'));
const output = resolve(root, 'qa/employee-access'); await mkdir(output, { recursive: true });
const workingSnapshot = async () => {
  const { data } = JSON.parse(await readFile(resolve(root, 'data/local-operations/operations.json'), 'utf8'));
  // Ignore the separately running scheduler's timestamp; keep every record and account in the guard.
  delete data.revision; if (data.push) delete data.push.lastRunAt;
  return data;
};
const checksum = data => createHash('sha256').update(JSON.stringify(data)).digest('hex');
const before = await workingSnapshot(), report = { checks: [], errors: [], overflows: [], screenshots: [], workingStoreContentUnchangedIgnoringHeartbeat: false, changedWorkingStoreKeys: [] };
const check = text => { report.checks.push(text); console.log('PASS', text); };
let server, browser, testPage;
try {
  await assert.rejects(fetch(base, { signal: AbortSignal.timeout(500) }));
  const source = await loadSnapshot();
  await new OperationsStore(temporary).mutate(source.provenance.sourceSha256, data => { data.sourceOperationsCleared = true; return { result: null, changed: true }; });
  server = spawn(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), 'preview', '--port', String(port), '--strictPort'], { cwd: root, env: { ...process.env, ARTEL_STORE_DIR: temporary, CHECKO_API_KEY: '', VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '' }, stdio: 'ignore' });
  for (let attempt = 0; attempt < 100; attempt++) { try { if ((await fetch(base + '/api/auth/session')).ok) break; } catch {} await new Promise(done => setTimeout(done, 100)); }
  const { cookie } = await bootstrapQaAuth(base);
  browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const admin = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  await authenticateContext(admin, base, cookie);
  const page = await admin.newPage(); testPage = page; page.on('pageerror', e => report.errors.push(e.message));
  await page.goto(base + '/#accounts');
  await expect(page.getByRole('heading', { name: 'Учётные записи', exact: true })).toBeVisible();
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
    for (const title of ['Обзор', 'Работа', 'Склад', 'Операторская', 'ЗП', 'Справочники']) await page.getByRole('checkbox', { name: title, exact: true }).uncheck();
    await expect(page.locator('.account-section-grid input')).toHaveCount(9);
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
  check('Administrator creates an employee and links an existing employee through the UI; all nine permissions are individually configurable; desktop and mobile forms save');
  const users = (await (await admin.request.get(base + '/api/auth/users')).json()).users.filter(user => user.role === 'manager');
  const snap = await (await admin.request.get(base + '/api/snapshot')).json();
  const directory = snap.directories;
  assert.equal(directory.managers.filter(row => row.name === 'Зуфар Browser QA').length, 1);
  const shipments = [];
  for (const [index, user] of users.entries()) {
    const response = await admin.request.post(base + '/api/shipments', { data: { fields: { shipment_type: 'azs', document_number: index ? 'ZUFAR-ONLY' : 'AIDAR-ONLY', date: '2026-09-01', customer_id: snap.companies[0].id, supplier_id: snap.companies[1].id, manager_id: user.managerId, product_id: directory.products[0].id, payment_form_id: directory.paymentForms.find(p => p.name === 'б/нал').id, quantity_litres: '1000', customer_amount: index ? '777777' : '100000', purchase_amount: '80000' } } });
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
    for (const id of ['overview', 'work', 'china', 'stock', 'payments', 'operator', 'payroll', 'directories', 'accounts']) {
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
  if (server && server.exitCode === null) { server.kill('SIGTERM'); await new Promise(done => server.once('exit', done)); }
  await rm(temporary, { recursive: true, force: true });
  const after = await workingSnapshot();
  report.workingStoreContentUnchangedIgnoringHeartbeat = checksum(before) === checksum(after);
  report.changedWorkingStoreKeys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
  await writeFile(resolve(output, 'browser.json'), JSON.stringify(report, null, 2));
  assert.equal(report.workingStoreContentUnchangedIgnoringHeartbeat, true, `Working store changed during isolated QA: ${report.changedWorkingStoreKeys.join(', ')}`);
}
