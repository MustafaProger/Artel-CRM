import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSettlements } from '../server/settlements';
import { emptyBanking, operationId } from '../server/banking/domain';
import { emptySber, SBER_ACCOUNT, SBER_INN } from '../server/banking/sber-domain';
import type { OperationsData } from '../server/operations-store';
import type { BankOperation } from '../web/src/banking-model';
import type { Company, Shipment } from '../web/src/model';

const firstInn = '7707083893', secondInn = '7736050003';
const account = '40702810000000000001';
const companies: Company[] = [
  { id: 'romashka', name: 'Тестовая Ромашка', inn: firstInn, roles: ['customer'], managerLabels: [], shipmentIds: [], paymentIds: [], flags: [] },
  { id: 'vasilek', name: 'Тестовый Василёк', inn: secondInn, roles: ['customer'], managerLabels: [], shipmentIds: [], paymentIds: [], flags: [] },
];
const empty = (): OperationsData => ({ schemaVersion: 1, sourceSha256: 'test', revision: 0, shipments: {}, companies: [], banking: emptyBanking(), sber: emptySber(), paymentAllocations: [] });
const shipment = (id: string, amount: string | null, date = '2026-09-01', company = companies[0], paid: string | null = '0'): Shipment => ({
  id, date, customerId: company.id, customer: company.name, supplierId: null, supplier: null, carrierId: null, carrier: null, product: null, liters: null, revenue: amount, cost: null, manager: null, sourceRow: 0, sourceSheet: '', flags: [],
  fields: { date, customer_id: company.id, customer_inn: company.inn ?? null, customer_amount: amount, paid_amount_source: paid, document_number: id, payment_form: 'б/нал' },
});
function receipt(id: string, amount: string, date = '2026-09-02', inn = firstInn, provider: 'tbank' | 'sber' = 'tbank'): BankOperation {
  const connectionId = provider === 'sber' ? 'sber-nk-artel' : 'tbank-nk-artel';
  const ownAccount = provider === 'sber' ? SBER_ACCOUNT : account;
  return { id: operationId(connectionId, ownAccount, id), connectionId, provider, bankOperationId: id, account: ownAccount, statementDate: date, amount, currency: 'RUB', direction: 'incoming', status: provider === 'tbank' ? 'Transaction' : undefined, booked: true, payer: { name: 'Тестовый плательщик', inn }, payee: { name: 'НК АРТЭЛЬ', inn: SBER_INN }, bankData: {}, updatedAt: '2026-09-02T12:00:00Z', source: 'statement-api', counterpartyId: null, allocations: [], importedSourceIds: [] };
}
const romashka = (result: ReturnType<typeof buildSettlements>) => result.report.companies.find(group => group.inn === firstInn)!;

test('customer receipts pay FIFO, carry advances into new shipments and reproduce the requested sequence', () => {
  const store = empty();
  const rows = [shipment('first', '40000', '2026-09-01'), shipment('second', '30000', '2026-09-02')];
  store.banking!.operations = [receipt('first-payment', '100000', '2026-09-03')];
  let result = buildSettlements(rows, companies, store);
  assert.deepEqual(romashka(result).shipments.map(row => row.paid), ['40000', '30000']);
  assert.equal(romashka(result).advance, '30000');
  rows.push(shipment('third', '20000', '2026-09-04'));
  result = buildSettlements(rows, companies, store);
  assert.equal(romashka(result).advance, '10000');
  rows.push(shipment('fourth', '30000', '2026-09-05'));
  result = buildSettlements(rows, companies, store);
  assert.equal(romashka(result).shipments[3].paid, '10000');
  assert.equal(romashka(result).debt, '20000');
  store.banking!.operations.push(receipt('second-payment', '10000', '2026-09-06'));
  result = buildSettlements(rows, companies, store);
  assert.equal(romashka(result).debt, '10000');
  store.banking!.operations.push(receipt('third-payment', '20000', '2026-09-07'));
  result = buildSettlements(rows, companies, store);
  assert.equal(romashka(result).debt, '0');
  assert.equal(romashka(result).advance, '10000');
  assert.deepEqual(result.report.totals, { shipped: '120000', incoming: '130000', debt: '0', advance: '10000', allocated: '120000' });
  assert.equal(romashka(result).receipts.at(-1)!.allocations[0].amount, '10000');
  assert.deepEqual(rows.map(row => row.fields.paid_amount_source), ['0', '0', '0', '0'], 'projection never writes into baseline shipment rows');
});

