import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { buildOrganizationSettlements, organizationSettlementsForActor, shipmentSettlementAllocations } from '../server/organization-settlements';
import { buildSettlements } from '../server/settlements';
import { emptyBanking, operationId, upsertOperations } from '../server/banking/domain';
import { emptySber } from '../server/banking/sber-domain';
import { sberConnections } from '../server/banking/sber-connections';
import { replaceStatementDay } from '../server/banking/statement-publication';
import { OperationsStore, type OperationsData } from '../server/operations-store';
import { createSnapshotMiddleware, loadSnapshot } from '../server/local-api';
import { currentSnapshot } from '../server/shipment-operations';
import type { AccountUser } from '../web/src/auth-model';
import type { BankOperation } from '../web/src/banking-model';
import type { Company, Shipment, Snapshot } from '../web/src/model';
import type { OurOrganizationId } from '../web/src/our-organizations';
import type { SettlementsReport } from '../web/src/settlements-model';

const SUPPLIER_INN = '7707083893', CUSTOMER_INN = '7736050003';
const company = (id: string, inn: string, role: string): Company => ({ id, inn, name: `Синтетический ${id}`, roles: [role], managerLabels: [], shipmentIds: [], paymentIds: [], flags: [] });
const supplier = company('supplier', SUPPLIER_INN, 'supplier'), customer = company('customer', CUSTOMER_INN, 'customer');
const companies = [supplier, customer];
const empty = (): OperationsData => ({ schemaVersion: 1, sourceSha256: 'synthetic-organizations', revision: 0, shipments: {}, companies: [], banking: emptyBanking(), sber: emptySber(), paymentAllocations: [] });
const shipment = (id: string, purchase: string | null, organization: OurOrganizationId | null = 'nk-artel', date = '2026-09-01', sale = '1000'): Shipment => ({
  id, date, customerId: customer.id, customer: customer.name, supplierId: supplier.id, supplier: supplier.name, carrierId: null, carrier: null, product: null, liters: '100', revenue: sale, cost: purchase, manager: 'Первый менеджер', sourceRow: 0, sourceSheet: 'Synthetic organization fixtures', flags: [],
  fields: { date, organization_id: organization, customer_id: customer.id, customer_inn: CUSTOMER_INN, supplier_id: supplier.id, supplier_inn: SUPPLIER_INN, customer_amount: sale, purchase_amount: purchase, paid_amount_source: '0', opening_paid_amount: '0', document_number: id, manager_id: 'manager-one', payment_form: 'б/нал' },
});
function payment(id: string, amount: string, organization: OurOrganizationId = 'nk-artel', direction: 'incoming' | 'outgoing' = 'outgoing', date = '2026-09-02'): BankOperation {
  const connectionId = organization === 'artel' ? 'sber-artel' : 'tbank-nk-artel';
  const account = organization === 'artel' ? '40702810000000000999' : '40702810000000000888';
  const own = { name: `Синтетическая ${organization}`, inn: sberConnections[organization === 'artel' ? 'sber-artel' : 'sber-nk-artel'].inn, account };
  const counterparty = { name: direction === 'incoming' ? customer.name : supplier.name, inn: direction === 'incoming' ? CUSTOMER_INN : SUPPLIER_INN, account: '40702810000000000777' };
  return { id: operationId(connectionId, account, id), connectionId, provider: organization === 'artel' ? 'sber' : 'tbank', bankOperationId: id, account, statementDate: date, documentNumber: `doc-${id}`, amount, currency: 'RUB', direction, status: 'Executed', booked: true, payer: direction === 'incoming' ? counterparty : own, payee: direction === 'incoming' ? own : counterparty, bankData: {}, updatedAt: '2026-09-28T00:00:00Z', purpose: `Синтетический платёж ${id}`, source: 'statement-api', counterpartyId: null, allocations: [], importedSourceIds: [] };
}
function insert(store: OperationsData, rows: BankOperation[]) {
  store.banking ??= emptyBanking();
  upsertOperations(store.banking, rows);
  for (const row of rows.filter(row => row.connectionId === 'sber-artel')) {
    const state = store.banking.connections[row.connectionId] ??= { accounts: [{ number: row.account, currency: 'RUB' }] };
    const days = state.settlementVerifiedDays ??= [];
    if (!days.some(day => day.account === row.account && day.date === row.statementDate)) days.push({ account: row.account, date: row.statementDate, syncedAt: row.updatedAt });
  }
}
const organization = (rows: Shipment[], store: OperationsData, id: OurOrganizationId = 'nk-artel', directory = companies) => buildOrganizationSettlements(rows, directory, store).organizations.find(row => row.id === id)!;
const balance = (rows: Shipment[], store: OperationsData, id: OurOrganizationId = 'nk-artel') => organization(rows, store, id).suppliers.companies.find(row => row.inn === SUPPLIER_INN)!;

