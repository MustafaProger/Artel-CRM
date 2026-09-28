import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSnapshot } from '../server/local-api';
import { OperationsStore } from '../server/operations-store';
import { dispatchBanks } from '../server/banking/scheduler';
import { BANK_SYNC_INTERVAL_MS, BANK_SYNC_RETRY_COOLDOWN_MS, syncDue } from '../server/banking/schedule';
import { BankHttpError, type BankRequest } from '../server/banking/transport';
import { SberHttpError, type SberRequest } from '../server/banking/sber-client';
import { SberService } from '../server/banking/sber-service';
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
  return { directory, store, source, now, env: environment(), close: () => rm(directory, { recursive: true, force: true }) };
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

test('server dispatch survives extended bank outages and a restart without any browser or manual resume', async () => {
  const f = await fixture(); let bankCalls = 0, sberCalls = 0, failing = true;
  const bank: BankRequest = async (...args) => { bankCalls++; if (failing) throw new BankHttpError(503); return noTransactions(...args); };
  const sber: SberRequest = async (...args) => { sberCalls++; if (failing) throw new SberHttpError(503); return sberEmpty(...args); };
  try {
    // Save a fully confirmed period before the next scheduled cycle meets an outage.
    for (let day = 0; day < 7; day++) await dispatchBanks(f.store, f.source, f.env, noTransactions, sberEmpty, f.now);
    const confirmed = await f.store.read(f.source);
    await f.store.mutate(f.source, data => {
      data.banking!.connections['tbank-nk-artel'].lastScheduledAt = new Date(0).toISOString();
      data.sber!.lastScheduledAt = new Date(0).toISOString();
      return { result: null, changed: true };
    });
    for (let attempt = 1; attempt <= 6; attempt++) {
      const before = Date.now();
      await dispatchBanks(new OperationsStore(f.directory), f.source, f.env, bank, sber);
      assert.equal(bankCalls, attempt); assert.equal(sberCalls, attempt);
      const state = await f.store.read(f.source);
      for (const job of [state.sber!.job!, state.banking!.connections['tbank-nk-artel'].job!]) {
        assert.equal(job.attempts, Math.min(5, attempt));
        assert.ok(Date.parse(job.nextAttemptAt!) >= before + (attempt >= 5 ? BANK_SYNC_RETRY_COOLDOWN_MS : 5_000 * 2 ** attempt));
      }
      assert.deepEqual(state.sber!.days, confirmed.sber!.days);
      assert.deepEqual(state.sber!.operations, confirmed.sber!.operations);
      assert.deepEqual(state.banking!.operations, confirmed.banking!.operations);
      assert.equal(state.sber!.lastSuccessAt, confirmed.sber!.lastSuccessAt);
      // Recreating storage and dispatching again cannot skip a saved cooldown.
      await dispatchBanks(new OperationsStore(f.directory), f.source, f.env, bank, sber);
      assert.equal(bankCalls, attempt); assert.equal(sberCalls, attempt);
      await f.store.mutate(f.source, data => {
        data.banking!.connections['tbank-nk-artel'].job!.nextAttemptAt = new Date(0).toISOString();
        data.sber!.job!.nextAttemptAt = new Date(0).toISOString();
        return { result: null, changed: true };
      });
    }
    failing = false;
    for (let day = 0; day < 7; day++) await dispatchBanks(new OperationsStore(f.directory), f.source, f.env, bank, sber);
    const recovered = await f.store.read(f.source);
    assert.equal(recovered.sber!.job, undefined);
    assert.equal(recovered.banking!.connections['tbank-nk-artel'].job, undefined);
    assert.equal(recovered.sber!.lastError, undefined);
    assert.equal(recovered.banking!.connections['tbank-nk-artel'].lastError, undefined);
    assert.equal(recovered.sber!.lastCompletedPeriod!.to, today());
    assert.deepEqual(recovered.shipments, confirmed.shipments);
    assert.deepEqual(recovered.paymentAllocations, confirmed.paymentAllocations);
  } finally { await f.close(); }
});