test('different INNs never share funds, while multiple directory entries with the same INN share one queue', () => {
  const alias = { ...companies[0], id: 'romashka-alias', name: 'Иное название той же фирмы' };
  const rows = [shipment('a', '40'), shipment('b', '30', '2026-09-02', alias), shipment('c', '100', '2026-09-03', companies[1])];
  const store = empty(); store.banking!.operations = [receipt('p', '100')];
  const result = buildSettlements(rows, [...companies, alias], store);
  assert.equal(romashka(result).advance, '30');
  assert.deepEqual(romashka(result).companyIds, ['romashka', 'romashka-alias']);
  assert.equal(result.report.companies.find(row => row.inn === secondInn)!.debt, '100');
});

test('advance from a valid unknown bank payer is retained and matches later directory and shipment records', () => {
  const store = empty(); store.banking!.operations = [receipt('prepaid', '125')];
  const initial = buildSettlements([], [], store);
  assert.equal(romashka(initial).advance, '125');
  assert.deepEqual(romashka(initial).companyIds, []);
  const next = buildSettlements([shipment('future', '100')], companies, store);
  assert.equal(romashka(next).advance, '25');
  assert.equal(romashka(next).shipments[0].paid, '100');
});

test('active TBank and new Sber receipts combine, ignoring archive, staged pages, and legacy Sber storage', () => {
  const store = empty(), tbank = receipt('t', '10'), sber = receipt('s', '20', '2026-09-03', firstInn, 'sber');
  store.banking!.operations = [tbank, tbank, receipt('old-sber', '999', '2026-09-02', firstInn, 'sber')];
  store.banking!.archivedOperations = [receipt('archived', '999')];
  store.banking!.connections['tbank-nk-artel'] = { accounts: [], lastSuccessAt: '2026-09-04T10:00:00Z', lastCompletedPeriod: { from: '2026-09-01', to: '2026-09-03' }, job: { id: 'job', from: '2026-09-01', to: '2026-09-04', day: '2026-09-04', accountIndex: 0, accounts: [{ number: account, currency: 'RUB' }], startedAt: '2026-09-04T11:00:00Z', pages: 1, attempts: 0, staged: [receipt('staged', '999')] } };
  store.sber!.operations = [sber];
  store.sber!.job = { id: 'job', from: '2026-09-01', to: '2026-09-04', day: '2026-09-04', page: 2, pages: 1, attempts: 0, staged: [receipt('sber-staged', '999', '2026-09-04', firstInn, 'sber')], seenPages: [] };
  const before = structuredClone(store);
  const result = buildSettlements([shipment('debt', '100')], companies, store);
  assert.equal(result.report.totals.incoming, '30');
  assert.equal(result.report.totals.debt, '70');
  assert.equal(result.allocations.length, 2);
  assert.deepEqual(buildSettlements([shipment('debt', '100')], companies, store), result, 'repeated reads preserve exact results and allocation IDs');
  assert.deepEqual(store, before);
  assert.equal(result.report.sources.find(source => source.id === 'tbank-nk-artel')!.lastSuccessAt, '2026-09-04T10:00:00Z');
});

test('outgoing, unbooked, own transfers, missing INN and non-ruble receipts cannot pay customer debt', () => {
  const store = empty();
  store.banking!.operations = [
    { ...receipt('out', '100'), direction: 'outgoing', payer: { inn: SBER_INN }, payee: { inn: firstInn } },
    { ...receipt('pending', '100'), booked: false, status: 'Authorization' },
    receipt('own', '100', '2026-09-02', SBER_INN),
    { ...receipt('foreign', '100'), currency: 'USD' },
    receipt('missing', '100', '2026-09-02', ''),
    receipt('invalid', '100', '2026-09-02', '1234567890'),
    receipt('zero', '0'),
  ];
  const result = buildSettlements([shipment('debt', '100')], companies, store);
  assert.equal(result.report.totals.debt, '100');
  assert.equal(result.report.totals.incoming, '0');
  assert.equal(result.allocations.length, 0);
  assert.equal(result.report.review.length, 6);
  assert.ok(!result.report.review.some(row => row.id === store.banking!.operations[0].id));
});

