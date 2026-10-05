// Browser -> actual Vite live config -> actual scoped proxy -> common CRM API.
// Only the fixed remote HTTPS transport is replaced with loopback. No working data
// or environment files are read. Generated passwords stay in memory, never reports.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer as createViteServer, loadConfigFromFile } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium, expect } from '@playwright/test';
import { createSnapshotMiddleware } from '../server/local-api.ts';
import { SabyClient } from '../server/saby-client.ts';
import { integrationRuntime, integrationConfig } from '../tests/helpers/trip-saby-integration.ts';
import { createLiveApiMiddleware, liveRouteAllowed } from '../../Artel-Logistics/scripts/live-api.ts';

const root = resolve(import.meta.dirname, '../../Artel-Logistics'), crmRoot = resolve(root, '../Artel-CRM');
const outputs = [resolve(root, 'qa/driver-access'), resolve(crmRoot, 'qa/driver-access')];
for (const output of outputs) await mkdir(output, { recursive: true });
const report = { syntheticOnly: true, workingStoreRead: false, productionRequests: 0, realSabyRequests: 0, mockedBrowserResponses: false, actualLiveViteConfig: true, checks: [], browserErrors: [], externalRequests: [], screenshots: [], forwarded: [] };
const check = text => { report.checks.push(text); console.log('PASS', text); };
const rt = await integrationRuntime();
const director = { name: 'Synthetic driver QA owner', login: 'driver.qa.owner', password: randomUUID() };
const logist = { name: 'Synthetic driver QA logist', login: 'driver.qa.logist', password: randomUUID(), role: 'logistician', managerId: 'manager', sections: ['trips', 'directories'] };
const drivers = [{ id: 'driver', date: '2025-04-01', note: 'SYNTHETIC-DRIVER-ONE' }, { id: 'driver-two', date: '2025-04-02', note: 'SYNTHETIC-DRIVER-TWO' }];
const setupToken = randomUUID();
const listen = server => new Promise(done => server.listen(0, '127.0.0.1', done));
const reservePort = async () => { const server = createHttpServer(); await listen(server); const port = server.address().port; await new Promise(done => server.close(done)); return port; };
let main, local, browser;
const secrets = [director.password, logist.password];
const redact = value => secrets.reduce((text, secret) => secret ? text.split(secret).join('[REDACTED]') : text, String(value));
try {
  await rt.store.mutate(rt.source, data => {
    data.directories.customerManagers = [{ companyId: 'customer', managerId: 'manager' }];
    Object.assign(data.directories.drivers[0], { name: 'QA Одинаковое имя', fullName: 'QA Одинаковое имя', phone: '+70000000101' });
    data.directories.drivers.push({ ...data.directories.drivers[0], id: 'driver-two' });
    Object.assign(data.companies.find(row => row.id === 'supplier'), { bankName: 'SYNTHETIC-PRIVATE-BANK', settlementAccount: 'SYNTHETIC-PRIVATE-ACCOUNT' });
    for (const shipment of Object.values(data.shipments)) shipment.fields.trip_notes = drivers[0].note;
    return { changed: true, result: null };
  });
  const denyProvider = async () => { throw new Error('External provider forbidden in driver QA'); };
  const middleware = createSnapshotMiddleware(rt.snapshotDirectory, {
    operationsStore: rt.store, authorizeRequest: () => true, secureCookies: true, setupToken,
    sabyClient: new SabyClient(integrationConfig(), denyProvider), sabyWorkflowMonitoringEnabled: false,
    bankEnvironment: { ARTEL_BANK_SYNC_ENABLED: 'false', ARTEL_BANK_REQUESTS_ENABLED: 'false' },
    bankRequest: denyProvider, sberRequest: denyProvider, fetcher: denyProvider, checkoApiKey: '',
    pushConfig: { publicKey: '', privateKey: '', subject: '', schedule: false }, pushSender: denyProvider,
  });
  main = await createViteServer({ configFile: false, envDir: false, root: resolve(crmRoot, 'web'), cacheDir: resolve(rt.directory, 'vite-crm'), plugins: [react(), { name: 'synthetic-driver-qa-api', configureServer(server) { server.middlewares.use(middleware); } }], server: { host: '127.0.0.1', port: await reservePort(), strictPort: true, cors: false, fs: { strict: true, allow: [resolve(crmRoot, 'web'), resolve(crmRoot, 'node_modules')], deny: ['**/data/**', '**/.env*'] } } });
  await main.listen();
  const mainBase = `http://127.0.0.1:${main.httpServer.address().port}`;
  const setup = await fetch(mainBase + '/api/auth/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...director, setupToken }) });
  assert.equal(setup.status, 200, 'Synthetic director setup');
  const loaded = await loadConfigFromFile({ command: 'serve', mode: 'live' }, resolve(root, 'vite.config.ts'), root);
  assert.ok(loaded); assert.equal(loaded.config.envDir, false);
  const port = await reservePort();
  assert.ok(![5173, 5186, 5187, 4186].includes(port));
  const proxy = createLiveApiMiddleware({ port, interfaceAddress: () => '127.0.0.1', upstreamRequest(options, callback) {
    assert.equal(options.hostname, 'artel-crm.online'); assert.equal(options.rejectUnauthorized, true);
    assert.ok(String(options.path).startsWith('/api/logistics/'));
    report.forwarded.push({ method: options.method, path: options.path });
    return httpRequest({ ...options, protocol: 'http:', hostname: '127.0.0.1', host: undefined, port: main.httpServer.address().port, localAddress: '127.0.0.1' }, callback);
  } });
  let replaced = 0;
  const plugins = loaded.config.plugins.flat(Infinity).map(plugin => plugin?.name !== 'artel-logistics-live-api' ? plugin : (replaced++, { name: 'artel-logistics-live-api-injected-driver-qa', configureServer(server) { server.middlewares.use(proxy); } }));
  assert.equal(replaced, 1);
  local = await createViteServer({ ...loaded.config, root: resolve(root, loaded.config.root), configFile: false, mode: 'live', cacheDir: resolve(rt.directory, 'vite-local'), plugins, server: { ...loaded.config.server, port } });
  await local.listen(); const localBase = `http://127.0.0.1:${port}`;
  const targets = [{ name: 'crm', base: mainBase, path: '/', prefix: '/api' }, { name: 'logistics', base: localBase, path: '/logistics/', prefix: '/api/logistics' }];
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const newPage = async target => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, serviceWorkers: 'block', reducedMotion: 'reduce', timezoneId: 'Europe/Moscow' });
    await context.route('**/*', route => {
      if (new URL(route.request().url()).origin === target.base) return route.continue();
      report.externalRequests.push(new URL(route.request().url()).origin); return route.abort();
    });
    const page = await context.newPage(); page.on('pageerror', error => report.browserErrors.push(redact(error.message))); return page;
  };
  const login = async (page, target, credentials) => {
    await page.goto(target.base + target.path);
    await page.getByLabel('Логин', { exact: true }).fill(credentials.login);
    await page.getByLabel('Пароль', { exact: true }).fill(credentials.password);
    await page.getByRole('button', { name: 'Войти', exact: true }).click();
  };
  // Chromium executes requests so Secure loopback cookies use the same policy as UI.
  const call = async (page, path, method = 'GET', body, expected = 200) => {
    const result = await page.evaluate(async ({ path, method, body }) => {
      const response = await fetch(path, { method, cache: 'no-store', headers: body === undefined ? {} : { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const text = await response.text(); let data; try { data = JSON.parse(text); } catch { data = null; }
      return { status: response.status, data, text };
    }, { path, method, body });
    assert.equal(result.status, expected, `${method} ${path}: expected ${expected}, received ${result.status}`);
    return result.data;
  };
  const admins = [];
  for (const target of targets) {
    const page = await newPage(target); await login(page, target, director); admins.push(page);
    await expect(page.getByRole('button', { name: 'Выйти', exact: true })).toBeVisible();
  }
  await call(admins[0], '/api/auth/users', 'POST', logist, 201);
  drivers[0].tripId = rt.tripId;
  const created = await call(admins[0], '/api/shipment-trips', 'POST', {
    idempotencyKey: randomUUID(), fields: { organization_id: 'artel', date: drivers[1].date, supplier_id: 'supplier', oil_depot_id: 'depot', product_id: 'product', purchase_price_unspecified_unit: '50000', quantity_tonnes: '8', driver_id: drivers[1].id, vehicle_id: 'vehicle', trip_notes: drivers[1].note },
    customers: [{ fields: { customer_id: 'customer', manager_id: 'manager', payment_form_id: 'payment', quantity_litres: '7000', sale_price_per_litre: '60', transport_amount: '1000' } }],
  }, 201);
  drivers[1].tripId = created.trip.id;
  const initialShipments = structuredClone((await rt.store.read(rt.source)).shipments);
  check('Both actual frontends use one disposable CRM store; logistics uses the real live Vite config and restricted proxy with injected loopback transport');
  for (const method of ['GET', 'POST', 'PATCH']) assert.equal(liveRouteAllowed('/api/logistics/drivers/driver/access', method), true);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) assert.equal(liveRouteAllowed('/api/logistics/driver/trips', method), false);
  for (const path of ['/api/logistics/driver/trips/x/files/y', '/api/logistics/driver/users', '/api/logistics/drivers/x/access/extra', '/api/logistics/auth/users', '/api/snapshot']) assert.equal(liveRouteAllowed(path, 'GET'), false);
  for (const method of ['POST', 'PUT', 'PATCH']) assert.equal(liveRouteAllowed('/api/logistics/shipment-trips/x/saby-workflow', method), false);
  check('Proxy permits only driver trip reads and exact access-management routes; generic driver paths, full CRM and Saby writes remain blocked');

  const openDriver = async (page, target, index) => {
    if (target.name === 'crm') {
      await page.goto(target.base + '/#accounts');
      await page.getByRole('button', { name: 'Добавить пользователя', exact: true }).click();
      await page.getByLabel('Полномочия', { exact: true }).selectOption('driver');
      await page.getByLabel('Водитель справочника', { exact: true }).selectOption(drivers[index].id);
      const panel = page.locator('.account-driver-editor');
      await expect(panel.getByRole('heading', { name: 'Доступ водителя', exact: true })).toBeVisible();
      return panel;
    }
    await page.goto(target.base + target.path + '#drivers');
    if (target.name === 'crm') await page.getByRole('group', { name: 'Справочники', exact: true }).getByRole('button', { name: 'Водители', exact: true }).click();
    await page.getByRole('button', { name: 'Редактировать: QA Одинаковое имя', exact: true }).nth(index).click();
    const dialog = page.getByRole('dialog'); await expect(dialog.getByRole('heading', { name: 'Доступ водителя', exact: true })).toBeVisible(); return dialog;
  };
  const closeDriver = async dialog => { await dialog.getByRole('button', { name: /^(Закрыть карточку справочника|Закрыть доступ водителя)$/ }).click(); await expect(dialog).toHaveCount(0); };
  const takeCredential = async (dialog, driver) => {
    const password = dialog.getByLabel('Временный пароль водителя', { exact: true }); await expect(password).toBeVisible();
    assert.equal(await password.getAttribute('type'), 'password');
    driver.login = await dialog.getByLabel('Логин водителя', { exact: true }).inputValue();
    driver.password = await password.inputValue(); secrets.push(driver.password);
    assert.ok(driver.password.length >= 16, 'Temporary password must have at least 16 characters');
    await dialog.getByRole('button', { name: 'Показать временный пароль', exact: true }).click();
    assert.equal(await password.getAttribute('type'), 'text');
    await dialog.getByRole('button', { name: 'Скрыть временный пароль', exact: true }).click();
    assert.equal(await password.getAttribute('type'), 'password');
    await expect(dialog.getByRole('button', { name: 'Скопировать данные входа', exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Данные переданы', exact: true }).click(); await expect(password).toHaveCount(0);
  };
  for (const [index, target] of targets.entries()) {
    const page = admins[index], driver = drivers[index]; const dialog = await openDriver(page, target, index);
    await expect(dialog).toContainText('Доступ ещё не выдан');
    let firstIssuedId;
    if (index === 1) {
      const endpoint = target.base + `${target.prefix}/drivers/${driver.id}/access`;
      let lost = false;
      await page.route(endpoint, async route => {
        if (lost || route.request().method() !== 'POST') return route.fallback();
        lost = true; const response = await route.fetch(); assert.equal(response.status(), 200);
        firstIssuedId = (await response.json()).access.userId;
        // The real write succeeded, but the browser never receives the password.
        await route.abort('connectionfailed');
      });
      await dialog.getByRole('button', { name: 'Выдать доступ', exact: true }).click();
      await expect(dialog.getByRole('alert')).toContainText('не подтверждён');
      await expect(dialog.getByRole('button', { name: 'Выдать доступ', exact: true })).toBeDisabled();
      await expect(dialog.getByLabel('Временный пароль водителя', { exact: true })).toHaveCount(0);
      await dialog.getByRole('button', { name: 'Проверить доступ снова', exact: true }).click();
      await expect(dialog).toContainText('Доступ активен');
      await page.unroute(endpoint);
      await dialog.getByRole('button', { name: 'Выдать новый пароль', exact: true }).click();
      await dialog.getByRole('button', { name: 'Подтвердить новый пароль', exact: true }).click();
    } else await dialog.getByRole('button', { name: 'Выдать доступ', exact: true }).click();
    await takeCredential(dialog, driver);
    await expect(dialog).toContainText('Доступ активен');
    const response = await call(page, `${target.prefix}/drivers/${driver.id}/access`); driver.access = response.access;
    if (firstIssuedId) assert.equal(response.access.userId, firstIssuedId);
    assert.equal(response.access.loginUrl, 'https://artel-crm.online/'); assert.equal(response.access.driverId, driver.id);
    assert.equal(response.access.login, driver.login); assert.equal(response.temporaryPassword, undefined);
    const repeat = await call(page, `${target.prefix}/drivers/${driver.id}/access`, 'POST', { action: 'issue', version: response.access.version });
    assert.equal(repeat.temporaryPassword, undefined); assert.equal(repeat.access.userId, response.access.userId); assert.equal(repeat.access.version, response.access.version);
    await call(page, `${target.prefix}/drivers/${driver.id}/access`, 'POST', { action: 'issue', version: 0 }, 409);
    await closeDriver(dialog);
  }
  assert.notEqual(drivers[0].access.userId, drivers[1].access.userId); assert.notEqual(drivers[0].login, drivers[1].login); assert.notEqual(drivers[0].password, drivers[1].password);
  check('Admin issues distinct strong credentials in both frontends; a lost successful issuance recovers the same account, matching contacts do not merge IDs, and repeated/stale issue creates no duplicate');

  for (const [index, target] of targets.entries()) {
    const page = admins[index], other = 1 - index, dialog = await openDriver(page, target, other);
    await expect(dialog.getByLabel('Логин водителя', { exact: true })).toHaveValue(drivers[other].login);
    await expect(dialog).toContainText('Доступ активен'); await expect(dialog.getByLabel('Временный пароль водителя', { exact: true })).toHaveCount(0); await closeDriver(dialog);
    const directory = await call(page, target.name === 'crm' ? '/api/snapshot?shipments=omit' : '/api/logistics/context');
    const serialized = JSON.stringify(directory); assert.doesNotMatch(serialized, /passwordHash|temporaryPassword|"salt"/);
    for (const secret of secrets) assert.ok(!serialized.includes(secret), 'Read API must not expose passwords');
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      if (target.name === 'logistics') {
        const menu = page.getByRole('combobox', { name: 'Раздел логистики', exact: true });
        await menu.selectOption('vehicles'); await expect(page.getByRole('heading', { name: 'Автомобили', level: 1, exact: true })).toBeVisible();
        await menu.selectOption('drivers'); await expect(page.getByRole('heading', { name: 'Водители', level: 1, exact: true })).toBeVisible();
      } else {
        await page.goto(target.base + '/#directories');
        const tabs = page.getByRole('group', { name: 'Справочники', exact: true });
        await tabs.getByRole('button', { name: 'Автомобили', exact: true }).click(); await tabs.getByRole('button', { name: 'Водители', exact: true }).click();
      }
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${target.name} directories fit ${width}px`);
      const imagePath = resolve(outputs[index], `${target.name}-directories-${width}.png`); await page.screenshot({ path: imagePath, fullPage: true }); report.screenshots.push(imagePath);
    }
    await page.setViewportSize({ width: 1440, height: 1050 });
    if (target.name === 'logistics') {
      const work = page.locator('.logistics-nav-group').filter({ has: page.getByText('Рабочее место', { exact: true }) });
      const directories = page.locator('.logistics-nav-group').filter({ has: page.getByText('Справочники', { exact: true }) });
      await expect(work.getByRole('link', { name: 'Рейсы', exact: true })).toBeVisible();
      for (const title of ['Автомобили', 'Водители']) { await expect(work.getByRole('link', { name: title, exact: true })).toHaveCount(0); await expect(directories.getByRole('link', { name: title, exact: true })).toBeVisible(); }
    }
    await expect(page.getByRole('button', { name: 'Очистка справочников', exact: true })).toHaveCount(0);
    for (const title of ['Компании', 'Перевозчики']) {
      await expect(page.getByRole('button', { name: title, exact: true })).toHaveCount(0);
      await expect(page.getByRole('link', { name: title, exact: true })).toHaveCount(0);
    }
  }
  check('The other frontend reads the same driver login/state without exposing secrets; cars/drivers are in directories and mobile navigation works at 390/320 px');

  const sessions = [];
  for (const target of targets) for (const [index, driver] of drivers.entries()) {
    const page = await newPage(target); const seenApis = [];
    page.on('request', request => { const path = new URL(request.url()).pathname; if (path.startsWith('/api/')) seenApis.push(path); });
    await login(page, target, driver); await expect(page.getByRole('heading', { name: 'Мои рейсы', exact: true })).toBeVisible();
    const list = await call(page, `${target.prefix}/driver/trips`); assert.equal(list.total, 1); assert.equal(list.trips.length, 1); assert.equal(list.trips[0].id, driver.tripId);
    const own = await call(page, `${target.prefix}/driver/trips/${driver.tripId}`); assert.equal(own.trip.id, driver.tripId);
    const expectedDeliveries = Object.entries(initialShipments).filter(([, row]) => row.fields.trip_id === driver.tripId).map(([id]) => id).sort();
    assert.deepEqual(own.trip.deliveries.map(row => row.id).sort(), expectedDeliveries);
    assert.deepEqual(list.trips[0].deliveries.map(row => row.id).sort(), expectedDeliveries);
    const safe = JSON.stringify({ list, own }); assert.ok(!safe.includes(drivers[1 - index].tripId)); assert.ok(!safe.includes(drivers[1 - index].note)); assert.doesNotMatch(safe, /SYNTHETIC-PRIVATE|passwordHash|temporaryPassword|purchase_price|sale_price|transport_amount|"margin"/);
    await call(page, `${target.prefix}/driver/trips/${drivers[1 - index].tripId}`, 'GET', undefined, 404);
    const search = await call(page, `${target.prefix}/driver/trips?q=${encodeURIComponent(drivers[1 - index].note)}`); assert.equal(search.total, 0); assert.deepEqual(search.trips, []);
    const searchInput = page.getByLabel('Поиск моих рейсов', { exact: true }); await searchInput.fill(drivers[1 - index].date);
    await expect(page.getByRole('link', { name: /^Открыть рейс / })).toHaveCount(0); await searchInput.fill('');
    await expect(page.getByRole('link', { name: /^Открыть рейс / })).toHaveCount(1); await page.getByRole('link', { name: /^Открыть рейс / }).click();
    await expect(page.locator('body')).not.toContainText(drivers[1 - index].note);
    for (const name of ['Новый рейс', 'Изменить рейс', 'Выдать доступ', 'Создать заявку в Saby']) await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
    for (const width of [390, 320]) { await page.setViewportSize({ width, height: 1000 }); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${target.name} driver ${index} fit ${width}`); }
    const imagePath = resolve(outputs[target.name === 'crm' ? 1 : 0], `${target.name}-driver-${index + 1}-320.png`); await page.screenshot({ path: imagePath, fullPage: true }); report.screenshots.push(imagePath);
    await page.goto(target.base + target.path + `#driver-trip/${drivers[1 - index].tripId}`);
    await expect(page.getByRole('alert')).toContainText('Рейс не найден');
    await expect(page.locator('.driver-trip-detail')).toHaveCount(0);
    // Attack all namespaces directly, including endpoints omitted by the driver UI.
    const deny = async (path, method = 'GET', body) => {
      const result = await page.evaluate(async ({ path, method, body }) => { const response = await fetch(path, { method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, text: await response.text() }; }, { path, method, body });
      assert.ok([401, 403, 404, 405].includes(result.status), `${target.name} driver denied ${method} ${path}, received ${result.status}`);
      assert.ok(!result.text.includes('SYNTHETIC-PRIVATE')); assert.ok(!result.text.includes(drivers[1 - index].note));
    };
    for (const path of ['/api/snapshot', '/api/shipments?search=SYNTHETIC', '/api/payments', '/api/banking/connections', '/api/auth/users', '/api/directories', '/api/logistics/context', `${target.prefix}/drivers/${driver.id}/access`, `${target.prefix}/shipment-trips`, `${target.prefix}/shipment-trips/${drivers[1 - index].tripId}`, `${target.prefix}/shipment-trips/${driver.tripId}/etrn`, `${target.prefix}/shipment-trips/${drivers[1 - index].tripId}/etrn/files/doc/file`, `${target.prefix}/driver/trips/${drivers[1 - index].tripId}/files/file`]) await deny(path);
    for (const [path, method, body] of [[`${target.prefix}/driver/trips/${driver.tripId}`, 'PATCH', {}], [`${target.prefix}/shipment-trips/${driver.tripId}`, 'PATCH', {}], [`${target.prefix}/shipment-trips/${driver.tripId}`, 'DELETE', {}], [`${target.prefix}/directories`, 'POST', { kind: 'drivers', name: 'FORBIDDEN' }], [`${target.prefix}/drivers/${driver.id}/access`, 'POST', { action: 'reset', version: driver.access.version }], [`${target.prefix}/shipment-trips/${driver.tripId}/saby-workflow`, 'POST', {}]]) await deny(path, method, body);
    // Keep automatic UI calls separate from deliberate probes above.
    assert.ok(!seenApis.slice(0, seenApis.findIndex(path => path === `${target.prefix}/driver/trips`) + 1).some(path => /snapshot|context|banking/.test(path)));
    sessions.push({ page, target, driverIndex: index });
  }
  check('Two same-name drivers log into both frontends with distinct accounts, see one own trip and deliveries, and no financial fields; search/counts and direct foreign IDs enforce ownership');
  check('Forged own/foreign file/document requests, full CRM/bank/user APIs, directory writes, trip changes/deletes and Saby actions fail closed for every driver session');

  const logistSessions = [];
  for (const target of targets) {
    const page = await newPage(target); await login(page, target, logist); await page.goto(target.base + target.path + '#trips');
    await expect(page.getByTestId('trip-card')).toHaveCount(2);
    await call(page, `${target.prefix}/shipment-trips`);
    await call(page, `${target.prefix}/drivers/driver/access`, 'GET', undefined, 403); logistSessions.push({ page, target });
  }
  check('Existing logist keeps both managed trips and cannot administer driver access; director keeps shared CRM and logistics administration');
  const resetDriver = drivers[0], oldPassword = resetDriver.password;
  let dialog = await openDriver(admins[1], targets[1], 0);
  await dialog.getByRole('button', { name: 'Выдать новый пароль', exact: true }).click(); await dialog.getByRole('button', { name: 'Подтвердить новый пароль', exact: true }).click(); await takeCredential(dialog, resetDriver); await closeDriver(dialog);
  assert.notEqual(resetDriver.password, oldPassword);
  const reset = await call(admins[0], '/api/drivers/driver/access'); assert.equal(reset.access.userId, resetDriver.access.userId); assert.equal(reset.access.version, resetDriver.access.version + 1); resetDriver.access = reset.access;
  for (const session of sessions.filter(session => session.driverIndex === 0)) await call(session.page, `${session.target.prefix}/driver/trips`, 'GET', undefined, 401);
  for (const target of targets) {
    const page = await newPage(target); await page.goto(target.base + target.path);
    await call(page, `${target.prefix}/auth/login`, 'POST', { login: resetDriver.login, password: oldPassword }, 401);
    await login(page, target, resetDriver); await expect(page.getByRole('heading', { name: 'Мои рейсы', exact: true })).toBeVisible();
    sessions.push({ page, target, driverIndex: 0, reset: true });
  }
  check('Password reset from logistics is visible in CRM, preserves driver userId, rejects the old password and invalidates both previous sessions');
  dialog = await openDriver(admins[0], targets[0], 0);
  await dialog.getByRole('button', { name: 'Отозвать доступ', exact: true }).click(); await dialog.getByRole('button', { name: 'Подтвердить отзыв', exact: true }).click(); await expect(dialog).toContainText('Доступ отозван'); await closeDriver(dialog);
  for (const session of sessions.filter(session => session.reset)) await call(session.page, `${session.target.prefix}/driver/trips`, 'GET', undefined, 401);
  const revoked = await call(admins[1], '/api/logistics/drivers/driver/access'); assert.equal(revoked.access.active, false); assert.equal(revoked.access.userId, resetDriver.access.userId);
  const revokedPage = await newPage(targets[0]); await revokedPage.goto(mainBase + '/'); await call(revokedPage, '/api/auth/login', 'POST', { login: resetDriver.login, password: resetDriver.password }, 401);
  dialog = await openDriver(admins[0], targets[0], 0); await dialog.getByRole('button', { name: 'Выдать новый пароль', exact: true }).click(); await dialog.getByRole('button', { name: 'Подтвердить новый пароль', exact: true }).click(); await takeCredential(dialog, resetDriver); await closeDriver(dialog);
  const restored = await call(admins[1], '/api/logistics/drivers/driver/access'); assert.equal(restored.access.userId, resetDriver.access.userId); assert.equal(restored.access.active, true);
  await login(revokedPage, targets[0], resetDriver); await expect(revokedPage.getByRole('heading', { name: 'Мои рейсы', exact: true })).toBeVisible();
  for (const session of sessions.filter(session => session.driverIndex === 1)) assert.equal((await call(session.page, `${session.target.prefix}/driver/trips`)).total, 1);
  for (const { page, target } of logistSessions) await call(page, `${target.prefix}/shipment-trips`);
  for (const [index, target] of targets.entries()) await call(admins[index], `${target.prefix}/drivers/driver/access`);
  const finalStore = await rt.store.read(rt.source);
  assert.deepEqual(finalStore.shipments, initialShipments);
  assert.equal(finalStore.accounts.users.filter(user => user.role === 'driver').length, 2);
  for (const driver of drivers) { const user = finalStore.accounts.users.find(user => user.driverId === driver.id); assert.ok(user); assert.ok(user.passwordHash); assert.equal(user.password, undefined); assert.equal(user.temporaryPassword, undefined); }
  const serializedStore = JSON.stringify(finalStore); for (const secret of secrets) assert.ok(!serializedStore.includes(secret), 'Store persists only password hashes');
  assert.deepEqual(report.browserErrors, []); assert.deepEqual(report.externalRequests, []);
  check('Revocation is shared and immediately closes both sessions; reissue restores the same account, the other driver/logist/director remain active, no trip/account duplication or plaintext password is persisted');
  report.passed = true;
} catch (error) {
  report.passed = false; report.error = redact(error.message);
  // Deliberately do not capture DOM or failure screenshots: an issuance panel
  // may contain a one-time secret, even when the visible input is masked.
  throw new Error(report.error);
} finally {
  await browser?.close(); await local?.close(); await main?.close(); await rt.close();
  for (const output of outputs) await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
}
