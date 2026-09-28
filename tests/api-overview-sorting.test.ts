import assert from 'node:assert/strict';
import test from 'node:test';
import { sortOverviewCompanies, sortOverviewEntries, type OverviewEntry } from '../web/src/overview-sorting';
import type { SettlementCompany, SettlementReceipt, SettlementShipment } from '../web/src/settlements-model';

const receipt = (id: string, date: string, amount = '1'): SettlementReceipt => ({ id, date, amount, allocated: '0', advance: amount, allocations: [], connectionId: 'synthetic', bank: 'Тестовый банк', company: 'Тест', account: 'synthetic', purpose: null });
const shipment = (id: string, date: string | null, amount: string | null = '1'): SettlementShipment => ({ id, date, amount, number: id, openingPaid: '0', bankPaid: '0', paid: '0', debt: amount, issue: amount === null ? 'Сумма неизвестна' : null });
const company = (key: string, changes: Partial<SettlementCompany> = {}): SettlementCompany => ({ key, name: key, inn: null, companyIds: [key], shipped: '0', incoming: '0', openingPaid: '0', allocated: '0', debt: '0', advance: '0', issues: [], shipments: [], receipts: [], ...changes });
const paymentEntry = (id: string, date: string, amount: string): OverviewEntry => ({ type: 'receipt', date, item: receipt(id, date, amount) });
const shipmentEntry = (id: string, date: string | null, amount: string | null): OverviewEntry => ({ type: 'shipment', date, item: shipment(id, date, amount) });
const companyKeys = (rows: SettlementCompany[]) => rows.map(row => row.key);
const entryIds = (rows: OverviewEntry[]) => rows.map(row => row.item.id);

test('company amount order uses absolute displayed balance with exact decimal precision', () => {
  const rows = [
    company('advance', { advance: '9007199254740993.31' }),
    company('debt', { debt: '9007199254740993.32' }),
    company('net', { advance: '100.01', debt: '100.00' }),
    company('zero'),
  ];
  const before = structuredClone(rows);
  assert.deepEqual(companyKeys(sortOverviewCompanies(rows, 'amount-desc')), ['debt', 'advance', 'net', 'zero']);
  assert.deepEqual(companyKeys(sortOverviewCompanies(rows, 'amount-asc')), ['zero', 'net', 'advance', 'debt']);
  assert.deepEqual(rows, before);
});

test('company date order uses latest valid operation, and undated companies stay last', () => {
  const rows = [
    company('recent', { receipts: [receipt('old', '2020-01-01'), receipt('new', '2026-09-10T00:00:00Z')], shipments: [shipment('invalid', 'invalid')] }),
    company('older', { shipments: [shipment('last', '2026-09-05')] }),
    company('undated', { shipments: [shipment('no-date', null)] }),
  ];
  assert.deepEqual(companyKeys(sortOverviewCompanies(rows, 'date-desc')), ['recent', 'older', 'undated']);
  assert.deepEqual(companyKeys(sortOverviewCompanies(rows, 'date-asc')), ['older', 'recent', 'undated']);
});

test('company ties are deterministic and sorting preserves filtered membership', () => {
  const rows = [company('b', { name: 'Контрагент', advance: '20', inn: '222' }), company('z', { name: 'Якорь', advance: '10', inn: '111' }), company('a', { name: 'Контрагент', debt: '20', inn: '222' })];
  const matches = (row: SettlementCompany) => `${row.name} ${row.inn ?? ''}`.includes('222');
  assert.deepEqual(companyKeys(sortOverviewCompanies(rows, 'amount-desc')), ['a', 'b', 'z']);
  assert.deepEqual(companyKeys(sortOverviewCompanies([...rows].reverse(), 'amount-desc')), ['a', 'b', 'z']);
  assert.deepEqual(companyKeys(sortOverviewCompanies(rows.filter(matches), 'amount-asc')), ['a', 'b']);
  assert.deepEqual(sortOverviewCompanies(rows.filter(matches), 'amount-asc'), sortOverviewCompanies(rows, 'amount-asc').filter(matches));
});

test('operation amount order uses magnitude and keeps unknown amounts last in both directions', () => {
  const rows = [paymentEntry('payment', '2026-09-10', '9007199254740993.31'), shipmentEntry('purchase', '2026-09-10', '-9007199254740993.32'), shipmentEntry('unknown', '2026-09-10', null), paymentEntry('small', '2026-09-10', '0.01')];
  const before = structuredClone(rows);
  assert.deepEqual(entryIds(sortOverviewEntries(rows, 'amount-desc')), ['purchase', 'payment', 'small', 'unknown']);
  assert.deepEqual(entryIds(sortOverviewEntries(rows, 'amount-asc')), ['small', 'payment', 'purchase', 'unknown']);
  assert.deepEqual(rows, before);
});

test('operation date order compares timestamps, keeps missing dates last and resolves ties by identity', () => {
  const rows = [shipmentEntry('undated', null, '1'), paymentEntry('older', '2026-09-10T01:00:00+03:00', '1'), shipmentEntry('z', '2026-09-10T00:00:00Z', '1'), shipmentEntry('invalid', 'invalid', '1'), shipmentEntry('a', '2026-09-10T00:00:00Z', '1')];
  assert.deepEqual(entryIds(sortOverviewEntries(rows, 'date-desc')), ['a', 'z', 'older', 'invalid', 'undated']);
  assert.deepEqual(entryIds(sortOverviewEntries(rows, 'date-asc')), ['older', 'a', 'z', 'invalid', 'undated']);
  assert.deepEqual(entryIds(sortOverviewEntries([...rows].reverse(), 'date-desc')), ['a', 'z', 'older', 'invalid', 'undated']);
});