test('supplier example A keeps fully closed purchase and both payment audit links, independent of customer paid amount', () => {
  const rows = [shipment('purchase-738000', '738000')], store = empty();
  rows[0].fields.paid_amount_source = '999999';
  assert.equal(balance(rows, store).debt, '738000');
  insert(store, [payment('payment-300000', '300000')]);
  assert.equal(balance(rows, store).debt, '438000');
  insert(store, [payment('payment-438000', '438000', 'nk-artel', 'outgoing', '2026-09-03')]);
  const before = structuredClone(store), result = balance(rows, store);
  assert.equal(result.debt, '0'); assert.equal(result.advance, '0');
  assert.equal(result.shipments.length, 1); assert.equal(result.shipments[0].paid, '738000');
  assert.deepEqual(result.receipts.map(row => row.allocations.map(part => [part.shipmentId, part.amount])), [[['purchase-738000', '300000']], [['purchase-738000', '438000']]]);
  assert.equal(result.receipts[0].bankOperationId, 'payment-300000');
  assert.equal(result.receipts[0].documentNumber, 'doc-payment-300000');
  assert.equal(result.receipts[0].account, store.banking!.operations[0].account);
  assert.equal(result.receipts[0].company, 'НК АРТЕЛЬ');
  assert.deepEqual(store, before, 'reading a ledger never writes payment allocations or shipment baselines');
});

test('supplier examples B/C use FIFO only inside organization + supplier and retain the other organization debt', () => {
  const store = empty(), rows = [shipment('newer', '600000', 'artel', '2026-09-02'), shipment('older', '400000', 'artel')];
  insert(store, [payment('sber-700000', '700000', 'artel')]);
  let result = balance(rows, store, 'artel');
  assert.deepEqual(result.shipments.map(row => [row.id, row.paid, row.debt]), [['older', '400000', '0'], ['newer', '300000', '300000']]);
  assert.equal(result.receipts[0].bank, 'СберБизнес');
  const split = [shipment('artel-purchase', '300000', 'artel'), shipment('nk-purchase', '400000')];
  result = balance(split, store, 'artel');
  assert.equal(result.debt, '0'); assert.equal(result.advance, '400000');
  assert.equal(balance(split, store).debt, '400000'); assert.equal(balance(split, store).advance, '0');
  assert.deepEqual(result.receipts[0].allocations.map(row => row.shipmentId), ['artel-purchase']);
});

test('supplier prepayment funds later purchases once; repeat import, correction, deletion and statement revocation rebuild exact balances', () => {
  const store = empty(), paid = payment('advance', '700000', 'artel');
  insert(store, [paid]);
  assert.equal(balance([], store, 'artel').advance, '700000');
  const rows = [shipment('later', '300000', 'artel', '2026-09-03')];
  assert.equal(balance(rows, store, 'artel').advance, '400000');
  insert(store, [paid]);
  assert.equal(balance(rows, store, 'artel').incoming, '700000');
  rows.push(shipment('later-2', '500000', 'artel', '2026-09-04'));
  assert.equal(balance(rows, store, 'artel').debt, '100000');
  insert(store, [{ ...paid, amount: '500000' }]);
  assert.equal(balance(rows, store, 'artel').debt, '300000');
  assert.equal(balance(rows.slice(1), store, 'artel').debt, '0');
  replaceStatementDay(store.banking!, 'sber-artel', { number: paid.account, currency: 'RUB' }, paid.statementDate, [], paid.updatedAt);
  assert.equal(balance(rows, store, 'artel').debt, '800000');
  assert.equal(balance(rows, store, 'artel').receipts.length, 0);
  assert.equal(store.banking!.archivedOperations?.length, 1);
});

