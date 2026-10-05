// Real browser and API, temporary synthetic store; no production data or provider calls.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium, expect } from '@playwright/test';
import { createSnapshotMiddleware } from '../server/local-api.ts';
import { integrationRuntime, integrationConfig } from '../tests/helpers/trip-saby-integration.ts';
import { SabyClient } from '../server/saby-client.ts';

const rt = await integrationRuntime();
const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'qa/driver-password');
await mkdir(output, { recursive: true });
const deny = async () => { throw new Error('External provider forbidden'); };
const middleware = createSnapshotMiddleware(rt.snapshotDirectory, {
  operationsStore: rt.store, sabyClient: new SabyClient(integrationConfig(), deny), sabyWorkflowMonitoringEnabled: false,
  bankEnvironment: { ARTEL_BANK_SYNC_ENABLED: 'false', ARTEL_BANK_REQUESTS_ENABLED: 'false' },
  bankRequest: deny, sberRequest: deny, fetcher: deny, checkoApiKey: '',
  pushConfig: { publicKey: '', privateKey: '', subject: '', schedule: false }, pushSender: deny,
});
let server, browser;
try {
  await rt.store.mutate(rt.source, data => { data.directories.drivers[0].name = 'Тестовый водитель'; return { changed: true, result: null }; });
  server = await createServer({ configFile: false, envDir: false, root: resolve(root, 'web'), cacheDir: resolve(rt.directory, 'vite'), plugins: [react(), { name: 'synthetic-api', configureServer(vite) { vite.middlewares.use(middleware); } }], server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  const base = `http://127.0.0.1:${server.httpServer.address().port}`;
  const owner = { name: 'Тестовый директор', login: 'password.qa.owner', password: randomUUID() };
  assert.equal((await fetch(base + '/api/auth/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(owner) })).status, 200);
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
  const page = await context.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  await page.getByLabel('Логин', { exact: true }).fill(owner.login);
  await page.getByLabel('Пароль', { exact: true }).fill(owner.password);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await page.goto(base + '/#directories');
  await page.getByRole('group', { name: 'Справочники', exact: true }).getByRole('button', { name: 'Водители', exact: true }).click();
  const icons = await page.locator('.sidebar nav svg').evaluateAll(nodes => nodes.map(node => node.innerHTML));
  assert.ok(icons.length >= 11); assert.equal(new Set(icons).size, icons.length);
  await page.getByRole('button', { name: 'Редактировать: Тестовый водитель', exact: true }).click();
  const dialog = page.getByRole('dialog'), panel = dialog.locator('.driver-access');
  const open = () => panel.getByRole('button', { name: 'Задать свой пароль', exact: true }).click();
  const password = panel.getByLabel('Новый пароль водителя', { exact: true });
  const repeat = panel.getByLabel('Повторите пароль', { exact: true });
  const save = panel.getByRole('button', { name: 'Сохранить пароль', exact: true });
  const delivered = () => panel.getByRole('button', { name: 'Данные переданы', exact: true }).click();
  let writes = 0;
  page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/drivers/driver/access')) writes++; });
  await open();
  await password.fill('short'); await repeat.fill('short'); await expect(save).toBeDisabled();
  const first = randomUUID();
  await password.fill(first); await repeat.fill(randomUUID()); await expect(save).toBeDisabled();
  await expect(panel).toContainText('Пароли не совпадают.');
  await repeat.fill(first); await expect(save).toBeEnabled();
  await repeat.press('Enter'); assert.equal(writes, 0);
  await panel.getByRole('button', { name: 'Показать введённый пароль', exact: true }).click();
  assert.equal(await password.getAttribute('type'), 'text');
  await panel.getByRole('button', { name: 'Скрыть введённый пароль', exact: true }).click();
  await save.click();
  await expect(panel.getByLabel('Временный пароль водителя', { exact: true })).toBeVisible();
  assert.ok(await panel.getByLabel('Временный пароль водителя', { exact: true }).inputValue() === first);
  const login = await panel.getByLabel('Логин водителя', { exact: true }).inputValue();
  await delivered(); await expect(panel).toContainText('Доступ активен');
  const signIn = secret => fetch(base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login, password: secret }) });
  assert.equal((await signIn(first)).status, 200);
  await panel.screenshot({ path: resolve(output, 'access-desktop.png') });
  await open(); await expect(password).toHaveValue(''); await expect(repeat).toHaveValue('');
  const next = randomUUID(); await password.fill(next); await repeat.fill(next);
  // Failed validation retains the administrator's input without rotating credentials.
  await page.route('**/api/drivers/driver/access', async route => route.request().method() === 'POST' ? route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Синтетическая ошибка проверки' }) }) : route.continue());
  await save.click(); await expect(panel.getByRole('alert')).toContainText('Синтетическая ошибка');
  assert.ok(await password.inputValue() === next); assert.equal((await signIn(first)).status, 200);
  await page.unroute('**/api/drivers/driver/access');
  await save.click(); await expect(panel.getByLabel('Временный пароль водителя', { exact: true })).toBeVisible();
  await delivered(); assert.equal((await signIn(first)).status, 401); assert.equal((await signIn(next)).status, 200);
  await open();
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await password.scrollIntoViewIfNeeded();
    assert.ok(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1), `Dialog fits ${width}`);
    assert.ok(await panel.evaluate(node => node.scrollWidth <= node.clientWidth + 1), `Panel fits ${width}`);
    await panel.screenshot({ path: resolve(output, `password-mobile-${width}.png`) });
  }
  await password.fill(randomUUID());
  await panel.getByRole('button', { name: 'Отмена изменения доступа', exact: true }).click();
  await open(); await expect(password).toHaveValue(''); await expect(repeat).toHaveValue('');
  await panel.getByRole('button', { name: 'Отмена изменения доступа', exact: true }).click();
  await panel.getByRole('button', { name: 'Выдать новый пароль', exact: true }).click();
  await panel.getByRole('button', { name: 'Подтвердить новый пароль', exact: true }).click();
  await expect(panel.getByLabel('Временный пароль водителя', { exact: true })).toBeVisible();
  await delivered();
  assert.deepEqual(errors, []);
  console.log('PASS: unique navigation icons; manual issue/reset and login; validation, show/hide, Enter safety, failed save retains input, cancel clears input, generation; desktop and 390/320 px layout. Synthetic data only.');
} finally { await browser?.close(); await server?.close(); await rt.close(); }
