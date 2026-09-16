import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSettlements } from '../server/settlements';
import { emptyBanking, operationId } from '../server/banking/domain';
import { emptySber, SBER_ACCOUNT, SBER_INN } from '../server/banking/sber-domain';
import { replaceStatementDay } from '../server/banking/statement-publication';
import { calculateShipment, TEMPLATE_PROFIT_RULE } from '../web/src/shipment-calculations';
import type { OperationsData } from '../server/operations-store';
import type { BankOperation } from '../web/src/banking-model';
import type { Company, Shipment } from '../web/src/model';

const INN = '7707083893', THIRD_ACCOUNT = '40702810000000000003';
const company: Company = { id: 'customer', name: 'Тестовая фирма', inn: INN, roles: ['customer'], managerLabels: [], shipmentIds: [], paymentIds: [], flags: [] };
const store = (): OperationsData => ({ schemaVersion: 1, sourceSha256: 'test', revision: 0, companies: [], shipments: {}, banking: emptyBanking(), sber: emptySber() });
const shipment = (id = 'shipment', amount = '70'): Shipment => ({ id, date: '2026-09-01', customerId: company.id, customer: company.name, supplierId: null, supplier: null, carrierId: null, carrier: null, product: null, liters: null, revenue: amount, cost: null, manager: null, sourceRow: 0, sourceSheet: '', flags: [], fields: { date: '2026-09-01', customer_inn: INN, customer_amount: amount, paid_amount_source: '0' } });
function receipt(connectionId = 'sber-nk-artel', account = SBER_ACCOUNT, amount = '40', bankId = 'same-bank-id'): BankOperation {
  return { id: operationId(connectionId, account, bankId), connectionId, provider: 'sber', bankOperationId: bankId, account, statementDate: '2026-09-02', direction: 'incoming', amount, currency: 'RUB', booked: true, payer: { inn: INN, name: company.name, account: '40702810000000000099' }, payee: { inn: SBER_INN, account }, bankData: {}, updatedAt: '2026-09-02T12:00:00Z', source: 'statement-api', counterpartyId: null, allocations: [], importedSourceIds: [] };
}
const calculate = (data: OperationsData, rows = [shipment()]) => buildSettlements(rows, [company], data);
const publishThird = (data: OperationsData, rows: BankOperation[], account = THIRD_ACCOUNT) => replaceStatementDay(data.banking!, 'sber-artel', { number: account, currency: 'RUB' }, '2026-09-02', rows, '2026-09-02T13:00:00Z');

test('same physical bank operation imported through two slots counts once; conflicting copies require review', () => {
  const data = store(); data.sber!.operations = [receipt()];
  publishThird(data, [receipt('sber-artel', SBER_ACCOUNT, '40.00')], SBER_ACCOUNT);
  let result = calculate(data);
  assert.equal(result.report.totals.incoming, '40'); assert.equal(result.report.totals.debt, '30');
  assert.equal(result.report.companies[0].receipts.length, 1);
  publishThird(data, [receipt('sber-artel', SBER_ACCOUNT, '41')], SBER_ACCOUNT);
  result = calculate(data);
  assert.equal(result.report.totals.incoming, '0'); assert.equal(result.report.totals.debt, '70');
  assert.equal(result.report.review.length, 2); assert.ok(result.report.review.every(row => row.reason.includes('разными')));
  publishThird(data, [], SBER_ACCOUNT);
  assert.equal(calculate(data).report.totals.incoming, '40', 'Removing a conflicting duplicate releases the authoritative receipt');
});

test('similar receipts and identical bank IDs on different accounts remain independent money', () => {
  const data = store(); data.sber!.operations = [receipt(), receipt('sber-nk-artel', SBER_ACCOUNT, '40', 'another-id')];
  publishThird(data, [receipt('sber-artel', THIRD_ACCOUNT)]);
  const result = calculate(data);
  assert.equal(result.report.totals.incoming, '120'); assert.equal(result.report.totals.advance, '50');
  assert.equal(result.report.companies[0].receipts.length, 3);
});

