// UI feedback audit. All writes target a disposable synthetic loopback store.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium, webkit, expect as baseExpect } from '@playwright/test';
import { writeTripsQaSnapshot } from './qa-trips-runtime.mjs';
import { startOperatorQaServer } from './qa-operator-runtime.mjs';
import { authenticateContext } from './qa-auth.mjs';
import { enabledPages } from '../web/src/page-catalog.ts';
const root = resolve(import.meta.dirname, '..'), built = process.argv.includes('--built');
const output = resolve(process.env.ARTEL_UI_FEEDBACK_OUTPUT || resolve(root, '../ui-feedback'), built ? 'built' : 'source');
const crudOnly = process.argv.includes('--crud-only');
const engines = process.env.ARTEL_UI_FEEDBACK_ENGINE ? [process.env.ARTEL_UI_FEEDBACK_ENGINE] : ['chromium', 'webkit'];
const expect = baseExpect.configure({ timeout: 20000 });
for (const key of Object.keys(process.env)) if (/^(ARTEL_|SABY_|SBER_|BANK_|VAPID_|PUSH_|CHECKO_|CRON_|BLOB_|VERCEL_)/.test(key)) delete process.env[key];
Object.assign(process.env, { ARTEL_OPERATOR_QA_BUILT: built ? '1' : '0', SABY_WORKFLOW_ENABLED: 'false', ARTEL_CABINET_SYNC_ENABLED: 'false', ARTEL_GEOCODER_ENABLED: 'false', ARTEL_BANK_SYNC_ENABLED: 'false', ARTEL_BANK_REQUESTS_ENABLED: 'false', PUSH_SCHEDULE_ENABLED: 'false' });
const temporary = await mkdtemp(resolve(tmpdir(), 'artel-ui-feedback-'));
await mkdir(output, { recursive: true });
const report = { passed: false, requestedFilters: { engines, crudOnly, skipWork: process.argv.includes('--skip-work'), skipEscape: process.argv.includes('--skip-escape') }, syntheticOnly: true, mode: built ? 'built' : 'source', workingStoreAccessed: false, pages: [], mutations: [], forms: [], errors: [], externalRequests: [], screenshots: [], observations: [], skipped: [
  { area: 'Bank/provider connectivity', reason: 'Real synchronization and bank writes are outside UI QA; no credentials, signatures or provider requests.' },
  { area: 'Invoice business create/delete', reason: 'Worker catalog/history is synthetic; external invoice creation is not executed.' },
  { area: 'Cabinet connect/delete', reason: 'Connection requires credential storage/provider authentication. Empty/error/loading UI is tested; credentials are never supplied.' },
  { area: 'Every domain mutation combination', reason: 'This harness exercises representative real API CRUD for directories/work/documents/operator. Existing domain suites remain responsible for shipment/trip/permissions/business edge cases.' },
] };
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') { report.externalRequests.push({ source: 'server', origin: url.origin }); return Promise.reject(new Error('External request forbidden in UI audit')); }
  return originalFetch(input, init);
};
const snapshotDirectory = resolve(temporary, 'snapshot'), operationsDirectory = resolve(temporary, 'store');
await writeTripsQaSnapshot(snapshotDirectory);
let runtime, browser, context;
const selectors = { documents: '.document-archive', overview: '.overview-page', work: '.work-page', shipments: '.shipments-workspace', trips: '.trips-page', payments: '.banking-page', 'cabinet-balances': '.cabinet-page', china: '.china-page', invoices: '.invoice-workspace', operator: '.operator-workspace', accounts: '.account-management', directories: '.directories-page' };
const endpoints = { overview: '/api/settlements', work: '/api/work', shipments: '/api/snapshot', trips: '/api/trip-requests/context', payments: '/api/snapshot', 'cabinet-balances': '/api/cabinets', china: '/api/china', invoices: '/api/invoices', operator: '/api/operator', accounts: '/api/snapshot', directories: '/api/snapshot', documents: '/api/documents' };
const invoiceFixture = { integration: { status: 'read_only', message: 'Синтетический обработчик счетов', checkedAt: '2026-11-05T12:00:00Z' }, invoiceProfiles: [], invoiceCreation: { mode: 'live', connections: [] }, canPrepare: false, organizations: [], buyers: [], connections: [], defaultUnitPrice: '79', settings: { defaultUnitPrice: '79', revision: 1, updatedAt: null, updatedBy: null }, product: { name: 'Учебное топливо', unit: 'л', vatRate: '22', vatMode: 'included' }, canCreate: false, canEditDefaultPrice: false, history: { status: 'ready', items: [] } };
const check = value => { report.observations.push(value); console.log('PASS', value); };
const shot = async (page, name) => { const path = resolve(output, name + '.png'); await page.screenshot({ path, fullPage: true }); report.screenshots.push(path); };
async function fits(page, name) {
  const geometry = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
  assert.ok(geometry.document <= geometry.viewport + 1, `${name}: horizontal overflow ${JSON.stringify(geometry)}`);
  return geometry;
}
const gates = new WeakMap();
async function hold(page, path, method = 'GET', fail = false) {
  let release, reached, hits = 0;
  const wait = new Promise(done => { release = done; });
  const entered = new Promise(done => { reached = done; });
  const gate = { path, method, fail, wait, entered, hits: () => hits, hit: () => { hits++; reached(); }, release, close: async () => { release(); if (gates.get(page) === gate) gates.delete(page); } };
  gates.set(page, gate); return gate;
}
async function pending(page, scope, button, path, method, label, fail = false) {
  const gate = await hold(page, path, method, fail), handle = await button.elementHandle();
  try {
    await button.click(); await Promise.race([gate.entered, new Promise((_, reject) => setTimeout(() => reject(new Error(label + ': request was not sent')), 15000))]);
    assert.equal(await handle.evaluate(el => el.disabled), true, label + ': active action locked');
    assert.ok(await scope.evaluate(el => el.scrollWidth <= el.clientWidth + 1), label + ': dialog fits');
    await scope.evaluate(el => { window.__dialogAudit = []; for (const type of ['cancel', 'close']) el.addEventListener(type, event => { queueMicrotask(() => window.__dialogAudit.push({ type, cancelable: event.cancelable, trusted: event.isTrusted, prevented: event.defaultPrevented, open: el.open, connected: el.isConnected })); }); });
    if (!process.argv.includes('--skip-escape')) await page.keyboard.press('Escape');
    const audit = await page.evaluate(() => ({ events: window.__dialogAudit, dialogs: [...document.querySelectorAll('dialog')].map(el => ({ open: el.open, inert: el.inert, motion: el.dataset.modalMotion, busy: el.querySelector('form')?.getAttribute('aria-busy'), text: el.textContent.slice(-350) })) }));
    if (!audit.dialogs.some(row => row.open)) console.log('DIALOG FAILURE', label, JSON.stringify(audit));
    await expect(scope).toBeVisible();
    assert.equal(gate.hits(), 1, label + ': exactly one pending request');
    await shot(page, label.replace(/[^a-zA-Z0-9-]/g, '-'));
  } finally { await gate.close(); }
  if (fail) await expect(scope.getByRole('alert')).toContainText('Учебная ошибка');
  else await expect(scope).toHaveCount(0);
  report.mutations.push({ label, path, method, errorInjected: fail, pendingLocked: true, escapeRetained: !process.argv.includes('--skip-escape'), requestsWhileHeld: gate.hits() });
}
try {
  runtime = await startOperatorQaServer({ root, snapshotDirectory, operationsDirectory });
  report.runtime = runtime.mode; report.artifacts = runtime.artifacts;
  const director = await runtime.bootstrap();
  const api = async (path, method = 'GET', body) => {
    const response = await fetch(runtime.base + path, { method, headers: { Cookie: director.cookie, Origin: runtime.base, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json(); assert.ok(response.ok, `${method} ${path}: ${JSON.stringify(result)}`); return result;
  };
  for (const engine of engines) {
    browser = await ({ chromium, webkit })[engine].launch({ headless: true });
    context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block', reducedMotion: 'reduce', timezoneId: 'Europe/Moscow' });
    await authenticateContext(context, runtime.base, director.cookie);
    await context.addInitScript(() => { if (navigator.serviceWorker) Object.defineProperty(navigator.serviceWorker, 'getRegistration', { configurable: true, value: async () => undefined }); });
    let cabinetFixture = null;
    await context.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== runtime.base) { report.externalRequests.push({ source: 'browser', engine, origin: url.origin }); return route.abort(); }
      const gate = gates.get(route.request().frame().page());
      if (gate && gate.path === url.pathname && gate.method === route.request().method()) { gate.hit(); await gate.wait; if (gate.fail) return route.fulfill({ status: 422, json: { error: 'Учебная ошибка: повторите действие. Ввод сохранён.' } }); }
      if (cabinetFixture && url.pathname === '/api/cabinets' && route.request().method() === 'GET') return route.fulfill({ json: cabinetFixture });
      if (url.pathname === '/api/invoices' && route.request().method() === 'GET') return route.fulfill({ json: invoiceFixture });
      return route.continue();
    });
    const page = await context.newPage(); page.on('pageerror', error => report.errors.push({ engine, message: error.message }));
    if (!crudOnly) {
    for (const item of enabledPages) {
      const gate = await hold(page, endpoints[item.id]);
      try {
        await page.goto(runtime.base + '/#' + item.id);
        await Promise.race([gate.entered, new Promise((_, reject) => setTimeout(() => reject(new Error(item.id + ': no gated GET')), 15000))]);
        // Prerequisite snapshot/context gates intentionally use neutral feedback;
        // only a page with its prerequisites ready can own a tailored skeleton.
        const feedback = page.locator('#main-content .page-loading:visible, #main-content .loading-skeleton:visible').first();
        await expect(feedback).toBeVisible();
        const skeleton = page.locator('#main-content .loading-skeleton:visible').first();
        if (await skeleton.count()) {
          const labelBox = await skeleton.locator(':scope > .sr-only').evaluate(el => ({ width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height, overflow: getComputedStyle(el).overflow }));
          assert.ok(labelBox.width <= 1 && labelBox.height <= 1 && labelBox.overflow === 'hidden', item.id + ': skeleton status label is visually hidden');
        }
        if (item.id === 'overview' && await skeleton.count()) {
          await page.emulateMedia({ reducedMotion: 'no-preference' });
          const animation = await skeleton.locator('.loading-skeleton__bar').first().evaluate(el => { const style = getComputedStyle(el, '::after'); const animation = el.getAnimations({ subtree: true }).find(item => item.animationName === 'skeleton-sweep'); return { name: style.animationName, duration: style.animationDuration, keys: animation?.effect.getKeyframes().map(frame => Object.keys(frame).filter(key => !['offset', 'computedOffset', 'easing', 'composite'].includes(key))) }; });
          assert.equal(animation.name, 'skeleton-sweep'); assert.ok(parseFloat(animation.duration) > 0); assert.ok(animation.keys?.every(keys => keys.every(key => key === 'transform')), JSON.stringify(animation));
          report.observations.push({ engine, normalMotion: animation }); await page.emulateMedia({ reducedMotion: 'reduce' });
        }
        for (const width of [1440, 375, 320]) {
          await page.setViewportSize({ width, height: 1000 });
          await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
          const geometry = await fits(page, `${engine}/${item.id}/loading/${width}`);
          assert.equal(await feedback.getAttribute('role'), 'status', item.id + ': feedback announces loading');
          assert.ok((await feedback.getAttribute('aria-label')) || (await feedback.textContent()).trim(), item.id + ': feedback has an accessible loading label');
          const motion = await feedback.evaluate(el => [...el.querySelectorAll('*')].flatMap(node => [getComputedStyle(node), getComputedStyle(node, '::after')]).filter(style => style.animationName !== 'none' && parseFloat(style.animationDuration) > 0.001).map(style => ({ name: style.animationName, duration: style.animationDuration })));
          assert.deepEqual(motion, [], item.id + ': reduced motion removes loading animation');
          report.pages.push({ engine, id: item.id, state: 'loading', width, ...geometry, reducedMotion: true, loadingKind: await feedback.evaluate(el => el.classList.contains('loading-skeleton') ? 'skeleton' : 'neutral') });
          if (['documents', 'trips', 'cabinet-balances', 'overview'].includes(item.id) && width !== 320) await shot(page, `${engine}-${item.id}-loading-${width}`);
        }
      } finally { await gate.close(); }
      await expect(page.locator(selectors[item.id])).toBeVisible();
      await expect(page.locator('#main-content .loading-skeleton')).toHaveCount(0);
      for (const width of [1440, 375, 320]) { await page.setViewportSize({ width, height: 1000 }); await page.evaluate(() => new Promise(done => requestAnimationFrame(done))); report.pages.push({ engine, id: item.id, state: 'loaded', width, ...await fits(page, `${engine}/${item.id}/loaded/${width}`) }); }
      check(`${engine}: ${item.id} held GET loading feedback + loaded UI at 1440/375/320`);
    }
    // Every route is then forced into an HTTP error and reloaded after removing the fault.
    await page.setViewportSize({ width: 375, height: 1000 });
    for (const item of enabledPages) {
      const gate = await hold(page, endpoints[item.id], 'GET', true);
      await page.goto(runtime.base + '/#' + item.id); await gate.entered; gate.release();
      await expect(page.locator('#main-content')).toContainText(/Учебная ошибка|Данные пока недоступны|Не удалось/);
      await expect(page.locator('#main-content .loading-skeleton')).toHaveCount(0);
      await fits(page, `${engine}/${item.id}/error`); report.pages.push({ engine, id: item.id, state: 'error', width: 375 });
      await gate.close(); await page.reload(); await expect(page.locator(selectors[item.id])).toBeVisible(); await expect(page.locator('#main-content .loading-skeleton')).toHaveCount(0);
    }
    check(`${engine}: all 12 routes leave loading on error and recover on reload`);
    }
    await page.setViewportSize({ width: 375, height: 1000 });
    // Real synthetic directory CRUD; 500-character schema cap, long plausible name well below it.
    await page.goto(runtime.base + '/#directories');
    await page.getByRole('group', { name: 'Справочники', exact: true }).getByRole('button', { name: 'Товары', exact: true }).click();
    await page.getByRole('button', { name: 'Добавить', exact: true }).click();
    let dialog = page.locator('dialog[open]'), name = `Дизельное топливо межсезонное для Северо-Западного транспортного подразделения ${engine}`;
    await dialog.getByLabel('Название товара', { exact: true }).fill(name);
    await pending(page, dialog, dialog.getByRole('button', { name: 'Сохранить', exact: true }), '/api/directories', 'POST', `${engine}-directory-create-error`, true);
    await expect(dialog.getByLabel('Название товара', { exact: true })).toHaveValue(name);
    await pending(page, dialog, dialog.getByRole('button', { name: 'Сохранить', exact: true }), '/api/directories', 'POST', `${engine}-directory-create`);
    await expect(page.locator('.directory-notice')).toBeVisible();
    const gap = await page.evaluate(() => document.querySelector('.directory-list').getBoundingClientRect().top - document.querySelector('.directory-notice').getBoundingClientRect().bottom);
    assert.ok(gap >= 12, `Directory success notice has ${gap}px gap`); report.observations.push({ engine, directorySuccessGapPx: gap });
    await shot(page, `${engine}-directory-success-long-text`); await fits(page, 'directory long product');
    await page.getByRole('button', { name: `Редактировать: ${name}`, exact: true }).click(); dialog = page.locator('dialog[open]');
    const editedName = name + ' — уточнено'; await dialog.getByLabel('Название товара', { exact: true }).fill(editedName);
    const catalog = await api('/api/snapshot?shipments=omit&context=directories');
    const product = (catalog.directories ?? catalog).products.find(row => row.name === name);
    await pending(page, dialog, dialog.getByRole('button', { name: 'Сохранить', exact: true }), '/api/directories/products/' + product.id, 'PATCH', `${engine}-directory-edit`);
    await page.getByRole('button', { name: `Удалить: ${editedName}`, exact: true }).click(); dialog = page.locator('dialog[open]');
    await dialog.getByRole('button', { name: 'Отмена', exact: true }).click(); await expect(dialog).toHaveCount(0);
    await page.getByRole('button', { name: `Удалить: ${editedName}`, exact: true }).click(); dialog = page.locator('dialog[open]');
    await pending(page, dialog, dialog.getByRole('button', { name: 'Удалить', exact: true }), '/api/directories/products/' + product.id, 'DELETE', `${engine}-directory-delete-error`, true);
    await pending(page, dialog, dialog.getByRole('button', { name: 'Удалить', exact: true }), '/api/directories/products/' + product.id, 'DELETE', `${engine}-directory-delete`);
    await expect(page.getByRole('button', { name: `Редактировать: ${editedName}`, exact: true })).toHaveCount(0);
    check(`${engine}: directory create/edit/delete, pending lock, error-retained input, retry, cancel and notice spacing`);
    if (!process.argv.includes('--skip-work')) {
    // Work task create/edit/delete. Deletion is guarded by the product's confirmation UI when present.
    await page.goto(runtime.base + '/#work'); await page.getByRole('button', { name: 'Новая задача', exact: true }).click(); dialog = page.locator('dialog[open]');
    const taskName = `Согласовать документы Северо-Западного транспортного подразделения ${engine}`;
    await dialog.getByLabel('Название', { exact: true }).fill(taskName);
    await pending(page, dialog, dialog.getByRole('button', { name: 'Сохранить', exact: true }), '/api/work/tasks', 'POST', `${engine}-work-create-error`, true);
    await expect(dialog.getByLabel('Название', { exact: true })).toHaveValue(taskName);
    await pending(page, dialog, dialog.getByRole('button', { name: 'Сохранить', exact: true }), '/api/work/tasks', 'POST', `${engine}-work-create`);
    const task = (await api('/api/work')).work.tasks.find(row => row.title === taskName);
    const taskCard = page.getByRole('button', { name: 'Задача: ' + taskName, exact: true }), cardHandle = await taskCard.elementHandle();
    const beforeRefresh = await taskCard.boundingBox(), scrollBefore = await page.evaluate(() => scrollY), refreshGate = await hold(page, '/api/work');
    await page.getByRole('button', { name: 'Обновить работу', exact: true }).click(); await refreshGate.entered;
    await expect(page.locator('.loading-progress')).toBeVisible(); await expect(page.locator('#main-content .loading-skeleton')).toHaveCount(0);
    assert.equal(await cardHandle.evaluate(el => el.isConnected), true); assert.deepEqual(await taskCard.boundingBox(), beforeRefresh); assert.equal(await page.evaluate(() => scrollY), scrollBefore);
    await refreshGate.close(); await expect(page.locator('.loading-progress')).toHaveCount(0); assert.equal(await cardHandle.evaluate(el => el.isConnected), true);
    check(`${engine}: refresh keeps same task node, geometry and scroll with fixed progress bar`);
    await page.getByRole('button', { name: 'Задача: ' + taskName, exact: true }).click(); dialog = page.locator('dialog[open]'); await dialog.getByLabel('Описание', { exact: true }).fill('Проверено на учебных данных.');
    await pending(page, dialog, dialog.getByRole('button', { name: 'Сохранить', exact: true }), '/api/work/tasks/' + task.id, 'PATCH', `${engine}-work-edit`);
    await page.getByRole('button', { name: 'Задача: ' + taskName, exact: true }).click(); dialog = page.locator('dialog[open]');
    await dialog.getByRole('button', { name: 'Удалить', exact: true }).click();
    const confirm = dialog.getByRole('button', { name: /Удалить запись|Подтвердить удаление|Удалить задачу/, exact: false });
    await expect(confirm).toBeVisible();
    await pending(page, dialog, confirm, '/api/work/tasks/' + task.id, 'DELETE', `${engine}-work-delete-error`, true);
    await pending(page, dialog, confirm, '/api/work/tasks/' + task.id, 'DELETE', `${engine}-work-delete`);
    await expect(page.getByRole('button', { name: 'Задача: ' + taskName, exact: true })).toHaveCount(0);
    check(`${engine}: work create/edit/delete pending/error/retry + explicit delete confirmation`);
    }
    // Archive categories/cards use real disposable API; files are not needed for a valid empty card.
    await page.goto(runtime.base + '/#documents'); await page.getByRole('button', { name: 'Добавить категорию', exact: true }).click(); dialog = page.locator('dialog[open]');
    const categoryName = `Учебные транспортные документы ${engine}`; await dialog.getByLabel('Название категории', { exact: true }).fill(categoryName);
    await pending(page, dialog, dialog.getByRole('button', { name: 'Сохранить', exact: true }), '/api/documents/categories', 'POST', `${engine}-document-category-create`);
    await page.getByRole('button', { name: 'Добавить документ', exact: true }).click(); dialog = page.locator('dialog[open]'); const docName = `Договор поставки топлива — Северо-Западное подразделение — приложение № 12 ${engine}`;
    await dialog.getByLabel('Наименование', { exact: true }).fill(docName);
    await pending(page, dialog, dialog.getByRole('button', { name: 'Сохранить', exact: true }), '/api/documents/cards', 'POST', `${engine}-document-create-error`, true);
    await expect(dialog.getByLabel('Наименование', { exact: true })).toHaveValue(docName);
    await pending(page, dialog, dialog.getByRole('button', { name: 'Сохранить', exact: true }), '/api/documents/cards', 'POST', `${engine}-document-create`);
    const archive = await api('/api/documents'), card = archive.items.find(row => row.name === docName);
    await page.locator('.archive-item').filter({ hasText: docName }).click(); dialog = page.locator('.archive-drawer[open]'); await dialog.getByLabel('Наименование', { exact: true }).fill(docName + ' исправлен');
    await pending(page, dialog, dialog.getByRole('button', { name: 'Сохранить', exact: true }), '/api/documents/cards/' + card.id, 'PATCH', `${engine}-document-edit`);
    await page.locator('.archive-item').filter({ hasText: docName }).click(); await page.locator('.archive-drawer[open]').getByRole('button', { name: 'Удалить', exact: true }).click(); dialog = page.locator('.archive-delete-dialog[open]');
    await pending(page, dialog, dialog.getByRole('button', { name: 'Удалить', exact: true }), '/api/documents/cards/' + card.id, 'DELETE', `${engine}-document-delete-error`, true);
    await pending(page, dialog, dialog.getByRole('button', { name: 'Удалить', exact: true }), '/api/documents/cards/' + card.id, 'DELETE', `${engine}-document-delete`);
    await expect(page.locator('.archive-item').filter({ hasText: docName })).toHaveCount(0); check(`${engine}: document category/card create/edit/delete pending/error/retry`);
    // Planned operator operation, allocation and deletion use real synthetic bookkeeping.
    const plan = await api('/api/operator/plans', 'POST', { clientName: `Учебный клиент ${engine}`, idempotencyKey: randomUUID(), recipients: [{ id: randomUUID(), name: 'Учебный получатель', bank: 'Учебный банк', card: '0000 0000 0000 0001', phone: '+70000000000', details: '', limit: '10000' }] });
    const workspace = await api('/api/operator'), activePlan = workspace.plans.find(row => row.clientName === `Учебный клиент ${engine}`);
    assert.ok(plan && activePlan); await page.goto(runtime.base + '/#operator'); await page.getByRole('button', { name: 'Новая операция', exact: true }).click(); dialog = page.locator('dialog[open]');
    const driverName = `Александр Константинович Северо-Западный ${engine}`;
    await dialog.getByLabel('Задание', { exact: true }).selectOption(activePlan.id); await dialog.getByLabel('Имя водителя', { exact: true }).fill(driverName); await dialog.getByLabel('Сервис', { exact: true }).selectOption({ label: 'ГПН' });
    await dialog.getByLabel('Литры', { exact: true }).fill('10'); await dialog.getByLabel('Цена за литр, ₽', { exact: true }).fill('80'); await dialog.getByRole('button', { name: 'Добавить получателя', exact: true }).click(); await dialog.getByLabel('Получатель 1', { exact: true }).selectOption(activePlan.recipients[0].id);
    await pending(page, dialog, dialog.getByRole('button', { name: 'Сохранить операцию', exact: true }), '/api/operator/refuellings', 'POST', `${engine}-operator-create-error`, true);
    await expect(dialog.getByLabel('Имя водителя', { exact: true })).toHaveValue(driverName);
    await pending(page, dialog, dialog.getByRole('button', { name: 'Сохранить операцию', exact: true }), '/api/operator/refuellings', 'POST', `${engine}-operator-create`);
    const operation = (await api('/api/operator')).refuellings.find(row => row.name === driverName);
    await page.getByRole('button', { name: driverName, exact: true }).click(); dialog = page.locator('dialog[open]'); await dialog.getByLabel('Комментарий', { exact: true }).fill('Учебное уточнение');
    await pending(page, dialog, dialog.getByRole('button', { name: 'Сохранить операцию', exact: true }), '/api/operator/refuellings/' + operation.id, 'PATCH', `${engine}-operator-edit`);
    await page.getByRole('button', { name: 'Действие с операцией ' + driverName, exact: true }).click(); await page.locator('.operator-operation-actions[open]').getByRole('button', { name: /Удалить операцию/ }).click(); dialog = page.locator('.operator-dialog[open]');
    await pending(page, dialog, dialog.getByRole('button', { name: 'Удалить операцию', exact: true }), '/api/operator/refuellings/' + operation.id + '/delete', 'PATCH', `${engine}-operator-delete-error`, true);
    await pending(page, dialog, dialog.getByRole('button', { name: 'Удалить операцию', exact: true }), '/api/operator/refuellings/' + operation.id + '/delete', 'PATCH', `${engine}-operator-delete`);
    const final = await api('/api/operator'); assert.ok(!final.refuellings.some(row => row.id === operation.id)); assert.equal(final.plans.find(row => row.id === activePlan.id).remaining, '10000.00');
    check(`${engine}: operator create/edit/delete pending/error/retry; available amount restored exactly`);
    cabinetFixture = { ...await api('/api/cabinets'), credentialStorageReady: true };
    await page.goto(runtime.base + '/#cabinet-balances'); await page.locator('.cabinet-intro').getByRole('button', { name: 'Добавить кабинет', exact: true }).click();
    dialog = page.locator('dialog[open]'); await dialog.locator('.cabinet-provider-option').filter({ hasText: 'GloPro' }).click();
    await dialog.getByLabel('Название кабинета', { exact: true }).fill('Учебный кабинет — только черновик');
    await dialog.getByRole('button', { name: 'Выбрать другой сервис', exact: true }).click(); await expect(dialog.locator('.cabinet-discard-prompt')).toBeVisible();
    await dialog.getByRole('button', { name: 'Продолжить редактирование', exact: true }).click(); await expect(dialog.getByLabel('Название кабинета', { exact: true })).toHaveValue('Учебный кабинет — только черновик');
    await dialog.getByRole('button', { name: 'Выбрать другой сервис', exact: true }).click(); await dialog.getByRole('button', { name: 'Не сохранять', exact: true }).click();
    await expect(dialog.locator('.cabinet-provider-option')).toHaveCount(5); await dialog.locator('.cabinet-provider-option').filter({ hasText: 'natcar' }).click();
    await dialog.getByLabel('Название кабинета', { exact: true }).fill('Учебное название'); await page.keyboard.press('Escape'); await expect(dialog.locator('.cabinet-discard-prompt')).toBeVisible();
    await dialog.getByRole('button', { name: 'Продолжить редактирование', exact: true }).click(); await expect(dialog.getByLabel('Название кабинета', { exact: true })).toHaveValue('Учебное название');
    await page.keyboard.press('Escape'); await dialog.getByRole('button', { name: 'Не сохранять', exact: true }).click(); await expect(dialog).toHaveCount(0);
    report.forms.push({ engine, area: 'cabinet', width: 375, switchingProviderDiscardGuard: true, escapeDiscardGuard: true, realCredentialsProvided: false, mutations: 0 });
    check(`${engine}: cabinet provider switch/close retain or discard draft, no credentials or writes`);
    await context.close(); context = null; await browser.close(); browser = null;
  }
  assert.deepEqual(report.errors, []); assert.deepEqual(report.externalRequests, []); report.passed = true;
} catch (error) { report.failure = { message: error.message, stack: error.stack }; throw error; }
finally { await context?.close(); await browser?.close(); await runtime?.server.close(); globalThis.fetch = originalFetch; await rm(temporary, { recursive: true, force: true }); report.temporaryStoreRemoved = true; await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ passed: report.passed, pages: report.pages.length, mutations: report.mutations.length, report: resolve(output, 'report.json') })); }
