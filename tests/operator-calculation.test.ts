import assert from 'node:assert/strict';
import test from 'node:test';
import Decimal from 'decimal.js';
import { calculateOperatorAmount } from '../web/src/operator-calculation';

test('operator calculation rounds the final total half up and accepts kopecks and comma decimals', () => {
  assert.equal(calculateOperatorAmount('100', '78.45', '10'), '7060.50');
  assert.equal(calculateOperatorAmount('100', '80', '10'), '7200.00');
  assert.equal(calculateOperatorAmount('3', '78,45', '10'), '211.82');
  assert.equal(calculateOperatorAmount('2', '78.45', '10'), '141.21');
  assert.equal(calculateOperatorAmount('1', '0.05', '10'), '0.05');
  assert.equal(calculateOperatorAmount('0.01', '0.01', '0'), '0.00');
  assert.equal(calculateOperatorAmount('100', '80', '100'), '0.00');
});

test('operator calculation rejects incomplete values and excess decimal places', () => {
  for (const [litres, price, discount] of [
    ['', '80', '10'], ['1.001', '80', '10'], ['1', '80.001', '10'],
    ['-1', '80', '10'], ['0', '80', '10'], ['1', '0', '10'],
    ['1e2', '80', '10'], ['NaN', '80', '10'], ['1', 'Infinity', '10'],
    ['1', '80', '-1'], ['1', '80', '101'], ['1', '80', '0.0000001'],
    ['1000000000001', '80', '10'], ['1', '1000000000001', '10'],
  ]) assert.equal(calculateOperatorAmount(litres, price, discount), null, [litres, price, discount].join('/'));
});

test('operator calculates unchanged historical precision only when explicitly allowed', () => {
  assert.equal(calculateOperatorAmount('200', '65.123456', '5'), null);
  assert.equal(calculateOperatorAmount('200', '65.123456', '5', true), '12373.46');
  assert.equal(calculateOperatorAmount('100.123456', '80', '5', true), '7609.38');
  assert.equal(calculateOperatorAmount('100.1234567', '80', '5', true), null);
});

test('operator precision remains independent of global Decimal settings', () => {
  const previous = { precision: Decimal.precision, rounding: Decimal.rounding };
  try {
    Decimal.set({ precision: 5, rounding: Decimal.ROUND_DOWN });
    assert.equal(calculateOperatorAmount('1000000000000.01', '78.45', '0.000001'), null);
    assert.equal(calculateOperatorAmount('999999999999.99', '78.45', '0.000001'), '78449999215499.22');
  } finally {
    Decimal.set(previous);
  }
});
