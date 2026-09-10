import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const port = Number(process.env.ARTEL_AUTH_QA_PORT || 5193), base = `http://127.0.0.1:${port}`;
const output = resolve(root, 'qa/navigation-auth');
await mkdir(output, { recursive: true });
const temporary = await mkdtemp(resolve(tmpdir(), 'artel-auth-browser-'));
const live = resolve(root, 'data/local-operations/operations.json');
const checksum = async () => existsSync(live) ? createHash('sha256').update(await readFile(live)).digest('hex') : null;
const before = await checksum();
const report = { checks: [], screenshots: [], errors: [], overflows: [], measurements: [], temporaryStoreRemoved: false, liveStoreUnchanged: false, serverMode: 'vite preview, built application' };
const check = name => { report.checks.push(name); console.log('PASS', name); };
let server, browser;
try {
  await assert.rejects(fetch(base, { signal: AbortSignal.timeout(500) }), 'QA port must be unused');
  server = spawn(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: root, env: { ...process.env, ARTEL_STORE_DIR: temporary, CHECKO_API_KEY: '' }, stdio: 'ignore' });
  for (let retry = 0; retry < 100; retry++) { try { if ((await fetch(`${base}/api/auth/session`)).ok) break; } catch {} await new Promise(done => setTimeout(done, 100)); }
  browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const page = await context.newPage(); page.on('pageerror', error => report.errors.push(error.message));
  const measure = async (name, width) => {
    const row = await page.evaluate(() => ({ width: innerWidth, documentWidth: document.documentElement.scrollWidth }));
    const path = resolve(output, `${name}-${width}.png`); await page.screenshot({ path, fullPage: true }); report.screenshots.push(path);
    report.measurements.push({ name, ...row });
    if (row.documentWidth > width + 1) report.measurements.push({ overflow: await page.locator('body *').evaluateAll(elements => elements.map(element => ({ tag: element.tagName, class: element.className, rect: element.getBoundingClientRect().toJSON() })).filter(row => row.rect.right > innerWidth + 1 && row.rect.width > 0).slice(0, 20)) });
    if (row.documentWidth > width + 1) report.overflows.push({ name, ...row });
  };
  const widths = [1440, 768, 390, 320];
  await page.goto(base);
  await expect(page.getByRole('heading', { name: 'Первый вход', exact: true })).toBeVisible();
  for (const width of widths) { await page.setViewportSize({ width, height: 1000 }); await measure('first-login', width); }
  const directorPassword = randomUUID(), managerPassword = randomUUID();
  await page.getByLabel('Имя', { exact: true }).fill('Директор интерфейс QA');
  await page.getByLabel('Логин', { exact: true }).fill('navigation-director');
  await page.getByLabel('Пароль', { exact: true }).fill(directorPassword);
  await page.getByRole('button', { name: 'Создать директора', exact: true }).click();
  await expect(page.locator('.blank-workspace')).toBeVisible();
  assert.equal((await context.request.get(`${base}/api/auth/session`).then(response => response.json())).user.role, 'director');
  check('First director created through the UI; authenticated session persists');
  await page.setViewportSize({ width: 1440, height: 1000 });
  const labels = await page.getByRole('navigation', { name: 'Основная навигация' }).getByRole('button').allTextContents();
  assert.deepEqual(labels.slice(0, 2), ['Обзор', 'Работа']);
  await expect(page.getByRole('button', { name: 'Проверка данных', exact: true })).toHaveCount(0);
  for (const [id, title] of [['overview', 'Обзор'], ['stock', 'Склад']]) {
    await page.goto(`${base}/#${id}`);
    const space = page.getByRole('region', { name: `${title}: рабочее пространство`, exact: true });
    await expect(space).toBeVisible(); await expect(space).toBeEmpty();
    await expect(page.locator('.page-content table,.page-content canvas,.page-content svg,.page-content .panel')).toHaveCount(0);
    for (const width of widths) { await page.setViewportSize({ width, height: 1000 }); await measure(`blank-${id}`, width); }
  }
  await page.goto(`${base}/#china`);
  await expect(page.getByRole('heading', { name: 'Артель Китай', exact: true })).toBeVisible();
  await expect(page.getByText('Баланс: расчёт не настроен', { exact: true })).toBeVisible();
  for (const width of widths) { await page.setViewportSize({ width, height: 1000 }); await measure('china', width); }
  await page.goto(`${base}/#operator`);
  await expect(page.getByRole('region', { name: 'Операторская: рабочее пространство', exact: true })).toContainText('Excel-файл с системой учёта не предоставлен');
  for (const width of widths) { await page.setViewportSize({ width, height: 1000 }); await measure('operator', width); }
  check('Overview and Warehouse are empty; China accounting and Operator missing-file notice are visible; navigation is correct');
  await page.goto(`${base}/#payroll`);
  for (const title of ['Зарплаты водителей', 'Зарплаты менеджеров']) {
    const tab = page.getByRole('tab', { name: title, exact: true }); await tab.click(); await expect(tab).toHaveAttribute('aria-selected', 'true'); await expect(page.getByRole('tabpanel', { name: title, exact: true })).toBeEmpty();
  }
  for (const width of widths) { await page.setViewportSize({ width, height: 1000 }); await measure('payroll', width); }
  check('Salary has separate driver and manager tabs with empty panels and no invented calculations');
  await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto(`${base}/#team`);
  await expect(page.getByRole('heading', { name: 'Учётные записи', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Роли команды', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Добавить пользователя', exact: true }).click();
  const form = page.locator('.account-form');
  await form.getByLabel('Имя', { exact: true }).fill('Менеджер интерфейс QA');
  await form.getByLabel('Логин', { exact: true }).fill('navigation-manager');
  await form.getByLabel('Пароль', { exact: true }).fill(managerPassword);
  await form.getByRole('combobox', { name: /^Роль/ }).selectOption('manager');
  const managerId = await form.getByRole('combobox', { name: /^Сотрудник справочника/ }).locator('option').nth(1).getAttribute('value');
  await form.getByRole('combobox', { name: /^Сотрудник справочника/ }).selectOption(managerId);
  await form.getByRole('button', { name: 'Сохранить пользователя', exact: true }).click();
  await expect(page.locator('.account-row').filter({ hasText: 'Менеджер интерфейс QA' })).toBeVisible();
  await page.reload();
  await expect(page.locator('.team-stat').filter({ hasText: 'Действующие пользователи' }).locator('strong')).toHaveText('2 пользователей');
  for (const width of widths) { await page.setViewportSize({ width, height: 1000 }); await measure('team-director', width); }
  check('Director creates a manager with directory association in AccountManagement; real active-user count is 2');
  await page.getByRole('button', { name: 'Выйти', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Вход', exact: true })).toBeVisible();
  assert.equal((await context.request.get(`${base}/api/snapshot`)).status(), 401);
  for (const width of widths) { await page.setViewportSize({ width, height: 1000 }); await measure('login', width); }
  await page.getByLabel('Логин', { exact: true }).fill('navigation-manager');
  await page.getByLabel('Пароль', { exact: true }).fill(managerPassword);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Роли команды', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Добавить пользователя', exact: true })).toHaveCount(0);
  await expect(page.locator('.account-panel')).toHaveCount(0);
  assert.equal((await context.request.get(`${base}/api/auth/session`).then(response => response.json())).user.role, 'manager');
  check('UI logout revokes previous session; manager login succeeds and account-management controls are hidden');
  await page.goto(`${base}/#directories`);
  await expect(page.locator('.directory-record').first()).toBeVisible();
  for (const button of ['Добавить', 'Удалить']) await expect(page.locator('.directories-page').getByRole('button', { name: button, exact: true })).toHaveCount(0);
  await expect(page.locator('.directory-delete')).toHaveCount(0);
  await expect(page.locator('.directory-record-open').first()).toBeDisabled();
  const managerData = await context.request.get(`${base}/api/snapshot`).then(response => response.json());
  const company = managerData.companies[0];
  assert.equal((await context.request.post(`${base}/api/directories`, { data: { kind: 'products', name: 'Нельзя создать' } })).status(), 403);
  assert.equal((await context.request.patch(`${base}/api/directories/companies/${company.id}`, { data: { version: company.version ?? 0, name: 'Нельзя изменить' } })).status(), 403);
  assert.equal((await context.request.delete(`${base}/api/directories/companies/${company.id}`, { data: { version: company.version ?? 0 } })).status(), 403);
  assert.equal((await context.request.post(`${base}/api/auth/users`, { data: { name: 'Недопустимый пользователь' } })).status(), 403);
  for (const width of widths) { await page.setViewportSize({ width, height: 1000 }); await measure('directories-manager', width); }
  check('Manager directory writes and account creation are blocked server-side with 403; add/delete hidden and editing disabled');
  await page.setViewportSize({ width: 320, height: 1000 });
  await page.getByRole('button', { name: 'Открыть меню', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Меню разделов', exact: true })).toBeVisible();
  await page.getByRole('dialog', { name: 'Меню разделов', exact: true }).getByRole('button', { name: 'Работа', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Новая задача', exact: true })).toBeEnabled();
  await expect(page.getByRole('dialog', { name: 'Меню разделов', exact: true })).toHaveCount(0);
  check('Mobile navigation opens and closes correctly when selecting Work');
  assert.deepEqual(report.errors, []); check('No browser JavaScript errors');
  assert.deepEqual(report.overflows, []); check('All checked screens fit 1440/768/390/320 without horizontal overflow');
} finally {
  await browser?.close();
  if (server && server.exitCode === null) { server.kill('SIGTERM'); await new Promise(done => { server.once('exit', done); setTimeout(done, 5000); }); }
  await rm(temporary, { recursive: true, force: true }); report.temporaryStoreRemoved = !existsSync(temporary);
  report.liveStoreUnchanged = before === await checksum();
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
  assert.ok(report.liveStoreUnchanged, 'Live operations store must be unchanged');
}