test('same supplier INN aliases share one queue; equal names with different INNs never share payments within an organization', () => {
  const alias = { ...supplier, id: 'supplier-alias' }, other = { ...supplier, id: 'supplier-other', inn: CUSTOMER_INN };
  const first = shipment('first', '40'), second = shipment('alias-second', '60', 'nk-artel', '2026-09-02'), unrelated = shipment('other-supplier', '80');
  second.supplierId = alias.id; second.fields.supplier_id = alias.id;
  unrelated.supplierId = other.id; unrelated.fields.supplier_id = other.id; unrelated.fields.supplier_inn = other.inn;
  const store = empty(); insert(store, [payment('same-name-payee', '70')]);
  const result = organization([unrelated, second, first], store, 'nk-artel', [supplier, alias, other, customer]).suppliers;
  const paid = result.companies.find(group => group.inn === SUPPLIER_INN)!, untouched = result.companies.find(group => group.inn === CUSTOMER_INN)!;
  assert.deepEqual(paid.shipments.map(row => [row.id, row.paid, row.debt]), [['first', '40', '0'], ['alias-second', '30', '30']]);
  assert.deepEqual(paid.companyIds, ['supplier', 'supplier-alias']);
  assert.equal(untouched.name, paid.name); assert.equal(untouched.debt, '80'); assert.equal(untouched.incoming, '0');
  assert.equal(untouched.receipts.length, 0);
});

test('supplier matching excludes incoming, unbooked, non-ruble, self, mismatched organization, unknown parties and unverified days', () => {
  const store = empty(), rows = [shipment('purchase', '1000')];
  const pending = { ...payment('pending', '11'), booked: false };
  const foreign = { ...payment('foreign', '12'), currency: 'USD' };
  const self = payment('self', '13'); self.payee.inn = sberConnections['sber-artel'].inn;
  const wrongOrg = payment('wrong-org', '14'); wrongOrg.payer.inn = sberConnections['sber-artel'].inn;
  const unknown = payment('unknown', '15'); unknown.payee.inn = '7702070139';
  const wrongAccount = payment('wrong-account', '16'); wrongAccount.payer.account = '40702810000000000666';
  const missingInn = payment('missing-inn', '17'); delete missingInn.payee.inn;
  const negative = payment('negative', '-18');
  insert(store, [pending, foreign, self, wrongOrg, unknown, wrongAccount, missingInn, payment('client-incoming', '19', 'nk-artel', 'incoming')]);
  store.banking!.operations.push(negative, payment('unverified-artel', '20', 'artel'));
  const result = organization(rows, store);
  assert.equal(result.suppliers.totals.incoming, '0'); assert.equal(result.suppliers.totals.debt, '1000');
  assert.equal(result.suppliers.review.length, 8);
  assert.equal(organization(rows, store, 'artel').suppliers.totals.incoming, '0');
  const conflict = shipment('bad-inn', '100'); conflict.fields.supplier_inn = CUSTOMER_INN;
  const bad = balance([conflict], store);
  assert.equal(bad, undefined);
  assert.match(organization([conflict], store).suppliers.companies[0].issues.join(' '), /не совпадает/);
});

test('canonical bank identity deduplicates repeated records, rejects contradictory copies and rejects ambiguous organization slots', () => {
  const rows = [shipment('purchase', '100')], store = empty(), paid = payment('same-bank-id', '70');
  store.banking!.operations = [paid, { ...paid }];
  assert.equal(balance(rows, store).incoming, '70');
  store.banking!.operations.push({ ...paid, amount: '80' });
  assert.equal(balance(rows, store).incoming, '0');
  assert.equal(organization(rows, store).suppliers.review.length, 1);
  const artel = payment('ambiguous-organization', '90', 'artel');
  artel.payer = { account: artel.account };
  insert(store, [artel]);
  const nk = { ...artel, connectionId: 'sber-nk-artel', id: operationId('sber-nk-artel', artel.account, artel.bankOperationId) };
  store.sber!.operations = [nk];
  for (const id of ['nk-artel', 'artel'] as const) {
    const ledger = organization(rows, store, id).suppliers;
    assert.equal(ledger.totals.incoming, '0');
    assert.ok(ledger.review.some(row => /разных наших организаций/.test(row.reason)));
  }
});

