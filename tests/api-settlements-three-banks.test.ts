import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createSnapshotMiddleware, loadSnapshot } from '../server/local-api';
import { decodeOperations, encodeOperations, OperationsStore } from '../server/operations-store';
import { normalizeTbank } from '../server/banking/adapters';
import { emptyBanking, operationId } from '../server/banking/domain';
import { emptySber, normalizeSberOperation, SBER_ACCOUNT, SBER_INN } from '../server/banking/sber-domain';
import { replaceStatementDay } from '../server/banking/statement-publication';
import type { BankOperation } from '../web/src/banking-model';
import type { Shipment, Snapshot } from '../web/src/model';
import type { SettlementsReport } from '../web/src/settlements-model';
import { accountNumber, fixtureConfig, tbankRow } from './banking-fixtures';

const base = await loadSnapshot();
const CUSTOMER_INN = '7707083893', THIRD_ACCOUNT = '40702810900000000003';
const TBANK_DAY = '2026-09-10', NK_DAY = '2026-09-11', ARTEL_DAY = '2026-09-12';
const SAME_BANK_ID = 'same-operation-number-in-three-banks';
function tbankReceipt(amount = '40000', id = SAME_BANK_ID): BankOperation {
  const raw = tbankRow(id, amount);
  return normalizeTbank(fixtureConfig(), { number: accountNumber, currency: 'RUB' }, TBANK_DAY, { ...raw, operationDate: `${TBANK_DAY}T10:00:00Z`, docDate: `${TBANK_DAY}T09:00:00Z`, payer: { ...raw.payer, inn: CUSTOMER_INN }, receiver: { ...raw.receiver, inn: SBER_INN } });
}
function nkReceipt(amount = '30000', id = SAME_BANK_ID, day = NK_DAY): BankOperation {
  return normalizeSberOperation({ operationId: id, direction: 'CREDIT', amount: { amount, currencyName: 'RUR' }, operationDate: `${day}T10:00:00`, documentDate: day, paymentPurpose: 'Синтетическая оплата для проверки трёх банков', rurTransfer: { payerName: 'Тестовый покупатель', payerInn: CUSTOMER_INN, payerAccount: '40702810000000000100', payeeAccount: SBER_ACCOUNT, payeeInn: SBER_INN } }, day);
}
function artelReceipt(amount = '30000', id = SAME_BANK_ID): BankOperation {
  const source = nkReceipt(amount, id, ARTEL_DAY);
  return { ...source, id: operationId('sber-artel', THIRD_ACCOUNT, id), connectionId: 'sber-artel', account: THIRD_ACCOUNT, payee: { ...source.payee, account: THIRD_ACCOUNT } };
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(resolve(tmpdir(), 'artel-three-bank-settlements-'));
  const store = new OperationsStore(directory);
  await store.mutate(base.provenance.sourceSha256, data => { data.sourceOperationsCleared = true; return { changed: true, result: null }; });
  let remoteRequests = 0;
  const serverFor = (operationsStore: OperationsStore) => {
    const noRemote = async () => { remoteRequests++; throw new Error('No external bank requests are permitted in integration fixtures'); };
    const middleware = createSnapshotMiddleware(undefined, { operationsStore, bankEnvironment: { ARTEL_BANK_SYNC_ENABLED: 'false' }, bankRequest: noRemote, sberRequest: noRemote });
    return createServer((request, response) => middleware(request, response, () => { response.writeHead(404); response.end(); }));
  };
  let server = serverFor(store), origin = '', cookie = '';
  const listen = async () => { await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; };
  t.after(async () => { await new Promise<void>(done => server.close(() => done())); await rm(directory, { recursive: true, force: true }); assert.equal(remoteRequests, 0); });
  await listen();
  const request = async (path: string, method = 'GET', body?: unknown) => {
    const response = await fetch(origin + path, { method, headers: { cookie, 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie')!.split(';')[0];
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await request('/api/auth/setup', 'POST', { name: 'Three banks QA', login: 'three.banks.director', password: randomUUID() })).status, 200);
  const snapshot: Snapshot = (await request('/api/snapshot')).body;
  const created = await request('/api/directories', 'POST', { kind: 'companies', name: 'Покупатель трёх банков — тест', inn: CUSTOMER_INN, roles: ['customer'], managerId: snapshot.directories!.managers[0].id, addresses: [] });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const shipment = async (amount: string, date: string) => {
    const response = await request('/api/shipments', 'POST', { fields: { shipment_type: 'azs', date, customer_id: created.body.entry.id, supplier_id: snapshot.companies[0].id, manager_id: snapshot.directories!.managers[0].id, product_id: snapshot.directories!.products[0].id, payment_form_id: snapshot.directories!.paymentForms.find(row => row.name === 'б/нал')!.id, quantity_litres: '1000', customer_amount: amount, purchase_amount: '0' } });
    assert.equal(response.status, 201, JSON.stringify(response.body)); return response.body.shipment as Shipment;
  };
  const report = async (): Promise<SettlementsReport> => { const response = await request('/api/settlements'); assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body; };
  const publish = (connectionId: 'tbank-nk-artel' | 'sber-artel', rows: BankOperation[], day = connectionId === 'tbank-nk-artel' ? TBANK_DAY : ARTEL_DAY) => store.mutate(base.provenance.sourceSha256, data => {
    data.banking ??= emptyBanking();
    replaceStatementDay(data.banking, connectionId, { number: connectionId === 'tbank-nk-artel' ? accountNumber : THIRD_ACCOUNT, currency: 'RUB' }, day, rows, `${day}T13:00:00Z`);
    return { changed: true, result: null };
  });
  const publishNk = (rows: BankOperation[]) => store.mutate(base.provenance.sourceSha256, data => {
    data.sber = { ...data.sber ?? emptySber(), operations: structuredClone(rows), lastSuccessAt: `${NK_DAY}T13:00:00Z`, lastCompletedPeriod: { from: NK_DAY, to: NK_DAY } };
    return { changed: true, result: null };
  });
  const restart = async () => { await new Promise<void>(done => server.close(() => done())); server = serverFor(new OperationsStore(directory)); await listen(); };
  return { directory, store, request, shipment, report, publish, publishNk, restart };
}

function checkBalances(report: SettlementsReport, shipped: string, incoming: string, allocated: string, debt: string, advance: string) {
  assert.deepEqual(report.totals, { shipped, incoming, allocated, debt, advance });
  assert.equal(report.companies.length, 1);
  const company = report.companies[0]; assert.equal(company.inn, CUSTOMER_INN);
  assert.deepEqual({ shipped: company.shipped, incoming: company.incoming, allocated: company.allocated, debt: company.debt, advance: company.advance }, report.totals);
  return company;
}

test('three concurrent bank publications share FIFO by INN, replay safely, survive restart and retract corrected or empty statements', async t => {
  const f = await fixture(t);
  const first = await f.shipment('40000', '2026-09-01'), second = await f.shipment('30000', '2026-09-02');
  const beforeBank = await f.store.read(base.provenance.sourceSha256);
  const tbank = tbankReceipt(), nk = nkReceipt(), artel = artelReceipt();
  assert.equal(new Set([tbank.id, nk.id, artel.id]).size, 3);
  assert.equal(new Set([tbank.bankOperationId, nk.bankOperationId, artel.bankOperationId]).size, 1);
  await Promise.all([f.publish('tbank-nk-artel', [tbank]), f.publishNk([nk]), f.publish('sber-artel', [artel])]);
  let report = await f.report();
  let company = checkBalances(report, '70000', '100000', '70000', '0', '30000');
  assert.deepEqual(company.shipments.map(row => [row.id, row.paid, row.debt]), [[first.id, '40000', '0'], [second.id, '30000', '0']]);
  assert.deepEqual(company.receipts.map(row => [row.connectionId, row.account, row.amount, row.company]), [['tbank-nk-artel', accountNumber, '40000', 'НК АРТЕЛЬ'], ['sber-nk-artel', SBER_ACCOUNT, '30000', 'НК АРТЕЛЬ'], ['sber-artel', THIRD_ACCOUNT, '30000', 'АРТЕЛЬ']]);
  assert.deepEqual(report.sources.map(row => row.id).sort(), ['sber-artel', 'sber-nk-artel', 'tbank-nk-artel']);
  assert.ok(report.sources.every(row => row.status === 'ready'));
  let stored = await f.store.read(base.provenance.sourceSha256);
  assert.equal(stored.revision, beforeBank.revision + 3, 'Concurrent commits must each persist exactly once');
  assert.equal(stored.banking!.operations.length, 2); assert.equal(stored.sber!.operations.length, 1);
  assert.deepEqual(stored.shipments, beforeBank.shipments, 'Bank receipts must not overwrite saved shipment fields');
  assert.deepEqual(stored.paymentAllocations, []);
  assert.deepEqual(stored.banking!.connections['sber-artel'].settlementVerifiedDays, [{ account: THIRD_ACCOUNT, date: ARTEL_DAY, syncedAt: `${ARTEL_DAY}T13:00:00Z` }]);

  await Promise.all([f.publish('tbank-nk-artel', [tbank]), f.publishNk([nk]), f.publish('sber-artel', [artel])]);
  assert.deepEqual(await f.report(), report, 'Replaying all three complete statements must preserve financial results');
  stored = await f.store.read(base.provenance.sourceSha256);
  assert.deepEqual(decodeOperations(encodeOperations(stored), base.provenance.sourceSha256), stored);
  assert.deepEqual(decodeOperations(await readFile(f.store.path, 'utf8'), base.provenance.sourceSha256), stored);
  await f.restart(); assert.deepEqual(await f.report(), report, 'New server and store must rebuild the same ledger from disk');

  const third = await f.shipment('20000', '2026-09-03');
  checkBalances(await f.report(), '90000', '100000', '90000', '0', '10000');
  assert.equal(third.fields.paid_amount_source, '20000'); assert.equal(third.fields.payment_date, ARTEL_DAY);
  const fourth = await f.shipment('30000', '2026-09-04');
  company = checkBalances(await f.report(), '120000', '100000', '100000', '20000', '0');
  assert.deepEqual(company.shipments.map(row => row.paid), ['40000', '30000', '20000', '10000']);
  assert.equal(fourth.fields.payment_date, ARTEL_DAY);

  const beforeCorrection = await f.store.read(base.provenance.sourceSha256);
  await f.publish('sber-artel', [artelReceipt('10000')]);
  company = checkBalances(await f.report(), '120000', '80000', '80000', '40000', '0');
  assert.deepEqual(company.shipments.map(row => row.paid), ['40000', '30000', '10000', '0']);
  assert.deepEqual(company.shipments.map(row => row.debt), ['0', '0', '10000', '30000']);
  const afterCorrection = await f.store.read(base.provenance.sourceSha256);
  assert.deepEqual(afterCorrection.sber, beforeCorrection.sber);
  assert.deepEqual(afterCorrection.banking!.operations.filter(row => row.connectionId === 'tbank-nk-artel'), beforeCorrection.banking!.operations.filter(row => row.connectionId === 'tbank-nk-artel'));
  let loaded: Snapshot = (await f.request('/api/snapshot')).body;
  assert.equal(loaded.shipments.find(row => row.id === fourth.id)!.fields.payment_date, null, 'A revoked allocation must not leave its payment date behind');

  await f.publish('sber-artel', []);
  report = await f.report(); company = checkBalances(report, '120000', '70000', '70000', '50000', '0');
  assert.deepEqual(company.shipments.map(row => row.paid), ['40000', '30000', '0', '0']);
  assert.deepEqual(company.receipts.map(row => row.connectionId), ['tbank-nk-artel', 'sber-nk-artel']);
  assert.equal(report.sources.find(row => row.id === 'sber-artel')!.status, 'ready', 'An empty verified day is loaded, not a connection failure');
  loaded = (await f.request('/api/snapshot')).body;
  assert.deepEqual([first, second, third, fourth].map(original => { const row = loaded.shipments.find(item => item.id === original.id)!; return [row.fields.paid_amount_source, row.fields.payment_date]; }), [['40000', TBANK_DAY], ['30000', NK_DAY], ['0', null], ['0', null]]);
  stored = await f.store.read(base.provenance.sourceSha256);
  assert.ok(stored.banking!.archivedOperations!.some(row => row.id === artel.id && row.amount === '10000'));
  assert.deepEqual(stored.sber, beforeCorrection.sber);
  assert.deepEqual(stored.shipments, afterCorrection.shipments);
  assert.deepEqual(stored.paymentAllocations, []);
  await f.restart(); assert.deepEqual(await f.report(), report);
});

test('legacy and staged third-bank data cannot pay debt; publication failures preserve complete statements and their balances', async t => {
  const f = await fixture(t);
  await f.shipment('70000', '2026-09-01');
  await Promise.all([f.publish('tbank-nk-artel', [tbankReceipt()]), f.publishNk([nkReceipt()])]);
  const legacy = artelReceipt('999999', 'unverified-legacy-operation');
  await f.store.mutate(base.provenance.sourceSha256, data => {
    data.banking!.operations.push(legacy);
    data.banking!.connections['sber-artel'] = { accounts: [{ number: THIRD_ACCOUNT, currency: 'RUB' }], lastSuccessAt: `${ARTEL_DAY}T09:00:00Z`, lastCompletedPeriod: { from: ARTEL_DAY, to: ARTEL_DAY } };
    return { changed: true, result: null };
  });
  let report = await f.report();
  checkBalances(report, '70000', '70000', '70000', '0', '0');
  let source = report.sources.find(row => row.id === 'sber-artel')!;
  assert.equal(source.status, 'not_loaded'); assert.equal(source.lastSuccessAt, null, 'An old success timestamp is not proof of a verified complete day');
  await f.store.mutate(base.provenance.sourceSha256, data => {
    data.banking!.connections['sber-artel'].job = { id: 'partial-third-bank-page', from: ARTEL_DAY, to: ARTEL_DAY, day: ARTEL_DAY, accountIndex: 0, accounts: [{ number: THIRD_ACCOUNT, currency: 'RUB' }], startedAt: `${ARTEL_DAY}T10:00:00Z`, pages: 1, attempts: 0, staged: [artelReceipt('888888', 'staged-only-operation')] };
    return { changed: true, result: null };
  });
  report = await f.report(); checkBalances(report, '70000', '70000', '70000', '0', '0');
  assert.equal(report.sources.find(row => row.id === 'sber-artel')!.status, 'syncing');
  await f.store.mutate(base.provenance.sourceSha256, data => {
    replaceStatementDay(data.banking!, 'sber-artel', { number: THIRD_ACCOUNT, currency: 'RUB' }, ARTEL_DAY, [artelReceipt()], `${ARTEL_DAY}T13:00:00Z`);
    delete data.banking!.connections['sber-artel'].job;
    return { changed: true, result: null };
  });
  report = await f.report(); checkBalances(report, '70000', '100000', '70000', '0', '30000');
  assert.equal(report.sources.find(row => row.id === 'sber-artel')!.status, 'ready');
  assert.ok(!report.companies[0].receipts.some(row => row.id === legacy.id));

  const beforeInvalidPublication = await readFile(f.store.path, 'utf8');
  await assert.rejects(f.store.mutate(base.provenance.sourceSha256, data => {
    replaceStatementDay(data.banking!, 'sber-artel', { number: THIRD_ACCOUNT, currency: 'RUB' }, ARTEL_DAY, [tbankReceipt()], `${ARTEL_DAY}T14:00:00Z`);
    return { changed: true, result: null };
  }), { status: 502 });
  assert.equal(await readFile(f.store.path, 'utf8'), beforeInvalidPublication, 'Failed publication must not advance revisions, markers or amounts');
  assert.deepEqual(await f.report(), report);
  const complete = await f.store.read(base.provenance.sourceSha256);
  await f.store.mutate(base.provenance.sourceSha256, data => {
    data.banking!.connections['sber-artel'].lastError = 'Синтетическая ошибка: банк временно недоступен';
    data.banking!.connections['sber-artel'].lastAttemptAt = `${ARTEL_DAY}T14:00:00Z`;
    return { changed: true, result: null };
  });
  report = await f.report(); checkBalances(report, '70000', '100000', '70000', '0', '30000');
  source = report.sources.find(row => row.id === 'sber-artel')!;
  assert.equal(source.status, 'error'); assert.match(source.lastError!, /временно недоступен/);
  assert.equal(source.lastSuccessAt, `${ARTEL_DAY}T13:00:00Z`);
  const failed = await f.store.read(base.provenance.sourceSha256);
  assert.deepEqual(failed.banking!.operations, complete.banking!.operations);
  assert.deepEqual(failed.banking!.connections['sber-artel'].settlementVerifiedDays, complete.banking!.connections['sber-artel'].settlementVerifiedDays);
  assert.deepEqual(failed.sber, complete.sber);
  await f.restart(); assert.deepEqual(await f.report(), report, 'Failures and last valid balances both survive restart');
});
