// Synthetic China/accounts UI round trips. No working data or external providers.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium, webkit, expect as baseExpect } from '@playwright/test';
import { writeTripsQaSnapshot } from './qa-trips-runtime.mjs';
import { startOperatorQaServer } from './qa-operator-runtime.mjs';
import { authenticateContext } from './qa-auth.mjs';
const root = resolve(import.meta.dirname, '..'), built = process.argv.includes('--built'), popupOnly = process.argv.includes('--popup-only');
const output = resolve(process.env.ARTEL_SECONDARY_QA_OUTPUT || resolve(root, '../ui-secondary'), (built ? 'built' : 'source') + (popupOnly ? '-popup' : ''));
const engines = process.env.ARTEL_SECONDARY_QA_ENGINE ? [process.env.ARTEL_SECONDARY_QA_ENGINE] : ['chromium', 'webkit'];
const expect = baseExpect.configure({ timeout: 20000 });
for (const key of Object.keys(process.env)) if (/^(ARTEL_|SABY_|SBER_|BANK_|VAPID_|PUSH_|CHECKO_|CRON_|BLOB_|VERCEL_)/.test(key)) delete process.env[key];
Object.assign(process.env, { ARTEL_OPERATOR_QA_BUILT: built ? '1' : '0', SABY_WORKFLOW_ENABLED: 'false', ARTEL_CABINET_SYNC_ENABLED: 'false', ARTEL_GEOCODER_ENABLED: 'false', ARTEL_BANK_SYNC_ENABLED: 'false', ARTEL_BANK_REQUESTS_ENABLED: 'false', PUSH_SCHEDULE_ENABLED: 'false' });
const temporary = await mkdtemp(resolve(tmpdir(), 'artel-secondary-ui-'));
await mkdir(output, { recursive: true });
const report = { passed: false, syntheticOnly: true, workingStoreAccessed: false, observations: [], mutations: [], errors: [], externalRequests: [], screenshots: [], gaps: ['China has no delete day/payment or edit payment UI; only the supported actions are tested.', 'Shipment CRUD is covered by the separate domain suite, not this harness.'] };
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => { const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url); if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') { report.externalRequests.push({ source: 'server', origin: url.origin }); return Promise.reject(new Error('External requests forbidden')); } return originalFetch(input, init); };
let runtime, browser, context, page, activeGate = null;
const check = message => { report.observations.push(message); console.log('PASS', message); };
async function shot(name) { const path = resolve(output, name + '.png'); await page.screenshot({ path, fullPage: true }); report.screenshots.push(path); }
async function fits(name) { const size = await page.evaluate(() => ({ width: innerWidth, content: document.documentElement.scrollWidth })); assert.ok(size.content <= size.width + 1, name + ': page overflow ' + JSON.stringify(size)); const dialogs = await page.locator('dialog[open]').evaluateAll(nodes => nodes.map(node => ({ width: node.clientWidth, content: node.scrollWidth }))); assert.ok(dialogs.every(row => row.content <= row.width + 1), name + ': dialog overflow ' + JSON.stringify(dialogs)); }
async function pending(scope, button, path, method, label, fail = false) {
  let release, entered, hits = 0;
  const wait = new Promise(done => { release = done; }), started = new Promise(done => { entered = done; });
  activeGate = { path, method, fail, wait, hit() { hits++; entered(); } };
  const handle = await button.elementHandle();
  try {
    await button.click();
    await Promise.race([started, new Promise((_, reject) => setTimeout(() => reject(new Error(label + ': no request')), 15000))]);
    assert.equal(await handle.evaluate(node => node.matches(':disabled')), true, label + ': submit locked');
    await handle.evaluate(node => node.click());
    report.observations.push({ label, phase: 'before-escape', dialog: await page.locator('dialog').evaluateAll(nodes => nodes.map(node => ({ open: node.open, motion: node.dataset.modalMotion, submitDisabled: node.querySelector('[type=submit]')?.disabled }))) }); await page.keyboard.press('Escape'); report.observations.push({ label, phase: 'after-escape', dialog: await page.locator('dialog').evaluateAll(nodes => nodes.map(node => ({ open: node.open, motion: node.dataset.modalMotion }))) }); await expect(scope).toBeVisible();
    assert.equal(hits, 1, label + ': duplicate request');
    await fits(label);
  } finally { release(); activeGate = null; }
  if (fail) await expect(page.getByRole('alert').filter({ hasText: 'Учебная ошибка' })).toBeVisible();
  else await expect(scope).toHaveCount(0);
  report.mutations.push({ label, method, path, rejected: fail, pendingLocked: true, duplicateRequests: hits - 1 });
}
try {
  const snapshotDirectory = resolve(temporary, 'snapshot'), operationsDirectory = resolve(temporary, 'store');
  await writeTripsQaSnapshot(snapshotDirectory);
  runtime = await startOperatorQaServer({ root, snapshotDirectory, operationsDirectory });
  report.runtime = runtime.mode; report.artifacts = runtime.artifacts;
  const director = await runtime.bootstrap();
  const api = async (path, method = 'GET', body) => { const response = await fetch(runtime.base + path, { method, headers: { Cookie: director.cookie, Origin: runtime.base, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const result = await response.json(); assert.ok(response.ok, `${method} ${path}: ${JSON.stringify(result)}`); return result; };
  const supplierName = 'Учебная нефтебаза «Северо-Западная топливная компания — поставки дизельного топлива»';
  const supplier = (await api('/api/directories', 'POST', { kind: 'companies', name: supplierName, roles: ['supplier'], addresses: [] })).entry;
  let sequence = 0;
  for (const engine of engines) {
    browser = await ({ chromium, webkit })[engine].launch({ headless: true });
    for (const width of [375, 320]) {
      const suffix = `${engine}-${width}`, day = `2026-10-${20 + sequence++}`;
      context = await browser.newContext({ viewport: { width, height: 960 }, reducedMotion: 'reduce', serviceWorkers: 'block', timezoneId: 'Europe/Moscow' });
      await authenticateContext(context, runtime.base, director.cookie);
      await context.addInitScript(() => { if (navigator.serviceWorker) Object.defineProperty(navigator.serviceWorker, 'getRegistration', { configurable: true, value: async () => undefined }); });
      await context.route('**/*', async route => { const url = new URL(route.request().url()); if (url.origin !== runtime.base) { report.externalRequests.push({ source: 'browser', origin: url.origin }); return route.abort(); } const gate = activeGate; if (gate && gate.path === url.pathname && gate.method === route.request().method()) { gate.hit(); await gate.wait; if (gate.fail) return route.fulfill({ status: 422, json: { error: 'Учебная ошибка: действие не выполнено. Ввод сохранён.' } }); } return route.continue(); });
      page = await context.newPage(); page.on('pageerror', error => report.errors.push({ engine, width, message: error.message }));
      await page.goto(runtime.base + '/#china');
      await page.getByRole('button', { name: 'Добавить день', exact: true }).click();
      let dialog = page.locator('dialog[open]');
      await dialog.getByLabel('Дата', { exact: true }).fill(day);
      await dialog.getByRole('combobox', { name: 'Поставщик 1' }).click();
      if (popupOnly) {
        await expect(dialog.getByRole('option', { name: supplierName, exact: true })).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(dialog.getByRole('combobox', { name: 'Поставщик 1' })).toHaveAttribute('aria-expanded', 'false');
        await expect(dialog).toBeVisible(); await expect(dialog.locator('.work-confirm')).toHaveCount(0);
        await page.keyboard.press('Escape'); await expect(dialog.locator('.work-confirm')).toBeVisible();
        await dialog.getByRole('button', { name: 'Продолжить редактирование', exact: true }).click();
        await expect(dialog.getByLabel('Дата', { exact: true })).toHaveValue(day);
        await page.keyboard.press('Escape'); await dialog.getByRole('button', { name: 'Не сохранять', exact: true }).click();
        await expect(dialog).toHaveCount(0); assert.ok(!(await api('/api/china')).china.days.some(row => row.date === day));
        check(suffix + ': first Escape closes combobox only, second Escape asks to discard, continue retains draft, discard writes nothing');
        await context.close(); context = null; continue;
      }
      await dialog.getByRole('option', { name: supplierName, exact: true }).click();
      await dialog.getByLabel('Количество литров 1', { exact: true }).fill('1234,5');
      await dialog.getByLabel('Сумма 1', { exact: true }).fill('76543,21');
      await fits(suffix + '-china-create'); await shot(suffix + '-china-form');
      await pending(dialog, dialog.getByRole('button', { name: 'Сохранить', exact: true }), '/api/china/days', 'POST', suffix + '-china-create-error', true);
      await expect(dialog.getByLabel('Сумма 1', { exact: true })).toHaveValue('76543,21');
      await expect(dialog.getByRole('combobox', { name: 'Поставщик 1' })).toHaveValue(supplierName);
      await pending(dialog, dialog.getByRole('button', { name: 'Сохранить', exact: true }), '/api/china/days', 'POST', suffix + '-china-create');
      let result = await api('/api/china'), created = result.china.days.find(row => row.date === day);
      assert.ok(created); assert.equal(created.fuels[0].supplierId, supplier.id); assert.equal(created.fuels[0].amount, '76543.21');
      await page.getByRole('button', { name: `Открыть день ${day}`, exact: true }).click(); dialog = page.locator('dialog[open]');
      await dialog.getByLabel('Сумма 1', { exact: true }).fill('80000');
      await page.keyboard.press('Escape'); await expect(dialog.locator('.work-confirm')).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Продолжить редактирование', exact: true })).toBeFocused();
      await dialog.getByRole('button', { name: 'Продолжить редактирование', exact: true }).click();
      await expect(dialog.getByLabel('Сумма 1', { exact: true })).toHaveValue('80000');
      await pending(dialog, dialog.getByRole('button', { name: 'Сохранить', exact: true }), '/api/china/days/' + created.id, 'PATCH', suffix + '-china-edit');
      await page.getByRole('button', { name: 'Добавить платёж', exact: true }).click(); dialog = page.locator('dialog[open]');
      await dialog.getByLabel('Дата', { exact: true }).fill(day); await dialog.getByLabel('Сумма платежа', { exact: true }).fill('90000');
      await pending(dialog, dialog.getByRole('button', { name: 'Сохранить', exact: true }), '/api/china/payments', 'POST', suffix + '-china-payment');
      result = await api('/api/china');
      assert.equal(result.china.days.filter(row => row.date === day).length, 1); assert.equal(result.china.days.find(row => row.id === created.id).fuels[0].amount, '80000');
      assert.equal(result.china.payments.filter(row => row.date === day).length, 1); assert.equal(result.china.payments.find(row => row.date === day).amount, '90000');
      check(suffix + ': China create/edit/payment persisted once; rejected save retains input; dirty-close focus/continue');
      await page.goto(runtime.base + '/#accounts');
      await page.getByRole('button', { name: 'Добавить пользователя', exact: true }).click();
      const employeeName = 'Александр Константинович Рождественский-Северный ' + suffix;
      const login = 'qa-secondary-' + suffix;
      await page.getByLabel('Новый сотрудник', { exact: true }).fill(employeeName);
      await page.getByRole('button', { name: 'Добавить сотрудника', exact: true }).click();
      await expect(page.getByLabel('Имя в приложении', { exact: true })).toHaveValue(employeeName);
      await page.getByLabel('Логин', { exact: true }).fill(login); await page.getByLabel('Пароль', { exact: true }).fill(randomUUID());
      await fits(suffix + '-account-create'); await shot(suffix + '-account-form');
      let form = page.locator('.account-form');
      await pending(form, page.getByRole('button', { name: 'Сохранить пользователя', exact: true }), '/api/auth/users', 'POST', suffix + '-account-create-error', true);
      await expect(page.getByLabel('Логин', { exact: true })).toHaveValue(login); await expect(page.getByLabel('Имя в приложении', { exact: true })).toHaveValue(employeeName);
      await pending(form, page.getByRole('button', { name: 'Сохранить пользователя', exact: true }), '/api/auth/users', 'POST', suffix + '-account-create');
      let users = (await api('/api/auth/users')).users; const account = users.find(row => row.login === login); assert.ok(account); assert.equal(users.filter(row => row.login === login).length, 1);
      let row = page.locator('.account-row').filter({ hasText: login });
      await row.getByRole('button', { name: 'Изменить', exact: true }).click();
      const nextName = employeeName + ' — диспетчер';
      await page.getByLabel('Имя в приложении', { exact: true }).fill(nextName);
      await pending(page.locator('.account-form'), page.getByRole('button', { name: 'Сохранить пользователя', exact: true }), '/api/auth/users/' + account.id, 'PATCH', suffix + '-account-edit');
      users = (await api('/api/auth/users')).users; assert.equal(users.find(user => user.id === account.id).name, nextName);
      row = page.locator('.account-row').filter({ hasText: login }); await fits(suffix + '-account-row');
      await row.getByRole('button', { name: 'Удалить ' + nextName, exact: true }).click(); dialog = page.locator('dialog[open]');
      await dialog.getByRole('button', { name: 'Отмена', exact: true }).click(); await expect(dialog).toHaveCount(0);
      assert.ok((await api('/api/auth/users')).users.some(user => user.id === account.id));
      await row.getByRole('button', { name: 'Удалить ' + nextName, exact: true }).click(); dialog = page.locator('dialog[open]');
      await dialog.getByLabel('Имя сотрудника для подтверждения удаления', { exact: true }).fill('Неверное имя'); await expect(dialog.getByRole('button', { name: 'Удалить учётную запись', exact: true })).toBeDisabled();
      await dialog.getByLabel('Имя сотрудника для подтверждения удаления', { exact: true }).fill(nextName);
      await pending(dialog, dialog.getByRole('button', { name: 'Удалить учётную запись', exact: true }), '/api/auth/users/' + account.id, 'DELETE', suffix + '-account-delete-error', true);
      await expect(dialog.getByLabel('Имя сотрудника для подтверждения удаления', { exact: true })).toHaveValue(nextName);
      await pending(dialog, dialog.getByRole('button', { name: 'Удалить учётную запись', exact: true }), '/api/auth/users/' + account.id, 'DELETE', suffix + '-account-delete');
      assert.ok(!(await api('/api/auth/users')).users.some(user => user.id === account.id));
      assert.ok((await api('/api/snapshot')).directories.managers.some(manager => manager.id === account.managerId));
      check(suffix + ': Accounts create/edit/delete persisted once; errors retain inputs; cancel/wrong-name protected; directory employee preserved');
      await context.close(); context = null;
    }
    await browser.close(); browser = null;
  }
  assert.deepEqual(report.errors, []); assert.deepEqual(report.externalRequests, []); report.passed = true;
} catch (error) { report.failure = { message: error.message, stack: error.stack }; if (page && !page.isClosed()) await shot('failure'); throw error; }
finally { await context?.close(); await browser?.close(); await runtime?.server.close(); globalThis.fetch = originalFetch; await rm(temporary, { recursive: true, force: true }); report.temporaryStoreRemoved = true; await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ passed: report.passed, mutations: report.mutations.length, report: resolve(output, 'report.json') })); }
