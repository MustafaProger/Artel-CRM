import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bankToday, defaultBankPeriod, bankPeriodError } from '../web/src/bank-period'

test('bank opening period stays valid on every day across month, year and leap-year boundaries', () => {
  for (let time = Date.parse('2026-01-01T12:00:00Z'); time <= Date.parse('2030-12-31T12:00:00Z'); time += 86400000) {
    const period = defaultBankPeriod(new Date(time))
    assert.equal(period.from, `${period.to.slice(0, 7)}-01`)
    assert.equal(bankPeriodError(period, period.to), '', period.to)
  }
  assert.deepEqual(defaultBankPeriod(new Date('2026-10-05T09:00:00Z')), { from: '2026-10-01', to: '2026-10-05' })
  assert.deepEqual(defaultBankPeriod(new Date('2028-02-29T12:00:00Z')), { from: '2028-02-01', to: '2028-02-29' })
})

test('bank date follows Moscow midnight, including the new year', () => {
  assert.equal(bankToday(new Date('2026-09-30T20:59:59Z')), '2026-09-30')
  assert.deepEqual(defaultBankPeriod(new Date('2026-09-30T21:00:00Z')), { from: '2026-10-01', to: '2026-10-01' })
  assert.deepEqual(defaultBankPeriod(new Date('2026-12-31T21:00:00Z')), { from: '2027-01-01', to: '2027-01-01' })
})

test('inclusive 31-day limit, empty/invalid dates, reversed and future periods are validated', () => {
  const error = (from: string, to: string) => bankPeriodError({ from, to }, '2026-10-05')
  assert.equal(error('2026-09-05', '2026-10-05'), '')
  assert.match(error('2026-09-04', '2026-10-05'), /31 дня/)
  assert.match(error('2026-09-01', '2026-10-05'), /31 дня/)
  assert.match(error('2026-10-05', '2026-10-04'), /начала|Начало/)
  assert.match(error('2026-10-05', '2026-10-06'), /Будущие/)
  for (const invalid of ['', 'invalid', '2026-02-30', '2026-13-01']) assert.match(error(invalid, '2026-10-05'), /Выберите/)
})
