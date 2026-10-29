// Exact-build-capable toolbar acceptance. All writes use isolated synthetic stores.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium, webkit, expect as baseExpect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { OperationsStore } from '../server/operations-store.ts';
import { writeTripsQaSnapshot } from './qa-trips-runtime.mjs';
import { startOperatorQaServer } from './qa-operator-runtime.mjs';
import { authenticateContext } from './qa-auth.mjs';
const expect = baseExpect.configure({ timeout: 15000 });
const root = resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(resolve(tmpdir(), 'artel-toolbars-ui-'));
const output = resolve(process.env.ARTEL_TOOLBARS_QA_OUTPUT || resolve(root, 'qa/toolbars-20261020'));
const snapshotDirectory = resolve(temporary, 'snapshot'), operationsDirectory = resolve(temporary, 'operations');
await mkdir(output, { recursive: true });
const source = await writeTripsQaSnapshot(snapshotDirectory);
const store = new OperationsStore(operationsDirectory);
const customerName = 'Учебный клиент с длинным полным наименованием для проверки переноса текста в карточке заявки';
await store.mutate(source, data => {
  data.sourceOperationsCleared = true;
  data.companies = [{ id: 'qa-toolbar-customer', name: customerName, roles: ['customer'], managerLabels: [], shipmentIds: [], paymentIds: [], flags: [] }];
  data.directories = { fleetSeedApplied: true, managers: [], products: [], paymentForms: [], drivers: [], vehicles: [], oilDepots: [], customerManagers: [], defaults: { profit: 'template-payment-form' }, duplicates: [], addresses: [{ id: 'qa-toolbar-address', companyId: 'qa-toolbar-customer', kind: 'delivery', name: 'Учебная площадка', address: 'Синтетическая область, улица Проверки Длинных Адресов, дом 120, корпус 2', latitude: '55.75', longitude: '37.61' }] };
  return { changed: true, result: null };
});
const runtime = await startOperatorQaServer({ root, snapshotDirectory, operationsDirectory });
const admin = await runtime.bootstrap();
const api = async (path, method = 'GET', body) => {
  const response = await fetch(runtime.base + path, { method, headers: { Cookie: admin.cookie, Origin: runtime.base, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json(); assert.ok(response.ok, JSON.stringify({ path, status: response.status, error: result.error })); return result;
};
const manager = (await api('/api/directories', 'POST', { kind: 'managers', name: 'Учебный сотрудник' })).entry;
await api('/api/auth/users', 'POST', { name: 'Учебный сотрудник с очень длинным именем для проверки компактного фильтра исполнителя', login: 'toolbars.qa', password: randomUUID(), role: 'employee', managerId: manager.id, sections: ['work'] });
const report = { synthetic: true, frontend: runtime.mode, artifacts: runtime.artifacts, productionWrites: 0, checks: [], geometry: [], axe: [], screenshots: [], pageErrors: [], externalRequests: [], pushOwners: [], jsonFailures: [], requests: [] };
const check = label => { report.checks.push(label); console.log('PASS', label); };
const widths = [390, 768, 1024, 1099, 1100, 1101, 1440, 1920];
let browser;
try {
  for (const [engine, launcher] of [['chromium', chromium], ['webkit', webkit]].filter(([name]) => !process.env.ARTEL_TOOLBARS_QA_ENGINE || name === process.env.ARTEL_TOOLBARS_QA_ENGINE)) {
    browser = await launcher.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    await authenticateContext(context, runtime.base, admin.cookie);
    await context.addInitScript(() => {
      const worker = { pushManager: { getSubscription: async () => null } };
      Object.defineProperty(navigator.serviceWorker, 'register', { configurable: true, value: async () => worker });
      Object.defineProperty(navigator.serviceWorker, 'ready', { configurable: true, value: Promise.resolve(worker) });
    });
    let workMode = 'ready', tripMode = 'ready', workGate, tripGate;
    let workGets = 0, tripGets = 0;
    const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== runtime.base) { report.externalRequests.push(url.origin); return route.abort(); }
      if (url.pathname.startsWith('/api/')) report.requests.push({ engine, method: request.method(), path: url.pathname, search: url.search });
      if (url.pathname === '/api/push/config') {
        assert.equal(request.headers()['x-artel-account'], admin.user.id, 'Work notifications remain bound to the authenticated owner');
        report.pushOwners.push({ engine, owner: request.headers()['x-artel-account'] });
        return json(route, { enabled: false, publicKey: '', lastRunAt: null, intervalSeconds: 60 });
      }
      if (url.pathname === '/api/work' && request.method() === 'GET') {
        workGets++;
        if (workMode === 'hold') await new Promise(done => { workGate = done; });
        if (workMode === 'failed') return json(route, { error: 'Синтетическая ошибка рабочего пространства.' }, 503);
        if (workMode === 'truncated') return route.fulfill({ status: 200, contentType: 'application/json', body: '' });
        if (workMode === 'empty') {
          const response = await route.fetch(), data = await response.json();
          return json(route, { ...data, work: { tasks: [], companyRecords: [], notes: [] } });
        }
      }
      if (url.pathname === '/api/trip-requests' && request.method() === 'GET') {
        tripGets++;
        if (tripMode === 'hold') await new Promise(done => { tripGate = done; });
        if (tripMode === 'failed') return json(route, { error: 'Синтетическая ошибка загрузки заявок.' }, 503);
      }
      return route.continue();
    });
    const page = await context.newPage(); page.on('pageerror', error => report.pageErrors.push({ engine, message: error.message }));
    const capture = async name => { const path = resolve(output, `${engine}-${name}.png`); await page.screenshot({ path, fullPage: true }); report.screenshots.push(path); };
    const audit = async name => {
      const result = await new AxeBuilder({ page }).analyze();
      report.axe.push({ engine, name, violations: result.violations.map(item => ({ id: item.id, nodes: item.nodes.map(node => node.html) })) });
      assert.equal(result.violations.length, 0, JSON.stringify(report.axe.at(-1)));
    };
    const settle = () => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
    const refreshWork = async () => { const before = workGets; await page.getByRole('button', { name: 'Обновить работу', exact: true }).click(); await expect.poll(() => workGets).toBeGreaterThan(before); await expect(page.getByRole('button', { name: 'Обновить работу', exact: true })).toBeEnabled(); };
    const workLayout = async width => {
      await settle();
      const geometry = await page.evaluate(() => {
        const box = selector => { const element = document.querySelector(selector), rect = element.getBoundingClientRect(); return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom }; };
        return { tabs: box('.work-views'), actions: box('.work-toolbar-actions'), filter: box('[aria-label="Фильтр исполнителя"]'), topbar: box('.work-view-toolbar'), buttons: [...document.querySelectorAll('.work-toolbar-actions > button')].map(element => ({ ...box(`[aria-label="${element.getAttribute('aria-label')}"]`), label: getComputedStyle(element.querySelector('.mobile-action-label')).display })), overflow: document.documentElement.scrollWidth - innerWidth };
      });
      assert.ok(Math.abs(geometry.tabs.y + geometry.tabs.height / 2 - geometry.actions.y - geometry.actions.height / 2) <= 2, JSON.stringify({ width, geometry }));
      assert.ok(geometry.tabs.right <= geometry.actions.x + 1, JSON.stringify({ width, geometry }));
      assert.ok(geometry.actions.right <= geometry.topbar.right + 1);
      assert.ok(geometry.filter.width >= 90 && geometry.filter.width <= 281);
      if (width <= 1100) assert.ok(geometry.filter.y >= geometry.actions.bottom - 1, JSON.stringify({ width, geometry }));
      else assert.ok(Math.abs(geometry.filter.y + geometry.filter.height / 2 - geometry.actions.y - geometry.actions.height / 2) <= 2);
      for (const button of geometry.buttons) {
        assert.ok(button.height >= 44);
        if (width <= 1100) { assert.equal(button.label, 'none'); assert.ok(Math.abs(button.width - 44) <= 1); }
        else { assert.notEqual(button.label, 'none'); assert.ok(button.width > 90); }
      }
      if (geometry.overflow > 1) {
        const diagnostics = await page.evaluate(() => [...document.querySelectorAll('body *')].map(element => {
          const box = element.getBoundingClientRect(), style = getComputedStyle(element);
          return { tag: element.tagName, className: typeof element.className === 'string' ? element.className : '', role: element.getAttribute('role'), text: element.textContent?.slice(0, 120), x: box.x, right: box.right, width: box.width, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, display: style.display, position: style.position, overflow: style.overflow, visibility: style.visibility };
        }).filter(item => item.right > innerWidth + 1 && item.width > 0));
        report.geometry.push({ engine, width, failure: true, ...geometry, diagnostics });
        await capture(`work-overflow-${width}`);
      }
      assert.ok(geometry.overflow <= 1, JSON.stringify({ width, geometry }));
      await expect(page.locator('.work-action-toolbar,.work-toolbar')).toHaveCount(0);
      report.geometry.push({ engine, width, ...geometry });
    };

    for (const width of widths) {
      await page.setViewportSize({ width, height: 1000 });
      workGate = undefined; workMode = 'hold'; await page.goto(runtime.base + '/#work');
      await expect(page.getByText('Загрузка рабочего пространства…', { exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Обновить работу', exact: true })).toBeDisabled();
      await expect.poll(() => typeof workGate).toBe('function'); workMode = 'failed'; workGate();
      await expect(page.getByRole('alert')).toContainText('Синтетическая ошибка рабочего пространства.');
      await expect(page.getByText('Данные не загружены. Нажмите «Обновить».', { exact: true })).toBeVisible();
      workMode = 'empty'; await refreshWork();
      await expect(page.getByText('Задач пока нет.', { exact: true })).toBeVisible();
      await expect(page.getByRole('alert')).toHaveCount(0); await workLayout(width);
      const assignee = page.getByLabel('Фильтр исполнителя', { exact: true });
      const options = await assignee.locator('option').evaluateAll(nodes => nodes.map(node => ({ value: node.value, label: node.textContent })));
      const long = options.find(option => option.label.includes('очень длинным')); assert.ok(long);
      const selected = page.waitForResponse(response => response.url().endsWith(`/api/work?assigneeId=${long.value}`));
      await assignee.selectOption(long.value); await selected; await workLayout(width);
      const mine = page.waitForResponse(response => response.url().endsWith('/api/work?assigneeId=mine'));
      await assignee.selectOption('mine'); await mine;
      await assignee.selectOption(''); await expect(page.getByRole('button', { name: 'Обновить работу', exact: true })).toBeEnabled();
      const bell = page.getByRole('button', { name: 'Напоминания', exact: true }); await bell.click();
      const notification = page.getByRole('dialog', { name: 'Напоминания', exact: true });
      await expect(notification.getByText('Напоминаний пока нет.', { exact: true })).toBeVisible();
      await expect(notification).not.toContainText('Сообщим, когда ваш счёт');
      const bounds = await notification.boundingBox(); assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width + 1);
      await page.keyboard.press('Escape'); await expect(notification).toBeHidden(); await expect(bell).toBeFocused();
      for (const name of ['Календарь', 'Архив задач', 'Задачи']) { await page.locator('.work-views').getByRole('button', { name, exact: true }).click(); await expect(page.locator('.work-views').getByRole('button', { name, exact: true })).toHaveAttribute('aria-pressed', 'true'); }
      await capture(`work-empty-${width}`); await audit(`work-empty-${width}`);
      await page.getByRole('button', { name: 'Новая задача', exact: true }).click();
      await expect(page.getByRole('dialog', { name: 'Новая задача', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Отмена', exact: true }).click();
      check(`${engine}: Work loading/error/empty, tabs/actions, long assignee + mine GET, reminder dialog and new-task action at ${width}px`);
      // A reload ensures the next initial-loading assertion cannot use cached page state.
      await page.goto(runtime.base + '/#trips');
      await expect(page.getByRole('button', { name: 'Новая заявка', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Обновить заявки', exact: true })).toHaveCount(0);
      await expect(page.locator('.trip-requests-panel .search-add-toolbar > button')).toHaveCount(1);
      await expect(page.getByRole('heading', { name: 'Заявок пока нет', exact: true })).toBeVisible();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await capture(`trip-requests-empty-${width}`); await audit(`trip-requests-empty-${width}`);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    // Native Response.json() error wording differs between Chromium and WebKit.
    // Compare against this engine's actual parser error, keeping exact propagation.
    const nativeJsonError = await page.evaluate(async () => {
      try { await new Response('', { headers: { 'Content-Type': 'application/json' } }).json(); return null; }
      catch (error) { return error.message; }
    });
    assert.ok(nativeJsonError);
    workMode = 'truncated'; await page.goto(runtime.base + '/#work');
    await expect(page.getByRole('alert')).toHaveText(nativeJsonError);
    report.jsonFailures.push({ engine, nativeJsonError, displayed: await page.getByRole('alert').innerText() });
    workMode = 'ready'; await refreshWork(); await expect(page.getByRole('alert')).toHaveCount(0);
    const reminderTitle = `Учебное напоминание с длинным названием ${engine}`;
    await api('/api/work/tasks', 'POST', { title: reminderTitle, description: 'Проверка сохранённых действий после переноса панели.', reminderAt: new Date(Date.now() + 3600000).toISOString() });
    await refreshWork(); const reminderBell = page.getByRole('button', { name: /^Напоминания, 1/ }); await reminderBell.click();
    await page.locator('.work-reminder').filter({ hasText: reminderTitle }).click();
    await expect(page.getByRole('dialog', { name: 'Задача', exact: true })).toBeVisible();
    await expect(page.getByLabel('Название', { exact: true })).toHaveValue(reminderTitle);
    await page.getByRole('button', { name: 'Отмена', exact: true }).click();
    for (const width of widths) { await page.setViewportSize({ width, height: 1000 }); await workLayout(width); await expect(page.getByRole('button', { name: `Задача: ${reminderTitle}`, exact: true })).toBeVisible(); }
    check(`${engine}: synthetic truncated JSON remains visible, refresh recovers actual API, reminder count opens correct task without mutations`);

    await page.setViewportSize({ width: 1440, height: 1000 });
    tripGate = undefined; tripMode = 'hold'; await page.goto(runtime.base + '/#trips');
    await expect(page.getByText('Загружаем заявки…', { exact: true })).toBeVisible();
    await expect.poll(() => typeof tripGate).toBe('function'); tripMode = 'failed'; tripGate();
    await expect(page.getByRole('alert')).toContainText('Синтетическая ошибка загрузки заявок.');
    tripMode = 'ready'; await page.getByRole('button', { name: 'Повторить загрузку', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Заявок пока нет', exact: true })).toBeVisible(); await expect(page.getByRole('alert')).toHaveCount(0);
    const beforeFocus = tripGets; await page.evaluate(() => window.dispatchEvent(new Event('focus'))); await expect.poll(() => tripGets).toBeGreaterThan(beforeFocus);
    await page.getByRole('button', { name: 'Новая заявка', exact: true }).click();
    let dialog = page.getByRole('dialog', { name: 'Новая заявка', exact: true });
    const choose = async (label, name) => { await dialog.getByRole('combobox', { name: new RegExp('^' + label) }).fill(name); await dialog.getByRole('listbox').getByRole('option', { name: new RegExp(name) }).first().click(); };
    await choose('Компания', 'Учебный клиент'); await choose('Место доставки', 'Учебная площадка');
    await dialog.getByLabel('Количество литров, л', { exact: false }).fill('1000'); await dialog.getByLabel('Цена за литр для клиента, ₽', { exact: true }).fill('79');
    const beforeSave = tripGets; await dialog.getByRole('button', { name: 'Сохранить заявку', exact: true }).click(); await expect(dialog).toHaveCount(0); await expect.poll(() => tripGets).toBeGreaterThan(beforeSave);
    const card = page.getByTestId('trip-request-card').filter({ hasText: customerName }); await expect(card).toHaveCount(1); await expect(card.locator('.trip-request-price')).toContainText('79');
    for (const width of widths) { await page.setViewportSize({ width, height: 1000 }); await expect(card).toBeVisible(); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)); await capture(`trip-requests-ready-${width}`); }
    await page.getByLabel('Поиск заявки', { exact: true }).fill('нет такой заявки'); await expect(page.getByRole('heading', { name: 'Заявки не найдены', exact: true })).toBeVisible();
    await page.getByLabel('Поиск заявки', { exact: true }).fill('Учебный клиент'); await expect(card).toHaveCount(1); await page.getByLabel('Поиск заявки', { exact: true }).fill('');
    await card.getByRole('button', { name: /^Изменить заявку:/ }).click(); dialog = page.getByRole('dialog', { name: 'Изменить заявку', exact: true });
    await dialog.getByLabel('Количество литров, л', { exact: false }).fill('1100'); const beforeEdit = tripGets;
    await dialog.getByRole('button', { name: 'Сохранить заявку', exact: true }).click(); await expect(dialog).toHaveCount(0); await expect.poll(() => tripGets).toBeGreaterThan(beforeEdit); await expect(card.locator('.trip-request-litres')).toContainText('1 100');
    await card.getByRole('button', { name: /^Удалить заявку:/ }).click(); const beforeDelete = tripGets;
    await page.getByRole('dialog').getByRole('button', { name: 'Удалить заявку', exact: true }).click(); await expect(card).toHaveCount(0); await expect.poll(() => tripGets).toBeGreaterThan(beforeDelete);
    await expect(page.getByRole('heading', { name: 'Заявок пока нет', exact: true })).toBeVisible();
    check(`${engine}: requests loading/error/retry/focus, removed refresh, real synthetic create/search/edit/delete and reload callbacks preserved`);
    // Remove only the synthetic reminder made by this engine to keep count expectations exact.
    const task = (await api('/api/work')).work.tasks.find(item => item.title === reminderTitle);
    await api(`/api/work/tasks/${task.id}`, 'DELETE', { version: task.version });
    await context.close(); await browser.close(); browser = undefined;
  }
  assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.externalRequests, []); assert.ok(report.pushOwners.length > 0); report.passed = true;
} catch (error) { report.passed = false; report.failure = error.stack || String(error); throw error; }
finally { await browser?.close(); await runtime.server.close(); await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2)); await rm(temporary, { recursive: true, force: true }); console.log(JSON.stringify({ passed: report.passed, frontend: runtime.mode, checks: report.checks.length, geometry: report.geometry.length, axe: report.axe.length, output })); }
