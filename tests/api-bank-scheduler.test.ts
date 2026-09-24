import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSnapshot } from '../server/local-api';
import { OperationsStore } from '../server/operations-store';
import { dispatchBanks } from '../server/banking/scheduler';
import { BANK_SYNC_INTERVAL_MS, syncDue } from '../server/banking/schedule';
import { BankHttpError, type BankRequest } from '../server/banking/transport';
import type { SberRequest } from '../server/banking/sber-client';
import { emptyBanking, today } from '../server/banking/domain';
import { emptySber } from '../server/banking/sber-domain';
import { accountNumber, fixtureEnvironment } from './banking-fixtures';

const environment = () => ({ ...fixtureEnvironment,
  ARTEL_BANK_TBANK_NK_ACCOUNTS: JSON.stringify([{ number: accountNumber, currency: 'RUB' }]),
  ARTEL_BANK_SBER_NK_CLIENT_ID: 'fixture-client', ARTEL_BANK_SBER_NK_CLIENT_SECRET: 'fixture-secret',
  ARTEL_BANK_SBER_NK_ACCESS_TOKEN: 'fixture-access', ARTEL_BANK_SBER_NK_REFRESH_TOKEN: 'fixture-refresh',
  ARTEL_BANK_SBER_NK_TLS_PFX_BASE64: 'fixture-pfx', ARTEL_BANK_SBER_NK_TLS_PASSPHRASE: 'fixture-pass', ARTEL_BANK_SBER_NK_TLS_CA_BASE64: 'fixture-ca',
  ARTEL_BANK_ENCRYPTION_KEY: 'ab'.repeat(32),
});
const noTransactions: BankRequest = async () => ({ operations: [] });
const sberEmpty: SberRequest = async (_env, request) => {
  const zero = { amount: '0', currencyName: 'RUR' };
  return request.path.endsWith('/summary') ? { openingBalance: zero, closingBalance: zero, creditTurnover: zero, debitTurnover: zero } : { transactions: [], _links: [] };
};
async function fixture(connected = true) {
  const directory = await mkdtemp(join(tmpdir(), 'artel-bank-scheduler-')), store = new OperationsStore(directory), source = (await loadSnapshot()).provenance.sourceSha256;
  const now = Date.now(), prior = new Date(now - BANK_SYNC_INTERVAL_MS).toISOString();
  await store.mutate(source, data => {
    data.banking = emptyBanking(); data.banking.connections['tbank-nk-artel'] = { accounts: [{ number: accountNumber, currency: 'RUB' }], ...(connected ? { lastSuccessAt: prior } : {}) };
    data.sber = { ...emptySber(), ...(connected ? { lastSuccessAt: prior } : {}) };
    return { result: null, changed: true };
  });
  return { store, source, now, env: environment(), close: () => rm(directory, { recursive: true, force: true }) };
}

test('Five-minute cadence waits for the boundary and requires a successful first connection', () => {
  const now = Date.now(), previous = new Date(now - BANK_SYNC_INTERVAL_MS).toISOString();
  assert.equal(syncDue(undefined, undefined, now), false);
  assert.equal(syncDue(undefined, previous, now - 1), false);
  assert.equal(syncDue(undefined, previous, now), true);
  assert.equal(syncDue(new Date(now).toISOString(), previous, now), false);
});

test('Disabled, unconfigured and never-synchronized banks make no scheduled requests', async () => {
  const f = await fixture(false); let calls = 0;
  const bank: BankRequest = async () => { calls++; return { operations: [] }; };
  const sber: SberRequest = async (...args) => { calls++; return sberEmpty(...args); };
  try {
    assert.equal((await dispatchBanks(f.store, f.source, { ...f.env, ARTEL_BANK_SYNC_ENABLED: 'false' }, bank, sber)).enabled, false);
    await dispatchBanks(f.store, f.source, { ARTEL_BANK_SYNC_ENABLED: 'true' }, bank, sber);
    await dispatchBanks(f.store, f.source, f.env, bank, sber);
    assert.equal(calls, 0);
    assert.equal((await f.store.read(f.source)).sber!.job, undefined);
  } finally { await f.close(); }
});

