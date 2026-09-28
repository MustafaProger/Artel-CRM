import assert from 'node:assert/strict';
import test from 'node:test';
import { companyBalance, overviewMoney, overviewMonths, signedMoney } from '../web/src/overview-model';
import type { SettlementCompany, SettlementReceipt, SettlementShipment } from '../web/src/settlements-model';

const receipt = (id: string, date: string, amount: string): SettlementReceipt => ({ id, date, amount, allocated: '0', advance: amount, allocations: [], connectionId: 'test', bank: 'Тестовый банк', company: 'Тест', account: 'test', purpose: null });
const shipment = (id: string, date: string | null, amount: string | null): SettlementShipment => ({ id, date, amount, number: id, openingPaid: '0', bankPaid: '0', paid: '0', debt: amount, issue: amount === null ? 'Сумма неизвестна' : null });
const company = (changes: Partial<SettlementCompany> = {}): SettlementCompany => ({ key: 'test', name: 'Тестовая компания', inn: null, companyIds: ['test'], shipped: '0', incoming: '0', openingPaid: '0', allocated: '0', debt: '0', advance: '0', issues: [], shipments: [], receipts: [], ...changes });

test('overview keeps signed balances and chart totals exact beyond Number precision', () => {
  const row = company({ advance: '9007199254740993.31', debt: '9007199254740993.30', receipts: [receipt('a', '2026-09-01', '9007199254740993.10'), receipt('b', '2026-09-02', '0.20')] });
  assert.equal(companyBalance(row), '0.01');
  assert.equal(signedMoney(companyBalance(row)), '+0,01\u00a0₽');
  assert.equal(signedMoney('-0.01'), '−0,01\u00a0₽');
  assert.equal(signedMoney('0'), '0,00\u00a0₽');
  assert.equal(overviewMoney(null), 'Неизвестно');
  const result = overviewMonths([row], '6', new Date('2026-09-28T08:00:00Z'));
  assert.equal(result.months.at(-1)?.incoming, '9007199254740993.30');
});

test('overview period includes empty months across a year and flags missing amounts without inventing data', () => {
  const row = company({
    receipts: [receipt('old', '2025-07-01', '500'), receipt('dec', '2025-12-31', '100.25'), receipt('jan', '2026-01-01', '0.75')],
    shipments: [shipment('known', '2026-01-15', '90'), shipment('unknown', '2026-01-16', null), shipment('undated', null, '50')],
  });
  const before = structuredClone(row);
  const now = new Date('2026-02-01T08:00:00Z');
  const result = overviewMonths([row], '6', now);
  assert.deepEqual(result.months.map(month => month.month), ['2025-09', '2025-10', '2025-11', '2025-12', '2026-01', '2026-02']);
  assert.deepEqual(result.months.at(-2), { month: '2026-01', incoming: '0.75', shipped: '90.00', receipts: 1, shipments: 2 });
  assert.equal(result.months.at(-1)?.shipped, '0.00');
  assert.equal(result.undated, 1);
  assert.equal(result.unknown, 1);
  assert.equal(overviewMonths([row], 'all', now).months[0].month, '2025-07');
  assert.equal(overviewMonths([row], '12', now).months.length, 12);
  assert.deepEqual(row, before);
});
