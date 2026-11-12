import { chromium, webkit, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const store = await mkdtemp(resolve(tmpdir(), 'artel-work-local-'));
const port = 5193;
const base = `http://127.0.0.1:${port}`;
let server, browser;

try {
  server = spawn(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: root, env: { ...process.env, ARTEL_STORE_DIR: store, CHECKO_API_KEY: '' }, stdio: 'ignore',
  });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { ready = (await fetch(`${base}/api/auth/session`)).ok; if (ready) break; } catch {}
    await new Promise(done => setTimeout(done, 100));
  }
  assert.ok(ready, 'local server started');
  const password = randomUUID();
  const setup = await fetch(`${base}/api/auth/setup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login: 'todo-qa', name: 'Директор QA', password }),
  });
  assert.equal(setup.status, 200);
  const cookie = setup.headers.get('set-cookie').split(';')[0];
  const api = async (path, method = 'GET', body) => {
    const response = await fetch(base + path, {
      method, headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const result = await response.json();
    assert.ok(response.ok, JSON.stringify(result));
    return result;
  };
  const createUser = async (name, login) => {
    const manager = (await api('/api/directories', 'POST', { kind: 'managers', name })).entry;
    return (await api('/api/auth/users', 'POST', { name, login, password, role: 'manager', managerId: manager.id })).user;
  };
  const zhenya = await createUser('Женя QA', 'zhenya-qa');
  const egor = await createUser('Егор QA', 'egor-qa');
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format();
  const longDescription = Array.from({ length: 7 }, (_, index) => `${index + 1}. Проверить реквизиты получателя и сумму по отгрузке перед печатью УПД.`).join('\n\n');
  const task = (await api('/api/work/tasks', 'POST', {
    title: 'Проверка редактора', dueDate: '2026-11-09', subtasks: [{ id: randomUUID(), title: 'Подзадача', done: false }],
  })).entry;

  const useWebkit = process.argv.includes('--webkit');
  browser = await (useWebkit ? webkit : chromium).launch({ headless: true, executablePath: process.env.ARTEL_QA_CHROMIUM });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', ...(useWebkit ? { serviceWorkers: 'block' } : {}) });
  await context.request.post(`${base}/api/auth/login`, { data: { login: 'todo-qa', password } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/#work`);
  await expect(page.getByRole('button', { name: 'Канбан', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Задача: Проверка редактора' })).not.toContainText('Срок');
  await page.getByRole('button', { name: 'Задача: Проверка редактора' }).click();
  const dialog = page.getByRole('dialog', { name: 'Задача' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Срок задачи')).toHaveValue('2026-11-09');
  await expect(dialog.getByRole('button', { name: 'Отмена' })).toHaveCount(0);
  await expect(dialog.getByText('•••')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Комментарии', exact: true })).toBeVisible();
  await expect(dialog.getByText('Добавить файл', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Удалить', exact: true })).toBeVisible();
  const subtask = dialog.getByRole('textbox', { name: 'Название подзадачи 1' });
  assert.equal(await subtask.evaluate(element => getComputedStyle(element).borderTopWidth), '0px');
  await dialog.getByRole('textbox', { name: 'Название', exact: true }).fill('Черновик без сохранения');
  await dialog.getByRole('button', { name: 'Закрыть рабочую запись' }).click();
  await expect(dialog).toHaveCount(0);
  assert.equal((await api('/api/work')).work.tasks.find(row => row.id === task.id).title, 'Проверка редактора');

  await page.getByRole('button', { name: 'Новая задача', exact: true }).click();
  const created = page.getByRole('dialog', { name: 'Новая задача' });
  await expect(created).toBeVisible();
  await expect(page.getByRole('form', { name: 'Новая задача' })).toHaveCount(0);
  await expect(created.getByText('Добавить файл', { exact: true })).toBeVisible();
  await created.getByRole('button', { name: 'Добавить подзадачу' }).click();
  await created.getByRole('textbox', { name: 'Название подзадачи 1' }).fill('Первый шаг');
  await created.getByRole('textbox', { name: 'Название', exact: true }).fill('Новая задача QA');
  const assigneeChoice = created.getByRole('combobox', { name: 'Исполнители' });
  await assigneeChoice.click();
  await expect(created.getByRole('listbox', { name: 'Исполнители' })).toBeVisible();
  await created.getByRole('option', { name: zhenya.name }).click();
  await created.getByRole('option', { name: egor.name }).click();
  await expect(created.getByRole('option', { name: zhenya.name })).toHaveAttribute('aria-selected', 'true');
  await assigneeChoice.press('Escape');
  await expect(created.getByRole('listbox', { name: 'Исполнители' })).toHaveCount(0);
  await created.getByLabel('Срок задачи').fill(today);
  await created.getByRole('textbox', { name: 'Описание' }).fill(longDescription);
  const priorityChoice = created.getByRole('combobox', { name: 'Приоритет' });
  await priorityChoice.click();
  await expect(created.getByRole('listbox', { name: 'Приоритет' })).toBeVisible();
  await expect(created.getByRole('option', { name: 'P4 · Обычный' })).toBeInViewport();
  await created.screenshot({ path: '/tmp/artel-work-priority-menu-preview.png' });
  await created.getByRole('option', { name: 'P1 · Срочно' }).click();
  await expect(priorityChoice).toContainText('P1 · Срочно');
  await created.screenshot({ path: '/tmp/artel-work-new-task-preview.png' });
  await created.getByRole('button', { name: 'Сохранить' }).click();
  await expect(created).toHaveCount(0);
  const priorityTask = (await api('/api/work')).work.tasks.find(row => row.title === 'Новая задача QA');
  assert.equal(priorityTask.subtasks[0].title, 'Первый шаг');
  assert.equal(priorityTask.priority, 1);
  assert.deepEqual(priorityTask.assigneeIds, [zhenya.id, egor.id]);
  const sidebarCount = page.getByRole('navigation', { name: 'Основная навигация' }).getByRole('button', { name: 'Работа', exact: true }).locator('small');
  await expect(sidebarCount).toHaveText('1');
  const priorityCheck = page.getByRole('checkbox', { name: 'Выполнена: Новая задача QA' });
  await expect(priorityCheck).toBeVisible();
  assert.deepEqual(await priorityCheck.locator('xpath=following-sibling::span').evaluate(element => { const style = getComputedStyle(element); return [style.borderTopColor, style.borderRadius]; }), ['rgb(240, 91, 91)', '7px']);
  await page.getByRole('button', { name: 'Задача: Новая задача QA' }).click();
  await expect(page.getByRole('dialog', { name: 'Задача' }).getByRole('combobox', { name: 'Приоритет' })).toContainText('P1 · Срочно');
  await page.getByRole('dialog', { name: 'Задача' }).getByRole('button', { name: 'Закрыть рабочую запись' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Задача: Новая задача QA' }).click();
  const mobileDialog = page.getByRole('dialog', { name: 'Задача' });
  await expect(mobileDialog.getByRole('combobox', { name: 'Приоритет' })).toBeVisible();
  const description = mobileDialog.getByRole('textbox', { name: 'Описание' });
  await expect(description).toHaveValue(longDescription);
  await description.focus();
  await expect(description).toHaveCSS('border-top-width', '0px');
  await expect(description.locator('..')).toHaveCSS('outline-style', 'none');
  assert.ok(await description.evaluate(element => element.scrollHeight <= element.clientHeight + 1), 'all description lines fit in the editor');
  const commentsButton = mobileDialog.getByRole('button', { name: 'Комментарии' });
  const handoffButton = mobileDialog.getByRole('button', { name: 'Передать задачу' });
  const commentField = mobileDialog.getByRole('textbox', { name: 'Новый комментарий' });
  const handoffField = mobileDialog.getByRole('textbox', { name: 'Комментарий к передаче' });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await commentsButton.click();
  await commentField.fill('УПД подготовлен.');
  await handoffButton.click();
  await expect(commentField).toHaveCount(0);
  await handoffField.fill('Черновик передачи');
  await commentsButton.click();
  await expect(commentField).toHaveValue('УПД подготовлен.');
  await commentsButton.click();
  await expect(commentField).toHaveCount(0);
  await handoffButton.click();
  await expect(handoffField).toHaveValue('Черновик передачи');
  await commentsButton.click();
  await mobileDialog.getByRole('button', { name: 'Отправить комментарий' }).click();
  await expect(mobileDialog.getByText('УПД подготовлен.', { exact: true })).toBeVisible();
  await expect(mobileDialog.locator('article time')).toHaveAttribute('datetime', /^\d{4}-/);
  await expect(mobileDialog.getByText('Директор QA', { exact: true })).toBeVisible();
  await mobileDialog.screenshot({ path: '/tmp/artel-work-task-mobile-preview.png' });
  await mobileDialog.getByRole('button', { name: 'Закрыть рабочую запись' }).click();
  await expect(mobileDialog).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const toggle = async () => {
    const [response] = await Promise.all([
      page.waitForResponse(response => response.url().endsWith('/api/work/tasks/' + priorityTask.id) && response.request().method() === 'PATCH'),
      priorityCheck.click(),
    ]);
    assert.equal(response.status(), 200);
  };
  await toggle();
  await expect(priorityCheck).toHaveCount(0);
  await page.getByRole('button', { name: 'Архив задач', exact: true }).click();
  await expect(priorityCheck).toBeChecked();
  await toggle();
  await expect(priorityCheck).toHaveCount(0);
  await page.getByRole('button', { name: 'Задачи', exact: true }).click();
  await expect(priorityCheck).toBeVisible();
  await expect(priorityCheck).not.toBeChecked();

  const zhenyaContext = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', ...(useWebkit ? { serviceWorkers: 'block' } : {}) });
  const egorContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', ...(useWebkit ? { serviceWorkers: 'block' } : {}) });
  for (const [userContext, login] of [[zhenyaContext, 'zhenya-qa'], [egorContext, 'egor-qa']]) {
    assert.ok((await userContext.request.post(`${base}/api/auth/login`, { data: { login, password } })).ok());
  }
  const sender = await zhenyaContext.newPage();
  await sender.goto(`${base}/#work`);
  const senderTask = sender.getByRole('button', { name: 'Задача: Новая задача QA' });
  const senderDialog = sender.getByRole('dialog', { name: 'Задача' });
  await senderTask.click();
  await senderDialog.getByRole('button', { name: 'Не выполнена', exact: true }).click();
  await expect(senderTask).toHaveCount(0);
  await sender.getByRole('button', { name: 'Архив задач', exact: true }).click();
  await expect(senderTask).toContainText('Не выполнена');
  await senderTask.click();
  await expect(senderDialog.getByRole('button', { name: 'Вернуть в работу' })).toBeVisible();
  await senderDialog.getByRole('button', { name: 'Передать задачу' }).click();
  await senderDialog.getByRole('checkbox', { name: egor.name }).check();
  await senderDialog.getByRole('textbox', { name: 'Комментарий к передаче' }).fill('Егор, распечатай УПД.');
  await senderDialog.getByRole('button', { name: 'Передать', exact: true }).click();
  await expect(senderDialog).toHaveCount(0);
  await expect(sender.getByRole('button', { name: 'Задача: Новая задача QA' })).toBeVisible();

  const receiver = await egorContext.newPage();
  await receiver.goto(`${base}/#work`);
  await expect(receiver.getByRole('button', { name: 'Работа', exact: true }).locator('small')).toHaveText('1');
  await receiver.getByRole('button', { name: 'Задача: Новая задача QA' }).click();
  const receiverDialog = receiver.getByRole('dialog', { name: 'Задача' });
  await receiverDialog.getByRole('button', { name: 'Комментарии' }).click();
  await expect(receiverDialog.getByText('Егор, распечатай УПД.', { exact: true })).toBeVisible();
  await expect(receiverDialog.getByRole('region', { name: 'Комментарии' }).getByText(zhenya.name, { exact: true })).toBeVisible();
  await expect(receiverDialog.getByText(`Передано · ${egor.name}`)).toBeVisible();
  await expect(receiverDialog.locator('.work-activity-list article p')).toHaveText(['Егор, распечатай УПД.', 'УПД подготовлен.']);
  await receiverDialog.getByRole('button', { name: 'Закрыть рабочую запись' }).click();
  await receiver.getByRole('checkbox', { name: 'Выполнена: Новая задача QA' }).click();
  await expect(receiver.getByRole('button', { name: 'Работа', exact: true }).locator('small')).toHaveText('0');

  const latest = (await api('/api/work')).work.tasks.find(row => row.id === task.id);
  const payload = Buffer.alloc(3 * 1024 * 1024, 65).toString('base64');
  const withFile = (await api(`/api/work/tasks/${task.id}`, 'PATCH', {
    version: latest.version, addAttachments: [{ name: 'three-megabytes.txt', data: payload }],
  })).entry;
  assert.equal(withFile.attachments[0].size, 3 * 1024 * 1024);
  assert.deepEqual(errors, []);
  console.log('PASS Work editor on desktop and mobile, full description, multiple assignees, animated panels, drafts, task outcomes, archive handoff, today count and attachments');
} finally {
  await browser?.close();
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await new Promise(done => { server.once('exit', done); setTimeout(done, 5000); });
  }
  await rm(store, { recursive: true, force: true });
}
