// Local security regression: temporary synthetic data, no provider traffic or working stores.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer, request as httpRequest } from 'node:http';
import { chromium, webkit, expect as baseExpect } from '@playwright/test';
import { OperationsStore } from '../server/operations-store.ts';
import { emptyDirectories } from '../server/directory-operations.ts';
import { SabyClient, sabyConfigFromEnv } from '../server/saby-client.ts';
import { enabledPages } from '../web/src/page-catalog.ts';
import { writeTripsQaSnapshot, startTripsQaServer } from './qa-trips-runtime.mjs';
import { authenticateContext, bootstrapQaAuth } from './qa-auth.mjs';

const root = resolve(import.meta.dirname, '..');
const built = process.argv.includes('--built');
const output = resolve(process.env.ARTEL_SECURITY_QA_OUTPUT || resolve(root, '.local/security-pages'), built ? 'built' : 'source');
const expect = baseExpect.configure({ timeout: 20000 });
// Never inherit service credentials or background jobs from the invoking shell.
for (const key of Object.keys(process.env)) if (/^(ARTEL_|SABY_|SBER_|BANK_|VAPID_|PUSH_|CHECKO_|CRON_|BLOB_|VERCEL_)/.test(key)) delete process.env[key];
process.env.ARTEL_OPERATOR_QA_BUILT = built ? '1' : '0';
process.env.SABY_WORKFLOW_ENABLED = 'false';
process.env.ARTEL_CABINET_SYNC_ENABLED = 'false';
process.env.ARTEL_GEOCODER_ENABLED = 'false';
process.env.ARTEL_BANK_SYNC_ENABLED = 'false';
process.env.ARTEL_BANK_REQUESTS_ENABLED = 'false';
process.env.PUSH_SCHEDULE_ENABLED = 'false';
const temporary = await mkdtemp(resolve(tmpdir(), 'artel-security-pages-'));
const snapshotDirectory = resolve(temporary, 'snapshot'), operationsDirectory = resolve(temporary, 'store');
const report = { passed: false, syntheticOnly: true, mode: built ? 'built' : 'source', workingStoreAccessed: false, checks: [], pages: [], forms: [], errors: [], consoleErrors: [], failedAssets: [], deniedResponses: [], externalRequests: [], invoiceWorkerMocked: true, staticBankIdentifiersMasked: true };
const check = name => { report.checks.push(name); console.log('PASS', name); };
await mkdir(output, { recursive: true });
const source = await writeTripsQaSnapshot(snapshotDirectory);
const store = new OperationsStore(operationsDirectory);
await store.mutate(source, data => {
  data.sourceOperationsCleared = true;
  data.directories = { ...emptyDirectories(), fleetSeedApplied: true,
    managers: ['admin', 'employee', 'manager', 'logistician'].map(role => ({ id: `qa-${role}`, name: `Учебный ${role}` })),
    vehicles: [{ id: 'qa-vehicle', plate: 'Т000ЕЕ00', capacityLitres: '16000' }],
    drivers: [{ id: 'qa-driver', name: 'Учебный водитель', fullName: 'Учебный водитель', vehicleId: 'qa-vehicle' }],
  };
  return { changed: true, result: null };
});
// A second guard catches server-side fetches in addition to blocked browser egress.
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') {
    report.externalRequests.push({ source: 'server', origin: url.origin });
    return Promise.reject(new Error('External requests forbidden in security QA'));
  }
  return originalFetch(input, init);
};
const denied = async () => { throw new Error('Provider forbidden in synthetic security QA'); };
let runtime, browser;
const selectors = { documents: '.document-archive', overview: '.overview-page', work: '.work-page', shipments: '.shipments-workspace', trips: '.trips-page', payments: '.banking-page', 'cabinet-balances': '.cabinet-page', china: '.china-page', invoices: '.invoice-workspace', operator: '.operator-workspace', accounts: '.account-management', directories: '.directories-page' };
const invoiceFixture = {
  integration: { status: 'read_only', message: 'Синтетический обработчик счетов', checkedAt: '2026-10-28T12:00:00Z' },
  invoiceProfiles: [], invoiceCreation: { mode: 'live', connections: [] }, canPrepare: false,
  organizations: [], buyers: [], connections: [], defaultUnitPrice: '79',
  settings: { defaultUnitPrice: '79', revision: 1, updatedAt: null, updatedBy: null },
  product: { name: 'Учебное топливо', unit: 'л', vatRate: '22', vatMode: 'included' },
  canCreate: false, canEditDefaultPrice: false, history: { status: 'ready', items: [] },
};
async function startBuiltRuntime() {
  const { createProductionRuntime } = await import(pathToFileURL(resolve(root, 'server-render/production.mjs')));
  const setupToken = randomUUID();
  const environment = {
    ARTEL_PUBLIC_ORIGIN: 'https://security-qa.local.test', ARTEL_LISTEN_HOST: '127.0.0.1', PORT: '0',
    ARTEL_SNAPSHOT_DIR: snapshotDirectory, ARTEL_STORE_DIR: operationsDirectory, ARTEL_SETUP_TOKEN: setupToken,
    ARTEL_BANK_REQUESTS_ENABLED: 'false', ARTEL_BANK_SYNC_ENABLED: 'false', ARTEL_CABINET_SYNC_ENABLED: 'false',
    ARTEL_GEOCODER_ENABLED: 'false', SABY_WORKFLOW_ENABLED: 'false', PUSH_SCHEDULE_ENABLED: 'false',
  };
  const production = await createProductionRuntime(environment); await production.start();
  const proxy = createServer((request, response) => {
    const headers = { ...request.headers, host: 'security-qa.local.test' };
    if (headers.origin) headers.origin = environment.ARTEL_PUBLIC_ORIGIN;
    const upstream = httpRequest({ host: '127.0.0.1', port: production.server.address().port, path: request.url, method: request.method, headers }, result => {
      response.writeHead(result.statusCode, result.headers); result.pipe(response);
    });
    upstream.on('error', () => { response.writeHead(502); response.end(); }); request.pipe(upstream);
  });
  await new Promise(done => proxy.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${proxy.address().port}`;
  return { base, bootstrap: async () => {
    const state = await fetch(base + '/api/auth/session').then(response => response.json()); assert.equal(state.needsSetup, true);
    const response = await fetch(base + '/api/auth/setup', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Учебный директор', login: 'qa.security.director', password: randomUUID(), setupToken }) });
    assert.equal(response.status, 200);
    return { cookie: response.headers.get('set-cookie').split(';')[0], user: (await response.json()).user };
  }, server: { close: async () => { await production.stop(); await new Promise(done => proxy.close(done)); } } };
}
try {
  if (built) {
    runtime = await startBuiltRuntime();
  } else {
    runtime = await startTripsQaServer({ root, snapshotDirectory, operationsDirectory, sabyClient: new SabyClient(sabyConfigFromEnv({}), denied) });
    runtime.bootstrap = () => bootstrapQaAuth(runtime.base);
  }
  assert.match(runtime.base, /^http:\/\/127\.0\.0\.1:\d+$/);
  const director = await runtime.bootstrap();
  const call = async (path, method = 'GET', body, cookie = director.cookie, expected = 200) => {
    const response = await fetch(runtime.base + path, { method, headers: { Cookie: cookie, Origin: runtime.base, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    assert.equal(response.status, expected, `${method} ${path}: ${response.status} ${await response.clone().text()}`);
    return response.json();
  };
  const allIds = enabledPages.map(page => page.id);
  const staffSections = ['overview', 'work', 'shipments', 'trips', 'operator', 'directories', 'invoices'].filter(id => allIds.includes(id));
  const credentials = [];
  for (const role of ['admin', 'employee', 'manager', 'logistician']) {
    const login = `qa.security.${role}`, password = randomUUID();
    const { user } = await call('/api/auth/users', 'POST', { name: `Учебный ${role}`, login, password, role, managerId: `qa-${role}`, sections: staffSections }, director.cookie, 201);
    credentials.push({ role, login, password, user });
  }
  const driverAccess = await call('/api/drivers/qa-driver/access', 'POST', { action: 'issue', version: 0 }, director.cookie, 200);
  credentials.push({ role: 'driver', login: driverAccess.access.login, password: driverAccess.temporaryPassword });
  const operator = await call('/api/operator');
  if (Array.isArray(operator.plans)) await call('/api/operator/plans', 'POST', {
    clientName: 'Учебный клиент аудита', idempotencyKey: randomUUID(),
    recipients: [{ id: randomUUID(), name: 'Учебный получатель', bank: 'Учебный банк', card: '0000 0000 0000 0001', phone: '+70000000001', details: 'Синтетические реквизиты', limit: '10000' }],
  }, director.cookie, 201);
  await call('/api/work/tasks', 'POST', { requestId: randomUUID(), title: '<img src=x onerror=alert(1)> Учебная задача', description: 'Синтетическая проверка экранирования', assigneeId: director.user.id }, director.cookie, 201);
  for (const [engine, launcher] of [['chromium', chromium], ['webkit', webkit]]) {
    browser = await launcher.launch({ headless: true });
    const contextFor = async identity => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
      // Native headless WebKit push discovery can stall. Push has separate focused tests.
      await context.addInitScript(() => {
        if (navigator.serviceWorker) Object.defineProperty(navigator.serviceWorker, 'getRegistration', { configurable: true, value: async () => undefined });
        window.__securityCspViolations = [];
        document.addEventListener('securitypolicyviolation', event => window.__securityCspViolations.push(event.effectiveDirective));
      });
      await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin !== runtime.base) { report.externalRequests.push({ source: 'browser', origin: url.origin, engine, role: identity.role }); return route.abort(); }
        if (url.pathname === '/api/invoices' && route.request().method() === 'GET') return route.fulfill({ json: invoiceFixture });
        return route.continue();
      });
      context.on('page', page => {
        page.on('pageerror', error => report.errors.push({ engine, role: identity.role, message: error.message }));
        page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push({ engine, role: identity.role, message: message.text() }); });
        page.on('response', response => {
          if (response.status() >= 400) {
            const item = { engine, role: identity.role, path: new URL(response.url()).pathname, status: response.status(), resource: response.request().resourceType() };
            if (response.status() === 403) report.deniedResponses.push(item); else report.failedAssets.push(item);
          }
        });
      });
      return context;
    };
    const layout = async (page, role, id, width) => {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
      const dimensions = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
      assert.ok(dimensions.document <= width + 1, `${engine}/${role}/${id}/${width}: horizontal overflow ${dimensions.document}`);
      assert.deepEqual(await page.evaluate(() => window.__securityCspViolations), [], `${engine}/${role}/${id}: no CSP regressions`);
      await expect(page.getByText('Не удалось открыть раздел', { exact: true })).toHaveCount(0);
      await expect(page.getByText('Данные пока недоступны', { exact: true })).toHaveCount(0);
      report.pages.push({ engine, role, id, width });
    };
    const visit = async (page, id) => {
      await page.goto(`${runtime.base}/#${id}`); await expect(page.locator(selectors[id])).toBeVisible();
    };
    const context = await contextFor({ role: 'director' });
    await authenticateContext(context, runtime.base, director.cookie);
    const page = await context.newPage();
    // Every enabled route is cold-loaded, including the newer invoices/operator pages.
    for (const item of enabledPages) {
      assert.ok(selectors[item.id], `Define a smoke selector for new page ${item.id}`);
      await visit(page, item.id);
      for (const width of [1440, 390]) {
        await layout(page, 'director', item.id, width);
        // Hide static bank registry identifiers only in the artifact pixels.
        // The browser and API use their real request/authentication paths.
        await page.screenshot({ path: resolve(output, `${engine}-${item.id}-${width}.png`), mask: [page.getByText(/^\d{20}$/)] });
      }
      if (item.id === 'work') {
        await expect(page.getByText('<img src=x onerror=alert(1)> Учебная задача', { exact: true })).toBeVisible();
        assert.equal(await page.locator('.work-page img').count(), 0, 'Task HTML stays literal text');
      }
      const formNames = { work: 'Новая задача', shipments: 'Добавить отгрузку', trips: 'Новый рейс', china: 'Добавить день', accounts: 'Добавить пользователя', directories: 'Добавить', invoices: 'Настройки счетов' };
      const name = formNames[item.id] || (item.id === 'operator' ? (await page.getByRole('button', { name: 'Новая операция', exact: true }).count() ? 'Новая операция' : 'Новая заправка') : null);
      if (name) {
        if (item.id === 'trips' && !await page.getByRole('button', { name, exact: true }).isVisible()) await page.locator('.trips-section-tabs').getByRole('button', { name: 'Рейсы', exact: true }).click();
        await page.getByRole('button', { name, exact: true }).click();
        const editor = page.locator(item.id === 'accounts' ? '.account-form' : 'dialog[open]');
        await expect(editor).toBeVisible();
        assert.ok(await editor.evaluate(el => el.scrollWidth <= el.clientWidth + 1), `${item.id} form fits mobile`);
        report.forms.push({ engine, id: item.id, width: 390 });
        if (item.id === 'accounts') await editor.getByRole('button', { name: 'Отмена', exact: true }).click();
        else await page.keyboard.press('Escape');
      }
    }
    await visit(page, 'overview');
    for (const item of enabledPages) {
      if (await page.locator('.sidebar').evaluate(el => el.inert)) await page.getByRole('button', { name: 'Открыть меню', exact: true }).click();
      await page.locator('.sidebar nav').getByRole('button', { name: item.title, exact: true }).click();
      await expect(page.locator(selectors[item.id])).toBeVisible();
    }
    check(`${engine}: ${enabledPages.length} pages cold-loaded at desktop/mobile, forms, literal HTML, sidebar navigation`);
    await context.close();

    for (const identity of credentials) {
      const staff = await contextFor(identity), staffPage = await staff.newPage();
      await staffPage.goto(runtime.base);
      await expect(staffPage.getByRole('heading', { name: 'Вход', exact: true })).toBeVisible();
      await staffPage.getByLabel('Логин', { exact: true }).fill(identity.login);
      await staffPage.getByLabel('Пароль', { exact: true }).fill(identity.password);
      await staffPage.getByRole('button', { name: 'Войти', exact: true }).click();
      await expect(staffPage.locator(identity.role === 'driver' ? '.driver-shell' : '.app-shell')).toBeVisible();
      // Browser loopback secure-context exceptions differ from APIRequestContext's
      // cookie jar. Verify the actual browser session, then send that exact
      // synthetic cookie explicitly for negative API and revocation assertions.
      const session = await staffPage.evaluate(async () => (await fetch('/api/auth/session')).json());
      assert.equal(session.user.role, identity.role);
      const sessionCookie = (await staff.cookies()).filter(cookie => cookie.name === 'artel_session').map(cookie => `${cookie.name}=${cookie.value}`).join('; ');
      assert.ok(sessionCookie, 'Browser retains the authenticated session cookie');
      const apiHeaders = { Cookie: sessionCookie, Origin: runtime.base };
      const staffPages = identity.role === 'admin' ? allIds : staffSections;
      if (identity.role === 'driver') {
        await expect(staffPage.locator('.driver-shell')).toBeVisible();
        for (const width of [1440, 390]) await layout(staffPage, identity.role, 'driver-trips', width);
        assert.equal((await staff.request.get(`${runtime.base}/api/auth/users`, { headers: apiHeaders })).status(), 403);
        assert.equal((await staff.request.get(`${runtime.base}/api/snapshot`, { headers: apiHeaders })).status(), 403);
      } else {
        for (const id of staffPages) {
          await visit(staffPage, id);
          for (const width of [1440, 390]) await layout(staffPage, identity.role, id, width);
        }
        if (identity.role !== 'admin') {
          for (const path of ['/api/auth/users', '/api/banking/operations']) assert.equal((await staff.request.get(runtime.base + path, { headers: apiHeaders })).status(), 403, `${identity.role} cannot read ${path}`);
          assert.equal((await staff.request.post(runtime.base + '/api/auth/users', { headers: apiHeaders, data: {} })).status(), 403);
          await staffPage.goto(runtime.base + '/#accounts');
          await expect(staffPage.getByRole('alert')).toContainText('Раздел недоступен');
          await expect(staffPage.locator('.account-management')).toHaveCount(0);
        }
      }
      if (identity.role !== 'driver' && await staffPage.locator('.sidebar').evaluate(el => el.inert)) await staffPage.getByRole('button', { name: 'Открыть меню', exact: true }).click();
      await staffPage.getByRole('button', { name: 'Выйти', exact: true }).click();
      await expect(staffPage.getByRole('heading', { name: 'Вход', exact: true })).toBeVisible();
      assert.equal((await staff.request.get(runtime.base + '/api/auth/session', { headers: apiHeaders }).then(response => response.json())).user, null);
      assert.equal((await staff.request.get(runtime.base + '/api/snapshot', { headers: apiHeaders })).status(), 401);
      check(`${engine}: ${identity.role} UI login, allowed pages, isolation, logout and revoked session`);
      await staff.close();
    }
    if (built) {
      // Negative CSP checks are isolated from the zero-error normal-page audit.
      const policyContext = await browser.newContext({ serviceWorkers: 'block' });
      await policyContext.route('**/*', route => new URL(route.request().url()).origin === runtime.base ? route.continue() : route.abort());
      const policyPage = await policyContext.newPage();
      const response = await policyPage.goto(runtime.base);
      assert.match(response.headers()['content-security-policy'] || '', /script-src\s+'self'/);
      const result = await policyPage.evaluate(async () => {
        const violations = [];
        document.addEventListener('securitypolicyviolation', event => violations.push(event.effectiveDirective));
        window.__securityInlineExecuted = false;
        const script = document.createElement('script'); script.textContent = 'window.__securityInlineExecuted = true'; document.head.append(script);
        const base = document.createElement('base'); base.href = 'https://forbidden.invalid/'; document.head.append(base);
        await new Promise(done => setTimeout(done, 100));
        return { executed: window.__securityInlineExecuted, baseURI: document.baseURI, violations };
      });
      assert.equal(result.executed, false);
      assert.ok(result.baseURI.startsWith(runtime.base));
      assert.ok(result.violations.some(value => value.startsWith('script-src')));
      assert.ok(result.violations.includes('base-uri'));
      const download = policyPage.waitForEvent('download');
      await policyPage.evaluate(() => {
        const anchor = document.createElement('a');
        anchor.href = URL.createObjectURL(new Blob(['%PDF-1.4\n% synthetic QA download\n'], { type: 'application/pdf' }));
        anchor.download = 'synthetic-security.pdf'; document.body.append(anchor); anchor.click(); anchor.remove();
      });
      assert.equal((await download).suggestedFilename(), 'synthetic-security.pdf');
      await policyContext.close();
      check(`${engine}: CSP blocks inline scripts/base replacement; PDF blob download remains available`);
    }
    await browser.close(); browser = null;
  }
  assert.deepEqual(report.errors, [], 'No uncaught browser errors');
  assert.deepEqual(report.consoleErrors, [], 'No browser console errors');
  assert.deepEqual(report.failedAssets, [], 'No failed page resources or APIs');
  assert.deepEqual(report.deniedResponses, [], 'Allowed pages never receive unexpected 403 responses');
  assert.deepEqual(report.externalRequests, [], 'No external traffic attempted');
  report.passed = true;
  console.log(JSON.stringify({ passed: true, pages: report.pages.length, checks: report.checks.length, forms: report.forms.length, output }));
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  await browser?.close();
  await runtime?.server.close();
  globalThis.fetch = originalFetch;
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
  await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