test('assigned clients isolate organizations; mixed legacy history cannot consume the same receipt twice while global compatibility remains intact', () => {
  const store = empty(), legacy = shipment('legacy', '10', null, '2026-09-01', '50');
  const artel = shipment('artel', '20', 'artel', '2026-09-02', '100'), nk = shipment('nk', '30', 'nk-artel', '2026-09-03', '100');
  legacy.fields.paid_amount_source = '10';
  insert(store, [payment('customer-150', '150', 'artel', 'incoming')]);
  const rows = [legacy, artel, nk], orgs = buildOrganizationSettlements(rows, companies, store);
  assert.deepEqual(orgs.organizations.map(row => [row.id, row.clients.totals.debt, row.clients.totals.advance]), [['nk-artel', '100', '0'], ['artel', '0', '50']]);
  const projected = shipmentSettlementAllocations(rows, companies, store);
  assert.deepEqual(projected.map(row => [row.shipmentId, row.amount]), [['artel', '100']]);
  const compatibility = buildSettlements(rows, companies, store);
  assert.equal(compatibility.report.totals.debt, '90');
  assert.deepEqual(compatibility.allocations.map(row => [row.shipmentId, row.amount]), [['legacy', '40'], ['artel', '100'], ['nk', '10']]);
  assert.deepEqual(shipmentSettlementAllocations([legacy], companies, store), buildSettlements([legacy], companies, store).allocations);
  assert.equal(legacy.fields.paid_amount_source, '10');
});

test('manager supplier projections hide foreign purchases, aliases, payment amounts, purposes, review and free advances', () => {
  const store = empty(), own = shipment('own', '300'), other = shipment('hidden-purchase', '400');
  other.fields.manager_id = 'manager-two';
  const hiddenAlias = { ...supplier, id: 'hidden-supplier-alias', name: 'Hidden alias name' };
  other.supplierId = hiddenAlias.id; other.supplier = hiddenAlias.name;
  insert(store, [payment('shared-1000', '1000')]);
  const directory = [hiddenAlias, ...companies], rows = [own, other];
  const actor: AccountUser = { id: 'user-manager', login: 'manager', name: 'Manager', role: 'manager', managerId: 'manager-one', sections: ['overview'], version: 1 };
  const snapshot = { companies: directory, shipments: rows, directories: { managers: [{ id: 'manager-one', name: 'One' }, { id: 'manager-two', name: 'Two' }], customerManagers: [] } } as unknown as Snapshot;
  const full = buildOrganizationSettlements(rows, directory, store).organizations;
  const report = organizationSettlementsForActor(full, snapshot, actor).organizations![0].suppliers;
  assert.equal(report.totals.incoming, '300'); assert.equal(report.totals.advance, '0');
  assert.equal(report.companies[0].receipts[0].amountIsScoped, true);
  assert.equal(report.companies[0].receipts[0].purpose, null);
  assert.deepEqual(report.companies[0].companyIds, [supplier.id]);
  assert.deepEqual(report.review, []); assert.deepEqual(report.sources, []);
  for (const secret of ['hidden-purchase', hiddenAlias.id, hiddenAlias.name, '"amount":"1000"', 'Синтетический платёж']) assert.ok(!JSON.stringify(report).includes(secret), secret);
});

