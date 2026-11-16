import assert from 'node:assert/strict';
import test from 'node:test';
import { licardBrowserConnection } from '../server/licard-browser-balance';

const now = Date.parse('2026-11-16T10:05:00Z');
const fresh = {
  version: 1, contract: 'RU260007461', state: 'connected',
  lastAttemptAt: '2026-11-16T10:04:00Z', lastSuccessAt: '2026-11-16T10:04:00Z',
  amountMinor: 22710610,
};

test('Licard publishes a valid zero balance and rejects another contract', () => {
  const result = licardBrowserConnection({ ...fresh, amountMinor: 0 }, now);
  assert.equal(result.state, 'connected');
  assert.equal(result.accounts?.[0]?.contract, fresh.contract);
  assert.equal(result.accounts?.[0]?.amountMinor, 0);
  assert.equal(licardBrowserConnection({ ...fresh, contract: 'RU123' }, now).accounts, undefined);
});

test('Licard preserves the previous amount after logout and marks delayed data stale', () => {
  const auth = licardBrowserConnection({ ...fresh, state: 'auth_required' }, now);
  assert.equal(auth.state, 'auth_required');
  assert.equal(auth.accounts?.[0]?.amountMinor, fresh.amountMinor);
  assert.equal(licardBrowserConnection(fresh, now + 600_000).state, 'error');
  assert.equal(licardBrowserConnection({ ...fresh, lastSuccessAt: undefined, amountMinor: undefined }, now).state, 'error');
});
