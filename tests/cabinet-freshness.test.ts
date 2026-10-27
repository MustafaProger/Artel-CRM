import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cabinetConnectionStale, type CabinetConnection } from '../web/src/cabinet-model';
import { today } from '../web/src/shipment-calculations';
const now = Date.parse('2026-10-26T09:00:00Z');
const connection: CabinetConnection = { id: 'fixture', provider: 'glopro', label: 'QA', createdAt: new Date(now).toISOString(), state: 'connected', lastSuccessAt: new Date(now).toISOString(), accounts: [{ id: '1:2', supplier: 'QA', contract: 'QA', amountMinor: 100, currency: 'RUB', sourceUpdatedAt: new Date(now).toISOString() }] };
test('fresh download cannot hide an old GloPro balance timestamp', () => {
  assert.equal(cabinetConnectionStale(connection, now), false);
  assert.equal(cabinetConnectionStale({ ...connection, accounts: [{ ...connection.accounts![0], sourceUpdatedAt: new Date(now - 600_001).toISOString() }] }, now), true);
  assert.equal(cabinetConnectionStale(connection, now + 600_001), true);
  assert.equal(cabinetConnectionStale({ ...connection, state: 'error' }, now), true);
  assert.equal(cabinetConnectionStale({ ...connection, lastSuccessAt: undefined }, now), true);
  assert.equal(cabinetConnectionStale({ ...connection, provider: 'natcar', accounts: [{ ...connection.accounts![0], sourceUpdatedAt: undefined }] }, now), false);
});
test('reused Moscow formatter follows midnight without caching the date', t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-26T20:59:59.999Z') });
  assert.equal(today(), '2026-10-26');
  t.mock.timers.tick(1);
  assert.equal(today(), '2026-10-27');
});