test('Both banks start on the same cycle, finish durable jobs and wait until the next five-minute boundary', async () => {
  const f = await fixture(); const bankDates: string[] = [], sberDates: string[] = [];
  const bank: BankRequest = async (config, path, token) => { bankDates.push(new URL(path, 'https://bank.test').searchParams.get('from')!); return noTransactions(config, path, token); };
  const sber: SberRequest = async (env, request) => { if (request.path.endsWith('/summary')) sberDates.push(request.query!.statementDate); return sberEmpty(env, request); };
  try {
    await dispatchBanks(f.store, f.source, f.env, bank, sber, f.now - 1);
    assert.equal(bankDates.length + sberDates.length, 0);
    const first = await dispatchBanks(f.store, f.source, f.env, bank, sber, f.now);
    assert.deepEqual(first.connections.map(row => row.id), ['tbank-nk-artel', 'sber-nk-artel', 'sber-artel']);
    assert.equal(bankDates.length, 1); assert.equal(sberDates.length, 1);
    const started = await f.store.read(f.source);
    assert.equal(started.banking!.connections['tbank-nk-artel'].lastScheduledAt, new Date(f.now).toISOString());
    assert.equal(started.sber!.lastScheduledAt, new Date(f.now).toISOString());
    for (let page = 1; page < 7; page++) await dispatchBanks(f.store, f.source, f.env, bank, sber, f.now);
    const complete = await f.store.read(f.source);
    assert.equal(complete.sber!.job, undefined); assert.equal(complete.banking!.connections['tbank-nk-artel'].job, undefined);
    assert.equal(complete.sber!.lastCompletedPeriod!.to, today());
    assert.equal(new Set(bankDates).size, 7); assert.equal(new Set(sberDates).size, 7);
    const before = bankDates.length + sberDates.length;
    await dispatchBanks(f.store, f.source, f.env, bank, sber, f.now + BANK_SYNC_INTERVAL_MS - 1);
    assert.equal(bankDates.length + sberDates.length, before);
    await dispatchBanks(f.store, f.source, f.env, bank, sber, f.now + BANK_SYNC_INTERVAL_MS);
    assert.equal(bankDates.length + sberDates.length, before + 2);
    assert.deepEqual(complete.shipments, started.shipments); assert.deepEqual(complete.paymentAllocations, started.paymentAllocations);
  } finally { await f.close(); }
});

test('A fatal T-Bank error does not stop Sber, and retry delays are preserved', async () => {
  const f = await fixture(); let bankCalls = 0, sberCalls = 0;
  const bank: BankRequest = async () => { bankCalls++; throw new BankHttpError(403); };
  const sber: SberRequest = async (...args) => { sberCalls++; return sberEmpty(...args); };
  try {
    const first = await dispatchBanks(f.store, f.source, f.env, bank, sber, f.now);
    assert.equal(first.failed, true); assert.equal(bankCalls, 1); assert.equal(sberCalls, 2);
    await dispatchBanks(f.store, f.source, f.env, bank, sber, f.now);
    assert.equal(bankCalls, 1); assert.equal(sberCalls, 4);
    await f.store.mutate(f.source, data => { data.sber!.job!.nextAttemptAt = new Date(Date.now() + 60_000).toISOString(); return { result: null, changed: true }; });
    await dispatchBanks(f.store, f.source, f.env, bank, sber, f.now);
    assert.equal(bankCalls, 1); assert.equal(sberCalls, 4);
    assert.equal((await f.store.read(f.source)).banking!.connections['tbank-nk-artel'].job!.attempts, 5);
  } finally { await f.close(); }
});
