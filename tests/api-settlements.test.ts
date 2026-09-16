import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createSnapshotMiddleware, loadSnapshot } from '../server/local-api';
import { OperationsStore } from '../server/operations-store';
import { currentSnapshot } from '../server/shipment-operations';
import { BankingService } from '../server/banking/service';
import { normalizeTbank } from '../server/banking/adapters';
import { emptyBanking, operationId, upsertOperations } from '../server/banking/domain';
import { emptySber, normalizeSberOperation, SBER_ACCOUNT, SBER_INN } from '../server/banking/sber-domain';
import { sections } from '../web/src/auth-model';
import type { BankOperation } from '../web/src/banking-model';
import type { Company, Shipment, Snapshot } from '../web/src/model';
import type { SettlementCompany, SettlementsReport } from '../web/src/settlements-model';
import { accountNumber, fixtureConfig, fixtureDay, fixtureEnvironment, tbankRow } from './banking-fixtures';

const base = await loadSnapshot();
const ROMASHKA_INN = '7707083893';
const OTHER_INN = '7736050003';
const receiptRaw = (id: string, amount: string, inn = ROMASHKA_INN) => {
  const row = tbankRow(id, amount);
  return { ...row, payer: { ...row.payer, name: 'ООО Ромашка — тест', inn } };
};
const receipt = (id: string, amount: string, inn = ROMASHKA_INN): BankOperation => normalizeTbank(fixtureConfig(), { number: accountNumber, currency: 'RUB' }, fixtureDay, receiptRaw(id, amount, inn));

