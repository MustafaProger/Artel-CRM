import assert from 'node:assert/strict';
import test from 'node:test';
import { driverDateTimeLabel, normalizeDriverMass } from '../web/src/driver-trip-model';
import { loadingDateFields } from '../web/src/trip-editor-rules';

test('driver mass input supports comma and exact delivery decimals, rejects invalid values', () => {
  assert.equal(normalizeDriverMass('2,123456'), '2.123456');
  assert.equal(normalizeDriverMass('.5'), '0.5');
  for (const raw of ['', '0', '-1', 'NaN', 'Infinity', '1e3', '2,1234567', 'one']) assert.equal(normalizeDriverMass(raw), null);
});

test('driver event labels always use Moscow for explicit and historical local timestamps', () => {
  const expected = driverDateTimeLabel('2026-10-07T22:15:00Z');
  assert.match(expected, /8 октября.*01:15 МСК/);
  assert.equal(driverDateTimeLabel('2026-10-08T01:15'), expected);
  assert.equal(driverDateTimeLabel('2026-10-08T01:15:00+03:00'), expected);
  assert.equal(driverDateTimeLabel('2026-10-08'), 'Время не подтверждено');
});

test('editing a plan preserves the requested future time without inventing actual events', () => {
  assert.deepEqual(loadingDateFields('2099-10-08T09:00'), {
    loading_at: '2099-10-08T09:00', date: '2099-10-08', loading_planned_at: '2099-10-08T09:00',
  });
});
