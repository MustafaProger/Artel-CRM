// Synthetic loopback-only regression: initial errors, navigation races and mounted drafts.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium, webkit, expect as baseExpect } from '@playwright/test';
import { writeTripsQaSnapshot } from './qa-trips-runtime.mjs';
import { startOperatorQaServer } from './qa-operator-runtime.mjs';
import { authenticateContext } from './qa-auth.mjs';

const root = resolve(import.meta.dirname, '..');
const built = process.argv.includes('--built');
const output = resolve(process.env.ARTEL_LOADING_NAV_OUTPUT || resolve(root, '../qa-loading-navigation'), built ? 'built' : 'source');
const engines = process.env.ARTEL_LOADING_NAV_ENGINE ? [process.env.ARTEL_LOADING_NAV_ENGINE] : ['chromium', 'webkit'];
const expect = baseExpect.configure({ timeout: 15000 });
for (const key of Object.keys(process.env)) if (/^(ARTEL_|SABY_|SBER_|BANK_|VAPID_|PUSH_|CHECKO_|CRON_|BLOB_|VERCEL_)/.test(key)) delete process.env[key];
Object.assign(process.env, { ARTEL_OPERATOR_QA_BUILT: built ? '1' : '0', SABY_WORKFLOW_ENABLED: 'false', ARTEL_CABINET_SYNC_ENABLED: 'false', ARTEL_GEOCODER_ENABLED: 'false', ARTEL_BANK_SYNC_ENABLED: 'false', ARTEL_BANK_REQUESTS_ENABLED: 'false', PUSH_SCHEDULE_ENABLED: 'false' });
const temporary = await mkdtemp(resolve(tmpdir(), 'artel-loading-navigation-'));
const snapshotDirectory = resolve(temporary, 'snapshot'), operationsDirectory = resolve(temporary, 'store');
await writeTripsQaSnapshot(snapshotDirectory);
await mkdir(output, { recursive: true });
const report = { passed: false, syntheticOnly: true, workingStoreAccessed: false, checks: [], requests: [], mutations: [], externalRequests: [], errors: [] };
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') {
    report.externalRequests.push({ source: 'server', origin: url.origin });
    return Promise.reject(new Error('External request forbidden in loading regression'));
  }
  return originalFetch(input, init);
};
let runtime, browser, activeGates = [];
const paint = page => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
const pendingUi = page => page.locator('main .page-loading, main .loading-skeleton');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function hold(path, response, method = 'GET') {
  const entered = deferred(), released = deferred(), finished = deferred();
  const gate = { path, method, response, requests: [], entered: entered.promise, finished: finished.promise, release: released.resolve, wait: released.promise, enter: entered.resolve, finish: finished.resolve };
  activeGates.push(gate);
  return gate;
}
async function reach(gate) {
  let timer;
  try { await Promise.race([gate.entered, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`No request reached ${gate.path}`)), 15000); })]); }
  finally { clearTimeout(timer); }
}
async function release(gate) { gate.release(); await gate.finished; }
const markerSnapshot = (snapshot, name) => ({ ...snapshot, directories: { ...snapshot.directories, products: [{ id: 'qa-loading-product', name, version: 1 }] } });
try {
  runtime = await startOperatorQaServer({ root, snapshotDirectory, operationsDirectory });
  report.runtime = runtime.mode; report.artifacts = runtime.artifacts;
  const actor = await runtime.bootstrap();
  const snapshotResponse = await fetch(runtime.base + '/api/snapshot?shipments=omit&context=directories', { headers: { Cookie: actor.cookie } });
  assert.ok(snapshotResponse.ok);
  const snapshot = await snapshotResponse.json();
  for (const engine of engines) for (const width of [375, 1440]) {
    const label = `${engine}-${width}`;
    browser = await ({ chromium, webkit })[engine].launch({ headless: true });
    const context = await browser.newContext({ viewport: { width, height: 1000 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
    await authenticateContext(context, runtime.base, actor.cookie);
    const page = await context.newPage();
    page.on('pageerror', error => report.errors.push({ label, message: String(error) }));
    activeGates = [];
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== runtime.base) { report.externalRequests.push({ source: 'browser', label, origin: url.origin }); return route.abort(); }
      if (request.method() !== 'GET') {
        report.mutations.push({ label, method: request.method(), path: url.pathname });
        assert.equal(request.method(), 'POST'); assert.equal(url.pathname, '/api/auth/employees');
      }
      if (url.pathname.startsWith('/api/')) report.requests.push({ label, path: url.pathname, search: url.search });
      // Development StrictMode can start the same initial GET twice. Both
      // requests belong to the same held stage until a newer gate replaces it.
      const gate = activeGates.findLast(item => item.path === url.pathname && item.method === request.method());
      if (!gate) return route.continue();
      gate.requests.push(request); gate.enter(); await gate.wait;
      try {
        if (gate.response) await route.fulfill(gate.response);
        else await route.fulfill({ response: await route.fetch() });
      } finally { gate.finish(); }
    });

    // App's snapshot failure must end loading, and explicit retry must leave the error view.
    let gate = hold('/api/snapshot', { status: 503, json: { error: 'Учебная ошибка снимка' } });
    await page.goto(runtime.base + '/#directories'); await reach(gate);
    await expect(pendingUi(page).first()).toBeVisible();
    await release(gate);
    await expect(page.getByRole('heading', { name: 'Данные пока недоступны', exact: true })).toBeVisible();
    await expect(pendingUi(page)).toHaveCount(0);
    gate = hold('/api/snapshot');
    await page.getByRole('button', { name: 'Повторить загрузку', exact: true }).click(); await reach(gate);
    await expect(page.getByRole('heading', { name: 'Данные пока недоступны', exact: true })).toHaveCount(0);
    await expect(pendingUi(page).first()).toBeVisible();
    await release(gate); await expect(page.locator('.directory-list')).toBeVisible();
    report.checks.push({ label, scenario: 'snapshot initial failure and retry', passed: true });

    // Trips' preliminary context has an independent failure/retry boundary.
    gate = hold('/api/trip-requests/context', { status: 503, json: { error: 'Учебная ошибка контекста' } });
    await page.evaluate(() => { location.hash = 'trips'; }); await reach(gate);
    await release(gate);
    await expect(page.getByText('Учебная ошибка контекста', { exact: false })).toBeVisible();
    await expect(pendingUi(page)).toHaveCount(0);
    gate = hold('/api/trip-requests/context');
    await page.getByRole('button', { name: 'Повторить загрузку справочников', exact: true }).click(); await reach(gate);
    await expect(page.getByText('Учебная ошибка контекста', { exact: false })).toHaveCount(0);
    await expect(pendingUi(page).first()).toBeVisible();
    await release(gate); await expect(page.locator('.trips-section-tabs')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Новая заявка', exact: true })).toBeVisible();
    report.checks.push({ label, scenario: 'trip context initial failure and retry', passed: true });

    // A1 → B → A2, finish A2 first and release both obsolete responses afterwards.
    const oldA = hold('/api/snapshot', { json: markerSnapshot(snapshot, 'УСТАРЕВШИЙ A1') });
    await page.evaluate(() => { location.hash = 'directories'; }); await reach(oldA);
    const oldB = hold('/api/snapshot', { json: markerSnapshot(snapshot, 'УСТАРЕВШИЙ B') });
    await page.evaluate(() => { location.hash = 'shipments'; }); await reach(oldB);
    const freshA = hold('/api/snapshot', { json: markerSnapshot(snapshot, 'АКТУАЛЬНЫЙ A2') });
    await page.evaluate(() => { location.hash = 'directories'; }); await reach(freshA);
    await release(freshA); await expect(page.locator('.directory-list')).toBeVisible();
    await page.getByRole('group', { name: 'Справочники', exact: true }).getByRole('button', { name: 'Товары', exact: true }).click();
    await expect(page.getByText('АКТУАЛЬНЫЙ A2', { exact: true })).toBeVisible();
    await page.getByRole('textbox', { name: 'Поиск в справочнике', exact: true }).fill('АКТУАЛЬНЫЙ');
    await release(oldA); await release(oldB); await paint(page);
    await expect(page.getByText('АКТУАЛЬНЫЙ A2', { exact: true })).toBeVisible();
    await expect(page.getByText(/УСТАРЕВШИЙ/)).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Поиск в справочнике', exact: true })).toHaveValue('АКТУАЛЬНЫЙ');
    await expect(pendingUi(page)).toHaveCount(0);
    assert.equal(new URL(page.url()).hash, '#directories');
    report.checks.push({ label, scenario: 'A1 B A2 ignores late A1 and B snapshots', passed: true });
    activeGates = [];

    // Adding a synthetic employee refreshes the App snapshot while the account draft stays open.
    await page.evaluate(() => { location.hash = 'accounts'; });
    await expect(page.locator('.account-row').first()).toBeVisible();
    await page.getByRole('button', { name: 'Добавить пользователя', exact: true }).click();
    const editor = page.getByRole('region', { name: 'Настройки учётной записи', exact: true });
    const handle = await editor.elementHandle();
    const login = editor.getByLabel('Логин', { exact: true });
    await login.fill(`qa.draft.${label}`);
    await editor.getByLabel('Новый сотрудник', { exact: true }).fill(`Учебный сотрудник ${label}`);
    gate = hold('/api/snapshot');
    await editor.getByRole('button', { name: 'Добавить сотрудника', exact: true }).click(); await reach(gate);
    assert.equal(await handle.evaluate(element => element.isConnected), true, 'Snapshot refresh unmounted the account editor');
    await expect(editor).toBeVisible(); await expect(pendingUi(page)).toHaveCount(0);
    await expect(login).toHaveValue(`qa.draft.${label}`);
    await login.fill(`qa.draft.${label}.kept`); await login.focus();
    await release(gate); await paint(page);
    assert.equal(await handle.evaluate(element => element.isConnected), true, 'Snapshot completion replaced the account editor');
    await expect(login).toHaveValue(`qa.draft.${label}.kept`); await expect(login).toBeFocused();
    await page.screenshot({ path: resolve(output, `${label}-preserved-draft.png`), fullPage: true });
    report.checks.push({ label, scenario: 'account draft node input and focus survive snapshot refresh', passed: true });

    // A mutation may finish after its editor's route has unmounted. Its old
    // onChanged callback must not supersede the newly selected page's snapshot.
    activeGates = [];
    await editor.getByLabel('Новый сотрудник', { exact: true }).fill(`Поздний учебный сотрудник ${label}`);
    const mutation = hold('/api/auth/employees', undefined, 'POST');
    await editor.getByRole('button', { name: 'Добавить сотрудника', exact: true }).click(); await reach(mutation);
    const currentSnapshot = hold('/api/snapshot');
    await page.evaluate(() => { location.hash = 'directories'; }); await reach(currentSnapshot);
    const originalSnapshotRequest = currentSnapshot.requests[0];
    const mutationResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/employees' && response.request().method() === 'POST').then(response => response.finished());
    await release(mutation); await mutationResponse; await paint(page);
    assert.equal(currentSnapshot.requests.length, 1, 'Old account callback superseded the new directory snapshot');
    assert.equal(originalSnapshotRequest.failure(), null, 'Old account callback aborted the active snapshot');
    assert.equal(new URL(originalSnapshotRequest.url()).searchParams.get('context'), 'directories');
    await release(currentSnapshot); await expect(page.locator('.directory-list')).toBeVisible();
    await expect(pendingUi(page)).toHaveCount(0);
    assert.equal(new URL(page.url()).hash, '#directories');
    report.checks.push({ label, scenario: 'late account mutation cannot abort or replace directory snapshot', passed: true });
    for (const pending of activeGates) pending.release();
    await context.close(); await browser.close(); browser = null;
    console.log('PASS', label, 'initial failures/retry, A→B→A, draft preservation, late mutation');
  }
  assert.deepEqual(report.errors, []); assert.deepEqual(report.externalRequests, []);
  assert.equal(report.mutations.length, engines.length * 4);
  report.passed = true;
} finally {
  for (const gate of activeGates) gate.release();
  await browser?.close(); await runtime?.server.close();
  globalThis.fetch = originalFetch;
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
  await rm(temporary, { recursive: true, force: true });
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, errors: report.errors.length, report: resolve(output, 'report.json') }));
}