test('supplier cents conserve money and use earliest purchases across deterministic ledgers', () => {
  const money = (cents: bigint) => `${cents / 100n}.${String(cents % 100n).padStart(2, '0')}`;
  const cents = (value: string) => { const [whole, fraction = ''] = value.split('.'); return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0')); };
  for (let seed = 1; seed <= 32; seed++) {
    const purchases = [101n * BigInt(seed), 223n * BigInt(seed), 317n * BigInt(seed)];
    const total = purchases.reduce((sum, amount) => sum + amount, 0n), paid = 501n * BigInt(seed);
    const rows = purchases.map((amount, index) => shipment(`p-${index}`, money(amount), 'nk-artel', `2026-09-0${index + 1}`));
    const store = empty(); insert(store, [payment('cents', money(paid))]);
    const result = balance(rows.reverse(), store);
    assert.equal(cents(result.debt) - cents(result.advance), total - paid);
    assert.equal(cents(result.allocated) + cents(result.advance), paid);
    assert.equal(cents(result.shipments[0].paid!), purchases[0]);
    assert.equal(cents(result.shipments[1].paid!), purchases[1]);
    assert.equal(cents(result.shipments[2].paid!), paid - purchases[0] - purchases[1]);
  }
});

test('shared client advance without shipments in that organization stays private across other-org and unassigned ownership', () => {
  const store = empty(), first = shipment('manager-one-legacy', '100', null), second = shipment('manager-two-nk', '100');
  second.fields.manager_id = 'manager-two';
  insert(store, [payment('private-artel-advance', '123456', 'artel', 'incoming')]);
  const snapshot = { companies, shipments: [first, second], directories: { managers: [{ id: 'manager-one', name: 'One' }, { id: 'manager-two', name: 'Two' }], customerManagers: [] } } as unknown as Snapshot;
  const full = buildOrganizationSettlements(snapshot.shipments, companies, store).organizations;
  assert.equal(full.find(org => org.id === 'artel')!.clients.totals.advance, '123456');
  for (const managerId of ['manager-one', 'manager-two']) {
    const actor: AccountUser = { id: managerId, login: managerId, name: managerId, role: 'manager', managerId, sections: ['overview'], version: 1 };
    const report = organizationSettlementsForActor(full, snapshot, actor).organizations!.find(org => org.id === 'artel')!.clients;
    assert.equal(report.totals.advance, '0'); assert.equal(report.totals.incoming, '0');
    assert.deepEqual(report.companies[0].receipts, []);
    assert.ok(!JSON.stringify(report).includes('private-artel-advance'));
    assert.ok(!JSON.stringify(report).includes('123456'));
  }
});

test('API adds organization ledgers while keeping global compatibility; snapshot, restart and manager scoping use saved synthetic records', async t => {
  const base = await loadSnapshot(), directory = await mkdtemp(resolve(tmpdir(), 'artel-organization-settlements-'));
  const store = new OperationsStore(directory);
  await store.mutate(base.provenance.sourceSha256, data => { data.sourceOperationsCleared = true; return { changed: true, result: null }; });
  const middleware = createSnapshotMiddleware(undefined, { operationsStore: store, bankEnvironment: { ARTEL_BANK_SYNC_ENABLED: 'false' }, bankRequest: async () => { throw new Error('No real bank calls'); } });
  const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end(); }));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => { await new Promise<void>(done => server.close(() => done())); await rm(directory, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let cookie = '';
  const request = async (path: string, method = 'GET', body?: unknown) => {
    const response = await fetch(url + path, { method, headers: { cookie, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie')!.split(';')[0];
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await request('/api/auth/setup', 'POST', { name: 'Organization QA', login: 'organization.qa', password: randomUUID() })).status, 200);
  const snapshot = (await request('/api/snapshot')).body as Snapshot;
  const ids: string[] = [];
  for (const source of companies) {
    const created = await request('/api/directories', 'POST', { kind: 'companies', name: source.name, inn: source.inn, roles: source.roles, ...(source.roles.includes('customer') ? { managerId: snapshot.directories!.managers[0].id } : {}), addresses: [] });
    assert.equal(created.status, 201, JSON.stringify(created.body)); ids.push(created.body.entry.id);
  }
  const savedIds: string[] = [];
  for (const org of ['artel', 'nk-artel', null]) {
    const created = await request('/api/shipments', 'POST', { fields: { shipment_type: 'azs', ...(org ? { organization_id: org } : {}), date: '2026-09-01', supplier_id: ids[0], customer_id: ids[1], manager_id: snapshot.directories!.managers[0].id, product_id: snapshot.directories!.products[0].id, payment_form_id: snapshot.directories!.paymentForms.find(row => row.name === 'б/нал')!.id, quantity_litres: '100', customer_amount: '500', purchase_amount: '300' } });
    assert.equal(created.status, 201, JSON.stringify(created.body)); savedIds.push(created.body.shipment.id);
  }
  await store.mutate(base.provenance.sourceSha256, data => { insert(data, [payment('outgoing-api', '700', 'artel'), payment('incoming-api', '700', 'artel', 'incoming')]); return { changed: true, result: null }; });
  const before = await store.read(base.provenance.sourceSha256);
  const response = await request('/api/settlements'); assert.equal(response.status, 200);
  const report = response.body as SettlementsReport;
  assert.equal(report.organizations!.find(row => row.id === 'artel')!.suppliers.totals.advance, '400');
  assert.equal(report.organizations!.find(row => row.id === 'nk-artel')!.suppliers.totals.debt, '300');
  assert.equal(report.totals.debt, '800'); assert.equal(report.unassignedShipmentCount, 1);
  const current = (await request('/api/snapshot')).body as Snapshot;
  assert.deepEqual(savedIds.map(id => current.shipments.find(row => row.id === id)!.fields.paid_amount_source), ['500', '0', '0']);
  assert.deepEqual(await store.read(base.provenance.sourceSha256), before);
  const reopened = new OperationsStore(directory), stored = await reopened.read(base.provenance.sourceSha256);
  assert.deepEqual(currentSnapshot(base, stored).shipments.map(row => [row.id, row.fields.paid_amount_source]), current.shipments.map(row => [row.id, row.fields.paid_amount_source]));
});
