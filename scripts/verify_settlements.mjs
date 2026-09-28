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
  const supplier = (await api('/api/directories', { kind: 'companies', name: 'ООО МТК · обзор QA', inn: '9900000024', roles: ['supplier'], addresses: [] })).entry;
  const companies = [];
  for (const [name, inn, manager] of [['ООО Ромашка · тестовый аванс', '7707083893', managers[0]], ['ООО Василёк · тестовый долг', '7736050003', managers[1]], ['Покупатель без ИНН · нужна проверка', '', managers[0]], ['ООО Новый клиент · без операций', '9900000017', managers[0]]]) {
    companies.push({ ...(await api('/api/directories', { kind: 'companies', name, inn, roles: ['customer'], managerId: manager.id, addresses: [] })).entry, managerId: manager.id });
  }
  const createShipment = async (company, amount, date, number, extra = {}) => api('/api/shipments', { fields: { shipment_type: 'azs', date, document_number: number, customer_id: company.id, supplier_id: supplier.id, manager_id: company.managerId, product_id: directories.products[0].id, payment_form_id: directories.paymentForms.find(row => row.name === 'б/нал').id, quantity_litres: '1000', customer_amount: amount, purchase_amount: '0', ...extra } });
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
  const managerLogins = [];
  for (let index = 0; index < managers.length; index++) {
    const password = randomBytes(24).toString('hex'), login = `overview-manager-${index}`;
    managerLogins.push({ login, password });
    await api('/api/auth/users', { name: managers[index].name, login, password, role: 'manager', managerId: managers[index].id, sections: ['overview', 'shipments'] });
  }
  await page.goto(base + '/#settlements');
  await expect(page.locator('.overview-page')).toBeVisible();
  await expect(page).toHaveURL(base + '/#overview');
  await expect(page.locator('.overview-organization-picker button')).toHaveCount(2);
  await expect(page.locator('.overview-freshness')).toContainText('28.09.2026');
  await expect(page.getByRole('button', { name: 'Общий клиентский итог и прежняя история', exact: true })).toHaveCount(0);
  await expect(page.locator('.overview-charts, .overview-review, .overview-org-rule')).toHaveCount(0);
  await expect(page.getByTestId('organization-unassigned-notice')).toContainText('4 отгрузок');
  await expect(page.getByTestId('organization-unassigned-notice').locator('p')).toHaveCount(0);
  check('Legacy settlements route opens the organization overview; refresh and update date remain, removed legacy view, explanations and review panels are absent');

  // New organization ledgers: all writes below remain in this temporary store.
  await createShipment(companies[0], '500000', '2026-09-06', 'NK-PURCHASE-400', { organization_id: 'nk-artel', purchase_amount: '400000' });
  await createShipment(companies[0], '350000', '2026-09-07', 'ARTEL-PURCHASE-300', { organization_id: 'artel', purchase_amount: '300000' });
  const supplierPayment = { ...artelReceipt, id: operationId('sber-artel', artelAccount, 'qa-supplier-artel-700'), bankOperationId: 'qa-supplier-artel-700', documentNumber: 'QA-700', direction: 'outgoing', amount: '700000', booked: true, payer: { name: 'АРТЕЛЬ · тест', account: artelAccount }, payee: { name: supplier.name, inn: supplier.inn, account: '40702810000000000299' }, purpose: 'Синтетическая оплата МТК. Только временная проверка.', bankData: {} };
  await store.mutate(source.provenance.sourceSha256, data => {
    replaceStatementDay(data.banking, 'sber-artel', { number: artelAccount, currency: 'RUB' }, fixtureDay, [artelReceipt, supplierPayment], `${fixtureDay}T13:00:00Z`);
    return { changed: true, result: null };
  });
  let organizationReport = await api('/api/settlements');
  const supplierGroup = (result, id) => result.organizations.find(row => row.id === id).suppliers.companies.find(row => row.inn === supplier.inn);
  assert.equal(supplierGroup(organizationReport, 'nk-artel').debt, '400000');
  assert.equal(supplierGroup(organizationReport, 'artel').advance, '400000');
  assert.equal(supplierGroup(organizationReport, 'artel').debt, '0');
  await page.getByRole('button', { name: 'Обновить', exact: true }).click();
  await expect(page.getByTestId('organization-ledger')).toHaveAttribute('data-organization-id', 'nk-artel');
  const orgBalance = () => page.locator('.organization-company-button').filter({ hasText: supplier.name }).getByTestId('organization-company-balance');
  await expect(orgBalance()).toHaveAttribute('data-balance', '-400000.00');
  await expect(page.locator('.overview-charts')).toHaveCount(0);
  for (const width of [1440, 390, 320]) await capture('organization-suppliers', width);
  for (const width of [1440, 320]) await audit('organization-suppliers', width);
  await page.locator('.overview-organization-picker [data-organization-id="artel"]').click();
  await expect(orgBalance()).toHaveAttribute('data-balance', '400000.00');
  const initialFilter = page.getByRole('combobox', { name: 'Фильтр контрагентов', exact: true });
  await initialFilter.selectOption('advance'); await expect(page.locator('.organization-company-button')).toHaveCount(1);
  await initialFilter.selectOption('debt'); await expect(page.locator('.organization-company-button')).toHaveCount(0);
  await initialFilter.selectOption('all');
  await page.locator('.organization-company-button').filter({ hasText: supplier.name }).click();
  const orgDetails = page.locator('.organization-company-details');
  await expect(orgDetails.locator('.overview-transaction[data-type="shipment"]')).toHaveCount(1);
  await expect(orgDetails.locator('.overview-transaction[data-type="receipt"]')).toHaveCount(1);
  const purchaseRow = orgDetails.locator('.overview-transaction[data-type="shipment"]');
  await purchaseRow.locator('summary').click();
  await expect(purchaseRow).toContainText('300 000,00');
  await expect(purchaseRow).toContainText('700 000,00');
  await expect(purchaseRow).toContainText('400 000,00');
  await expect(purchaseRow).toContainText('qa-supplier-artel-700');
  await purchaseRow.locator('.overview-allocation-trace button').click();
  const paymentRow = orgDetails.locator('.overview-transaction[data-type="receipt"]');
  await expect(paymentRow.locator('details')).toHaveAttribute('open', '');
  await expect(paymentRow.locator('summary')).toBeFocused();
  await expect(paymentRow).toContainText(artelAccount);
  await expect(paymentRow).toContainText('QA-700');
  await paymentRow.locator('.overview-allocation-trace button').click();
  await expect(purchaseRow.locator('summary')).toBeFocused();
  for (const width of [1440, 390, 320]) await capture('supplier-allocation-detail', width);
  for (const width of [1440, 320]) await audit('supplier-allocation-detail', width);
  check('Organization C: ARTEL 700,000 pays only its 300,000 purchase, leaves 400,000 advance; NK debt 400,000 remains; closed purchases retain bidirectional payment trace');

  await createShipment(companies[0], '200000', '2026-09-15', 'ARTEL-ADVANCE-150', { organization_id: 'artel', purchase_amount: '150000' });
  await page.getByRole('button', { name: 'Обновить', exact: true }).click();
  await expect(orgDetails.getByTestId('organization-company-balance')).toHaveAttribute('data-balance', '250000.00');
  await page.reload();
  await page.locator('.overview-organization-picker [data-organization-id="artel"]').click();
  await expect(orgBalance()).toHaveAttribute('data-balance', '250000.00');
  organizationReport = await api('/api/settlements');
  assert.deepEqual(supplierGroup(organizationReport, 'artel').receipts[0].allocations.map(row => row.amount), ['300000', '150000']);
  assert.equal(supplierGroup(organizationReport, 'nk-artel').debt, '400000');
  await page.getByRole('button', { name: 'Клиенты', exact: true }).click();
  await expect(page.getByTestId('organization-ledger')).toHaveAttribute('data-side', 'clients');
  const scopedClient = page.locator('.organization-company-button').filter({ hasText: companies[0].name });
  await scopedClient.click();
  await expect(orgDetails).toContainText('ARTEL-PURCHASE-300');
  await expect(orgDetails).not.toContainText('NK-PURCHASE-400');
  await expect(orgDetails).not.toContainText('ROM-40');
  check('Supplier advance is consumed once by the next purchase and persists after reload; client detail contains only the chosen organization and excludes unassigned history');

  // A loss of access must also clear the new organization drilldown.
  const organizationDenied = route => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Тестовая потеря доступа к организациям.' }) });
  await page.route('**/api/settlements', organizationDenied);
  await page.getByRole('button', { name: 'Обновить', exact: true }).click();
  await expect(page.locator('.organization-company-details, .organization-company-button, .overview-organization-picker')).toHaveCount(0);
  await page.unroute('**/api/settlements', organizationDenied);
  await page.getByRole('button', { name: 'Обновить', exact: true }).click();
  await expect(page.locator('.overview-organization-picker button')).toHaveCount(2);
  check('403 clears organization balances and transaction detail before retry');

  await page.setViewportSize({ width: 1440, height: 1000 });
  // Sber's production adapter pins its account server-side. Render the same
  // synthetic stored operation through a read-only UI fixture, never a real account.
  const sberUiFixture = route => {
    assert.equal(route.request().method(), 'GET');
    const url = new URL(route.request().url());
    const body = url.pathname.endsWith('/statements') ? { account: artelAccount, company: 'АРТЕЛЬ · тест', inn: '9900000032', days: [], operations: [supplierPayment], lastSuccessAt: `${fixtureDay}T13:00:00Z`, missing: ['Тестовая выписка: банк отключён'] } : { operation: supplierPayment };
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  };
  await page.route('**/api/banking/sber/sber-artel/**', sberUiFixture);
  await page.goto(base + '/#payments');
  await page.getByRole('button', { name: 'Открыть СберБизнес — АРТЕЛЬ', exact: true }).click();
  await page.getByRole('button', { name: 'Открыть операцию № QA-700', exact: true }).click();
  const bankDialog = page.getByRole('dialog');
  await expect(bankDialog.locator('.bank-panel-header')).toContainText('АРТЕЛЬ');
  await expect(bankDialog.locator('.bank-panel-header')).not.toContainText('НК АРТЕЛЬ');
  const bankTrace = bankDialog.getByRole('region', { name: 'Распределение оплаты поставщику', exact: true });
  await expect(bankTrace).toContainText('700 000,00');
  await expect(bankTrace).toContainText('450 000,00');
  await expect(bankTrace).toContainText('250 000,00');
  await expect(bankTrace).toContainText('ARTEL-PURCHASE-300');
  await expect(bankTrace).toContainText('ARTEL-ADVANCE-150');
  await expect(bankTrace).not.toContainText('NK-PURCHASE-400');
  await capture('supplier-bank-payment', 320);
  const bankAxe = await new AxeBuilder({ page }).include('.bank-supplier-trace').analyze();
  report.accessibility.push({ name: 'supplier-bank-payment', width: 320, violations: bankAxe.violations });
  assert.deepEqual(bankAxe.violations, []);
  check('Sber ARTEL synthetic payment UI shows original 700,000, allocated 450,000, advance 250,000 from real temporary settlement API; bank listing/detail mocked, no bank contacted');

  await createShipment(companies[1], '400000', '2026-09-16', 'OTHER-MANAGER-350', { organization_id: 'artel', purchase_amount: '350000' });
  const ownContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  try {
    assert.equal((await ownContext.request.post(base + '/api/auth/login', { data: managerLogins[0] })).status(), 200);
    const scoped = await (await ownContext.request.get(base + '/api/settlements')).json();
    const ownSupplier = supplierGroup(scoped, 'artel');
    assert.equal(ownSupplier.receipts[0].amount, '450000');
    assert.equal(ownSupplier.receipts[0].amountIsScoped, true);
    assert.equal(ownSupplier.receipts[0].advance, '0');
    assert.ok(!JSON.stringify(scoped).includes('OTHER-MANAGER-350'));
    const ownPage = await ownContext.newPage();
    ownPage.on('pageerror', error => report.errors.push(error.message));
    await ownPage.goto(base + '/#overview');
    await ownPage.locator('.overview-organization-picker [data-organization-id="artel"]').click();
    await expect(ownPage.locator('[data-total="advance"]')).toContainText('Доступен руководителю');
    await ownPage.locator('.organization-company-button').filter({ hasText: supplier.name }).click();
    const ownReceipt = ownPage.locator('.organization-company-details .overview-transaction[data-type="receipt"]');
    await ownReceipt.locator('summary').click();
    await expect(ownReceipt).toContainText('Сумма в вашей области');
    await expect(ownReceipt).toContainText('450 000,00');
    await expect(ownReceipt).not.toContainText('700 000,00');
    await expect(ownReceipt).not.toContainText('OTHER-MANAGER-350');
    await capture('manager-supplier-detail', 320, ownPage);
  } finally { await ownContext.close(); }
  check('Manager supplier view shows only own 450,000 of a shared payment, labels it as partial, hides foreign purchases and does not claim access to the free supplier advance');
  // Distinct synthetic balances and latest-operation dates exercise every sort
  // independently in each organization and on both sides of the ledger.
  const extraSuppliers = [];
  for (const [name, inn] of [['Поставщик Бета · сортировка QA', '9900000049'], ['Поставщик Гамма · сортировка QA', '9900000056']]) {
    extraSuppliers.push((await api('/api/directories', { kind: 'companies', name, inn, roles: ['supplier'], addresses: [] })).entry);
  }
  for (const [company, sale, date, number, org, purchase, vendor] of [
    [companies[0], '12000', '2026-09-11', 'NK-SORT-10', 'nk-artel', '10000', supplier],
    [companies[0], '24000', '2026-09-19', 'NK-SORT-20', 'nk-artel', '20000', supplier],
    [companies[1], '90000', '2026-09-12', 'NK-BETA', 'nk-artel', '120000', extraSuppliers[0]],
    [companies[3], '45000', '2026-09-22', 'NK-GAMMA', 'nk-artel', '60000', extraSuppliers[1]],
    [companies[1], '80000', '2026-09-20', 'ARTEL-BETA', 'artel', '120000', extraSuppliers[0]],
    [companies[3], '25000', '2026-09-25', 'ARTEL-GAMMA', 'artel', '60000', extraSuppliers[1]],
  ]) await createShipment(company, sale, date, number, { organization_id: org, purchase_amount: purchase, supplier_id: vendor.id });
  organizationReport = await api('/api/settlements');
  await page.goto(base + '/#overview');
  const companyButtons = () => page.locator('.organization-company-button');
  const companyNames = () => companyButtons().locator('.overview-company-identity strong');
  const companySort = page.getByRole('combobox', { name: 'Сортировка контрагентов', exact: true });
  const operationSort = page.getByRole('combobox', { name: 'Сортировка операций', exact: true });
  const expectedCompanies = {
    'nk-artel:suppliers': { amount: [supplier.name, extraSuppliers[0].name, extraSuppliers[1].name], date: [extraSuppliers[1].name, supplier.name, extraSuppliers[0].name] },
    'artel:suppliers': { amount: [extraSuppliers[0].name, supplier.name, extraSuppliers[1].name], date: [extraSuppliers[1].name, extraSuppliers[0].name, supplier.name] },
    'nk-artel:clients': { amount: [companies[0].name, companies[1].name, companies[3].name], date: [companies[3].name, companies[0].name, companies[1].name] },
    'artel:clients': { amount: [companies[0].name, companies[1].name, companies[3].name], date: [companies[3].name, companies[1].name, companies[0].name] },
  };
  for (const org of ['nk-artel', 'artel']) {
    await page.locator(`.overview-organization-picker [data-organization-id="${org}"]`).click();
    for (const side of ['suppliers', 'clients']) {
      await page.getByRole('button', { name: side === 'suppliers' ? 'Поставщики' : 'Клиенты', exact: true }).click();
      const expected = expectedCompanies[`${org}:${side}`];
      // Clients with no operations can remain in the directory; limit this
      // check to the three counterparties whose balances have distinct values.
      await page.getByRole('combobox', { name: 'Фильтр контрагентов', exact: true }).selectOption('debt');
      await expect(companySort).toHaveValue('amount-desc');
      for (const option of ['amount-desc', 'amount-asc', 'date-desc', 'date-asc']) {
        await companySort.selectOption(option);
        const names = expected[option.startsWith('amount') ? 'amount' : 'date'];
        await expect(companyNames()).toHaveText(option.endsWith('asc') ? [...names].reverse() : names);
      }
      const mainName = side === 'suppliers' ? supplier.name : companies[0].name;
      await companyButtons().filter({ hasText: mainName }).click();
      await expect(operationSort).toHaveValue('date-desc');
      const data = organizationReport.organizations.find(row => row.id === org)[side].companies.find(row => row.name === mainName);
      const entryValues = new Map([...data.shipments.map(row => [`shipment:${row.id}`, { amount: Number(row.amount), date: row.date }]), ...data.receipts.map(row => [`receipt:${row.id}`, { amount: Number(row.amount), date: row.date }])]);
      assert.ok(entryValues.size >= 3, 'Each sorting fixture must contain at least three real API operations');
      for (const option of ['amount-desc', 'amount-asc', 'date-desc', 'date-asc']) {
        await operationSort.selectOption(option);
        const ids = await orgDetails.locator('.overview-transaction').evaluateAll(rows => rows.map(row => `${row.dataset.type}:${row.dataset.transactionId}`));
        assert.deepEqual([...ids].sort(), [...entryValues.keys()].sort(), `${org}/${side} ${option} preserves all operations`);
        const key = option.startsWith('amount') ? 'amount' : 'date';
        const values = ids.map(id => entryValues.get(id)[key]);
        const ordered = [...values].sort((a, b) => typeof a === 'number' ? a - b : a.localeCompare(b));
        assert.deepEqual(values, option.endsWith('desc') ? ordered.reverse() : ordered, `${org}/${side} ${option} uses original API amounts/dates`);
      }
      const transactionType = orgDetails.getByRole('combobox', { name: 'Тип операций контрагента', exact: true });
      await transactionType.selectOption('shipment');
      await expect(orgDetails.locator('.overview-transaction')).toHaveCount(data.shipments.length);
      await operationSort.selectOption('amount-desc');
      await expect(transactionType).toHaveValue('shipment');
      await transactionType.selectOption('receipt');
      await expect(orgDetails.locator('.overview-transaction')).toHaveCount(data.receipts.length);
      await transactionType.selectOption('all');
      if (org === 'artel' && side === 'clients') {
        for (const width of [1440, 390, 320]) await capture('organization-sorted-history', width);
        for (const width of [1440, 320]) await audit('organization-sorted-history', width);
      }
      await page.getByRole('button', { name: side === 'suppliers' ? 'Назад к поставщикам' : 'Назад к клиентам', exact: true }).click();
      await expect(companySort).toHaveValue('date-asc');
    }
  }
  check('All four amount/date sorts work independently for supplier/client lists and operation histories in both organizations; filters and list order survive drilldown');
  const search = page.getByRole('textbox', { name: 'Поиск контрагентов по названию или ИНН', exact: true });
  const companyFilter = page.getByRole('combobox', { name: 'Фильтр контрагентов', exact: true });
  await search.fill(companies[0].inn); await expect(companyButtons()).toHaveCount(1);
  await companyButtons().click();
  await page.getByRole('button', { name: 'Назад к клиентам', exact: true }).click();
  await expect(search).toHaveValue(companies[0].inn);
  await search.fill('Василёк'); await expect(companyButtons()).toHaveCount(1);
  await search.fill('Такого контрагента нет'); await expect(companyButtons()).toHaveCount(0);
  await page.getByRole('button', { name: 'Сбросить фильтры', exact: true }).click();
  await expect(search).toHaveValue(''); await expect(companyFilter).toHaveValue('all');
  await expect(companyButtons()).toHaveCount(3);
  await createShipment(companies[2], '9000', '2026-09-26', 'REVIEW-INN', { organization_id: 'artel' });
  await page.getByRole('button', { name: 'Обновить', exact: true }).click();
  await companyFilter.selectOption('review'); await expect(companyButtons()).toHaveCount(1);
  await expect(companyButtons()).toContainText('без ИНН');
  await expect(page.locator('.overview-review')).toHaveCount(0);
  await companyFilter.selectOption('all');
  for (const width of [1440, 390, 320]) await capture('organization-sorted-list', width);
  for (const width of [1440, 320]) await audit('organization-sorted-list', width);
  check('Name/INN search, empty search reset and review filtering work; the removed payment-review panel remains absent');

  // Verify both managers against actual permission-scoped API responses.
  for (let index = 0; index < managers.length; index++) {
    const managerContext = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    try {
      assert.equal((await managerContext.request.post(base + '/api/auth/login', { data: managerLogins[index] })).status(), 200);
      const scoped = await (await managerContext.request.get(base + '/api/settlements')).json();
      const managerPage = await managerContext.newPage(); managerPage.on('pageerror', error => report.errors.push(error.message));
      await managerPage.goto(base + '/#overview');
      for (const org of ['nk-artel', 'artel']) {
        await managerPage.locator(`.overview-organization-picker [data-organization-id="${org}"]`).click();
        await managerPage.getByRole('button', { name: 'Клиенты', exact: true }).click();
        const expected = scoped.organizations.find(row => row.id === org).clients;
        assert.equal(expected.scope, 'own'); assert.deepEqual(expected.sources, []); assert.deepEqual(expected.review, []);
        await expect(managerPage.locator('.organization-company-button')).toHaveCount(expected.companies.length);
        await expect(managerPage.locator('.overview-page')).not.toContainText(companies[1 - index].name);
        await expect(managerPage.locator('.overview-sources, .overview-review')).toHaveCount(0);
      }
      await capture(`manager-${index + 1}-clients`, 320, managerPage);
    } finally { await managerContext.close(); }
  }
  check('Two manager sessions render only their own organization counterparties; foreign names, source data and review panels are absent');

  await page.setViewportSize({ width: 1440, height: 1000 });
  const refreshFailure = route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Тестовая временная недоступность обзора.' }) });
  const balancesBeforeError = await companyButtons().getByTestId('organization-company-balance').allTextContents();
  await page.route('**/api/settlements', refreshFailure);
  await page.getByRole('button', { name: 'Обновить', exact: true }).click();
  await expect(page.locator('.overview-error')).toContainText('Тестовая временная недоступность обзора.');
  await expect(page.locator('.overview-error')).toContainText('могут быть неактуальны');
  assert.deepEqual(await companyButtons().getByTestId('organization-company-balance').allTextContents(), balancesBeforeError);
  await page.unroute('**/api/settlements', refreshFailure);
  await page.getByRole('button', { name: 'Повторить загрузку', exact: true }).click();
  await expect(page.locator('.overview-error')).toHaveCount(0);
  check('Failed refresh retains balances with an actionable stale-data warning; retry clears it');
  for (const status of [401, 403]) {
    await companyButtons().filter({ hasText: companies[0].name }).click();
    const denied = route => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ error: `Тестовая потеря доступа: ${status}.` }) });
    await page.route('**/api/settlements', denied);
    await page.getByRole('button', { name: 'Обновить', exact: true }).click();
    await expect(page.locator('.overview-error')).toContainText(`Тестовая потеря доступа: ${status}.`);
    await expect(page.locator('.organization-company-details, .organization-company-button, .overview-organization-picker')).toHaveCount(0);
    await expect(page.locator('.overview-page')).not.toContainText(companies[0].name);
    await page.unroute('**/api/settlements', denied);
    await page.getByRole('button', { name: 'Обновить', exact: true }).click();
    await expect(page.locator('.overview-organization-picker button')).toHaveCount(2);
    await page.locator('.overview-organization-picker [data-organization-id="artel"]').click();
    await page.getByRole('button', { name: 'Клиенты', exact: true }).click();
  }
  check('401/403 refresh removes previously visible balances, counterparties and history; restored access reloads the organization list');
  const currentReport = await api('/api/settlements');
  const emptyLedger = row => ({ ...row, companies: [], sources: [], review: [], totals: { shipped: '0', incoming: '0', debt: '0', advance: '0', allocated: '0' } });
  const emptyReport = { ...emptyLedger(currentReport), organizations: currentReport.organizations.map(row => ({ ...row, suppliers: emptyLedger(row.suppliers), clients: emptyLedger(row.clients) })) };
  const emptyResponse = route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(emptyReport) });
  await page.route('**/api/settlements', emptyResponse);
  await page.reload(); await expect(companyButtons()).toHaveCount(0);
  await expect(page.locator('[data-total="debt"]')).toContainText('0,00');
  await capture('empty-overview', 320); await audit('empty-overview', 320);
  await page.unroute('**/api/settlements', emptyResponse);
  await page.route('**/api/settlements', refreshFailure);
  await page.reload(); await expect(page.locator('.overview-error')).toContainText('Тестовая временная недоступность обзора.');
  await expect(companyButtons()).toHaveCount(0); await expect(page.locator('.overview-organization-picker')).toHaveCount(0);
  await capture('unavailable-overview', 320); await audit('unavailable-overview', 320);
  await page.unroute('**/api/settlements', refreshFailure);
  await page.getByRole('button', { name: 'Обновить', exact: true }).click();
  await expect(page.locator('.overview-organization-picker button')).toHaveCount(2);
  check('Empty and initially unavailable organization reports render without invented data; retry restores the isolated fixture');
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
