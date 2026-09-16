import assert from 'node:assert/strict';
import { test } from 'node:test';
import { emptyBanking, operationId, validateBanking } from '../server/banking/domain';
import { replaceStatementDay } from '../server/banking/statement-publication';
import type { BankAccount, BankingData, BankOperation } from '../web/src/banking-model';

const account: BankAccount = { number: '40702810000000000001', currency: 'RUB' };
const otherAccount: BankAccount = { number: '40702810000000000002', currency: 'RUB' };
const day = '2026-09-01', syncedAt = '2026-09-02T12:00:00.000Z';
function operation(id = 'payment', amount = '10', connectionId = 'tbank-nk-artel', ownAccount = account, statementDate = day): BankOperation {
  return { id: operationId(connectionId, ownAccount.number, id), connectionId, provider: connectionId.startsWith('sber-') ? 'sber' : 'tbank', bankOperationId: id, account: ownAccount.number, statementDate, amount, currency: 'RUB', direction: 'incoming', booked: true, payer: { inn: '7707083893' }, payee: { inn: '5050140563' }, bankData: {}, updatedAt: syncedAt, source: 'statement-api', counterpartyId: null, allocations: [], importedSourceIds: [] };
}
const coverage = (data: BankingData, connection = 'tbank-nk-artel') => data.connections[connection].settlementVerifiedDays;

test('complete day publication is idempotent and records exact coverage without mutating input rows', () => {
  const data = emptyBanking(), row = operation();
  replaceStatementDay(data, 'tbank-nk-artel', account, day, [row], syncedAt);
  assert.deepEqual(data.operations, [row]);
  assert.deepEqual(coverage(data), [{ account: account.number, date: day, syncedAt }]);
  assert.deepEqual(data.connections['tbank-nk-artel'].accounts, [account]);
  const published = structuredClone(data);
  replaceStatementDay(data, 'tbank-nk-artel', account, day, [row], syncedAt);
  assert.deepEqual(data, published);
  row.amount = '999'; row.payer.inn = '7736050003';
  assert.equal(data.operations[0].amount, '10');
  assert.equal(data.operations[0].payer.inn, '7707083893');
  assert.doesNotThrow(() => validateBanking(data));
});

test('replacement updates corrected amounts and archives removed identities once', () => {
  const data = emptyBanking(), first = operation('first', '10'), removed = operation('removed', '20');
  replaceStatementDay(data, 'tbank-nk-artel', account, day, [first, removed], syncedAt);
  const nextSync = '2026-09-03T15:30:00Z', changed = { ...first, amount: '12.34' }, replacement = operation('new-bank-id', '20');
  replaceStatementDay(data, 'tbank-nk-artel', account, day, [changed, replacement], nextSync);
  assert.deepEqual(data.operations, [changed, replacement]);
  assert.deepEqual(data.archivedOperations, [removed]);
  assert.deepEqual(coverage(data), [{ account: account.number, date: day, syncedAt: nextSync }]);
  replaceStatementDay(data, 'tbank-nk-artel', account, day, [changed, replacement], nextSync);
  assert.equal(data.archivedOperations!.length, 1);
});

test('empty completed day removes prior operations and still records a verified day', () => {
  const data = emptyBanking(), row = operation();
  data.operations = [row];
  replaceStatementDay(data, 'tbank-nk-artel', account, day, [], syncedAt);
  assert.deepEqual(data.operations, []);
  assert.deepEqual(data.archivedOperations, [row]);
  assert.deepEqual(coverage(data), [{ account: account.number, date: day, syncedAt }]);
  replaceStatementDay(data, 'tbank-nk-artel', account, day, [], syncedAt);
  assert.equal(data.archivedOperations!.length, 1);
});

