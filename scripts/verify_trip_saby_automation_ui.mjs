// Real local trip save/retry API, synthetic automation/status responses only.
// Provider behavior is covered separately by server integration tests.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, webkit, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { SabyClient } from '../server/saby-client.ts';
import { integrationRuntime, integrationConfig } from '../tests/helpers/trip-saby-integration.ts';
import { bootstrapQaAuth, authenticateContext } from './qa-auth.mjs';
import { startTripsQaServer } from './qa-trips-runtime.mjs';

const root = resolve(import.meta.dirname, '..'), useWebkit = process.env.QA_WEBKIT === '1';
const output = resolve(root, 'qa', `trip-saby-automation-${useWebkit ? 'webkit' : 'chromium'}`);
await mkdir(output, { recursive: true });
const rt = await integrationRuntime();
const report = { syntheticAutomationResponses: true, realTripSaveApi: true, workingStoreAccessed: false, realSabyRequests: 0, checks: [], errors: [], externalRequests: [], screenshots: [] };
const check = name => { report.checks.push(name); console.log('PASS', name); };
const queued = () => ({ status: 'not_sent', phase: 'preparation', ready: true, blockers: [], locked: false, updatedAt: '2026-10-06T10:00:00Z', lastError: null, order: null, deliveries: [], carrierConfirmed: false, loadingFacts: null, lastCheckedAt: null, lastCheckAttemptAt: null, monitoring: { enabled: true, intervalSeconds: 15 }, history: [], automation: { enabled: true, enrolled: true } });
let state = queued(), savedTripId = null, saves = [], workflowReads = 0, workflowPosts = 0, signingPosts = 0, loseFirstSave = true, advanceOnReconcile = false, listReads = 0;
const savedIds = new Set();
let browser, runtime, page;
try {
  runtime = await startTripsQaServer({ root, snapshotDirectory: rt.snapshotDirectory, operationsDirectory: resolve(rt.directory, 'store'), sabyClient: new SabyClient(integrationConfig(), async () => { throw new Error('Real Saby requests are forbidden by automation UI QA'); }) });
  const { base } = runtime, { cookie } = await bootstrapQaAuth(base);
  browser = useWebkit ? await webkit.launch({ headless: true }) : await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce', serviceWorkers: 'block', timezoneId: 'Europe/Moscow' });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== base) { report.externalRequests.push(url.href); return route.abort(); }
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (url.pathname === '/api/shipment-trips' && request.method() === 'GET') {
      listReads++;
      const response = await route.fetch(), body = await response.json();
      return json({ ...body, automation: { enabled: true } }, response.status());
    }
    if (url.pathname === '/api/shipment-trips' && request.method() === 'POST') {
      saves.push(request.postDataJSON());
      const response = await route.fetch(), body = await response.json();
      assert.equal(response.status(), 201, JSON.stringify(body));
      savedTripId = body.trip.id; savedIds.add(savedTripId);
      if (loseFirstSave) { loseFirstSave = false; return route.abort('failed'); }
      return route.fulfill({ response });
    }
    if (/\/saby-workflow\/signing\/start$/.test(url.pathname)) { signingPosts++; return json({ error: 'Unexpected per-trip signing launch' }, 409); }
    if (/\/saby-workflow$/.test(url.pathname)) {
      if (request.method() === 'GET') { workflowReads++; return json(state); }
      workflowPosts++;
      assert.ok(state.automation.enrolled, 'Legacy records must not run a workflow POST');
      if (advanceOnReconcile) { state.signing.sender.state = 'confirmed'; state.signing.carrier.state = 'waiting'; advanceOnReconcile = false; }
      return json(state);
    }
    if (/\/shipment-trips\/[^/]+\/etrn$/.test(url.pathname)) return json({ deliveries: [] });
    if (/\/shipment-trips\/[^/]+\/saby$/.test(url.pathname)) return json({ saby: { documents: [] } });
    return route.continue();
  });
  await authenticateContext(context, base, cookie);
  page = await context.newPage(); await page.clock.install();
  page.on('pageerror', reason => report.errors.push(reason.message));
  const main = page.getByRole('region', { name: 'Документы рейса в Saby', exact: true });
  const signing = page.getByRole('region', { name: 'Подписание заявки', exact: true });
  const choose = async (scope, label, name) => { const picker = scope.getByRole('combobox', { name: new RegExp('^' + label) }); await picker.fill(name); await scope.getByRole('listbox').getByRole('option', { name: new RegExp(name) }).first().click(); };
  const refresh = async () => { const reads = workflowReads; await expect.poll(async () => { await page.evaluate(() => window.dispatchEvent(new Event('focus'))); return workflowReads; }).toBeGreaterThan(reads); await page.clock.runFor(100); };
  const shot = async name => { const path = resolve(output, `${name}.png`); await main.screenshot({ path }); report.screenshots.push(path); };

  await page.goto(base + '/#trips');
  await expect(page.getByRole('button', { name: 'Изменить рейс', exact: true })).toBeVisible();
  const listReadsBeforeEditor = listReads;
  await page.getByRole('button', { name: 'Новый рейс', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('После сохранения готового рейса CRM автоматически');
  assert.equal(listReads, listReadsBeforeEditor, 'Trips editor reuses the already-loaded automation capability');
  await expect(dialog.getByRole('button', { name: 'Сохранить рейс', exact: true })).toHaveCount(1);
  await dialog.getByLabel('Дата отгрузки / погрузки', { exact: true }).fill('2026-10-07');
  await dialog.getByLabel('Дата отгрузки / погрузки — время', { exact: true }).fill('10:00');
  await choose(dialog, 'Поставщик', 'Синтетический поставщик');
  await choose(dialog, 'Нефтебаза', 'Синтетическая нефтебаза');
  await choose(dialog, 'Товар', 'ДТ');
  await dialog.getByLabel('Цена поставщика за тонну, ₽', { exact: false }).fill('50000');
  await dialog.getByLabel('Плановая масса груза, т', { exact: false }).fill('8');
  const customer = dialog.getByTestId('trip-customer').first();
  await choose(customer, 'Клиент', 'ИП ПолучательТестовый Тест');
  await choose(customer, 'Место выгрузки', 'Доставка');
  await choose(customer, 'Менеджер', 'Тест');
  await customer.getByLabel('Количество литров, л', { exact: false }).fill('10000');
  await customer.getByLabel('Цена за литр, ₽', { exact: false }).fill('60');
  await customer.getByLabel('Сумма перевозки, ₽', { exact: true }).fill('1000');
  await choose(dialog, 'Водитель', 'Тест');
  await expect(dialog.getByRole('combobox', { name: 'Автомобиль *', exact: true })).toHaveValue('Т001ЕЕ777');
  await dialog.getByRole('button', { name: 'Сохранить рейс', exact: true }).evaluate(button => { button.click(); button.click(); });
  await expect(dialog.getByRole('button', { name: 'Повторить сохранение', exact: true })).toBeEnabled();
  assert.equal(saves.length, 1); assert.equal(signingPosts, 0); assert.equal(workflowPosts, 0);
  await dialog.getByRole('button', { name: 'Повторить сохранение', exact: true }).click();
  await expect(dialog).toHaveCount(0); await expect(main).toContainText('Автоматическая отправка в очереди');
  assert.equal(saves.length, 2); assert.deepEqual(saves[0], saves[1]); assert.equal(savedIds.size, 1);
  assert.equal(signingPosts, 0); assert.equal(workflowPosts, 0);
  check('Save uses one idempotent trip payload; a lost reply recovers one saved trip without any extra browser launch or confirmation');

  const beforePoll = workflowReads; await page.clock.fastForward(15_001);
  await expect.poll(() => workflowReads).toBeGreaterThan(beforePoll);
  assert.equal(state.locked, false); assert.equal(state.order, null); assert.equal(signingPosts, 0); assert.equal(workflowPosts, 0);
  check('An enrolled queue is polled with GET before a document or workflow lock exists');

  state.ready = false; state.blockers = ['Укажите сведения нефтебазы для Saby'];
  await refresh(); await expect(main).toContainText('Рейс сохранён · отправка приостановлена'); await expect(main).toContainText('Укажите сведения нефтебазы для Saby');
  await expect(main.getByRole('button', { name: 'Создать заявку в Saby', exact: true })).toHaveCount(0);
  check('Missing automation inputs show a saved trip and concrete blockers, without a manual send button');

  state = { ...queued(), locked: true, phase: 'awaiting_carrier', order: { id: 'synthetic-auto-order', number: 'QA-42', date: '2026-10-07', status: 'draft', url: null, revision: 'revision-auto', remoteStatus: 'Ожидает подписания', signatureStatus: 'not_signed', exchangeStage: 'signature_pending' }, signing: { state: 'active', mode: 'automatic', requestedAt: '2026-10-06T10:00:00Z', sender: { state: 'waiting' }, carrier: { state: 'not_started' } } };
  await refresh(); await expect(signing).toContainText('Автоматическое подписание');
  await expect(signing.getByRole('checkbox')).toHaveCount(0); await expect(signing.getByRole('combobox')).toHaveCount(0);
  await expect(main.getByRole('button', { name: /Подписать и продолжить|Проверить доступные подписи|Заполнить водителя/ })).toHaveCount(0);
  await expect(signing).not.toContainText('подтверждение владельца');
  for (const width of [1440, 768, 390, 320]) { await page.setViewportSize({ width, height: 1050 }); assert.ok(await main.evaluate(node => node.scrollWidth <= node.clientWidth + 1)); await shot(`automatic-${width}`); }
  const accessibility = await new AxeBuilder({ page }).include('.workflow-signing').withTags(['wcag2a', 'wcag2aa']).analyze();
  assert.deepEqual(accessibility.violations.map(({ id }) => id), []);
  check('Automatic signing has no per-trip selection or confirmation and fits 320–1440 px with no accessibility violations');

  advanceOnReconcile = true;
  await main.getByRole('button', { name: 'Обновить из Saby', exact: true }).click();
  await expect(main.locator('.workflow-current strong')).toContainText('НК АРТЕЛЬ · ожидаем подпись');
  assert.equal(workflowPosts, 1); assert.equal(signingPosts, 0);
  check('The single explicit refresh reconciles an enrolled chain and displays fresh carrier progress');

  state.automation.enrolled = false; state.signing.mode = 'with_confirmation'; state.signing.state = 'unknown'; state.signing.carrier.state = 'unknown'; state.order.number = '11';
  await refresh();
  await expect(main.locator('.workflow-current strong')).toContainText('НК АРТЕЛЬ · результат подписания не подтверждён');
  await expect(signing).toContainText('Продолжение приостановлено');
  await expect(signing).toContainText('Подпись подтверждена в Saby');
  await expect(signing).not.toContainText('подтверждение владельца');
  await expect(signing).not.toContainText('CRM продолжает эту цепочку');
  await main.getByRole('button', { name: 'Обновить сохранённое состояние', exact: true }).click();
  assert.equal(workflowPosts, 1); assert.equal(signingPosts, 0);
  await shot('legacy-unknown');
  check('Legacy order 11 preserves sender evidence and uncertain carrier state; its refresh is GET-only and never re-enrolls or promises completion');

  state.signing.state = 'completed'; state.signing.carrier.state = 'confirmed'; state.carrierConfirmed = true; state.phase = 'awaiting_loading';
  await refresh(); await expect(main.getByRole('heading', { name: 'Фактическая погрузка' })).toBeVisible();
  await expect(main.getByRole('checkbox', { name: 'Подтверждаю фактические сведения погрузки всего рейса' })).toBeVisible();
  await expect(main.getByRole('button', { name: 'Сохранить погрузку и продолжить', exact: true })).toBeDisabled();
  check('Automatic signing does not invent actual loading facts or remove their separate confirmation');

  assert.ok(savedTripId); assert.deepEqual(report.errors, []); assert.deepEqual(report.externalRequests, []);
} catch (reason) {
  report.failure = reason.message;
  await page?.screenshot({ path: resolve(output, 'failure.png'), fullPage: false }).catch(() => {});
  throw reason;
} finally {
  await browser?.close(); await runtime?.server.close(); await rt.close();
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
}