test('own-account transfers cannot pay a buyer even when payer INN is absent or claims an external buyer', () => {
  for (const inn of [undefined, INN, 'invalid']) {
    const data = store();
    data.banking!.connections['sber-artel'] = { accounts: [{ number: THIRD_ACCOUNT, currency: 'RUB' }] };
    data.sber!.operations = [{ ...receipt(), payer: { inn, account: THIRD_ACCOUNT } }];
    const result = calculate(data);
    assert.equal(result.report.totals.incoming, '0'); assert.equal(result.report.totals.debt, '70');
    assert.match(result.report.review[0].reason, /собственного счёта/);
  }
});

test('third-bank historical timestamps and staged rows do not enable old money; only complete days are eligible', () => {
  const data = store(), row = receipt('sber-artel', THIRD_ACCOUNT);
  data.banking!.operations = [row];
  data.banking!.connections['sber-artel'] = { accounts: [{ number: THIRD_ACCOUNT, currency: 'RUB' }], lastSuccessAt: '2026-01-01T00:00:00Z', lastCompletedPeriod: { from: '2026-01-01', to: '2026-01-01' } };
  let result = calculate(data);
  assert.equal(result.report.totals.incoming, '0');
  let source = result.report.sources.find(source => source.id === 'sber-artel')!;
  assert.equal(source.status, 'not_loaded'); assert.equal(source.lastSuccessAt, null); assert.equal(source.from, null);
  publishThird(data, [row]); result = calculate(data); source = result.report.sources.find(source => source.id === 'sber-artel')!;
  assert.equal(result.report.totals.incoming, '40'); assert.equal(source.status, 'ready');
  assert.equal(source.from, '2026-09-02'); assert.equal(source.lastSuccessAt, '2026-09-02T13:00:00Z');
  data.banking!.connections['sber-artel'].lastError = 'Банк временно недоступен';
  result = calculate(data);
  assert.equal(result.report.totals.incoming, '40'); assert.equal(result.report.sources.find(source => source.id === 'sber-artel')!.status, 'error');
  publishThird(data, []); assert.equal(calculate(data).report.totals.debt, '70');
});

test('allowed forty-digit tanker inputs retain a one-kopeck receipt in both ledger and shipment debt', () => {
  const rules = { sale: 'litres', purchase: 'litres', profit: TEMPLATE_PROFIT_RULE, debtSign: 'paid-minus-sale' } as const;
  const fields = { date: '2026-09-01', payment_form: 'б/нал', quantity_litres: `2${'0'.repeat(39)}`, quantity_tonnes: '1', sale_price_per_litre: `5${'0'.repeat(39)}`, purchase_price_unspecified_unit: '0', purchase_unit: 'litres', customer_inn: INN };
  const baseline = calculateShipment(fields, rules).fields;
  const huge = `1${'0'.repeat(79)}`;
  assert.equal(baseline.customer_amount, huge);
  const row = { ...shipment('huge', huge), fields: baseline, calculationRules: rules };
  const data = store(); data.sber!.operations = [receipt('sber-nk-artel', SBER_ACCOUNT, '0.01')];
  const result = calculate(data, [row, shipment('small', '0.02')]);
  const cents = (value: bigint) => { const s = value.toString().padStart(3, '0'); return `${s.slice(0, -2)}.${s.slice(-2)}`; };
  const expectedDebt = cents(10n ** 81n - 1n);
  assert.equal(result.report.companies[0].shipments.find(row => row.id === 'huge')!.debt, expectedDebt);
  assert.equal(result.report.totals.shipped, `${huge}.02`);
  assert.equal(result.report.totals.debt, `${huge}.01`);
  const projected = calculateShipment(baseline, rules, { allocations: result.allocations.filter(allocation => allocation.shipmentId === 'huge') }).fields;
  assert.equal(projected.paid_amount_source, '0.01'); assert.equal(projected.debt_overpayment_source, `-${expectedDebt}`);
});

test('all ruble identifiers are accounted identically and foreign currency remains separate for review', () => {
  for (const currency of ['RUB', 'RUR', '643', '810', 'USD']) {
    const data = store(); data.sber!.operations = [{ ...receipt(), currency }];
    const result = calculate(data);
    assert.equal(result.report.totals.incoming, currency === 'USD' ? '0' : '40');
    assert.equal(result.report.review.length, currency === 'USD' ? 1 : 0);
  }
});