test('same bank operation ID in other accounts or connections and records of other days remain untouched', () => {
  const data = emptyBanking();
  const target = operation('shared'), otherSource = operation('shared', '20', 'sber-artel'), otherOwnAccount = operation('shared', '30', 'tbank-nk-artel', otherAccount), otherDay = operation('different-day', '40', 'tbank-nk-artel', account, '2026-09-02');
  data.operations = [target, otherSource, otherOwnAccount, otherDay];
  replaceStatementDay(data, 'tbank-nk-artel', account, day, [], syncedAt);
  assert.deepEqual(data.operations, [otherSource, otherOwnAccount, otherDay]);
  assert.deepEqual(data.archivedOperations, [target]);
  assert.deepEqual(coverage(data), [{ account: account.number, date: day, syncedAt }]);
  assert.equal(data.connections['sber-artel'], undefined);
});

test('publishing a third connector verifies only the replaced account/day and leaves legacy days unverified', () => {
  const data = emptyBanking(), existing = operation('legacy', '10', 'sber-artel'), untouched = operation('older', '20', 'sber-artel', account, '2026-08-31'), differentAccount = operation('another-account', '30', 'sber-artel', otherAccount);
  data.operations = [existing, untouched, differentAccount];
  data.connections['sber-artel'] = { accounts: [otherAccount] };
  const current = operation('fresh', '12', 'sber-artel');
  replaceStatementDay(data, 'sber-artel', account, day, [current], syncedAt);
  assert.deepEqual(data.operations, [untouched, differentAccount, current]);
  assert.deepEqual(coverage(data, 'sber-artel'), [{ account: account.number, date: day, syncedAt }]);
  assert.deepEqual(data.connections['sber-artel'].accounts, [otherAccount, account]);
  assert.deepEqual(data.archivedOperations, [existing]);
});

test('publication preserves connection, state and sync-job references held by the caller', () => {
  const data = emptyBanking();
  data.connections['tbank-nk-artel'] = { accounts: [account], job: { id: 'job', from: day, to: '2026-09-02', day, accountIndex: 0, accounts: [account], startedAt: syncedAt, pages: 0, attempts: 0 }, lease: { id: 'fence', until: Date.now() + 30000 } };
  const connections = data.connections, state = connections['tbank-nk-artel'], job = state.job;
  replaceStatementDay(data, 'tbank-nk-artel', { ...account, name: 'Updated account' }, day, [operation()], syncedAt);
  assert.equal(data.connections, connections);
  assert.equal(data.connections['tbank-nk-artel'], state);
  assert.equal(state.job, job);
  job!.day = '2026-09-02';
  assert.equal(data.connections['tbank-nk-artel'].job!.day, '2026-09-02');
  assert.equal(state.accounts.length, 1);
  assert.equal(state.accounts[0].name, 'Updated account');
});

test('currency aliases are accepted while a different account currency is rejected atomically', () => {
  for (const code of ['RUB', 'RUR', '643', '810']) {
    const data = emptyBanking();
    replaceStatementDay(data, 'tbank-nk-artel', { ...account, currency: code }, day, [operation()], syncedAt);
    assert.equal(data.operations.length, 1);
  }
  const data = emptyBanking();
  assert.throws(() => replaceStatementDay(data, 'tbank-nk-artel', { ...account, currency: 'USD' }, day, [operation()], syncedAt));
  assert.deepEqual(data, emptyBanking());
});