async function fixture(t: TestContext) {
  const directory = await mkdtemp(resolve(tmpdir(), 'artel-settlements-'));
  const store = new OperationsStore(directory);
  await store.mutate(base.provenance.sourceSha256, data => { data.sourceOperationsCleared = true; return { changed: true, result: null }; });
  const middleware = createSnapshotMiddleware(undefined, { operationsStore: store, bankEnvironment: { ARTEL_BANK_SYNC_ENABLED: 'false' }, bankRequest: async () => { throw new Error('Tests must never contact a bank'); } });
  const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end(); }));
  let closed = false;
  const close = async () => { if (closed) return; closed = true; await new Promise<void>(done => server.close(() => done())); await rm(directory, { recursive: true, force: true }); };
  t.after(close);
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = () => {
    let cookie = '';
    return async (path: string, method = 'GET', body?: unknown) => {
      const response = await fetch(url + path, { method, headers: { cookie, 'Content-Type': 'application/json' }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie')!.split(';')[0];
      return { status: response.status, body: await response.json() };
    };
  };
  const director = client(), password = randomUUID();
  assert.equal((await director('/api/auth/setup', 'POST', { name: 'Settlements QA', login: 'settlements.director', password })).status, 200);
  const snapshot: Snapshot = (await director('/api/snapshot')).body;
  const companies: Company[] = [];
  for (const [name, inn] of [['ООО Ромашка — тест', ROMASHKA_INN], ['ООО Ромашка — другая фирма', OTHER_INN]]) {
    const created = await director('/api/directories', 'POST', { kind: 'companies', name, inn, roles: ['customer'], managerId: snapshot.directories!.managers[0].id, addresses: [] });
    assert.equal(created.status, 201, JSON.stringify(created.body)); companies.push(created.body.entry);
  }
  const shipment = async (amount: string, date: string, customerId = companies[0].id, managerId = snapshot.directories!.managers[0].id) => {
    const response = await director('/api/shipments', 'POST', { fields: { shipment_type: 'azs', date, customer_id: customerId, supplier_id: snapshot.companies[0].id, manager_id: managerId, product_id: snapshot.directories!.products[0].id, payment_form_id: snapshot.directories!.paymentForms.find(row => row.name === 'б/нал')!.id, quantity_litres: '1000', customer_amount: amount, purchase_amount: '0' } });
    assert.equal(response.status, 201, JSON.stringify(response.body)); return response.body.shipment as Shipment;
  };
  const report = async () => {
    const response = await director('/api/settlements'); assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body as SettlementsReport;
  };
  const company = async (inn = ROMASHKA_INN) => {
    const result = (await report()).companies.find(row => row.inn === inn); assert.ok(result, `Missing company ${inn}`); return result;
  };
  const insert = (rows: BankOperation[]) => store.mutate(base.provenance.sourceSha256, data => { data.banking ??= emptyBanking(); upsertOperations(data.banking, rows); return { changed: true, result: null }; });
  return { directory, store, director, client, password, snapshot, companies, shipment, report, company, insert, close };
}

function amounts(company: SettlementCompany, expected: { shipped: string; incoming: string; debt: string; advance: string }) {
  assert.deepEqual({ shipped: company.shipped, incoming: company.incoming, debt: company.debt, advance: company.advance }, expected);
}

test('bank FIFO follows the complete user sequence, persists across reload and deduplicates repeated statement synchronization', async t => {
  const f = await fixture(t);
  try {
    const first = await f.shipment('40000', '2026-09-01'), second = await f.shipment('30000', '2026-09-02');
    const importedRows = [receiptRaw('romashka-100', '100000')];
    let requests = 0;
    const service = new BankingService(f.store, base.provenance.sourceSha256, { ...fixtureEnvironment, ARTEL_BANK_TBANK_NK_ACCOUNTS: JSON.stringify([{ number: accountNumber, currency: 'RUB' }]) }, async () => { requests++; return { operations: importedRows }; });
    const sync = async () => { await service.start('tbank-nk-artel', fixtureDay, fixtureDay); await service.tick('tbank-nk-artel'); };
    const storedBeforeBank = await f.store.read(base.provenance.sourceSha256);
    await sync();
    amounts(await f.company(), { shipped: '70000', incoming: '100000', debt: '0', advance: '30000' });
    assert.deepEqual((await f.company()).shipments.map(row => [row.id, row.paid, row.debt]), [[first.id, '40000', '0'], [second.id, '30000', '0']]);
    let stored = await f.store.read(base.provenance.sourceSha256);
    assert.deepEqual(stored.shipments, storedBeforeBank.shipments, 'Derived payment fields must not be written back into shipment inputs');
    assert.deepEqual(stored.paymentAllocations, storedBeforeBank.paymentAllocations);
    const third = await f.shipment('20000', '2026-09-03');
    amounts(await f.company(), { shipped: '90000', incoming: '100000', debt: '0', advance: '10000' });
    assert.equal(third.fields.paid_amount_source, '20000', 'POST response must include the current bank allocation');
    const fourth = await f.shipment('30000', '2026-09-04');
    amounts(await f.company(), { shipped: '120000', incoming: '100000', debt: '20000', advance: '0' });
    assert.equal((await f.company()).shipments.find(row => row.id === fourth.id)!.paid, '10000');
    importedRows.push(receiptRaw('romashka-10', '10000')); await sync();
    amounts(await f.company(), { shipped: '120000', incoming: '110000', debt: '10000', advance: '0' });
    importedRows.push(receiptRaw('romashka-20', '20000')); await sync();
    amounts(await f.company(), { shipped: '120000', incoming: '130000', debt: '0', advance: '10000' });
    const settled = await f.report();
    await sync(); assert.deepEqual((await f.report()).companies, settled.companies); assert.equal(requests, 4);
    stored = await new OperationsStore(f.directory).read(base.provenance.sourceSha256);
    assert.equal(stored.banking!.operations.length, 3);
    assert.deepEqual(stored.paymentAllocations, []);
    const reloaded = currentSnapshot(base, stored);
    assert.deepEqual(reloaded.shipments.map(row => [row.id, row.fields.paid_amount_source, row.fields.debt_overpayment_source]).sort(), [[first.id, '40000', '0'], [second.id, '30000', '0'], [third.id, '20000', '0'], [fourth.id, '30000', '0']].sort());
    assert.ok(reloaded.shipments.every(row => row.fields.payment_date === fixtureDay));
    assert.equal(Object.hasOwn(reloaded, 'settlements'), false);
    assert.deepEqual(reloaded.payments, [], 'A bank statement must not become legacy imported payments');

    const edited = await f.director(`/api/shipments/${first.id}`, 'PATCH', { version: first.version, fields: { customer_amount: '60000' } });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    amounts(await f.company(), { shipped: '140000', incoming: '130000', debt: '10000', advance: '0' });
    assert.equal((await f.company()).shipments.find(row => row.id === fourth.id)!.paid, '20000');
    assert.equal((await f.director(`/api/shipments/${second.id}`, 'DELETE', { version: second.version })).status, 200);
    amounts(await f.company(), { shipped: '110000', incoming: '130000', debt: '0', advance: '20000' });
    assert.ok(!(await f.company()).shipments.some(row => row.id === second.id));
    assert.deepEqual((await f.store.read(base.provenance.sourceSha256)).paymentAllocations, []);
  } finally { await f.close(); }
});

test('settlements isolate customer INNs, combine active Sber and T-Bank receipts and ignore outgoing, unbooked, foreign-currency, staged, archived and self transfers', async t => {
  const f = await fixture(t);
  try {
    const first = await f.shipment('100.3', '2026-09-01'), other = await f.shipment('200', '2026-09-02', f.companies[1].id);
    const accepted = receipt('accepted', '40.1');
    const sber = normalizeSberOperation({ operationId: 'active-sber', direction: 'CREDIT', amount: { amount: '0.2', currencyName: 'RUR' }, operationDate: `${fixtureDay}T12:00:00`, paymentPurpose: 'Доплата тестовая', rurTransfer: { payerName: 'Другое название, тот же ИНН', payerInn: ROMASHKA_INN, payerAccount: '40702810000000012345', payeeAccount: SBER_ACCOUNT } }, fixtureDay);
    const oldSber = { ...receipt('obsolete-sber', '999'), id: operationId('sber-artel', accountNumber, 'obsolete-sber'), connectionId: 'sber-artel', provider: 'sber' as const };
    const self = receipt('self-transfer', '888', SBER_INN); self.payee.inn = SBER_INN;
    const ownAccount = receipt('own-account-transfer', '888', SBER_INN); ownAccount.payer.account = accountNumber;
    const outgoing = { ...receipt('outgoing', '999'), direction: 'outgoing' as const }; outgoing.payee = { ...outgoing.payer }; outgoing.payer = { inn: SBER_INN, account: accountNumber };
    await f.store.mutate(base.provenance.sourceSha256, data => {
      data.banking = emptyBanking();
      upsertOperations(data.banking, [accepted, receipt('other-company', '250', OTHER_INN), outgoing, { ...receipt('pending', '999'), booked: false }, { ...receipt('usd', '999'), currency: 'USD' }, self, ownAccount, oldSber]);
      data.banking.archivedOperations = [receipt('archived', '999')];
      data.banking.connections['tbank-nk-artel'] = { accounts: [{ number: accountNumber, currency: 'RUB' }], job: { id: 'staged-page', from: fixtureDay, to: fixtureDay, day: fixtureDay, accountIndex: 0, accounts: [{ number: accountNumber, currency: 'RUB' }], startedAt: `${fixtureDay}T00:00:00Z`, pages: 1, attempts: 0, staged: [receipt('staged', '999')] } };
      data.sber = { ...emptySber(), operations: [sber] };
      return { result: null, changed: true };
    });
    amounts(await f.company(), { shipped: '100.3', incoming: '40.3', debt: '60', advance: '0' });
    amounts(await f.company(OTHER_INN), { shipped: '200', incoming: '250', debt: '0', advance: '50' });
    const report = await f.report();
    assert.deepEqual(report.totals, { shipped: '300.3', incoming: '290.3', debt: '60', advance: '50', allocated: '240.3' });
    assert.deepEqual((await f.company()).receipts.map(row => row.id).sort(), [accepted.id, sber.id].sort());
    const snap: Snapshot = (await f.director('/api/snapshot')).body;
    assert.equal(snap.shipments.find(row => row.id === first.id)!.fields.paid_amount_source, '40.3');
    assert.equal(snap.shipments.find(row => row.id === other.id)!.fields.paid_amount_source, '200');
    assert.equal(snap.shipments.find(row => row.id === first.id)!.fields.debt_overpayment_source, '-60');
    const before = await f.store.read(base.provenance.sourceSha256);
    await f.report(); await f.director('/api/shipments'); await f.director('/api/snapshot');
    assert.deepEqual(await f.store.read(base.provenance.sourceSha256), before, 'GET projections do not mutate stored inputs');
  } finally { await f.close(); }
});

test('editing an existing historical payment never turns projected bank money into a permanent opening balance', async t => {
  const f = await fixture(t);
  try {
    const row = await f.shipment('100', '2026-09-01');
    // Reproduce an already saved historical tanker using valid current directory IDs.
    await f.store.mutate(base.provenance.sourceSha256, data => {
      Object.assign(data.shipments[row.id].fields, { shipment_type: 'tanker', calculation_mode: 'historical', paid_amount_source: '20', opening_paid_amount: '20', opening_payment_date: '2026-08-30', payment_date: '2026-08-30', debt_overpayment_source: '-80', purchase_unit: 'litres' });
      return { changed: true, result: null };
    });
    await f.insert([receipt('historical-bank-payment', '30')]);
    let loaded: Shipment = (await f.director(`/api/shipments/${row.id}`)).body.shipment;
    assert.equal(loaded.fields.paid_amount_source, '50');
    assert.equal(loaded.fields.opening_paid_amount, '20');
    assert.equal(loaded.fields.payment_date, fixtureDay);
    const edited = await f.director(`/api/shipments/${row.id}`, 'PATCH', { version: row.version, fields: { date: '2026-09-02' } });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.shipment.fields.paid_amount_source, '50');
    const stored = await new OperationsStore(f.directory).read(base.provenance.sourceSha256);
    assert.equal(stored.shipments[row.id].fields.paid_amount_source, '20');
    assert.equal(stored.shipments[row.id].fields.opening_paid_amount, '20');
    assert.equal(stored.shipments[row.id].fields.payment_date, '2026-08-30');
    await f.store.mutate(base.provenance.sourceSha256, data => { data.banking!.operations = []; return { changed: true, result: null }; });
    loaded = (await f.director(`/api/shipments/${row.id}`)).body.shipment;
    assert.equal(loaded.fields.paid_amount_source, '20');
    assert.equal(loaded.fields.payment_date, '2026-08-30');
    amounts(await f.company(), { shipped: '100', incoming: '0', debt: '80', advance: '0' });
  } finally { await f.close(); }
});

