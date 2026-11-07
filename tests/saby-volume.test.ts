import assert from 'node:assert/strict';
import test from 'node:test';
import { exactSabyVolume, formatSabyVolume, sabyVolumeRoundedToZero, SABY_VOLUME_ROUNDING_VERSION as version } from '../server/saby-volume';

test('Saby volumes convert decimal litres exactly and round only the requested XML field', () => {
  assert.equal(exactSabyVolume('15048', 'litres'), '15.048');
  assert.equal(formatSabyVolume('15048', 'litres', 2, version), '15.05');
  assert.equal(formatSabyVolume('15048', 'litres', 3, version), '15.048');
  assert.equal(formatSabyVolume('15048', 'cubic-metres', 2, version), '15048', 'units are never inferred');
  assert.equal(formatSabyVolume('15,048', 'cubic-metres', 2, version), '15.05');
  assert.equal(formatSabyVolume('15048,5', 'litres', 3, version), '15.049');
  assert.equal(formatSabyVolume('15048', 'litres', 2), '15.048', 'frozen snapshots without opt-in remain exact');
});

test('half-up boundaries avoid binary floating point and preserve significant large inputs', () => {
  for (const [litres, dp, expected] of [
    ['1004.999', 2, '1'], ['1005', 2, '1.01'], ['1005.001', 2, '1.01'],
    ['1000.499', 3, '1'], ['1000.5', 3, '1.001'], ['1000.501', 3, '1.001'],
    ['999994.999', 2, '999.99'], ['999995', 2, '1000'],
    ['99999999999999999999.499', 3, '99999999999999999.999'],
  ] as const) assert.equal(formatSabyVolume(litres, 'litres', dp, version), expected);
});

test('invalid and nonpositive source values cannot become a positive Saby volume', () => {
  for (const value of ['', '-1', '+1', '1e4', 'NaN', 'Infinity', '1.2.3', '1,2.3', '1 000', 1000, null, '1'.repeat(41)]) {
    assert.equal(formatSabyVolume(value, 'litres', 2, version), null);
  }
  assert.equal(formatSabyVolume('0', 'litres', 2, version), '0');
  assert.equal(formatSabyVolume('4.999', 'litres', 2, version), '0');
  assert.equal(sabyVolumeRoundedToZero('4.999', 'litres', 2, version), true);
  assert.equal(sabyVolumeRoundedToZero('5', 'litres', 2, version), false);
  assert.equal(sabyVolumeRoundedToZero('0.499', 'litres', 3, version), true);
  assert.equal(sabyVolumeRoundedToZero('0', 'litres', 2, version), false);
});