test('HTTP 408 remains retryable while access and TLS failures remain stopped', async () => {
  for (const status of [408, 403, 495]) {
    const f = await fixture(); let calls = 0;
    const bank: BankRequest = async () => { calls++; throw new BankHttpError(status); };
    const sber: SberRequest = async () => { calls++; throw new SberHttpError(status); };
    try {
      await dispatchBanks(f.store, f.source, f.env, bank, sber, f.now);
      const state = await f.store.read(f.source);
      for (const job of [state.sber!.job!, state.banking!.connections['tbank-nk-artel'].job!]) {
        assert.equal(job.attempts, status === 408 ? 1 : 5);
        assert.equal(!!job.nextAttemptAt, status === 408);
      }
      await dispatchBanks(f.store, f.source, f.env, bank, sber, f.now);
      assert.equal(calls, 2);
      if (status !== 408) {
        await dispatchBanks(new OperationsStore(f.directory), f.source, f.env, bank, sber, f.now + 86400000);
        assert.equal(calls, 2, 'time and restart cannot rearm a permanent failure');
      }
    } finally { await f.close(); }
  }
});

test('bank Retry-After remains authoritative when an exhausted job enters its cooldown', async () => {
  const f = await fixture();
  try {
    await dispatchBanks(f.store, f.source, f.env, noTransactions, sberEmpty, f.now);
    await f.store.mutate(f.source, data => {
      data.banking!.connections['tbank-nk-artel'].job!.attempts = 4;
      data.sber!.job!.attempts = 4;
      return { result: null, changed: true };
    });
    const before = Date.now();
    await dispatchBanks(f.store, f.source, f.env, async () => { throw new BankHttpError(429, 3600); }, async () => { throw new SberHttpError(429, 3600); });
    const state = await f.store.read(f.source);
    for (const job of [state.sber!.job!, state.banking!.connections['tbank-nk-artel'].job!]) assert.ok(Date.parse(job.nextAttemptAt!) >= before + 3600_000);
  } finally { await f.close(); }
});

test('repeated malformed bank responses still exhaust the retry budget and preserve saved data', async () => {
  const f = await fixture(); let calls = 0;
  const bank: BankRequest = async () => { calls++; return { operations: 'invalid' }; };
  const sber: SberRequest = async () => { calls++; return []; };
  try {
    for (let day = 0; day < 7; day++) await dispatchBanks(f.store, f.source, f.env, noTransactions, sberEmpty, f.now);
    const confirmed = await f.store.read(f.source);
    await f.store.mutate(f.source, data => {
      data.banking!.connections['tbank-nk-artel'].lastScheduledAt = new Date(0).toISOString();
      data.sber!.lastScheduledAt = new Date(0).toISOString();
      return { result: null, changed: true };
    });
    for (let attempt = 1; attempt <= 5; attempt++) {
      await dispatchBanks(f.store, f.source, f.env, bank, sber);
      if (attempt < 5) await f.store.mutate(f.source, data => {
        data.banking!.connections['tbank-nk-artel'].job!.nextAttemptAt = new Date(0).toISOString();
        data.sber!.job!.nextAttemptAt = new Date(0).toISOString();
        return { result: null, changed: true };
      });
    }
    const stopped = await f.store.read(f.source);
    for (const job of [stopped.sber!.job!, stopped.banking!.connections['tbank-nk-artel'].job!]) {
      assert.equal(job.attempts, 5); assert.equal(job.nextAttemptAt, undefined);
    }
    await dispatchBanks(new OperationsStore(f.directory), f.source, f.env, bank, sber, Date.now() + 86400000);
    assert.equal(calls, 10);
    assert.deepEqual(stopped.sber!.days, confirmed.sber!.days);
    assert.deepEqual(stopped.sber!.operations, confirmed.sber!.operations);
    assert.deepEqual(stopped.banking!.operations, confirmed.banking!.operations);
  } finally { await f.close(); }
});

test('Sber rechecks a concurrent retry delay or permanent stop after acquiring its lease', async () => {
  for (const stopped of [false, true]) {
    const f = await fixture(); let calls = 0;
    try {
      await new SberService(f.store, f.source, f.env, sberEmpty).start(today(), today());
      let race = true;
      const service = new SberService({
        read: source => f.store.read(source),
        mutate: async (source, update) => {
          if (race) {
            race = false;
            await f.store.mutate(source, data => {
              const job = data.sber!.job!;
              if (stopped) job.attempts = 5;
              else job.nextAttemptAt = new Date(Date.now() + 60_000).toISOString();
              return { result: null, changed: true };
            });
          }
          return f.store.mutate(source, update);
        },
      }, f.source, f.env, async (...args) => { calls++; return sberEmpty(...args); });
      await service.tick();
      assert.equal(calls, 0);
      assert.equal((await f.store.read(f.source)).sber!.lease, undefined);
    } finally { await f.close(); }
  }
});
