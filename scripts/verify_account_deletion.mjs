import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { bootstrapQaAuth, authenticateContext } from './qa-auth.mjs';
import { loadSnapshot } from '../server/local-api.ts';
import { OperationsStore } from '../server/operations-store.ts';

// Run with: node --import tsx scripts/verify_account_deletion.mjs (after npm run build).
const root = resolve(import.meta.dirname, '..');
const port = Number(process.env.ARTEL_DELETE_QA_PORT || 5206), base = `http://127.0.0.1:${port}`;
const temporary = await mkdtemp(resolve(tmpdir(), 'artel-account-deletion-'));
const output = resolve(root, 'qa/employee-deletion'); await mkdir(output, { recursive: true });
const localStore = resolve(root, 'data/local-operations/operations.json');
const checksum = async () => existsSync(localStore) ? createHash('sha256').update(await readFile(localStore)).digest('hex') : null;
const before = await checksum();
const report = { checks: [], errors: [], screenshots: [], measurements: [], temporaryStoreRemoved: false, localStoreUnchanged: false, bankSyncEnabled: false };
const check = text => { report.checks.push(text); console.log('PASS', text); };
let server, browser, page;
try {
  assert.ok(existsSync(resolve(root, 'app-dist/index.html')), 'Build the application before running browser QA');
  await assert.rejects(fetch(base, { signal: AbortSignal.timeout(500) }), 'QA port must be unused');
  const source = await loadSnapshot();
  const store = new OperationsStore(temporary);
  await store.mutate(source.provenance.sourceSha256, data => { data.sourceOperationsCleared = true; return { result: null, changed: true }; });
  const environment = { ...process.env, ARTEL_STORE_DIR: temporary, CHECKO_API_KEY: '', ARTEL_BANK_SYNC_ENABLED: 'false', PUSH_SCHEDULE_ENABLED: 'false', VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '' };
  for (const key of Object.keys(environment)) if (key.startsWith('ARTEL_BANK_') && key !== 'ARTEL_BANK_SYNC_ENABLED') environment[key] = '';
  server = spawn(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), 'preview', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: root, env: environment, stdio: 'ignore' });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(base + '/api/auth/session')).ok) { ready = true; break; } } catch {}
    await new Promise(done => setTimeout(done, 100));
  }
  assert.ok(ready, 'Isolated QA server is ready');
  const { cookie, user: director } = await bootstrapQaAuth(base);
  browser = await chromium.launch({ headless: true, executablePath: process.env.ARTEL_QA_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const admin = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  await authenticateContext(admin, base, cookie);
  page = await admin.newPage(); page.on('pageerror', error => report.errors.push(error.message));
  const createEmployee = async (name, login) => {
    const employeeResponse = await admin.request.post(base + '/api/directories', { data: { kind: 'managers', name } });
    assert.equal(employeeResponse.status(), 201);
    const employee = (await employeeResponse.json()).entry;
    const password = randomUUID();
    const response = await admin.request.post(base + '/api/auth/users', { data: { name, login, password, role: 'manager', managerId: employee.id } });
    assert.equal(response.status(), 201);
    return { user: (await response.json()).user, credentials: { login, password }, employee };
  };
  const removed = await createEmployee('Удаление Browser QA', 'deletion-qa');
  const retained = await createEmployee('Другой Browser QA', 'retained-qa');
  const employeeContext = await browser.newContext({ serviceWorkers: 'block' });
  assert.equal((await employeeContext.request.post(base + '/api/auth/login', { data: removed.credentials })).status(), 200);
  const taskResponse = await employeeContext.request.post(base + '/api/work/tasks', { data: { title: 'Открытая задача удаления', comment: 'Автор сохранится', addAttachments: [{ name: 'history.txt', data: Buffer.from('QA history').toString('base64') }] } });
  assert.equal(taskResponse.status(), 201);
  const task = (await taskResponse.json()).entry;
  const noteResponse = await employeeContext.request.post(base + '/api/work/notes', { data: { title: 'Заметка бывшего сотрудника', content: 'История' } });
  assert.equal(noteResponse.status(), 201);
  await page.goto(base + '/#accounts');
  await expect(page.getByRole('heading', { name: 'Учётные записи', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: `Удалить ${director.name}`, exact: true })).toBeDisabled();
  check('Self deletion is disabled in the account list with an explicit explanation');
  const dialog = page.getByRole('dialog', { name: 'Удалить учётную запись?', exact: true });
  const confirm = () => dialog.getByLabel('Имя сотрудника для подтверждения удаления', { exact: true });
  const submit = () => dialog.getByRole('button', { name: 'Удалить учётную запись', exact: true });
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.getByRole('button', { name: `Удалить ${removed.user.name}`, exact: true }).click();
    await expect(dialog).toBeVisible();
    await expect(confirm()).toBeFocused();
    await expect(submit()).toBeDisabled();
    await confirm().fill('Неправильное имя'); await expect(submit()).toBeDisabled();
    await confirm().fill(removed.user.name); await expect(submit()).toBeEnabled();
    const dimensions = await page.evaluate(() => {
      const dialog = document.querySelector('dialog[open]'); const rect = dialog.getBoundingClientRect();
      return { width: innerWidth, documentWidth: document.documentElement.scrollWidth, dialogLeft: rect.left, dialogRight: rect.right, dialogContentWidth: dialog.scrollWidth, dialogWidth: dialog.clientWidth };
    });
    report.measurements.push(dimensions);
    assert.ok(dimensions.documentWidth <= width + 1 && dimensions.dialogLeft >= 0 && dimensions.dialogRight <= width + 1 && dimensions.dialogContentWidth <= dimensions.dialogWidth + 1, `Dialog fits width ${width}`);
    const screenshot = resolve(output, `confirmation-${width}.png`); await page.screenshot({ path: screenshot, fullPage: true }); report.screenshots.push(screenshot);
    if (width === 390) await page.keyboard.press('Escape'); else await dialog.getByRole('button', { name: 'Отмена', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('button', { name: `Удалить ${removed.user.name}`, exact: true })).toBeVisible();
  }
  check('Desktop 1440 and mobile 390/320 dialogs fit without overflow; exact-name gating, focus, cancel and Escape work');
  await page.getByRole('button', { name: `Удалить ${removed.user.name}`, exact: true }).click();
  await confirm().fill(removed.user.name); await submit().click();
  await expect(dialog.getByRole('alert')).toContainText('задачи — 1');
  await expect(dialog.getByRole('alert')).toContainText('передайте их другому сотруднику');
  assert.equal((await employeeContext.request.get(base + '/api/work')).status(), 200);
  const blockedScreenshot = resolve(output, 'active-task-block-320.png'); await page.screenshot({ path: blockedScreenshot, fullPage: true }); report.screenshots.push(blockedScreenshot);
  await dialog.getByRole('link', { name: '«Работа»', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Новая задача', exact: true })).toBeVisible();
  await page.getByRole('button', { name: `Задача: ${task.title}`, exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Задача', exact: true });
  await editor.getByRole('combobox', { name: 'Исполнитель', exact: true }).selectOption(retained.user.id);
  await editor.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(editor).toHaveCount(0);
  check('Open work prevents deletion; the guidance opens Work and the task is handed over through the mobile UI');
  const beforeDeletion = await store.read(source.provenance.sourceSha256);
  await page.goto(base + '/#accounts');
  await page.getByRole('button', { name: `Удалить ${removed.user.name}`, exact: true }).click();
  await confirm().fill(removed.user.name); await submit().click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('status')).toContainText('Учётная запись удалена');
  await expect(page.getByRole('button', { name: `Удалить ${removed.user.name}`, exact: true })).toHaveCount(0);
  assert.equal((await employeeContext.request.get(base + '/api/work')).status(), 401);
  assert.equal((await employeeContext.request.post(base + '/api/auth/login', { data: removed.credentials })).status(), 401);
  const after = await new OperationsStore(temporary).read(source.provenance.sourceSha256);
  assert.deepEqual(after.work, beforeDeletion.work); assert.deepEqual(after.directories, beforeDeletion.directories); assert.deepEqual(after.shipments, beforeDeletion.shipments);
  assert.equal(after.accounts.users.find(user => user.id === removed.user.id).active, false);
  assert.ok(after.accounts.users.find(user => user.id === removed.user.id).deletedAt);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Учётные записи', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: `Удалить ${removed.user.name}`, exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: `Удалить ${retained.user.name}`, exact: true })).toBeVisible();
  check('Deletion succeeds on mobile and persists after reload; old sessions/login fail; manager, other accounts, work history and shipments stay unchanged');
  await page.goto(base + '/#work');
  await page.getByRole('button', { name: `Задача: ${task.title}`, exact: true }).click();
  await expect(editor.locator('.work-comments')).toContainText(removed.user.name);
  await expect(editor.getByRole('link', { name: /history\.txt/ })).toBeVisible();
  await expect(editor.getByRole('combobox', { name: 'Исполнитель', exact: true }).locator(`option[value="${removed.user.id}"]`)).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const historyScreenshot = resolve(output, 'historical-author-1440.png'); await page.screenshot({ path: historyScreenshot, fullPage: true }); report.screenshots.push(historyScreenshot);
  check('Historical comment author and file remain visible while the deleted account is absent from new assignment choices');
  assert.deepEqual(report.errors, []); check('No browser JavaScript errors');
} catch (error) {
  report.errors.push(error.message);
  await page?.screenshot({ path: resolve(output, 'failure.png'), fullPage: true }).catch(() => {});
  throw error;
} finally {
  await browser?.close();
  if (server && server.exitCode === null) { server.kill('SIGTERM'); await new Promise(done => { server.once('exit', done); setTimeout(done, 5000).unref(); }); }
  await rm(temporary, { recursive: true, force: true }); report.temporaryStoreRemoved = !existsSync(temporary);
  report.localStoreUnchanged = before === await checksum();
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
  assert.ok(report.localStoreUnchanged, 'Existing local store must stay unchanged');
}
