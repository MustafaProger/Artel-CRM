import { chromium, webkit, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

// Browser regression for the saved reminder instant and notification links.
// Only a temporary local store is used; Web Push and external requests are disabled.
const root = resolve(import.meta.dirname, '..');
assert.ok(!process.env.ARTEL_NOTIFICATION_QA_BROWSER || ['chromium', 'webkit'].includes(process.env.ARTEL_NOTIFICATION_QA_BROWSER), 'ARTEL_NOTIFICATION_QA_BROWSER must be chromium or webkit');
const folder = await mkdtemp(resolve(tmpdir(), 'artel-task-notifications-'));
const probe = createServer();
await new Promise((done, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', done); });
const port = probe.address().port;
await new Promise((done, reject) => probe.close(error => error ? reject(error) : done()));
const origin = `http://127.0.0.1:${port}`;
const password = randomUUID(), login = 'task-notifications-qa';
const day = `${new Date().getUTCFullYear() + 1}-06-17`;
const preciseReminder = `${day}T09:30:45.123Z`;
const browserErrors = [], browsers = [];
let server, serverOutput = '';

async function json(response, status = 200) {
  assert.equal(response.status(), status, await response.text());
  return response.json();
}

try {
  server = spawn(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), '--port', String(port), '--strictPort'], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ARTEL_STORE_DIR: folder, VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '', VAPID_SUBJECT: '', PUSH_SCHEDULE_ENABLED: 'false' },
  });
  for (const stream of [server.stdout, server.stderr]) stream.on('data', chunk => { serverOutput = (serverOutput + chunk).slice(-8000); });
  await expect.poll(async () => {
    if (server.exitCode !== null) throw new Error(`Temporary server exited: ${serverOutput}`);
    try { return (await fetch(`${origin}/api/auth/session`, { signal: AbortSignal.timeout(1000) })).status; }
    catch { return 0; }
  }, { timeout: 30000, intervals: [100, 250, 500] }).toBe(200);
  const setup = await fetch(`${origin}/api/auth/setup`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login, name: 'Task notification QA', password }),
  });
  assert.equal(setup.status, 200, await setup.text());

  const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const chromiumOptions = !existsSync(chromium.executablePath()) && existsSync(chromePath) ? { executablePath: chromePath } : {};
  for (const [name, browserType, options] of [['chromium', chromium, chromiumOptions], ['webkit', webkit, {}]]) {
    if (process.env.ARTEL_NOTIFICATION_QA_BROWSER && process.env.ARTEL_NOTIFICATION_QA_BROWSER !== name) continue;
    console.log(`RUN ${name}: isolated notification form regression`);
    const browser = await browserType.launch({ headless: true, ...options });
    browsers.push(browser);
    // This covers form persistence, not push transport; blocked workers also keep
    // WebKit's localhost service worker registration from stalling the UI run.
    const context = await browser.newContext({ locale: 'ru-RU', timezoneId: 'Europe/Moscow', viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    const session = await json(await context.request.post(`${origin}/api/auth/login`, { data: { login, password } }));
    assert.equal((await json(await context.request.get(`${origin}/api/push/config`))).enabled, false, 'Push must remain disabled');
    const page = await context.newPage();
    page.on('pageerror', error => { browserErrors.push(`${name}: ${error.message}`); console.error(`${name} browser error: ${error.message}`); });
    const dialog = page.getByRole('dialog');
    const pass = message => console.log(`PASS ${name}: ${message}`);
    const openEntry = async (kind, entry) => {
      await page.goto(`${origin}/?workKind=${kind}&workId=${encodeURIComponent(entry.id)}#work`);
      await expect(dialog).toBeVisible();
      await expect(dialog.getByLabel(kind === 'tasks' ? 'Название' : 'Текущий вопрос', { exact: true })).toHaveValue(kind === 'tasks' ? entry.title : entry.question);
      await expect(page).toHaveURL(`${origin}/#work`);
    };
    const save = async (kind, method, button = 'Сохранить') => {
      const pending = page.waitForResponse(response => {
        const path = new URL(response.url()).pathname;
        return response.request().method() === method && (method === 'POST' ? path === `/api/work/${kind}` : path.startsWith(`/api/work/${kind}/`));
      });
      await dialog.getByRole('button', { name: button, exact: true }).click();
      const response = await pending;
      const result = await json(response, method === 'POST' ? 201 : 200);
      await expect(dialog).toHaveCount(0);
      return { entry: result.entry, sent: response.request().postDataJSON() };
    };
    const persisted = async (kind, id) => {
      const result = await json(await context.request.get(`${origin}/api/work`));
      return result.work[kind === 'tasks' ? 'tasks' : 'companyRecords'].find(entry => entry.id === id);
    };

    await page.goto(`${origin}/#work`);
    await expect(page.getByRole('button', { name: 'Новая задача', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Новая задача', exact: true }).click();
    await dialog.getByLabel('Название', { exact: true }).fill(`Напомнить себе ${name}`);
    await expect(dialog.getByLabel('Исполнитель', { exact: true })).toHaveValue(session.user.id);
    await dialog.getByLabel('Напоминание', { exact: true }).fill(`${day}T12:30`);
    const self = await save('tasks', 'POST');
    assert.equal(self.entry.assigneeId, session.user.id);
    assert.equal(self.entry.createdBy, session.user.id);
    assert.equal(self.sent.reminderAt, `${day}T09:30:00.000Z`);
    assert.equal((await persisted('tasks', self.entry.id)).reminderAt, `${day}T09:30:00.000Z`);
    pass('self-assigned reminder saves local 12:30 as UTC 09:30');

    let task = (await json(await context.request.post(`${origin}/api/work/tasks`, { data: { title: `Точное время ${name}`, reminderAt: preciseReminder } }), 201)).entry;
    for (const change of ['title', 'comment', 'archive']) {
      await openEntry('tasks', task);
      await expect(dialog.getByLabel('Напоминание', { exact: true })).toHaveValue(`${day}T12:30`);
      if (change === 'title') await dialog.getByLabel('Название', { exact: true }).fill(`${task.title} изменено`);
      if (change === 'comment') await dialog.getByLabel('Новый комментарий', { exact: true }).fill('Уточнение без изменения времени');
      const saved = await save('tasks', 'PATCH', change === 'archive' ? 'В архив задач' : 'Сохранить');
      task = saved.entry;
      assert.equal(saved.sent.reminderAt, preciseReminder);
      assert.equal((await persisted('tasks', task.id)).reminderAt, preciseReminder);
      if (change === 'title') assert.ok(task.title.endsWith(' изменено'));
      if (change === 'comment') assert.ok(task.comments.some(comment => comment.text === 'Уточнение без изменения времени'));
      if (change === 'archive') assert.ok(task.archivedAt);
      pass(`${change} edit preserves reminder seconds and milliseconds`);
    }
    await openEntry('tasks', task);
    task = (await save('tasks', 'PATCH', 'Вернуть в работу')).entry;
    assert.equal(task.reminderAt, preciseReminder);
    assert.equal(task.archivedAt, null);
    await openEntry('tasks', task);
    await dialog.getByLabel('Напоминание', { exact: true }).fill(`${day}T14:10`);
    const rescheduled = await save('tasks', 'PATCH');
    task = rescheduled.entry;
    assert.equal(rescheduled.sent.reminderAt, `${day}T11:10:00.000Z`);
    assert.equal((await persisted('tasks', task.id)).reminderAt, `${day}T11:10:00.000Z`);
    await openEntry('tasks', task);
    await dialog.getByLabel('Напоминание', { exact: true }).fill('');
    const cleared = await save('tasks', 'PATCH');
    task = cleared.entry;
    assert.equal(cleared.sent.reminderAt, null);
    assert.equal((await persisted('tasks', task.id)).reminderAt, null);
    pass('changing reminder time saves the new UTC instant; clearing saves null');

    const work = await json(await context.request.get(`${origin}/api/work`));
    assert.ok(work.companies[0], 'The isolated snapshot must contain a company');
    const record = (await json(await context.request.post(`${origin}/api/work/companies`, {
      data: { companyId: work.companies[0].id, question: `Обсудить поставку ${name}`, reminderAt: preciseReminder },
    }), 201)).entry;
    await openEntry('companies', record);
    await expect(dialog.getByLabel('Напоминание', { exact: true })).toHaveValue(`${day}T12:30`);
    await dialog.getByLabel('Новый комментарий', { exact: true }).fill('Комментарий к компании');
    const commented = await save('companies', 'PATCH');
    assert.equal(commented.sent.reminderAt, preciseReminder);
    assert.equal((await persisted('companies', record.id)).reminderAt, preciseReminder);
    assert.ok(commented.entry.comments.some(comment => comment.text === 'Комментарий к компании'));
    pass('company comment preserves the original exact reminder instant');

    // Assignment and reminder payloads share this URL contract; verify distinct IDs.
    for (const [label, entry] of [['assignment', task], ['reminder', self.entry]]) {
      await openEntry('tasks', entry);
      await dialog.getByRole('button', { name: 'Отмена', exact: true }).click();
      await expect(dialog).toHaveCount(0);
      pass(`${label} link opens the exact task`);
    }
    await context.close();
    await browser.close();
  }
  assert.deepEqual(browserErrors, []);
  console.log('PASS no browser errors; no real push or production data used');
} finally {
  await Promise.all(browsers.map(browser => browser.close()));
  if (server && server.exitCode === null) {
    const exited = new Promise(done => server.once('exit', done));
    server.kill('SIGTERM');
    await exited;
  }
  await rm(folder, { recursive: true, force: true });
}
