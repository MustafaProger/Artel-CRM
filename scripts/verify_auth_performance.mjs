// Isolated loopback auth QA: real middleware + synthetic credentials/data only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer, request as httpRequest } from 'node:http';
import { chromium, webkit, expect as baseExpect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
const root = resolve(process.env.ARTEL_AUTH_QA_ROOT || resolve(import.meta.dirname, '..'));
const output = resolve(process.env.ARTEL_AUTH_QA_OUTPUT || resolve(root, '.local/auth-ui'), process.argv.includes('--built') ? 'built' : 'source');
const built = process.argv.includes('--built'), baseline = process.argv.includes('--baseline');
// Production resolves app-dist from cwd. Root overrides must select BOTH the
// backend bundle and its corresponding compiled frontend, never a mixed pair.
const originalCwd = process.cwd();
process.chdir(root);
for (const key of Object.keys(process.env)) if (/^(ARTEL_|SABY_|SBER_|BANK_|VAPID_|PUSH_|CHECKO_|CRON_|BLOB_|VERCEL_)/.test(key)) delete process.env[key];
process.env.SABY_WORKFLOW_ENABLED = 'false';
process.env.ARTEL_CABINET_SYNC_ENABLED = 'false';
process.env.ARTEL_BANK_SYNC_ENABLED = 'false';
process.env.ARTEL_BANK_REQUESTS_ENABLED = 'false';
process.env.ARTEL_GEOCODER_ENABLED = 'false';
process.env.PUSH_SCHEDULE_ENABLED = 'false';
const expect = baseExpect.configure({ timeout: 10000 });
const temp = await mkdtemp(resolve(tmpdir(), 'artel-auth-performance-'));
const snapshotDirectory = resolve(temp, 'snapshot'), operationsDirectory = resolve(temp, 'store');
const report = { passed: false, baseline, built, sourceRoot: root, staticRoot: resolve(root, 'app-dist'), syntheticOnly: true, externalRequests: [], checks: [], timings: [], serverRequests: [], browserRequests: [], errors: [], screenshots: [], accessibility: [], interceptedAuth: [] };
await mkdir(output, { recursive: true });
await mkdir(operationsDirectory, { recursive: true });
const { writeTripsQaSnapshot, startTripsQaServer } = await import(pathToFileURL(resolve(root, 'scripts/qa-trips-runtime.mjs')));
const sourceHash = await writeTripsQaSnapshot(snapshotDirectory);
const { migrateWorkStorage } = await import(pathToFileURL(resolve(root, 'server/work-partition.ts')));
const { OperationsStore } = await import(pathToFileURL(resolve(root, 'server/operations-store.ts')));
await new OperationsStore(operationsDirectory).mutate(sourceHash, data => { data.sourceOperationsCleared = true; return { result: null, changed: true }; });
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') { report.externalRequests.push(url.origin); throw new Error('Synthetic QA forbids external requests'); }
  return originalFetch(input, init);
};
const check = (engine, name) => { report.checks.push({ engine, name }); console.log('PASS', engine, name); };
const delay = milliseconds => new Promise(done => setTimeout(done, milliseconds));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
let runtime, browser;
const trackServer = server => server.prependListener('request', (request, response) => {
  if (!request.url?.startsWith('/api/')) return;
  const start = performance.now();
  response.once('finish', () => report.serverRequests.push({ method: request.method, path: request.url.split('?')[0], status: response.statusCode, milliseconds: performance.now() - start }));
});
try {
  let setupToken;
  if (built) {
    const { createProductionRuntime } = await import(pathToFileURL(resolve(root, 'server-render/production.mjs')));
    setupToken = randomUUID();
    const environment = { ARTEL_PUBLIC_ORIGIN: 'https://auth-qa.local.test', ARTEL_LISTEN_HOST: '127.0.0.1', PORT: '0', ARTEL_SNAPSHOT_DIR: snapshotDirectory, ARTEL_STORE_DIR: operationsDirectory, ARTEL_SETUP_TOKEN: setupToken, ARTEL_BANK_REQUESTS_ENABLED: 'false', ARTEL_BANK_SYNC_ENABLED: 'false', ARTEL_CABINET_SYNC_ENABLED: 'false', ARTEL_GEOCODER_ENABLED: 'false', SABY_WORKFLOW_ENABLED: 'false', PUSH_SCHEDULE_ENABLED: 'false' };
    const production = await createProductionRuntime(environment); trackServer(production.server); await production.start();
    const proxy = createServer((request, response) => {
      const headers = { ...request.headers, host: 'auth-qa.local.test' }; if (headers.origin) headers.origin = environment.ARTEL_PUBLIC_ORIGIN;
      const upstream = httpRequest({ host: '127.0.0.1', port: production.server.address().port, path: request.url, method: request.method, headers }, result => {
        if (result.headers['set-cookie']) assert.ok(result.headers['set-cookie'].every(value => /; Secure(?:;|$)/i.test(value)));
        response.writeHead(result.statusCode, result.headers); result.pipe(response);
      });
      upstream.on('error', () => { response.writeHead(502); response.end(); }); request.pipe(upstream);
    });
    await new Promise(done => proxy.listen(0, '127.0.0.1', done));
    runtime = { base: `http://127.0.0.1:${proxy.address().port}`, close: async () => { await production.stop(); await new Promise(done => proxy.close(done)); } };
  } else {
    const server = await startTripsQaServer({ root, snapshotDirectory, operationsDirectory }); trackServer(server.server.httpServer);
    runtime = { base: server.base, close: () => server.server.close() };
  }
  const password = randomUUID(), login = 'qa.auth.performance';
  const setup = await fetch(runtime.base + '/api/auth/setup', { method: 'POST', headers: { Origin: runtime.base, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Учебный директор', login, password, ...(setupToken ? { setupToken } : {}) }) });
  assert.equal(setup.status, 200); await setup.json();
  await migrateWorkStorage(operationsDirectory, sourceHash);
  report.partitionedStore = true;
  for (const [engine, launcher] of [['chromium', chromium], ['webkit', webkit]]) {
    browser = await launcher.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    await context.route('**/*', route => { const url = new URL(route.request().url()); return url.origin === runtime.base ? route.continue() : (report.externalRequests.push(url.origin), route.abort()); });
    await context.addInitScript(() => {
      const original = window.fetch.bind(window);
      window.fetch = (input, init) => {
        const path = typeof input === 'string' ? input : input.url;
        if (window.__delayNextWork401 && /^\/api\/work(?:\?|$)/.test(path)) {
          window.__delayNextWork401 = false;
          return new Promise(done => { window.__releaseOld401 = () => done(new Response('{"error":"Expired synthetic request"}', { status: 401, headers: { 'Content-Type': 'application/json' } })); });
        }
        return original(input, init);
      };
    });
    const page = await context.newPage();
    const trackPage = target => {
      target.on('pageerror', error => report.errors.push({ engine, message: error.message }));
      target.on('requestfinished', request => {
        if (!request.url().includes('/api/')) return;
        const time = request.timing();
        report.browserRequests.push({ engine, method: request.method(), path: new URL(request.url()).pathname, milliseconds: time.responseEnd, responseStartMs: time.responseStart });
      });
    };
    trackPage(page);
    const audit = async (name, width) => {
      await page.setViewportSize({ width, height: 1000 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
      report.accessibility.push({ engine, name, width, violations: result.violations.map(item => ({ id: item.id, nodes: item.nodes.map(node => node.target) })) });
      assert.deepEqual(result.violations.map(item => item.id), [], `${engine} ${name} ${width} accessibility`);
      const file = resolve(output, `${engine}-${name}-${width}.png`); await page.screenshot({ path: file, fullPage: true }); report.screenshots.push(file);
    };
    const ready = target => expect(target.getByRole('button', { name: 'Новая задача', exact: true })).toBeEnabled();
    const form = target => expect(target.getByLabel('Логин', { exact: true })).toBeVisible();
    const signIn = async (target, candidate = password) => {
      await form(target); await target.getByLabel('Логин', { exact: true }).fill(login); await target.getByLabel('Пароль', { exact: true }).fill(candidate);
      await target.getByRole('button', { name: 'Войти', exact: true }).click();
    };
    const cookie = async () => (await context.cookies()).filter(value => value.name === 'artel_session').map(value => `${value.name}=${value.value}`).join('; ');
    const api = async (path, token = '') => fetch(runtime.base + path, { headers: { Origin: runtime.base, ...(token ? { Cookie: token } : {}) } });
    const forward = async (route, expectedCookie) => {
      // WebKit interception can omit Cookie from allHeaders; route.fetch also
      // uses API-client Secure rules on HTTP loopback. Forward this isolated
      // browser context's real stored cookie explicitly for fault injection.
      const headers = await route.request().allHeaders();
      const browserCookie = await cookie();
      headers.cookie = browserCookie;
      const response = await route.fetch({ headers });
      report.interceptedAuth.push({ engine, path: new URL(route.request().url()).pathname, cookiePresent: !!headers.cookie, cookieMatches: expectedCookie === undefined ? null : headers.cookie?.split('; ').includes(expectedCookie) === true, status: response.status() });
      if (expectedCookie !== undefined) { assert.ok(headers.cookie?.split('; ').includes(expectedCookie), 'Forwarded browser cookie matches captured synthetic session'); assert.equal(response.status(), 200, 'Fault injection must follow a committed successful logout'); }
      return response;
    };

    // No injected delay in these measurements. UI includes automation overhead;
    // serverRequests separately records request->response finish in the middleware.
    for (let sample = 0; sample < 3; sample++) {
      let start = performance.now(); await page.goto(runtime.base + '/#work'); await form(page);
      report.timings.push({ engine, sample, action: 'anonymous-load', milliseconds: performance.now() - start });
      await page.getByLabel('Логин', { exact: true }).fill(login); await page.getByLabel('Пароль', { exact: true }).fill(password);
      const count = report.serverRequests.length;
      start = performance.now(); await page.getByRole('button', { name: 'Войти', exact: true }).click(); await ready(page);
      report.timings.push({ engine, sample, action: 'login-to-work-ready', milliseconds: performance.now() - start });
      assert.equal(report.serverRequests.slice(count).filter(row => row.path === '/api/auth/session').length, 0, 'No follow-up session GET on successful login');
      start = performance.now(); await page.reload(); await ready(page);
      report.timings.push({ engine, sample, action: 'authenticated-reload', milliseconds: performance.now() - start });
      const token = await cookie(); start = performance.now(); await page.getByRole('button', { name: 'Выйти', exact: true }).click(); await form(page);
      report.timings.push({ engine, sample, action: 'logout-to-login-ready', milliseconds: performance.now() - start });
      assert.equal((await api('/api/snapshot', token)).status, 401);
    }
    check(engine, 'Real login/reload/logout and revoked raw cookie; no duplicate session GET on login');
    // Explicit fault injection: same 1200ms push registration on both revisions.
    await signIn(page); await ready(page);
    await page.evaluate(() => { window.__pushCalls = 0; navigator.serviceWorker.getRegistration = async () => { window.__pushCalls++; await new Promise(done => setTimeout(done, 1200)); return undefined; }; });
    let start = performance.now(); await page.getByRole('button', { name: 'Выйти', exact: true }).click(); await form(page);
    const pushMs = performance.now() - start;
    report.timings.push({ engine, action: 'logout-injected-push-1200ms', milliseconds: pushMs, nativeCalls: await page.evaluate(() => window.__pushCalls) });
    if (!baseline) assert.equal(await page.evaluate(() => window.__pushCalls), 0, 'Logout never invokes native push operations');
    if (baseline) { await context.close(); await browser.close(); browser = undefined; continue; }
    check(engine, 'Native push registration/unsubscribe excluded from logout critical path');
    await page.reload(); await form(page);
    for (const width of [320, 390, 1440]) await audit('login', width);
    await signIn(page, 'incorrect-local-password'); await expect(page.getByRole('alert')).toBeVisible(); await expect(page.locator('.app-shell')).toHaveCount(0);
    await page.route('**/api/auth/login', route => route.abort('failed'), { times: 1 }); await signIn(page); await expect(page.getByRole('alert')).toBeVisible();
    await signIn(page); await ready(page);
    check(engine, 'Wrong password and network login failure remain unauthenticated; retry succeeds');
    await page.route('**/api/auth/logout', route => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"Synthetic outage"}' }), { times: 1 });
    await page.getByRole('button', { name: 'Выйти', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('Не удалось подтвердить выход'); await ready(page);
    const stillValid = await cookie(); assert.equal((await api('/api/work', stillValid)).status, 200);
    for (const width of [320, 390, 1440]) await audit('logout-error', width);
    await page.getByRole('button', { name: 'Повторить выход', exact: true }).click(); await form(page);
    assert.equal((await api('/api/work', stillValid)).status, 401);
    check(engine, 'Failed logout visible on desktop/mobile; session kept until confirmed retry; old token rejected');
    await signIn(page); await ready(page);
    const pending = deferred(), release = deferred(); let logoutCount = 0;
    await page.route('**/api/auth/logout', async route => { logoutCount++; const response = await forward(route); pending.resolve(); await release.promise; await route.fulfill({ response }); }, { times: 1 });
    await page.getByRole('button', { name: 'Выйти', exact: true }).click(); await pending.promise;
    await expect(page.getByRole('status')).toContainText('Завершаем сеанс');
    await page.evaluate(() => { [...document.querySelectorAll('button')].find(button => button.textContent === 'Выйти')?.click(); });
    assert.equal(logoutCount, 1); assert.equal(await page.locator('.auth-session-workspace').getAttribute('inert'), '');
    for (const width of [320, 390, 1440]) await audit('logout-pending', width);
    release.resolve(); await form(page); check(engine, 'Pending logout is visible/inert and duplicate action does not send another POST');
    await signIn(page); await ready(page); const lostCookie = await cookie();
    await page.route('**/api/auth/logout', async route => { await forward(route, lostCookie); await route.abort('failed'); }, { times: 1 });
    await page.getByRole('button', { name: 'Выйти', exact: true }).click(); await expect(page.getByRole('alert')).toContainText('Не удалось подтвердить выход');
    assert.equal((await api('/api/work', lostCookie)).status, 401, 'Committed logout revokes raw cookie even if response is lost');
    await page.getByRole('button', { name: 'Повторить выход', exact: true }).click(); await form(page);
    check(engine, 'Committed logout with lost response is explicit; retry accepts confirmed 401 and closes UI');

    // Late response from the old workspace must not expire a newly signed-in UI.
    await signIn(page); await ready(page);
    await page.evaluate(() => { window.__delayNextWork401 = true; });
    await page.getByRole('button', { name: 'Обновить работу', exact: true }).click(); await page.waitForFunction(() => typeof window.__releaseOld401 === 'function');
    await page.getByRole('button', { name: 'Выйти', exact: true }).click(); await form(page); await signIn(page); await ready(page);
    await page.evaluate(() => window.__releaseOld401()); await delay(100); await ready(page);
    assert.ok((await api('/api/auth/session', await cookie()).then(response => response.json())).user);
    check(engine, 'Delayed 401 from previous workspace cannot clear a newer login');
    const other = await context.newPage(); trackPage(other); await other.goto(runtime.base + '/#work'); await ready(other);
    await page.getByRole('button', { name: 'Выйти', exact: true }).click(); await form(page); await form(other);
    check(engine, 'Confirmed logout invalidates another tab without waiting for focus or a timer');
    // Session refresh started before login: capture anonymous response then delay it.
    const sessionStarted = deferred(), sessionRelease = deferred();
    await page.route('**/api/auth/session', async route => { const response = await forward(route); sessionStarted.resolve(); await sessionRelease.promise; await route.fulfill({ response }).catch(() => undefined); }, { times: 1 });
    await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await sessionStarted.promise;
    await signIn(page); await ready(page); sessionRelease.resolve(); await delay(100); await ready(page);
    check(engine, 'Old anonymous session response cannot replace successful login');
    // Web Locks serialize shared-cookie mutations, including delayed response delivery.
    assert.equal(await page.evaluate(() => !!navigator.locks), true);
    await ready(other);
    const logoutStarted = deferred(), logoutRelease = deferred();
    await page.route('**/api/auth/logout', async route => { const response = await forward(route); logoutStarted.resolve(); await logoutRelease.promise; await route.fulfill({ response }); }, { times: 1 });
    await page.getByRole('button', { name: 'Выйти', exact: true }).click(); await logoutStarted.promise;
    await other.reload(); await form(other); let otherLogins = 0; other.on('request', request => { if (new URL(request.url()).pathname === '/api/auth/login') otherLogins++; });
    await signIn(other); await delay(100); assert.equal(otherLogins, 0, 'New login waits for logout cookie response');
    logoutRelease.resolve(); await ready(other); await ready(page); assert.equal(otherLogins, 1);
    assert.ok((await api('/api/auth/session', await cookie()).then(response => response.json())).user);
    check(engine, 'Parallel tabs: delayed logout cannot erase following login cookie');
    // Reverse order: hold a successful login response while another tab requests
    // logout. The latter waits for the new cookie, then revokes that exact login.
    const loginStarted = deferred(), loginRelease = deferred();
    const anonymous = route => route.fulfill({ status: 200, contentType: 'application/json', body: '{"user":null,"needsSetup":false,"setupTokenRequired":false}' });
    await page.route('**/api/auth/session', anonymous);
    await page.reload(); await form(page); await page.unroute('**/api/auth/session', anonymous);
    await page.route('**/api/auth/login', async route => { const response = await forward(route); loginStarted.resolve(); await loginRelease.promise; await route.fulfill({ response }); }, { times: 1 });
    await signIn(page); await loginStarted.promise;
    let reverseLogouts = 0; other.on('request', request => { if (new URL(request.url()).pathname === '/api/auth/logout') reverseLogouts++; });
    await other.getByRole('button', { name: 'Выйти', exact: true }).click(); await delay(100); assert.equal(reverseLogouts, 0);
    const reverseDone = other.waitForResponse(response => new URL(response.url()).pathname === '/api/auth/logout');
    loginRelease.resolve(); await (await reverseDone).finished(); await form(page); await form(other); assert.equal(reverseLogouts, 1);
    assert.equal((await api('/api/auth/session', await cookie()).then(response => response.json())).user, null);
    check(engine, 'Parallel tabs: delayed login completes before following logout revokes the new session');
    // Two same-turn form submissions create one login, even before React rerenders.
    let repeatLogins = 0; page.on('request', request => { if (new URL(request.url()).pathname === '/api/auth/login') repeatLogins++; });
    await page.getByLabel('Логин', { exact: true }).fill(login); await page.getByLabel('Пароль', { exact: true }).fill(password);
    await page.evaluate(() => { document.querySelector('form').requestSubmit(); document.querySelector('form').requestSubmit(); });
    await ready(page); assert.equal(repeatLogins, 1); await ready(other);
    check(engine, 'Parallel same-turn login submissions send exactly one POST');

    // CRM and logistics have independent cookies, broadcasts and lock names.
    if (built) {
      // Logistics frontend is deliberately not in the production build (Vite
      // config); test its independent cookie/API here, full UI in source mode.
      assert.equal(await page.evaluate(async credentials => (await fetch('/api/logistics/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(credentials) })).status, { login, password }), 200);
      await page.getByRole('button', { name: 'Выйти', exact: true }).click(); await form(page); await form(other);
      assert.ok(await page.evaluate(async () => (await fetch('/api/logistics/auth/session').then(response => response.json())).user));
      check(engine, 'CRM logout leaves independent logistics API session active; logistics UI is source-only');
    } else {
      const logistics = await context.newPage(); trackPage(logistics); await logistics.goto(runtime.base + '/logistics/'); await form(logistics); await signIn(logistics);
      await expect(logistics.locator('.logistics-shell')).toBeVisible();
      await page.getByRole('button', { name: 'Выйти', exact: true }).click(); await form(page); await form(other);
      await expect(logistics.locator('.logistics-shell')).toBeVisible();
      assert.ok(await logistics.evaluate(async () => (await fetch('/api/logistics/auth/session').then(response => response.json())).user));
      check(engine, 'CRM logout leaves independently authenticated logistics workspace active');
    }
    await context.close(); await browser.close(); browser = undefined;
  }
  assert.deepEqual(report.errors, []); assert.deepEqual(report.externalRequests, []);
  report.passed = true;
} finally {
  await browser?.close(); await runtime?.close(); globalThis.fetch = originalFetch;
  await rm(temp, { recursive: true, force: true });
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, baseline, built, checks: report.checks.length, output }));
  process.chdir(originalCwd);
}
