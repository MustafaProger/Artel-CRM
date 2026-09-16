// Run with: node --import tsx scripts/verify_settlements.mjs
// Every synthetic company, shipment, receipt and account stays in a temporary store.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { authenticateContext, bootstrapQaAuth } from './qa-auth.mjs';
import { loadSnapshot } from '../server/local-api.ts';
import { OperationsStore } from '../server/operations-store.ts';
import { normalizeTbank } from '../server/banking/adapters.ts';
import { emptyBanking, operationId, upsertOperations } from '../server/banking/domain.ts';
import { emptySber, normalizeSberOperation, SBER_ACCOUNT } from '../server/banking/sber-domain.ts';
import { replaceStatementDay } from '../server/banking/statement-publication.ts';
import { accountNumber, fixtureConfig, fixtureDay, tbankRow } from '../tests/banking-fixtures.ts';

const root = resolve(import.meta.dirname, '..'), port = 5199, base = `http://127.0.0.1:${port}`;
const temporary = await mkdtemp(resolve(tmpdir(), 'artel-settlements-ui-'));
const output = resolve(root, 'qa/settlements'); await mkdir(output, { recursive: true });
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
const report = { fixtureOnly: true, banksContacted: false, connections: ['tbank-nk-artel', 'sber-nk-artel', 'sber-artel'], checks: [], errors: [], overflows: [], accessibility: [], screenshots: [], workingStoreContentUnchangedIgnoringHeartbeat: false };
const check = text => { report.checks.push(text); console.log('PASS', text); };
let server, browser, page;
try {
  await assert.rejects(fetch(base, { signal: AbortSignal.timeout(500) }), 'The isolated QA port must be unused');
  const source = await loadSnapshot(), store = new OperationsStore(temporary);
  await store.mutate(source.provenance.sourceSha256, data => { data.sourceOperationsCleared = true; return { changed: true, result: null }; });
  const isolatedEnvironment = { ...process.env, ARTEL_STORE_DIR: temporary, ARTEL_BANK_SYNC_ENABLED: 'false', CHECKO_API_KEY: '', VAPID_PUBLIC_KEY: '', VAPID_PRIVATE_KEY: '', PUSH_SCHEDULE_ENABLED: 'false', CRON_SECRET: '' };
  for (const name of ['ARTEL_BANK_TBANK_NK_TOKEN', 'ARTEL_BANK_TBANK_NK_WEBHOOK_TOKEN', 'ARTEL_BANK_TBANK_NK_ACCOUNTS', 'ARTEL_BANK_SBER_NK_CLIENT_ID', 'ARTEL_BANK_SBER_NK_CLIENT_SECRET', 'ARTEL_BANK_SBER_NK_ACCESS_TOKEN', 'ARTEL_BANK_SBER_NK_REFRESH_TOKEN', 'ARTEL_BANK_SBER_NK_TLS_PFX_BASE64', 'ARTEL_BANK_SBER_NK_TLS_PASSPHRASE', 'ARTEL_BANK_SBER_NK_TLS_CA_BASE64']) isolatedEnvironment[name] = '';
  for (const name of Object.keys(isolatedEnvironment)) if (name.startsWith('ARTEL_BANK_')) isolatedEnvironment[name] = '';
  for (const key of ['CLIENT_ID', 'CLIENT_SECRET', 'ACCESS_TOKEN', 'REFRESH_TOKEN', 'TLS_PFX_BASE64', 'TLS_PASSPHRASE', 'TLS_CA_BASE64']) isolatedEnvironment[`ARTEL_BANK_SBER_ARTEL_${key}`] = '';
  isolatedEnvironment.ARTEL_BANK_SYNC_ENABLED = 'false';
  server = spawn(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: root, env: isolatedEnvironment, stdio: 'ignore' });
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
  const companies = [];
  for (const [name, inn] of [['ООО Ромашка · тестовый аванс', '7707083893'], ['ООО Василёк · тестовый долг', '7736050003'], ['Покупатель без ИНН · нужна проверка', '']]) {
    companies.push((await api('/api/directories', { kind: 'companies', name, inn, roles: ['customer'], managerId: directories.managers[0].id, addresses: [] })).entry);
  }
  const createShipment = async (company, amount, date, number) => api('/api/shipments', { fields: { shipment_type: 'azs', date, document_number: number, customer_id: company.id, supplier_id: snapshot.companies[0].id, manager_id: directories.managers[0].id, product_id: directories.products[0].id, payment_form_id: directories.paymentForms.find(row => row.name === 'б/нал').id, quantity_litres: '1000', customer_amount: amount, purchase_amount: '0' } });
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
  await page.goto(base + '/#settlements');
  await expect(page.getByRole('heading', { name: 'Расчёты с покупателями', exact: true })).toBeVisible();
  await expect(page.locator('.settlements-company-button')).toHaveCount(3);
  await expect(page.locator('.settlements-total-debt')).toContainText('130 000,00');
  await expect(page.locator('.settlements-total-advance')).toContainText('30 000,00');
  await expect(page.getByRole('heading', { name: /Поступления на проверку/ })).toBeVisible();
  check('The ledger shows separate debt and advance totals, three buyers and one unresolved bank receipt');
  await page.locator('.settlements-sources summary').click();
  await expect(page.locator('.settlements-sources li')).toHaveCount(3);
  for (const [id, label] of [['tbank-nk-artel', 'Т-Банк · НК АРТЕЛЬ'], ['sber-nk-artel', 'СберБизнес · НК АРТЕЛЬ'], ['sber-artel', 'СберБизнес · АРТЕЛЬ']]) {
    const item = page.locator(`.settlements-sources [data-connection-id="${id}"]`);
    await expect(item).toContainText(label); await expect(item).toContainText('Выписка загружена');
  }
  check('Three isolated statement fixtures are attributed to T-Bank/NK ARTEL and both distinct Sber organizations; no external bank request is needed');
  const search = page.getByRole('textbox', { name: 'Поиск покупателей по названию или ИНН' });
  await search.fill(companies[0].inn); await expect(page.locator('.settlements-company-button')).toHaveCount(1);
  await page.locator('.settlements-company-button').click();
  await expect(page.locator('.settlements-company-details')).toContainText('ROM-40');
  await expect(page.locator('.settlements-company-details')).toContainText('ROM-30');
  await expect(page.locator('.settlements-detail-table tbody tr')).toHaveCount(2);
  const paidRows = await page.locator('.settlements-detail-table tbody tr').evaluateAll(rows => rows.map(row => [...row.querySelectorAll('td')].map(cell => cell.textContent.replace(/\s/g, ''))));
  assert.equal(paidRows[0][4], '40000,00₽'); assert.equal(paidRows[1][4], '30000,00₽');
  await expect(page.locator('.settlements-receipt')).toHaveCount(3);
  for (const [id, label] of [['tbank-nk-artel', 'Т-Банк · НК АРТЕЛЬ'], ['sber-nk-artel', 'СберБизнес · НК АРТЕЛЬ'], ['sber-artel', 'СберБизнес · АРТЕЛЬ']]) await expect(page.locator(`.settlements-receipt[data-connection-id="${id}"] .settlements-receipt-heading`)).toContainText(label);
  assert.equal((await page.locator('.settlements-receipt-balances').allTextContents()).filter(value => value.replace(/\s/g, '').includes('Остатокаванса30000,00₽')).length, 1);
  await page.locator('.settlements-allocations a').first().click();
  assert.equal(new URL(page.url()).hash, '#settlements', 'Receipt allocation links must not leave the ledger');
  const focusedShipment = await page.evaluate(() => document.activeElement?.id);
  assert.ok(focusedShipment.startsWith('settlement-shipment-'));
  check('Search by INN opens both FIFO allocations (40,000 and 30,000), keeps 30,000 advance and focuses shipment links without changing the route');
  const capture = async (name, width) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); window.scrollTo(0, 0); });
    const dimensions = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
    if (dimensions.document > width + 1 || dimensions.body > width + 1) report.overflows.push({ name, ...dimensions });
    const path = resolve(output, `${name}-${width}.png`); await page.screenshot({ path, fullPage: true }); report.screenshots.push(path);
  };
  for (const width of [1440, 390, 320]) await capture('company-advance', width);
  await search.fill('Василёк'); await expect(page.locator('.settlements-company-button')).toHaveCount(1);
  await page.locator('.settlements-company-button').click();
  await expect(page.locator('.settlements-company-details')).toContainText('VAS-150');
  await expect(page.locator('.settlements-company-row [data-label="Долг"]')).toContainText('120 000,00');
  await capture('company-debt', 320);
  await search.fill('');
  await page.getByRole('combobox', { name: /^Показать/ }).selectOption('debt'); await expect(page.locator('.settlements-company-button')).toHaveCount(2);
  await page.getByRole('combobox', { name: /^Показать/ }).selectOption('advance'); await expect(page.locator('.settlements-company-button')).toHaveCount(1);
  await page.getByRole('combobox', { name: /^Показать/ }).selectOption('review'); await expect(page.locator('.settlements-company-button')).toHaveCount(1);
  await expect(page.locator('.settlements-company-button')).toContainText('без ИНН');
  await page.getByRole('combobox', { name: /^Показать/ }).selectOption('all');
  for (const width of [1440, 390, 320]) await capture('ledger', width);
  check('Name search and debt/advance/review filters work on mobile; desktop, 390px and 320px layouts have no page overflow');
  for (const width of [1440, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    const result = await new AxeBuilder({ page }).include('.settlements-page').analyze();
    report.accessibility.push({ width, violations: result.violations });
    assert.deepEqual(result.violations, [], `Accessibility violations in the ledger at ${width}px`);
  }
  check('Axe reports zero violations within the new ledger at desktop and 320px mobile widths');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await createShipment(companies[0], '20000', '2026-09-05', 'ROM-20');
  await page.getByRole('button', { name: 'Обновить', exact: true }).click();
  await expect(page.locator('.settlements-total-advance')).toContainText('10 000,00');
  await page.reload(); await expect(page.locator('.settlements-total-advance')).toContainText('10 000,00');
  const persisted = await api('/api/settlements'); assert.equal(persisted.companies.find(row => row.inn === companies[0].inn).advance, '10000');
  check('A new shipment consumes the existing advance after refresh, and the balance survives a browser reload');
  const failedSourceMessage = 'Тестовая ошибка загрузки СберБизнес АРТЕЛЬ. Предыдущая выписка сохранена.';
  await store.mutate(source.provenance.sourceSha256, data => { data.banking.connections['sber-artel'].lastError = failedSourceMessage; return { changed: true, result: null }; });
  await page.getByRole('button', { name: 'Обновить', exact: true }).click();
  const failedSource = page.locator('.settlements-sources [data-connection-id="sber-artel"]');
  await expect(failedSource).toContainText('Ошибка загрузки'); await expect(failedSource).toContainText(failedSourceMessage);
  const afterSourceError = await api('/api/settlements');
  assert.deepEqual(afterSourceError.totals, persisted.totals); assert.deepEqual(afterSourceError.companies, persisted.companies);
  assert.equal(afterSourceError.sources.find(row => row.id === 'sber-artel').status, 'error');
  await expect(page.locator('.settlements-total-advance')).toContainText('10 000,00');
  check('A failed refresh of one bank is visible with its organization and error while its saved receipts keep the shared balances unchanged');
  const refreshFailure = route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Тестовая временная недоступность взаиморасчётов.' }) });
  await page.route('**/api/settlements', refreshFailure, { times: 1 });
  await page.getByRole('button', { name: 'Обновить', exact: true }).click();
  await expect(page.locator('.settlements-error')).toContainText('Тестовая временная недоступность взаиморасчётов.');
  await expect(page.locator('.settlements-error')).toContainText('Показаны последние полученные данные');
  await expect(page.locator('.settlements-total-advance')).toContainText('10 000,00');
  await page.unroute('**/api/settlements', refreshFailure);
  await page.getByRole('button', { name: 'Обновить', exact: true }).click();
  await expect(page.locator('.settlements-error')).toHaveCount(0);
  await expect(page.locator('.settlements-total-advance')).toContainText('10 000,00');
  check('A failed ledger HTTP refresh preserves totals and shows a stale-data warning; a successful retry removes the warning');
  assert.deepEqual(report.errors, []); assert.deepEqual(report.overflows, []);
  await rm(resolve(output, 'failure.png'), { force: true });
} catch (error) {
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