test('invalid complete-day inputs fail before changing operations, archive, accounts or coverage', async t => {
  const cases: [string, (data: BankingData) => void][] = [
    ['unknown connection', data => replaceStatementDay(data, 'unknown-bank', account, day, [operation()], syncedAt)],
    ['invalid account', data => replaceStatementDay(data, 'tbank-nk-artel', { ...account, number: '123' }, day, [], syncedAt)],
    ['impossible date', data => replaceStatementDay(data, 'tbank-nk-artel', account, '2026-02-31', [], syncedAt)],
    ['invalid timestamp', data => replaceStatementDay(data, 'tbank-nk-artel', account, day, [], 'not-a-time')],
    ['duplicate operation', data => replaceStatementDay(data, 'tbank-nk-artel', account, day, [operation(), operation()], syncedAt)],
    ['wrong provider', data => replaceStatementDay(data, 'tbank-nk-artel', account, day, [{ ...operation(), provider: 'sber' }], syncedAt)],
    ['wrong connection', data => replaceStatementDay(data, 'tbank-nk-artel', account, day, [operation('new', '10', 'sber-artel')], syncedAt)],
    ['wrong account', data => replaceStatementDay(data, 'tbank-nk-artel', account, day, [operation('new', '10', 'tbank-nk-artel', otherAccount)], syncedAt)],
    ['wrong day', data => replaceStatementDay(data, 'tbank-nk-artel', account, day, [operation('new', '10', 'tbank-nk-artel', account, '2026-09-02')], syncedAt)],
    ['forged identity', data => replaceStatementDay(data, 'tbank-nk-artel', account, day, [{ ...operation(), id: 'wrong-id' }], syncedAt)],
    ['negative amount', data => replaceStatementDay(data, 'tbank-nk-artel', account, day, [operation('new', '-1')], syncedAt)],
    ['numeric amount', data => replaceStatementDay(data, 'tbank-nk-artel', account, day, [operation('new', 1 as unknown as string)], syncedAt)],
    ['foreign currency', data => replaceStatementDay(data, 'tbank-nk-artel', account, day, [{ ...operation(), currency: 'USD' }], syncedAt)],
    ['malformed bank party', data => replaceStatementDay(data, 'tbank-nk-artel', account, day, [{ ...operation(), payer: [] }], syncedAt)],
    ['invalid booked flag', data => replaceStatementDay(data, 'tbank-nk-artel', account, day, [{ ...operation(), booked: 'true' as unknown as boolean }], syncedAt)],
    ['non-array rows', data => replaceStatementDay(data, 'tbank-nk-artel', account, day, null as unknown as BankOperation[], syncedAt)],
    ['identity active on another day', data => replaceStatementDay(data, 'tbank-nk-artel', account, day, [operation('other-day')], syncedAt)],
  ];
  for (const [name, attempt] of cases) await t.test(name, () => {
    const data = emptyBanking();
    data.operations = [operation('existing'), operation('other-day', '20', 'tbank-nk-artel', account, '2026-09-02')];
    data.archivedOperations = [operation('already-archived')];
    data.connections['tbank-nk-artel'] = { accounts: [account], settlementVerifiedDays: [{ account: account.number, date: '2026-08-31', syncedAt }] };
    const before = structuredClone(data);
    assert.throws(() => attempt(data));
    assert.deepEqual(data, before);
  });
});

test('verified-day schema is optional for legacy data and strict about types, account/day identity and timestamps', () => {
  const legacy = emptyBanking();
  legacy.operations = [operation('legacy', '10', 'sber-artel')];
  legacy.connections['sber-artel'] = { accounts: [account] };
  assert.doesNotThrow(() => validateBanking(legacy));
  const valid = { account: account.number, date: day, syncedAt };
  const invalid = [null, {}, 'day', [null], [{ ...valid, account: '123' }], [{ ...valid, account: 12345 }], [{ ...valid, date: '2026-02-31' }], [{ ...valid, date: 20260901 }], [{ ...valid, syncedAt: '' }], [{ ...valid, syncedAt: '2026-02-31T12:00:00Z' }], [{ ...valid, syncedAt: '2026-09-02T12:00:00' }], [valid, valid]];
  for (const rows of invalid) {
    const data = structuredClone(legacy);
    data.connections['sber-artel'].settlementVerifiedDays = rows as never;
    assert.throws(() => validateBanking(data), JSON.stringify(rows));
  }
  legacy.connections['sber-artel'].settlementVerifiedDays = [valid, { ...valid, date: '2026-09-02' }, { ...valid, account: otherAccount.number }];
  assert.doesNotThrow(() => validateBanking(legacy));
});

test('account lists reject duplicate numbers and malformed entries, including sync-job accounts', () => {
  for (const accounts of [[account, account], [{ ...account, currency: 643 }], [null]]) {
    const data = emptyBanking();
    data.connections['tbank-nk-artel'] = { accounts: accounts as never };
    assert.throws(() => validateBanking(data));
  }
  const data = emptyBanking();
  data.connections['tbank-nk-artel'] = { accounts: [account], job: { id: 'job', from: day, to: day, day, accountIndex: 0, accounts: [account, account], startedAt: syncedAt, pages: 0, attempts: 0 } };
  assert.throws(() => validateBanking(data));
});
