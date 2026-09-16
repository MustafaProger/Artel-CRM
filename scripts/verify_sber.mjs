// Run with: node --import tsx scripts/verify_sber.mjs
// Every bank response is synthetic. This check never uses production credentials or storage.
import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import localApi, { loadSnapshot } from '../server/local-api.ts';
import { OperationsStore } from '../server/operations-store.ts';
import { SberHttpError } from '../server/banking/sber-client.ts';
import { bootstrapQaAuth, authenticateContext } from './qa-auth.mjs';

const root = resolve(import.meta.dirname, '..'), output = resolve(root, 'qa/sber');
const temporary = await mkdtemp(resolve(tmpdir(), 'artel-sber-browser-'));
const port = Number(process.env.ARTEL_SBER_QA_PORT || 5196), base = `http://127.0.0.1:${port}`;
const report = { fixtureOnly: true, checks: [], errors: [], violations: [], measurements: [], bankRequests: [] };
const check = name => { report.checks.push(name); console.log('PASS', name); };
const account = '40702810438720035571';
const environment = Object.fromEntries(['CLIENT_ID', 'CLIENT_SECRET', 'TLS_PFX_BASE64', 'TLS_PASSPHRASE', 'TLS_CA_BASE64', 'ACCESS_TOKEN', 'REFRESH_TOKEN'].map(key => [`ARTEL_BANK_SBER_NK_${key}`, `synthetic-qa-${key}`]));
environment.ARTEL_BANK_ENCRYPTION_KEY = randomBytes(32).toString('base64');
environment.ARTEL_BANK_SYNC_ENABLED = 'false';
const money = amount => ({ amount, currencyName: 'RUR' });
const bankRow = (id, direction, amount, name, inn, counterpartyAccount) => ({
  operationId: id, direction, amount: money(amount), operationDate: '2026-09-15T09:31:30+03:00', number: id,
  documentDate: '2026-09-15', paymentPurpose: `Тестовая оплата ${id}. Уникальное назначение ${id === 'incoming-alpha' ? 'кипарис' : 'берёза'}.`,
  rurTransfer: direction === 'CREDIT' ? { payerName: name, payerInn: inn, payerAccount: counterpartyAccount, payeeName: 'ООО «НК АРТЭЛЬ»', payeeInn: '5050140563', payeeAccount: account } : { payeeName: name, payeeInn: inn, payeeAccount: counterpartyAccount, payerName: 'ООО «НК АРТЭЛЬ»', payerInn: '5050140563', payerAccount: account },
});
const rows = [bankRow('incoming-alpha', 'CREDIT', '0.1', 'Тест Альфа', '7700000001', '40700000000000000001'), bankRow('outgoing-beta', 'DEBIT', '0.2', 'Тест Бета', '7700000002', '40700000000000000002'), bankRow('incoming-gamma', 'CREDIT', '0.2', 'Тест Гамма', '7700000003', '40700000000000000003')];
let bankFailure = false, incompleteSummary = false, server, browser;
const fakeSber = async (_environment, options) => {
  report.bankRequests.push({ path: options.path, day: options.query?.statementDate, page: options.query?.page });
  if (bankFailure) throw new SberHttpError(403);
  const day = options.query?.statementDate;
  if (options.path.endsWith('/summary')) {
    const result = { openingBalance: money(day === '2026-09-16' ? '100.1' : '100'), creditTurnover: money(day === '2026-09-15' ? '0.3' : '0'), debitTurnover: money(day === '2026-09-15' ? '0.2' : '0'), closingBalance: money(day < '2026-09-15' ? '100' : '100.1') };
    if (incompleteSummary && day === '2026-09-13') delete result.creditTurnover;
    return result;
  }
  if (options.path.endsWith('/transactions')) {
    if (day !== '2026-09-15') return { transactions: [], _links: [] };
    if (options.query.page === '1') return { transactions: rows.slice(0, 2), _links: [{ rel: 'next', href: `/fintech/api/v2/statement/transactions?accountNumber=${account}&statementDate=${day}&page=2` }] };
    return { transactions: rows.slice(2), _links: [] };
  }
  if (options.path.endsWith('/transactionId')) {
    const row = rows.find(item => item.operationId === options.query.id);
    assert.ok(row, 'Details must request an existing bank ID');
    return { ...row, paymentPurpose: `${row.paymentPurpose}\nПолное назначение из карточки банка.`, rurTransfer: { ...row.rurTransfer, payerKpp: '770001001', payerBankBic: '044525000', payerBankName: 'Тестовый банк', payeeBankCorrAccount: '30100000000000000001' }, documentMetadata: { fixtureMarker: 'Банковский документ QA' } };
  }
  throw new Error('Unexpected fake bank request');
};
const store = new OperationsStore(temporary), snapshot = await loadSnapshot();
await mkdir(output, { recursive: true });
try {
  server = await createServer({ configFile: false, root: resolve(root, 'web'), plugins: [react(), localApi({ operationsStore: store, bankEnvironment: environment, sberRequest: fakeSber })], server: { host: '127.0.0.1', port, strictPort: true } });
  await server.listen();
  const { cookie } = await bootstrapQaAuth(base);
  const before = await store.read(snapshot.provenance.sourceSha256);
  const read = async () => { const response = await fetch(`${base}/api/banking/sber/statements?from=2026-09-14&to=2026-09-16`, { headers: { Cookie: cookie } }); assert.ok(response.ok); return response.json(); };
  browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', timezoneId: 'Europe/Moscow' });
  await authenticateContext(context, base, cookie);
  const page = await context.newPage(); page.on('pageerror', error => report.errors.push(error.message));
  await page.goto(`${base}/#payments`);
  await page.getByRole('button', { name: 'Открыть СберБизнес — НК АРТЕЛЬ', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Выписки по дням', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Обновить из банка', exact: true })).toBeEnabled();
  await expect(page.getByLabel('Начало периода выписки Сбера')).toHaveValue('2026-09-01');
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(new Date());
  await expect(page.getByLabel('Конец периода выписки Сбера')).toHaveValue(today);
  await expect(page.getByLabel('Конец периода выписки Сбера')).toHaveAttribute('max', today);
  assert.equal(report.bankRequests.length, 0, 'Opening the screen must only read saved state');
  check('Default period September 1 through Moscow today; initial screen never starts bank requests');
  const setPeriod = async (from, to) => {
    await page.getByLabel('Начало периода выписки Сбера').fill(from);
    await page.getByLabel('Конец периода выписки Сбера').fill(to);
    await page.getByRole('button', { name: 'Показать период', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Обновить из банка', exact: true })).toBeEnabled();
  };
  await setPeriod('2026-09-14', '2026-09-16');
  await page.getByRole('button', { name: 'Обновить из банка', exact: true }).click();
  await expect(page.getByText('Получаем банковские данные', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Обновить из банка', exact: true })).toBeEnabled({ timeout: 30000 });
  await expect(page.locator('.sber-days-table tbody tr')).toHaveCount(3);
  await expect(page.locator('.sber-operations-table tbody tr')).toHaveCount(3);
  const initialState = await read();
  assert.equal(initialState.days.length, 3); assert.equal(initialState.operations.length, 3); assert.ok(initialState.lastSuccessAt); assert.equal(initialState.progress, undefined);
  assert.ok(report.bankRequests.some(request => request.day === '2026-09-15' && request.page === '2'));
  await expect(page.locator('.sber-days-table').getByRole('row').filter({ hasText: '15.09.2026' })).toContainText('0,30 ₽');
  check('Explicit refresh saves each day, follows the second page, formats exact decimals and records successful synchronization');
  await page.getByLabel('Скрыть дни без оборотов').check();
  await expect(page.locator('.sber-days-table tbody tr')).toHaveCount(1);
  await page.getByRole('button', { name: 'Операции за 15.09.2026', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Операции за 15.09.2026', exact: true })).toBeVisible();
  await expect(page.locator('.sber-operations-table tbody tr')).toHaveCount(3);
  await page.getByLabel('Скрыть дни без оборотов').uncheck();
  await page.getByRole('button', { name: 'Операции за 14.09.2026', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'В этот день нет загруженных операций', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Показать весь период', exact: true }).click();
  check('Daily rows select operations; zero turnover days can be hidden; empty-day and full-period views work');
  const search = page.getByLabel('Поиск по контрагенту, ИНН, счёту или назначению');
  for (const value of ['Тест Альфа', '7700000001', '40700000000000000001', 'кипарис']) {
    await search.fill(value); await expect(page.locator('.sber-operations-table tbody tr')).toHaveCount(1); await expect(page.locator('.sber-operations-table')).toContainText('Тест Альфа');
  }
  await search.fill('');
  await page.getByLabel('Направление операции Сбера').selectOption('outgoing');
  await expect(page.locator('.sber-operations-table tbody tr')).toHaveCount(1); await expect(page.locator('.sber-operations-table')).toContainText('Тест Бета');
  await search.fill('нет такого контрагента');
  await expect(page.getByRole('heading', { name: 'Операции по этим фильтрам не найдены' })).toBeVisible();
  await page.getByRole('button', { name: 'Сбросить фильтры', exact: true }).click();
  check('Search matches counterparty, INN, account and payment purpose; direction and empty-filter states work');
  await page.getByRole('button', { name: 'Открыть операцию № incoming-alpha', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Загрузить подробности из банка', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Загрузить подробности из банка', exact: true }).click();
  await expect(page.locator('.bank-payment-purpose')).toContainText('Полное назначение из карточки банка.');
  await expect(page.locator('.bank-parties')).toContainText('770001001');
  await expect(page.locator('.bank-parties')).toContainText('30100000000000000001');
  await page.getByText('Все поля, полученные от банка', { exact: true }).click();
  await expect(page.locator('.bank-raw-details')).toContainText('Банковский документ QA');
  const detailAxe = await new AxeBuilder({ page }).include('.sber-payment-panel').withTags(['wcag2a', 'wcag2aa']).analyze();
  report.violations.push(...detailAxe.violations.map(value => ({ scope: 'detail', id: value.id, nodes: value.nodes.map(node => ({ target: node.target, summary: node.failureSummary })) })));
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    const size = await page.getByRole('dialog').evaluate(element => ({ width: element.clientWidth, scroll: element.scrollWidth }));
    report.measurements.push({ scope: 'detail', viewport: width, ...size }); assert.ok(size.scroll <= size.width + 1, `Detail overflow at ${width}`);
    await page.screenshot({ path: resolve(output, `detail-${width}-fixtures.png`), fullPage: true });
  }
  await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toHaveCount(0);
  await search.fill('Полное назначение из карточки банка');
  await expect(page.locator('.sber-operations-table tbody tr')).toHaveCount(1);
  await search.fill('');
  check('Operation detail keeps full purpose, party requisites, INN, document fields and bank detail refresh; Escape closes dialog');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await setPeriod('2026-09-13', '2026-09-16');
  incompleteSummary = true;
  await page.getByRole('button', { name: 'Обновить из банка', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Обновить из банка', exact: true })).toBeEnabled({ timeout: 30000 });
  await expect(page.locator('.sber-days-table').getByRole('row').filter({ hasText: '13.09.2026' })).toContainText('Не передано');
  await page.getByLabel('Скрыть дни без оборотов').check();
  await expect(page.locator('.sber-days-table tbody tr')).toHaveCount(2);
  assert.equal((await read()).operations.length, 3);
  check('Missing turnover remains unknown and its day is not hidden as zero; repeated refresh does not duplicate rows');
  incompleteSummary = false;
  bankFailure = true;
  await page.getByRole('button', { name: 'Обновить из банка', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Продолжить загрузку', exact: true })).toBeEnabled({ timeout: 30000 });
  await expect(page.getByRole('alert').first()).toContainText('Сбер не разрешил просмотр');
  const failed = await read(); assert.equal(failed.operations.length, 3); assert.equal(failed.lastSuccessAt, initialState.lastSuccessAt);
  await expect(page.locator('.sber-operations-table tbody tr')).toHaveCount(3);
  bankFailure = false;
  await page.getByRole('button', { name: 'Продолжить загрузку', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Обновить из банка', exact: true })).toBeEnabled({ timeout: 30000 });
  const resumed = await read(); assert.equal(resumed.progress, undefined); assert.equal(resumed.lastError, undefined); assert.equal(resumed.operations.length, 3); assert.notEqual(resumed.lastSuccessAt, initialState.lastSuccessAt);
  check('Bank 403 retains all saved rows and last successful timestamp; explicit resume restarts exhausted job and finishes without duplicates');
  await page.getByLabel('Скрыть дни без оборотов').uncheck();
  const tomorrow = new Date(`${today}T12:00:00Z`); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  await page.getByLabel('Конец периода выписки Сбера').fill(tomorrow.toISOString().slice(0, 10));
  await expect(page.getByRole('button', { name: 'Показать период', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Обновить из банка', exact: true })).toBeDisabled();
  await page.getByLabel('Конец периода выписки Сбера').fill('2026-09-16');
  check('Future periods cannot be applied or synchronized');
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    const size = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
    await page.screenshot({ path: resolve(output, `statements-${width}-fixtures.png`), fullPage: true });
    report.measurements.push({ scope: 'page', ...size });
    if (size.scroll > size.width + 1) report.measurements.push({ overflow: await page.locator('body *').evaluateAll(elements => elements.map(element => ({ tag: element.tagName, class: element.className, rect: element.getBoundingClientRect().toJSON(), overflow: getComputedStyle(element).overflowX })).filter(row => row.rect.right > innerWidth + 1 && row.rect.width > 0).slice(0, 30)) });
    assert.ok(size.scroll <= size.width + 1, `Statement page overflow at ${width}`);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  const axe = await new AxeBuilder({ page }).include('.sber-statements').withTags(['wcag2a', 'wcag2aa']).analyze();
  report.violations.push(...axe.violations.map(value => ({ scope: 'page', id: value.id, nodes: value.nodes.map(node => ({ target: node.target, summary: node.failureSummary })) })));
  assert.equal(report.violations.length, 0, 'Sber statements and detail accessibility');
  assert.equal(report.errors.length, 0, 'Browser runtime errors');
  check('Statements and detail fit 1440, 768, 390 and 320 px; Axe WCAG A/AA audit and browser errors clean');
  const requestsBeforeCard = report.bankRequests.length;
  await page.getByRole('button', { name: 'Все подключения', exact: true }).click();
  const card = page.getByRole('button', { name: 'Открыть СберБизнес — НК АРТЕЛЬ', exact: true });
  await expect(card).toContainText('Подключён');
  await expect(card).toContainText(account);
  await expect(card.locator('.bank-last-sync')).not.toContainText('Ещё не выполнялась');
  assert.equal(report.bankRequests.length, requestsBeforeCard);
  check('Bank card shows saved connection status, account and successful synchronization without contacting bank');
  const after = await store.read(snapshot.provenance.sourceSha256);
  for (const key of ['shipments', 'companies', 'directories', 'paymentAllocations']) assert.deepEqual(after[key], before[key]);
  check('Shipment, directory and allocation data remain unchanged in isolated storage');
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.failure = error.message; throw error; }
finally { await writeFile(resolve(output, 'verification.json'), JSON.stringify(report, null, 2)); await browser?.close(); await server?.close(); await rm(temporary, { recursive: true, force: true }); }
