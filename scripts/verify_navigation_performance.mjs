// Synthetic, isolated browser regression. No production API or working store.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { chromium, webkit, expect } from '@playwright/test';

const root = resolve(import.meta.dirname, '..');
const engine = process.env.QA_WEBKIT === '1' ? 'webkit' : 'chromium';
const output = resolve(process.env.ARTEL_PERFORMANCE_UI_OUTPUT || resolve(root, 'qa/navigation-performance'), engine);
const report = { engine, environment: 'local built UI, mocked APIs, no business data', checks: [], measurements: [], errors: [] };
const check = name => { report.checks.push(name); console.log('PASS', name); };
const delay = ms => new Promise(done => setTimeout(done, ms));
const user = { id: 'qa-owner', name: 'QA', login: 'qa', role: 'director', managerId: null, active: true, version: 1 };
const task = { id: 'qa-task', version: 1, title: 'Проверка отклика', description: '', status: 'todo', companyId: null, dueDate: null, reminderAt: null, assigneeId: user.id, createdBy: user.id, updatedBy: user.id, createdAt: '2026-10-28T10:00:00Z', updatedAt: '2026-10-28T10:00:00Z' };
const snapshot = { overview: { shipmentCount: 39 }, shipments: [], payments: [], monthly: [], companies: [], directories: { managers: [], drivers: [], vehicles: [], products: [], addresses: [], customerManagers: [], paymentForms: [], oilDepots: [] } };
let browser;
const servers = [];
async function serve(directory) {
  const server = createServer(async (request, response) => {
    const path = new URL(request.url, 'http://localhost').pathname;
    const file = resolve(directory, `.${path === '/' ? '/index.html' : path}`);
    if (!file.startsWith(`${directory}/`)) { response.writeHead(404).end(); return; }
    try {
      const body = await readFile(file);
      response.writeHead(200, { 'Content-Type': ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png', '.json': 'application/json' })[extname(file)] || 'application/octet-stream' }).end(body);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done)); servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}
async function scenario(base, baseline = false) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  await context.addInitScript(() => {
    window.__qaTimings = {};
    document.addEventListener('click', event => {
      if (event.target.closest('.auth-submit')) window.__qaTimings.loginStarted = performance.now();
      if (event.target.matches('.work-task-check input')) window.__qaTimings.taskStarted = performance.now();
    }, true);
    new MutationObserver(() => {
      const timings = window.__qaTimings;
      if (timings.loginStarted && !timings.workReady && document.querySelector('.work-task-row')) timings.workReady = performance.now();
      if (timings.taskStarted && !timings.taskFeedback && document.querySelector('.work-task-row.is-saving')) timings.taskFeedback = performance.now();
    }).observe(document, { childList: true, subtree: true, attributes: true });
  });
  const page = await context.newPage();
  page.on('pageerror', error => report.errors.push(error.message));
  let signedIn = false, navigationDelay = 1200, navigationStatus = 200, navigationFinished = 0, snapshotStatus = 200, snapshotDelay = 1200, patchStatus = 200;
  const calls = [];
  let loginUser = user;
  const currentTask = { ...task };
  await page.route('**/api/**', async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    const call = { path, method: request.method(), at: performance.now(), finished: false };
    calls.push(call);
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) }).catch(() => {});
    if (path === '/api/auth/session') { if (signedIn) await delay(400); return json({ user: signedIn ? loginUser : null, needsSetup: false, setupTokenRequired: false }); }
    if (path === '/api/auth/login' || path === '/api/auth/setup') { signedIn = true; return json({ status: 200, user: loginUser }); }
    if (path === '/api/auth/logout') { signedIn = false; return json({ status: 200 }); }
    if (path === '/api/navigation') { const status = navigationStatus; await delay(navigationDelay); navigationFinished++; call.finished = true; return json(status === 200 ? { shipmentCount: 39 } : { error: 'QA navigation unavailable' }, status); }
    if (path === '/api/snapshot') { await delay(snapshotDelay); return json(snapshotStatus === 200 ? snapshot : { error: 'QA snapshot unavailable' }, snapshotStatus); }
    if (path === '/api/work') { await delay(50); return json({ work: { tasks: [currentTask], companyRecords: [], notes: [] }, users: [loginUser], historicalUsers: [], companies: [], currentUser: loginUser, revision: 1 }); }
    if (path === '/api/work/tasks/qa-task') { await delay(900); if (patchStatus !== 200) return json({ error: 'QA rejected update' }, patchStatus); Object.assign(currentTask, request.postDataJSON(), { version: currentTask.version + 1 }); return json({ entry: currentTask }); }
    if (path === '/api/settlements') return json({ organizations: [], unassignedShipmentCount: 0 });
    if (path === '/api/china') return json({ china: { days: [], payments: [] }, suppliers: [] });
    if (path === '/api/cabinets') return json({ connections: [], credentialStorageReady: false });
    if (path === '/api/operator') return json({ recipients: [], refuellings: [], groups: [], services: [], plans: [], cases: [] });
    if (path === '/api/auth/users') return json({ users: [loginUser], currentUserId: loginUser.id, staff: { managers: [], drivers: [] } });
    if (path === '/api/push/config') return json({ enabled: false, publicKey: '' });
    return json({ error: 'QA service unavailable' }, 503);
  });
  await page.goto(`${base}/#work`);
  await page.getByLabel('Логин', { exact: true }).fill('qa');
  await page.getByLabel('Пароль', { exact: true }).fill('synthetic-password-only');
  const sessionReads = calls.filter(row => row.path === '/api/auth/session').length;
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Новая задача', exact: true })).toBeEnabled();
  const readyMs = await page.evaluate(() => Math.round(window.__qaTimings.workReady - window.__qaTimings.loginStarted));
  assert.ok(Number.isFinite(readyMs));
  const loginReads = calls.filter(row => row.path === '/api/auth/session').length - sessionReads;
  const snapshotReads = calls.filter(row => row.path === '/api/snapshot').length;
  report.measurements.push({ variant: baseline ? 'baseline' : 'candidate', scenario: 'login to populated work', readyMs, extraSessionReads: loginReads, snapshotReads, injectedSessionDelayMs: 400, injectedSnapshotDelayMs: 1200, injectedNavigationDelayMs: 1200, injectedWorkDelayMs: 50 });
  if (baseline) { await context.close(); return; }
  assert.equal(loginReads, 0);
  assert.equal(snapshotReads, 0);
  assert.equal(navigationFinished, 0, 'Work becomes usable while sidebar request is still pending');
  check('Login uses committed public user; Work loads without snapshot or sidebar dependency');
  await expect(page.getByRole('button', { name: 'Отгрузки', exact: true }).locator('small')).toHaveText('39');
  check('Delayed sidebar count arrives without replacing the active Work page');

  const checkbox = page.getByRole('checkbox', { name: 'Выполнена: Проверка отклика' });
  const workReadsBefore = calls.filter(row => row.path === '/api/work').length;
  await checkbox.check(); await expect(checkbox).toBeChecked(); await expect(checkbox).toBeDisabled();
  const feedbackMs = await page.evaluate(() => Math.round(window.__qaTimings.taskFeedback - window.__qaTimings.taskStarted));
  assert.ok(Number.isFinite(feedbackMs));
  report.measurements.push({ scenario: 'optimistic task feedback', readyMs: feedbackMs, injectedPatchDelayMs: 900 });
  await expect(checkbox).toBeEnabled();
  assert.equal(calls.filter(row => row.path === '/api/work').length, workReadsBefore);
  patchStatus = 409; await checkbox.uncheck(); await expect(checkbox).not.toBeChecked(); await expect(checkbox).toBeChecked();
  await expect(page.getByText('QA rejected update')).toBeVisible();
  check('Task feedback is immediate; delayed save commits once, rejection rolls back, no extra Work GET');

  for (const [hash, endpoint, selector] of [['overview', '/api/settlements', '.overview-page'], ['cabinet-balances', '/api/cabinets', '.cabinet-page'], ['china', '/api/china', '.china-page'], ['operator', '/api/operator', '.operator-workspace'], ['invoices', '/api/invoices', '.page-content']]) {
    const offset = calls.length;
    await page.evaluate(value => { location.hash = value; }, hash);
    await expect.poll(() => calls.slice(offset).some(row => row.path === endpoint)).toBe(true);
    await expect(page.locator(hash === 'cabinet-balances' ? '.page-content' : selector)).toBeVisible();
    assert.equal(calls.slice(offset).find(row => row.path === '/api/navigation')?.finished, false, `${hash} is mounted before its sidebar response`);
    assert.equal(calls.slice(offset).some(row => row.path === '/api/snapshot'), false);
    check(`${hash}: own API starts without snapshot; navigation remains nonblocking`);
  }
  navigationDelay = 0; navigationStatus = 503;
  await page.evaluate(() => { location.hash = 'work'; });
  await expect(page.getByRole('button', { name: 'Новая задача', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Отгрузки', exact: true }).locator('small')).toHaveCount(0);
  check('Sidebar request failure hides stale count without breaking Work');

  snapshotDelay = 0; snapshotStatus = 503;
  await page.evaluate(() => { location.hash = 'directories'; });
  await expect(page.getByRole('heading', { name: 'Данные пока недоступны' })).toBeVisible();
  snapshotStatus = 200;
  await page.getByRole('button', { name: 'Повторить загрузку' }).click();
  await expect(page.getByRole('button', { name: 'Клиенты', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Отгрузки', exact: true }).locator('small')).toHaveText('39');
  check('Snapshot-dependent directories retain loading, failure, retry and sidebar counter');
  snapshotDelay = 1200;
  await page.evaluate(() => { location.hash = 'accounts'; });
  await expect(page.getByText('Загружаем CRM…', { exact: true })).toBeVisible();
  await page.evaluate(() => { location.hash = 'work'; });
  await expect(page.getByRole('button', { name: 'Новая задача', exact: true })).toBeEnabled();
  await delay(1300);
  await expect(page.getByRole('button', { name: 'Новая задача', exact: true })).toBeEnabled();
  check('Leaving a delayed snapshot cancels it; stale completion cannot replace current page');

  navigationStatus = 401;
  await page.evaluate(() => { location.hash = 'china'; });
  await expect(page.getByRole('button', { name: 'Войти', exact: true })).toBeVisible();
  check('Expired navigation session immediately returns to login');
  navigationStatus = 200;
  loginUser = { ...user, role: 'employee', id: 'qa-limited', sections: ['work'] };
  await page.evaluate(() => { location.hash = 'work'; });
  await page.getByLabel('Логин', { exact: true }).fill('qa-limited');
  await page.getByLabel('Пароль', { exact: true }).fill('synthetic-password-only');
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Новая задача', exact: true })).toBeEnabled();
  const forbiddenOffset = calls.length;
  await page.evaluate(() => { location.hash = 'directories'; });
  await expect(page.getByText('Раздел недоступен. Обратитесь к администратору.')).toBeVisible();
  assert.equal(calls.slice(forbiddenOffset).some(row => ['/api/snapshot', '/api/navigation'].includes(row.path)), false);
  check('Restricted employee cannot mount or request forbidden snapshot page');
  await page.getByRole('button', { name: 'Выйти', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Войти', exact: true })).toBeVisible();
  check('Logout remains functional after direct login response');
  await context.close();
}
try {
  await mkdir(output, { recursive: true });
  browser = engine === 'webkit' ? await webkit.launch({ headless: true }) : await chromium.launch({ headless: true });
  if (process.env.ARTEL_PERFORMANCE_BASELINE_DIST) await scenario(await serve(resolve(process.env.ARTEL_PERFORMANCE_BASELINE_DIST)), true);
  await scenario(await serve(resolve(root, 'app-dist')));
  assert.deepEqual(report.errors, []);
} finally {
  await browser?.close();
  for (const server of servers) await new Promise(done => server.close(done));
  await writeFile(resolve(output, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
}
