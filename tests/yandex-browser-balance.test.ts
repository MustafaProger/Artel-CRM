import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { yandexBrowserConnection, readYandexBrowserBalance } from '../server/yandex-browser-balance';
import { cabinetConnectionStale } from '../web/src/cabinet-model';
const now = Date.parse('2026-10-27T12:00:00Z');
const input = () => ({ version: 1, companyId: '7d90c6ecc6804d738c19d1c1c0ab0aaa', contractId: '49844602', contractNumber: '43207794/25', createdAt: '2026-10-27T10:00:00Z', lastAttemptAt: new Date(now).toISOString(), lastSuccessAt: new Date(now).toISOString(), state: 'connected', balance: { amountMinor: 12345, availableMinor: 23456, currency: 'RUB' } });
test('Yandex money is own fuel funds, available funds and credit stay separate; untrusted fields never reach API', () => {
  const row = yandexBrowserConnection({ ...input(), secret: 'not-for-api', error: 'not-for-api', balance: { ...input().balance, overdraftLimitMinor: 200000, overdraftAvailableMinor: 11111 } }, now);
  assert.equal(row.state, 'connected'); assert.equal(row.accounts?.[0].amountMinor, 12345);
  assert.equal(row.accounts?.[0].contract, '43207794/25');
  assert.deepEqual(row.accounts?.[0].details?.map(d => d.amountMinor), [23456, 200000, 11111]);
  assert.equal(row.accounts?.[0].sourceUpdatedAt, undefined); assert.ok(!JSON.stringify(row).includes('not-for-api'));
  assert.equal(cabinetConnectionStale(row, now), false);
});
for (const [name, patch] of Object.entries({ company: { companyId: 'other' }, contract: { contractId: 'other' }, number: { contractNumber: 'other' }, currency: { balance: { ...input().balance, currency: 'USD' } }, decimals: { balance: { ...input().balance, amountMinor: 12.3 } }, overflow: { balance: { ...input().balance, amountMinor: Number.MAX_SAFE_INTEGER + 1 } }, future: { lastSuccessAt: '2030-01-01T00:00:00Z' }, missingBalance: { balance: undefined }, wrongTime: { lastAttemptAt: 'bad' }, outOfOrder: { createdAt: '2026-10-27T12:00:01Z' } })) {
  test(`Yandex rejects ${name} without publishing money`, () => {
    const row = yandexBrowserConnection({ ...input(), ...patch }, now);
    assert.equal(row.state, 'error'); assert.equal(row.accounts, undefined);
  });
}
test('Yandex reauth and provider error preserve last successful timestamp and amount', () => {
  for (const state of ['error', 'auth_required']) {
    const row = yandexBrowserConnection({ ...input(), state, lastAttemptAt: new Date(now + 1000).toISOString() }, now + 1000);
    assert.equal(row.state, state); assert.equal(row.lastSuccessAt, input().lastSuccessAt);
    assert.equal(row.accounts?.[0].amountMinor, 12345); assert.equal(cabinetConnectionStale(row, now), true);
  }
});
test('Yandex stopped worker becomes stale without new success timestamp', () => {
  const row = yandexBrowserConnection(input(), now + 600001);
  assert.equal(row.state, 'error'); assert.equal(row.lastSuccessAt, input().lastSuccessAt); assert.equal(row.accounts?.[0].amountMinor, 12345);
});
test('Yandex snapshot file bounded, atomic reader rejects malformed and symlink; missing is optional', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'yandex-balance-'));
  try {
    const file = join(dir, 'snapshot.json');
    assert.equal(await readYandexBrowserBalance(file), null); assert.equal(await readYandexBrowserBalance(), null);
    const fresh = { ...input(), createdAt: new Date(Date.now()-1000).toISOString(), lastAttemptAt: new Date().toISOString(), lastSuccessAt: new Date().toISOString() };
    await writeFile(file, JSON.stringify(fresh)); assert.equal((await readYandexBrowserBalance(file))?.accounts?.[0].amountMinor, 12345);
    await writeFile(file, '{broken'); assert.equal((await readYandexBrowserBalance(file))?.state, 'error');
    await writeFile(file, ' '.repeat(16385)); assert.equal((await readYandexBrowserBalance(file))?.accounts, undefined);
    await symlink(file, join(dir, 'link')); assert.equal((await readYandexBrowserBalance(join(dir, 'link')))?.state, 'error');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