test('the firm ledger requires management access while employee shipment views contain only their projected payments and no bank receipt details', async t => {
  const f = await fixture(t);
  try {
    assert.equal((await f.client()('/api/settlements')).status, 401);
    const managerIds = f.snapshot.directories!.managers.slice(0, 2).map(row => row.id);
    assert.equal(managerIds.length, 2);
    const first = await f.shipment('40000', '2026-09-01', f.companies[0].id, managerIds[0]);
    const second = await f.shipment('30000', '2026-09-02', f.companies[0].id, managerIds[1]);
    const incoming = receipt('private-bank-receipt', '100000'); incoming.purpose = 'PRIVATE BANK PURPOSE';
    await f.insert([incoming]);
    for (const [index, managerId] of managerIds.entries()) {
      const login = `settlements.manager.${index}`;
      const created = await f.director('/api/auth/users', 'POST', { name: `Manager ${index}`, login, password: f.password, role: 'manager', managerId, sections: sections.map(row => row.id) });
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const manager = f.client(); assert.equal((await manager('/api/auth/login', 'POST', { login, password: f.password })).status, 200);
      assert.equal((await manager('/api/settlements')).status, 403, 'Granting the section alone must not expose the global ledger');
      const response = await manager('/api/snapshot'); assert.equal(response.status, 200);
      const snap: Snapshot = response.body, own = index ? second : first;
      assert.deepEqual(snap.shipments.map(row => row.id), [own.id]);
      assert.equal(snap.shipments[0].fields.paid_amount_source, index ? '30000' : '40000');
      assert.equal(snap.shipments[0].fields.debt_overpayment_source, '0');
      const json = JSON.stringify(snap);
      for (const privateValue of [incoming.id, incoming.purpose!, accountNumber, '"settlements"', '"receipts"', '"advance"']) assert.ok(!json.includes(privateValue), privateValue);
      assert.equal((await manager(`/api/shipments/${own.id}`)).body.shipment.fields.paid_amount_source, index ? '30000' : '40000');
      assert.equal((await manager(`/api/shipments/${index ? first.id : second.id}`)).status, 404);
    }
    const admin = f.client();
    const employee = await f.director('/api/directories', 'POST', { kind: 'managers', name: 'Ledger admin employee' });
    assert.equal(employee.status, 201);
    assert.equal((await f.director('/api/auth/users', 'POST', { name: 'Ledger admin', login: 'settlements.admin', password: f.password, role: 'admin', managerId: employee.body.entry.id, sections: [] })).status, 201);
    assert.equal((await admin('/api/auth/login', 'POST', { login: 'settlements.admin', password: f.password })).status, 200);
    assert.equal((await admin('/api/settlements')).status, 200);
  } finally { await f.close(); }
});
