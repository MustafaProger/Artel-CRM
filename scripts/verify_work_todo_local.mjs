import { chromium, expect } from '@playwright/test';
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
  const task = (await api('/api/work/tasks', 'POST', {
    title: 'Проверка редактора', dueDate: '2026-11-09', subtasks: [{ id: randomUUID(), title: 'Подзадача', done: false }],
  })).entry;

  browser = await chromium.launch({ headless: true, executablePath: process.env.ARTEL_QA_CHROMIUM });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
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
  await expect(dialog.getByText('Комментарии')).toHaveCount(0);
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
  const assigneeChoice = created.getByRole('combobox', { name: 'Исполнитель *' });
  await assigneeChoice.click();
  await expect(created.getByRole('listbox', { name: 'Исполнитель *' })).toBeVisible();
  await assigneeChoice.press('Escape');
  await expect(created.getByRole('listbox', { name: 'Исполнитель *' })).toHaveCount(0);
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
  await mobileDialog.screenshot({ path: '/tmp/artel-work-task-mobile-preview.png' });
  await mobileDialog.getByRole('button', { name: 'Закрыть рабочую запись' }).click();
  await expect(mobileDialog).toHaveCount(0);
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

  const latest = (await api('/api/work')).work.tasks.find(row => row.id === task.id);
  const payload = Buffer.alloc(3 * 1024 * 1024, 65).toString('base64');
  const withFile = (await api(`/api/work/tasks/${task.id}`, 'PATCH', {
    version: latest.version, addAttachments: [{ name: 'three-megabytes.txt', data: payload }],
  })).entry;
  assert.equal(withFile.attachments[0].size, 3 * 1024 * 1024);
  assert.deepEqual(errors, []);
  console.log('PASS Work editor on desktop and mobile, priority, subtasks, attachments, archive and restoration');
} finally {
  await browser?.close();
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await new Promise(done => { server.once('exit', done); setTimeout(done, 5000); });
  }
  await rm(store, { recursive: true, force: true });
}
