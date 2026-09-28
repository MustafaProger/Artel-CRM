// Run with: node --import tsx scripts/verify_settlements.mjs
// Every synthetic company, shipment, receipt and account stays in a temporary store.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { authenticateContext, bootstrapQaAuth } from './qa-auth.mjs';
import { loadSnapshot } from '../server/local-api.ts';
import { OperationsStore } from '../server/operations-store.ts';
import { clearOperations } from '../server/reset-operations.ts';
import { normalizeTbank } from '../server/banking/adapters.ts';
import { emptyBanking, operationId, upsertOperations } from '../server/banking/domain.ts';
import { emptySber, normalizeSberOperation, SBER_ACCOUNT } from '../server/banking/sber-domain.ts';
import { replaceStatementDay } from '../server/banking/statement-publication.ts';
import { accountNumber, fixtureConfig, fixtureDay, tbankRow } from '../tests/banking-fixtures.ts';

const root = resolve(import.meta.dirname, '..'), port = 5199, base = `http://127.0.0.1:${port}`;
const temporary = await mkdtemp(resolve(tmpdir(), 'artel-overview-ui-'));
const output = resolve(root, 'qa/overview'); await mkdir(output, { recursive: true });
const workingSnapshot = async () => {
  try {
    const { data } = JSON.parse(await readFile(resolve(root, 'data/local-operations/operations.json'), 'utf8'));
    // The separate running local app may update its push scheduler heartbeat.
    delete data.revision; if (data.push) delete data.push.lastRunAt;
    return data;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
const checksum = data => createHash('sha256').update(JSON.stringify(data)).digest('hex');
const before = await workingSnapshot();
const report = { status: 'running', fixtureOnly: true, banksContacted: false, connections: ['tbank-nk-artel', 'sber-nk-artel', 'sber-artel'], checks: [], errors: [], overflows: [], accessibility: [], screenshots: [], workingStoreContentUnchangedIgnoringHeartbeat: false };
const check = text => { report.checks.push(text); console.log('PASS', text); };
let server, browser, page, serverLog = '';
try {
  await assert.rejects(fetch(base, { signal: AbortSignal.timeout(500) }), 'The isolated QA port must be unused');
  const source = await loadSnapshot(), store = new OperationsStore(temporary);
  await store.mutate(source.provenance.sourceSha256, data => { clearOperations(source, data); data.companies.forEach(company => { company.directoryArchived = true; }); return { changed: true, result: null }; });
  const isolatedEnvironment = { ...process.env, ARTEL_STORE_DIR: temporary, ARTEL_BANK_SYNC_ENABLED: 'false', CHECKO_API_KEY: '', VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '', PUSH_SCHEDULE_ENABLED: 'false', CRON_SECRET: '' };
  for (const name of ['ARTEL_BANK_TBANK_NK_TOKEN', 'ARTEL_BANK_TBANK_NK_WEBHOOK_TOKEN', 'ARTEL_BANK_TBANK_NK_ACCOUNTS', 'ARTEL_BANK_SBER_NK_CLIENT_ID', 'ARTEL_BANK_SBER_NK_CLIENT_SECRET', 'ARTEL_BANK_SBER_NK_ACCESS_TOKEN', 'ARTEL_BANK_SBER_NK_REFRESH_TOKEN', 'ARTEL_BANK_SBER_NK_TLS_PFX_BASE64', 'ARTEL_BANK_SBER_NK_TLS_PASSPHRASE', 'ARTEL_BANK_SBER_NK_TLS_CA_BASE64']) isolatedEnvironment[name] = '';
  for (const name of Object.keys(isolatedEnvironment)) if (name.startsWith('ARTEL_BANK_')) isolatedEnvironment[name] = '';
  for (const key of ['CLIENT_ID', 'CLIENT_SECRET', 'ACCESS_TOKEN', 'REFRESH_TOKEN', 'TLS_PFX_BASE64', 'TLS_PASSPHRASE', 'TLS_CA_BASE64']) isolatedEnvironment[`ARTEL_BANK_SBER_ARTEL_${key}`] = '';
  isolatedEnvironment.ARTEL_BANK_SYNC_ENABLED = 'false';
  server = spawn(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: root, env: isolatedEnvironment, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [server.stdout, server.stderr]) stream.on('data', chunk => { serverLog = (serverLog + chunk).slice(-10000); });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (server.exitCode !== null) throw new Error(`Isolated Vite exited with code ${server.exitCode}`);
    try { if ((await fetch(base + '/api/auth/session')).ok) { ready = true; break; } } catch {}
    await new Promise(done => setTimeout(done, 100));
  }
  assert.equal(ready, true, 'Isolated Vite did not start');
  const { cookie } = await bootstrapQaAuth(base);
  browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  await authenticateContext(context, base, cookie);
  const api = async (path, data) => {
    const response = data === undefined ? await context.request.get(base + path) : await context.request.post(base + path, { data });
    const body = await response.json(); assert.ok(response.ok(), `${path}: ${response.status()} ${JSON.stringify(body)}`); return body;
  };
  const snapshot = await api('/api/snapshot'), directories = snapshot.directories;
  const managers = [];
  for (const name of ['Айдар · обзор QA', 'Зуфар · обзор QA']) managers.push((await api('/api/directories', { kind: 'managers', name })).entry);
  const supplier = (await api('/api/directories', { kind: 'companies', name: 'Поставщик · обзор QA', roles: ['supplier'], addresses: [] })).entry;
  const companies = [];
  for (const [name, inn, manager] of [['ООО Ромашка · тестовый аванс', '7707083893', managers[0]], ['ООО Василёк · тестовый долг', '7736050003', managers[1]], ['Покупатель без ИНН · нужна проверка', '', managers[0]], ['ООО Новый клиент · без операций', '9900000017', managers[0]]]) {
    companies.push({ ...(await api('/api/directories', { kind: 'companies', name, inn, roles: ['customer'], managerId: manager.id, addresses: [] })).entry, managerId: manager.id });
  }
  const createShipment = async (company, amount, date, number) => api('/api/shipments', { fields: { shipment_type: 'azs', date, document_number: number, customer_id: company.id, supplier_id: supplier.id, manager_id: company.managerId, product_id: directories.products[0].id, payment_form_id: directories.paymentForms.find(row => row.name === 'б/нал').id, quantity_litres: '1000', customer_amount: amount, purchase_amount: '0' } });
  await createShipment(companies[0], '40000', '2026-09-01', 'ROM-40');
  await createShipment(companies[0], '30000', '2026-09-02', 'ROM-30');
  await createShipment(companies[1], '150000', '2026-09-03', 'VAS-150');
  await createShipment(companies[2], '10000', '2026-09-04', 'CHECK-INN');
  const incoming = (id, amount, company) => {
    const raw = tbankRow(id, amount);
    return normalizeTbank(fixtureConfig(), { number: accountNumber, currency: 'RUB' }, fixtureDay, { ...raw, payer: { ...raw.payer, name: company.name, inn: company.inn }, payPurpose: 'Тестовое поступление за топливо. Распределение по самым ранним отгрузкам покупателя.' });
  };
  const incomingSber = (id, amount, company) => normalizeSberOperation({ operationId: id, direction: 'CREDIT', amount: { amount, currencyName: 'RUB' }, operationDate: `${fixtureDay}T12:00:00Z`, paymentPurpose: 'Тестовое поступление Сбера в общий баланс покупателя.', rurTransfer: { payerName: company.name, payerInn: company.inn, payerAccount: '40702810000000000199', payeeName: 'НК АРТЕЛЬ — тест', payeeAccount: SBER_ACCOUNT } }, fixtureDay);
  const artelAccount = '40702810000000000003';
  const nkReceipt = incomingSber('qa-romashka-sber-nk-30', '30000', companies[0]);
  const artelReceipt = { ...incomingSber('qa-romashka-sber-artel-30', '30000', companies[0]), id: operationId('sber-artel', artelAccount, 'qa-romashka-sber-artel-30'), connectionId: 'sber-artel', account: artelAccount };
  artelReceipt.payee = { ...artelReceipt.payee, name: 'АРТЕЛЬ — тест', account: artelAccount };
  artelReceipt.bankData = { ...artelReceipt.bankData, rurTransfer: { ...artelReceipt.bankData.rurTransfer, payeeName: 'АРТЕЛЬ — тест', payeeAccount: artelAccount } };
  await store.mutate(source.provenance.sourceSha256, data => {
    data.banking = emptyBanking(); upsertOperations(data.banking, [incoming('qa-romashka-tbank-40', '40000', companies[0]), incoming('qa-vasilek-30', '30000', companies[1]), incoming('qa-missing-inn', '5000', companies[2])]);
    data.banking.connections['tbank-nk-artel'] = { accounts: [{ number: accountNumber, currency: 'RUB' }], lastSuccessAt: `${fixtureDay}T12:00:00Z`, lastCompletedPeriod: { from: fixtureDay, to: fixtureDay } };
    data.sber = { ...emptySber(), operations: [nkReceipt], lastSuccessAt: `${fixtureDay}T12:00:00Z`, lastCompletedPeriod: { from: fixtureDay, to: fixtureDay } };
    replaceStatementDay(data.banking, 'sber-artel', { number: artelAccount, currency: 'RUB' }, fixtureDay, [artelReceipt], `${fixtureDay}T12:00:00Z`);
    Object.assign(data.banking.connections['sber-artel'], { lastSuccessAt: `${fixtureDay}T12:00:00Z`, lastCompletedPeriod: { from: fixtureDay, to: fixtureDay } });
    return { changed: true, result: null };
  });
  const ledger = await api('/api/settlements');
  assert.deepEqual(ledger.totals, { shipped: '230000', incoming: '130000', debt: '130000', advance: '30000', allocated: '100000' });
  assert.equal(ledger.review.length, 1);
  assert.deepEqual(ledger.sources.map(row => row.id).sort(), [...report.connections].sort());
  assert.ok(ledger.sources.every(row => row.status === 'ready' && row.lastSuccessAt === `${fixtureDay}T12:00:00Z`));
  assert.deepEqual(ledger.companies.find(row => row.inn === companies[0].inn).receipts.map(row => row.connectionId).sort(), [...report.connections].sort());
  page = await context.newPage(); page.on('pageerror', error => report.errors.push(error.message));
  await page.clock.setFixedTime(new Date('2026-09-28T09:00:00Z'));
  await page.goto(base + '/#settlements');
  await expect(page.locator('.overview-page')).toBeVisible();
  await expect(page).toHaveURL(base + '/#overview');
  await expect(page.getByRole('button', { name: 'Взаиморасчёты', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Взаиморасчёты', exact: true })).toHaveCount(0);
  await expect(page.locator('.overview-company-button')).toHaveCount(4);
  await expect(page.locator('.overview-total[data-total="debt"]')).toContainText('130 000,00');
  await expect(page.locator('.overview-total[data-total="advance"]')).toContainText('30 000,00');
  await expect(page.locator('.overview-review')).toBeVisible();
  check('Legacy settlements route opens Overview, with one navigation entry, debt/advance totals and unresolved receipts');

  const companyButton = (name, target = page) => target.locator('.overview-company-button').filter({ hasText: name });
  const romashka = companyButton(companies[0].name), vasilek = companyButton(companies[1].name);
  const positiveBalance = romashka.locator('.overview-balance'), negativeBalance = vasilek.locator('.overview-balance');
  await expect(positiveBalance).toHaveAttribute('data-balance', '30000.00');
  await expect(positiveBalance).toHaveAttribute('data-tone', 'advance');
  await expect(positiveBalance).toContainText('+30 000,00');
  await expect(negativeBalance).toHaveAttribute('data-balance', '-120000.00');
  await expect(negativeBalance).toHaveAttribute('data-tone', 'debt');
  await expect(companyButton(companies[3].name).locator('.overview-balance')).toHaveAttribute('data-balance', '0.00');
  assert.match((await negativeBalance.innerText()).replace(/\s/g, ''), /^[−-]120000,00/);
  const colors = await Promise.all([positiveBalance, negativeBalance].map(locator => locator.evaluate(element => getComputedStyle(element).color)));
  const rgb = value => value.match(/[\d.]+/g).map(Number);
  assert.ok(rgb(colors[0])[1] > rgb(colors[0])[0], `Advance must be green: ${colors[0]}`);
  assert.ok(rgb(colors[1])[0] > rgb(colors[1])[1], `Debt must be red: ${colors[1]}`);
  check('Company names sit beside exact signed balances: a green +30,000 advance and a red −120,000 debt');

  const capture = async (name, width, target = page) => {
    await target.setViewportSize({ width, height: 1000 });
    await target.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); window.scrollTo(0, 0); });
    const dimensions = await target.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
    if (dimensions.document > width + 1 || dimensions.body > width + 1) report.overflows.push({ name, ...dimensions });
    const path = resolve(output, `${name}-${width}.png`); await target.screenshot({ path, fullPage: true }); report.screenshots.push(path);
  };
  const audit = async (name, width) => {
    await page.setViewportSize({ width, height: 1000 });
    const result = await new AxeBuilder({ page }).include('.overview-page').analyze();
    report.accessibility.push({ name, width, violations: result.violations });
    assert.deepEqual(result.violations, [], `Accessibility violations in ${name} at ${width}px`);
  };
  const period = page.getByRole('combobox', { name: 'Период диаграммы', exact: true });
  await expect(period).toHaveValue('6');
  await expect(page.locator('.overview-month-button')).toHaveCount(6);
  await period.selectOption('12'); await expect(period).toHaveValue('12');
  await expect(page.locator('.overview-month-button')).toHaveCount(12);
  await period.selectOption('all'); await expect(period).toHaveValue('all');
  await page.locator('.overview-month-button[data-month="2026-09"]').click();
  await expect(page.locator('.overview-chart-detail')).toContainText('130 000,00');
  await expect(page.locator('.overview-chart-detail')).toContainText('230 000,00');
  await expect(positiveBalance).toHaveAttribute('data-balance', '30000.00');
  await period.selectOption('6');
  check('Monthly chart supports six/twelve months and all time; selecting September exposes exact incoming/shipped values without changing current balances');
  for (const width of [1440, 390, 320]) await capture('overview', width);
  for (const width of [1440, 320]) await audit('overview', width);

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('.overview-sources summary').click();
  for (const [id, label] of [['tbank-nk-artel', 'Т-Банк · НК АРТЕЛЬ'], ['sber-nk-artel', 'СберБизнес · НК АРТЕЛЬ'], ['sber-artel', 'СберБизнес · АРТЕЛЬ']]) {
    const item = page.locator(`.overview-sources [data-connection-id="${id}"]`);
    await expect(item).toContainText(label); await expect(item).toContainText('Выписка загружена');
  }
  check('Director can inspect the three distinct stored bank statement sources without contacting a bank');
  const search = page.getByRole('textbox', { name: 'Поиск компаний по названию или ИНН', exact: true });
  await search.fill(companies[0].inn); await expect(page.locator('.overview-company-button')).toHaveCount(1);
  await romashka.click();
  const details = page.locator('.overview-company-details');
  await expect(details).toContainText(companies[0].name);
  await expect(details).toContainText('ROM-40'); await expect(details).toContainText('ROM-30');
  await expect(details.locator('.overview-transaction[data-type="shipment"]')).toHaveCount(2);
  await expect(details.locator('.overview-transaction[data-type="receipt"]')).toHaveCount(3);
  for (const label of ['Т-Банк', 'СберБизнес', 'НК АРТЕЛЬ', 'АРТЕЛЬ']) await expect(details).toContainText(label);
  const transactionFilter = details.getByRole('combobox', { name: 'Тип операций компании', exact: true });
  await transactionFilter.selectOption('receipt'); await expect(details.locator('.overview-transaction')).toHaveCount(3);
  await transactionFilter.selectOption('shipment'); await expect(details.locator('.overview-transaction')).toHaveCount(2);
  await transactionFilter.selectOption('all');
  const shipmentEntry = details.locator('.overview-transaction[data-type="shipment"]').filter({ hasText: 'ROM-40' });
  await shipmentEntry.locator('summary').click();
  await expect(shipmentEntry.getByText('Сумма отгрузки', { exact: true })).toBeVisible();
  await expect(shipmentEntry.getByText('Оплачено всего', { exact: true })).toBeVisible();
  await expect(shipmentEntry.locator('.overview-operation-data')).toContainText('40 000,00');
  const receiptEntry = details.locator('.overview-transaction[data-type="receipt"]').first();
  await receiptEntry.locator('summary').click();
  await expect(receiptEntry.getByText('Счёт зачисления', { exact: true })).toBeVisible();
  await expect(receiptEntry.getByText('Назначение платежа', { exact: true })).toBeVisible();
  await transactionFilter.selectOption('receipt');
  const allocationReceipt = details.locator('.overview-transaction[data-type="receipt"]').filter({ has: page.locator('.overview-receipt-allocations button') }).first();
  if (await allocationReceipt.locator('details').getAttribute('open') === null) await allocationReceipt.locator('summary').click();
  const relatedShipment = allocationReceipt.locator('.overview-receipt-allocations button').first();
  const targetNumber = (await relatedShipment.innerText()).match(/ROM-(?:40|30)/)[0];
  await relatedShipment.click();
  await expect(transactionFilter).toHaveValue('all');
  const focusedShipment = details.locator('.overview-transaction[data-type="shipment"]').filter({ hasText: targetNumber });
  await expect(focusedShipment.locator('summary')).toBeFocused();
  await expect(focusedShipment.locator('details')).toHaveAttribute('open', '');
  await expect(page).toHaveURL(base + '/#overview');
  for (const width of [1440, 390, 320]) await capture('company-advance', width);
  for (const width of [1440, 320]) await audit('company-details', width);
  check('Company drilldown shows both shipment debits with document numbers and three bank receipt credits, accessible on desktop and narrow mobile screens');
  await page.getByRole('button', { name: 'Назад к компаниям', exact: true }).click();
  await expect(search).toHaveValue(companies[0].inn);
  await search.fill('Василёк'); await expect(page.locator('.overview-company-button')).toHaveCount(1);
  await vasilek.click();
  await expect(details).toContainText('VAS-150');
  await expect(details.locator('.overview-transaction[data-type="receipt"]')).toHaveCount(1);
  await expect(details.locator('.overview-transaction[data-type="shipment"]')).toHaveCount(1);
  await capture('company-debt', 320);
  await page.getByRole('button', { name: 'Назад к компаниям', exact: true }).click();
  await search.fill('');
  const companyFilter = page.getByRole('combobox', { name: 'Фильтр компаний', exact: true });
  await companyFilter.selectOption('debt'); await expect(page.locator('.overview-company-button')).toHaveCount(2);
  await companyFilter.selectOption('advance'); await expect(page.locator('.overview-company-button')).toHaveCount(1);
  await companyFilter.selectOption('review'); await expect(page.locator('.overview-company-button')).toHaveCount(1);
  await expect(page.locator('.overview-company-button')).toContainText('без ИНН');
  await companyFilter.selectOption('all');
  await search.fill('Такой компании нет'); await expect(page.locator('.overview-company-button')).toHaveCount(0);
  await expect(page.locator('.overview-page')).toContainText(/нет|найден/);
  await search.fill('');
  check('Name/INN search, empty search, debt/advance/review filters and returning from a company work while preserving search');

  for (let index = 0; index < managers.length; index++) {
    const password = randomBytes(24).toString('hex'), login = `overview-manager-${index}`;
    await api('/api/auth/users', { name: managers[index].name, login, password, role: 'manager', managerId: managers[index].id, sections: ['overview', 'shipments'] });
    const managerContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    try {
      assert.equal((await managerContext.request.post(base + '/api/auth/login', { data: { login, password } })).status(), 200);
      const scopedResponse = await managerContext.request.get(base + '/api/settlements'); assert.equal(scopedResponse.status(), 200);
      const scoped = await scopedResponse.json(), own = companies[index], other = companies[1 - index];
      assert.equal(scoped.scope, 'own'); assert.deepEqual(scoped.sources, []); assert.deepEqual(scoped.review, []);
      assert.deepEqual(scoped.companies.map(row => row.name).sort(), (index === 0 ? [companies[0].name, companies[2].name, companies[3].name] : [companies[1].name]).sort());
      assert.ok(!JSON.stringify(scoped).includes(other.name)); assert.ok(!JSON.stringify(scoped).includes(other.id));
      assert.equal(scoped.totals.incoming, index === 0 ? '100000' : '30000');
      assert.equal(scoped.totals.shipped, index === 0 ? '80000' : '150000');
      const managerPage = await managerContext.newPage(); managerPage.on('pageerror', error => report.errors.push(error.message));
      await managerPage.clock.setFixedTime(new Date('2026-09-28T09:00:00Z'));
      await managerPage.goto(base + '/#overview');
      await expect(managerPage.locator('.overview-company-button')).toHaveCount(index === 0 ? 3 : 1);
      await expect(managerPage.locator('.overview-page')).not.toContainText(other.name);
      await expect(managerPage.locator('.overview-sources')).toHaveCount(0);
      await managerPage.locator('.overview-month-button[data-month="2026-09"]').click();
      await expect(managerPage.locator('.overview-chart-detail')).toContainText(index === 0 ? '100 000,00' : '30 000,00');
      await expect(managerPage.locator('.overview-chart-detail')).toContainText(index === 0 ? '80 000,00' : '150 000,00');
      await capture(`manager-${index + 1}`, 1440, managerPage);
      await companyButton(own.name, managerPage).click();
      await expect(managerPage.locator('.overview-company-details')).toContainText(index === 0 ? 'ROM-40' : 'VAS-150');
      await expect(managerPage.locator('.overview-page')).not.toContainText(index === 0 ? 'VAS-150' : 'ROM-40');
      await expect(managerPage.locator('.overview-transaction[data-type="receipt"]')).toHaveCount(index === 0 ? 3 : 1);
      await capture(`manager-${index + 1}-company`, 320, managerPage);
    } finally { await managerContext.close(); }
  }
  check('Two isolated manager sessions each receive and render only their companies, credits, shipment debits, balances and chart totals; global sources/unresolved receipts are absent');

  await page.setViewportSize({ width: 1440, height: 1000 });
  await createShipment(companies[0], '20000', '2026-09-05', 'ROM-20');
  await page.getByRole('button', { name: 'Обновить', exact: true }).click();
  await expect(page.locator('.overview-total[data-total="advance"]')).toContainText('10 000,00');
  await page.reload(); await expect(page.locator('.overview-total[data-total="advance"]')).toContainText('10 000,00');
  const persisted = await api('/api/settlements'); assert.equal(persisted.companies.find(row => row.inn === companies[0].inn).advance, '10000');
  check('A new shipment consumes 20,000 of the existing company advance after refresh, and the result survives a reload');
  const failedSourceMessage = 'Тестовая ошибка загрузки СберБизнес АРТЕЛЬ. Предыдущая выписка сохранена.';
  await store.mutate(source.provenance.sourceSha256, data => { data.banking.connections['sber-artel'].lastError = failedSourceMessage; return { changed: true, result: null }; });
  await page.getByRole('button', { name: 'Обновить', exact: true }).click();
  const failedSource = page.locator('.overview-sources [data-connection-id="sber-artel"]');
  await expect(failedSource).toContainText('Ошибка загрузки'); await expect(failedSource).toContainText(failedSourceMessage);
  const afterSourceError = await api('/api/settlements');
  assert.deepEqual(afterSourceError.totals, persisted.totals); assert.deepEqual(afterSourceError.companies, persisted.companies);
  assert.equal(afterSourceError.sources.find(row => row.id === 'sber-artel').status, 'error');
  await expect(page.locator('.overview-total[data-total="advance"]')).toContainText('10 000,00');
  check('A bank statement refresh error is visible and retains saved receipts and all company balances');
  const refreshFailure = route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Тестовая временная недоступность обзора.' }) });
  await page.route('**/api/settlements', refreshFailure);
  await page.getByRole('button', { name: 'Обновить', exact: true }).click();
  await expect(page.locator('.overview-error')).toContainText('Тестовая временная недоступность обзора.');
  await expect(page.locator('.overview-error')).toContainText('Они могут быть неактуальны');
  await expect(page.locator('.overview-total[data-total="advance"]')).toContainText('10 000,00');
  await page.unroute('**/api/settlements', refreshFailure);
  await page.getByRole('button', { name: 'Обновить', exact: true }).click();
  await expect(page.locator('.overview-error')).toHaveCount(0);
  check('Failed HTTP refresh preserves displayed balances with a stale-data warning; successful retry clears the warning');

  for (const status of [401, 403]) {
    await companyButton(companies[0].name).click();
    await expect(page.locator('.overview-company-details')).toContainText(companies[0].name);
    const denied = route => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ error: `Тестовая потеря доступа: ${status}.` }) });
    await page.route('**/api/settlements', denied);
    await page.getByRole('button', { name: 'Обновить', exact: true }).click();
    await expect(page.locator('.overview-error')).toContainText(`Тестовая потеря доступа: ${status}.`);
    await expect(page.locator('.overview-company-details, .overview-company-button, .overview-total, .overview-charts')).toHaveCount(0);
    await expect(page.locator('.overview-page')).not.toContainText(companies[0].name);
    await page.unroute('**/api/settlements', denied);
    await page.getByRole('button', { name: 'Обновить', exact: true }).click();
    await expect(page.locator('.overview-company-button')).toHaveCount(4);
  }
  check('401/403 refresh immediately removes previously visible company details, balances and charts; restored access reloads the company list');

  const emptyReport = { ...persisted, companies: [], sources: [], review: [], totals: { shipped: '0', incoming: '0', debt: '0', advance: '0', allocated: '0' } };
  const emptyResponse = route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(emptyReport) });
  await page.route('**/api/settlements', emptyResponse);
  await page.reload(); await expect(page.locator('.overview-company-button')).toHaveCount(0);
  await expect(page.locator('.overview-total[data-total="debt"]')).toContainText('0,00');
  await capture('empty-overview', 320); await audit('empty-overview', 320);
  await page.unroute('**/api/settlements', emptyResponse);
  await page.route('**/api/settlements', refreshFailure);
  await page.reload(); await expect(page.locator('.overview-page')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.overview-error')).toContainText('Тестовая временная недоступность обзора.');
  await expect(page.locator('.overview-company-button')).toHaveCount(0);
  await capture('unavailable-overview', 320);
  await page.unroute('**/api/settlements', refreshFailure);
  await page.getByRole('button', { name: 'Обновить', exact: true }).click();
  await expect(page.locator('.overview-company-button')).toHaveCount(4);
  check('An empty report and an initially unavailable report render without stale invented data; retry restores the real isolated fixture');
  assert.deepEqual(report.errors, []); assert.deepEqual(report.overflows, []);
  check('No browser exceptions or horizontal page overflow at 1440, 390 and 320 pixels; axe reports no violations for overview, company and empty states');
  await rm(resolve(output, 'failure.png'), { force: true });
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = String(error.stack || error);
  report.serverLog = serverLog;
  if (page) { await page.screenshot({ path: resolve(output, 'failure.png'), fullPage: true }).catch(() => {}); console.error(await page.locator('body').innerText().catch(() => '')); }
  throw error;
} finally {
  await browser?.close();
  if (server && server.exitCode === null) { server.kill('SIGTERM'); await new Promise(done => server.once('exit', done)); }
  await rm(temporary, { recursive: true, force: true });
  report.workingStoreContentUnchangedIgnoringHeartbeat = checksum(before) === checksum(await workingSnapshot());
  await writeFile(resolve(output, 'browser.json'), JSON.stringify(report, null, 2));
  assert.equal(report.workingStoreContentUnchangedIgnoringHeartbeat, true, 'Working CRM data changed while isolated browser QA ran');
}
