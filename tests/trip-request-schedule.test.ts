import test from 'node:test';
import assert from 'node:assert/strict';
import { requestMapDays, requestIsOnMap, validRequestDate } from '../web/src/trip-request-schedule';

test('map uses Moscow calendar days across midnight, month, year and leap day', () => {
  for (const [instant, expected] of [
    ['2026-10-28T20:59:59Z', ['2026-10-28', '2026-10-29']],
    ['2026-10-28T21:00:00Z', ['2026-10-29', '2026-10-30']],
    ['2026-12-31T12:00:00Z', ['2026-12-31', '2027-01-01']],
    ['2028-02-28T12:00:00Z', ['2028-02-28', '2028-02-29']],
  ] as const) assert.deepEqual(requestMapDays(new Date(instant)), expected);
  const now = new Date('2026-10-28T12:00:00Z');
  for (const executionDate of ['2025-01-01', '2026-10-27', '2026-10-28', '2026-10-29']) assert.equal(requestIsOnMap({ status: 'active', executionDate }, now), true);
  for (const executionDate of [undefined, null, '', '2026-02-30', 'not-a-date', '2026-10-30']) assert.equal(requestIsOnMap({ status: 'active', executionDate }, now), false);
  for (const status of ['consumed', 'cancelled'] as const) assert.equal(requestIsOnMap({ status, executionDate: '2026-10-28' }, now), false);
  assert.equal(validRequestDate('2028-02-29'), true);
  assert.equal(validRequestDate('2026-02-29'), false);
});

 test('past requests remain after Moscow midnight; next day enters and later dates stay out', () => {
  const before = new Date('2026-12-31T20:59:59Z'), after = new Date('2026-12-31T21:00:00Z');
  for (const executionDate of ['2026-01-01', '2026-12-31', '2027-01-01']) {
    for (const now of [before, after]) assert.equal(requestIsOnMap({ status: 'active', executionDate }, now), true);
  }
  assert.equal(requestIsOnMap({ status: 'active', executionDate: '2027-01-02' }, before), false);
  assert.equal(requestIsOnMap({ status: 'active', executionDate: '2027-01-02' }, after), true);
  assert.equal(requestIsOnMap({ status: 'active', executionDate: '2027-01-03' }, after), false);
  for (const status of ['consumed', 'cancelled'] as const) assert.equal(requestIsOnMap({ status, executionDate: '2026-01-01' }, after), false);
});