test('decimal allocations remain exact and retain precision beyond JavaScript numbers', () => {
  const store = empty();
  store.banking!.operations = [receipt('precise', '9007199254740993.300000000000000003')];
  const result = buildSettlements([shipment('first', '9007199254740993.1'), shipment('second', '0.200000000000000002', '2026-09-02')], companies, store);
  assert.equal(result.report.totals.debt, '0');
  assert.equal(result.report.totals.allocated, '9007199254740993.300000000000000002');
  assert.equal(result.report.totals.advance, '0.000000000000000001');
});

test('unknown baseline payments and missing or conflicting INNs remain visible without allocation', () => {
  const missing = { ...companies[1], id: 'no-inn', inn: undefined };
  const rows = [shipment('unknown-paid', '50', '2026-09-01', companies[0], null), shipment('missing-inn', '20', '2026-09-01', missing), shipment('conflict', '30')];
  rows[2].fields.customer_inn = secondInn;
  const store = empty(); store.banking!.operations = [receipt('payment', '100')];
  const result = buildSettlements(rows, [...companies, missing], store);
  assert.equal(result.allocations.length, 0);
  assert.equal(romashka(result).advance, '100');
  assert.equal(romashka(result).shipments[0].paid, null);
  assert.equal(romashka(result).shipments[0].debt, null);
  assert.ok(result.report.companies.every(group => group.issues.length));
  assert.equal(result.report.companies.flatMap(group => group.shipments).length, 3);
});

test('unknown or invalid shipment amounts and dates are ineligible; explicit zero is a settled shipment', () => {
  const rows = [shipment('unknown-amount', null), shipment('bad-date', '25', '2026-02-31'), shipment('zero', '0')];
  const store = empty(); store.banking!.operations = [receipt('payment', '100')];
  const result = buildSettlements(rows, companies, store);
  assert.equal(result.allocations.length, 0);
  assert.equal(romashka(result).advance, '100');
  assert.equal(romashka(result).debt, '25');
  assert.equal(romashka(result).shipments.find(row => row.id === 'zero')!.debt, '0');
});

test('existing paid amounts are preserved and historical excess is displayed without being spent twice', () => {
  const rows = [shipment('partly-paid', '100', '2026-09-01', companies[0], '60'), shipment('overpaid', '40', '2026-09-02', companies[0], '50'), shipment('unpaid', '30', '2026-09-03')];
  const store = empty(); store.banking!.operations = [receipt('payment', '50')];
  const result = buildSettlements(rows, companies, store);
  assert.deepEqual(romashka(result).shipments.map(row => row.paid), ['100', '50', '10']);
  assert.equal(romashka(result).debt, '20');
  assert.equal(romashka(result).advance, '10');
  assert.ok(romashka(result).issues.some(issue => issue.includes('Историческая переплата')));
});

test('changes and deletions to authoritative records recalculate debt and advance without stale postings', () => {
  const rows = [shipment('first', '40'), shipment('second', '30', '2026-09-02')];
  const store = empty(); store.banking!.operations = [receipt('payment', '100')];
  assert.equal(romashka(buildSettlements(rows, companies, store)).advance, '30');
  store.banking!.operations[0].amount = '50';
  let result = buildSettlements(rows, companies, store);
  assert.equal(romashka(result).debt, '20');
  assert.equal(romashka(result).advance, '0');
  result = buildSettlements(rows.slice(1), companies, store);
  assert.equal(romashka(result).advance, '20');
  store.banking!.operations = [];
  result = buildSettlements(rows, companies, store);
  assert.equal(romashka(result).debt, '70');
  assert.equal(result.allocations.length, 0);
});

test('same-day shipment FIFO is deterministic by creation time then ID, independent of input order', () => {
  const rows = [shipment('c', '10'), { ...shipment('a', '10'), createdAt: '2026-09-01T12:00:00Z' }, { ...shipment('b', '10'), createdAt: '2026-09-01T12:00:00Z' }];
  const store = empty(); store.banking!.operations = [receipt('payment', '15')];
  const result = buildSettlements(rows, companies, store);
  assert.deepEqual(romashka(result).shipments.map(row => [row.id, row.paid]), [['c', '10'], ['a', '5'], ['b', '0']]);
  assert.deepEqual(buildSettlements([...rows].reverse(), companies, store), result);
});
