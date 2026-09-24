import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OperationsStore } from '../server/operations-store';
import { loadSnapshot } from '../server/local-api';
import { SberService } from '../server/banking/sber-service';
import { sberConnections } from '../server/banking/sber-connections';
import { decryptSberTokens, emptySber, normalizeSberOperation, parseSberPage } from '../server/banking/sber-domain';
import { SberHttpError, type SberRequest } from '../server/banking/sber-client';
import { settlementSources } from '../server/settlement-sources';
import { dispatchBanks } from '../server/banking/scheduler';
import { BANK_SYNC_INTERVAL_MS } from '../server/banking/schedule';

const artel = sberConnections['sber-artel'], nk = sberConnections['sber-nk-artel'], day = '2026-09-23';
const money = (amount: string) => ({ amount, currencyName: 'RUB' });
const summary = (incoming = '0.3') => ({ openingBalance: money('0'), creditTurnover: money(incoming), debitTurnover: money('0'), closingBalance: money(incoming) });
const row = (account: string, id = 'same-bank-id', amount = '0.3') => ({ operationId: id, direction: 'CREDIT', amount: money(amount), operationDate: day, rurTransfer: { payeeAccount: account, payerInn: '7700000001' } });
function environment() {
  return { ARTEL_BANK_ENCRYPTION_KEY: 'ab'.repeat(32), ...Object.fromEntries(Object.values(sberConnections).flatMap(c => ['CLIENT_ID','CLIENT_SECRET','TLS_PFX_BASE64','TLS_PASSPHRASE','TLS_CA_BASE64','ACCESS_TOKEN','REFRESH_TOKEN'].map(key => [`${c.prefix}_${key}`, `${c.id}-${key}`]))) };
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'artel-two-sber-')), store = new OperationsStore(directory), source = (await loadSnapshot()).provenance.sourceSha256;
  return { store, source, env: environment(), close: () => rm(directory, { recursive: true, force: true }) };
}

test('two Sber connections rotate only their own pair, encrypt for their own account and survive restart', async () => {
  const f = await fixture();
  const refreshed: string[] = [];
  const request: SberRequest = async (_env, options, prefix) => {
    const c = Object.values(sberConnections).find(c => c.prefix === prefix)!;
    assert.ok(c);
    if (options.form) {
      assert.equal(options.form.client_id, `${c.id}-CLIENT_ID`);
      assert.equal(options.form.client_secret, `${c.id}-CLIENT_SECRET`);
      assert.equal(options.form.refresh_token, `${c.id}-REFRESH_TOKEN`);
      refreshed.push(c.id);
      return { access_token: `${c.id}-new-access`, refresh_token: `${c.id}-new-refresh`, expires_in: '3600' };
    }
    assert.equal(options.query?.accountNumber, c.account);
    if (options.accessToken === `${c.id}-ACCESS_TOKEN`) throw new SberHttpError(401);
    const saved = (await f.store.read(f.source))[c.slot]!;
    assert.equal(decryptSberTokens(saved.encryptedTokens!, f.env, c).refreshToken, `${c.id}-new-refresh`, 'saved before the next statement request');
    return options.path.endsWith('/summary') ? summary() : { transactions: [row(c.account)], _links: [] };
  };
  try {
    const services = Object.values(sberConnections).map(c => new SberService(f.store, f.source, f.env, request, c));
    await Promise.all(services.map(s => s.start(day, day)));
    await Promise.all(services.map(s => s.tick()));
    const saved = await f.store.read(f.source);
    assert.deepEqual(refreshed.sort(), ['sber-artel','sber-nk-artel']);
    assert.notEqual(saved.sber!.operations[0].id, saved.sberArtel!.operations[0].id);
    assert.throws(() => decryptSberTokens(saved.sberArtel!.encryptedTokens!, f.env, nk));
    assert.throws(() => decryptSberTokens(saved.sber!.encryptedTokens!, f.env, artel));
    assert.equal(saved.banking!.connections[artel.id].settlementVerifiedDays!.length, 1);
    assert.equal(settlementSources(saved).operations.length, 2);
    assert.ok(!(await readFile(f.store.path, 'utf8')).includes('new-refresh'));
    const restarted = new SberService(new OperationsStore(f.store.path.replace('/operations.json','')), f.source, f.env, request, artel);
    await restarted.start(day, day); await restarted.tick();
    assert.equal(refreshed.length, 2);
    assert.equal((await f.store.read(f.source)).banking!.operations.length, 1);
  } finally { await f.close(); }
});

test('ARTEL pagination publishes atomically; failed pages, partial totals and another account retain confirmed data and allocations', async () => {
  const f = await fixture(); let mode = 'complete';
  const request: SberRequest = async (_env, options) => {
    if (options.path.endsWith('/summary')) return mode === 'partial' ? {} : summary();
    if (options.path.endsWith('/transactionId')) return { ...row(artel.account, 'one', '0.1'), paymentPurpose: 'Verified full purpose' };
    if (mode === 'wrong-account') return { transactions: [row(nk.account)], _links: [] };
    if (mode === 'empty') return { transactions: [], _links: [] };
    if (options.query?.page === '1') return { transactions: [row(artel.account, 'one', '0.1')], _links: [{ rel: 'next', href: `?page=2&accountNumber=${artel.account}&statementDate=${day}` }] };
    if (mode === 'failed-page') throw new SberHttpError(403);
    return { transactions: [row(artel.account, 'two', '0.2')], _links: [] };
  };
  const service = new SberService(f.store, f.source, f.env, request, artel);
  try {
    await service.start(day, day); await service.tick();
    assert.equal((await f.store.read(f.source)).banking, undefined);
    await service.tick();
    await f.store.mutate(f.source, data => {
      data.banking!.operations[0].counterpartyId = 'manual-company';
      data.banking!.operations[0].allocations = [{ documentId: 'manual-invoice', documentType: 'invoice', amount: '0.1' }];
      return { changed: true, result: null };
    });
    const before = await f.store.read(f.source);
    for (mode of ['failed-page','partial','wrong-account','empty']) {
      await service.start(day, day); await service.tick(); await service.tick();
      const state = await f.store.read(f.source);
      assert.ok(state.sberArtel!.lastError, mode);
      assert.deepEqual(state.banking, before.banking, mode);
      assert.deepEqual(state.sberArtel!.operations, before.sberArtel!.operations, mode);
      assert.deepEqual(state.paymentAllocations, before.paymentAllocations);
    }
    mode = 'complete'; await service.start(day, day); await service.tick(); await service.tick();
    const after = await f.store.read(f.source);
    assert.equal(after.banking!.operations.length, 2);
    assert.deepEqual(after.banking!.operations[0].allocations, before.banking!.operations[0].allocations);
    assert.equal(after.banking!.operations[0].counterpartyId, 'manual-company');
    assert.equal(after.banking!.connections[artel.id].settlementVerifiedDays!.length, 1);
    assert.deepEqual(after.shipments, before.shipments);
    await service.enrich(after.sberArtel!.operations[0].id);
    const enriched = await f.store.read(f.source);
    assert.equal(enriched.banking!.operations[0].purpose, 'Verified full purpose');
    assert.deepEqual(enriched.banking!.operations[0].allocations, before.banking!.operations[0].allocations);
  } finally { await f.close(); }
});

test('Sber identities cannot cross accounts, page links, storage slots or operation details', async () => {
  assert.throws(() => normalizeSberOperation(row(nk.account), day, artel));
  assert.throws(() => parseSberPage({ transactions: [], _links: [{ rel: 'next', href: `?page=2&accountNumber=${nk.account}` }] }, day, 1, artel));
  const f = await fixture();
  try {
    await assert.rejects(f.store.mutate(f.source, data => { data.sberArtel = emptySber(nk); return { result: null, changed: true }; }));
    const request: SberRequest = async (_env, options) => options.path.endsWith('/summary') ? summary() : { transactions: [row(artel.account)], _links: [] };
    const a = new SberService(f.store, f.source, f.env, request, artel), n = new SberService(f.store, f.source, f.env, request, nk);
    await a.start(day, day); await a.tick();
    const id = (await f.store.read(f.source)).sberArtel!.operations[0].id;
    await assert.rejects(n.operation(id), /не найдена/);
    await assert.rejects(n.enrich(id), /не найдена/);
  } finally { await f.close(); }
});

test('repeated later-page failures exhaust the day retry budget and wait for an explicit retry', async () => {
  const f = await fixture(); let calls = 0, rejectLastPage = true;
  const request: SberRequest = async (_env, options) => {
    calls++;
    if (options.path.endsWith('/summary')) return summary();
    if (options.query?.page === '1') return { transactions: [row(artel.account, 'first-page', '0.1')], _links: [{ rel: 'next', href: '?page=2' }] };
    if (rejectLastPage) throw new SberHttpError(503);
    return { transactions: [row(artel.account, 'last-page', '0.2')], _links: [] };
  };
  const service = new SberService(f.store, f.source, f.env, request, artel);
  try {
    await service.start(day, day);
    for (let attempt = 1; attempt <= 5; attempt++) {
      await service.tick(); await service.tick();
      const state = (await f.store.read(f.source)).sberArtel!;
      assert.equal(state.job!.attempts, attempt);
      assert.equal(state.operations.length, 0, 'partial pages stay unpublished');
      await f.store.mutate(f.source, data => { delete data.sberArtel!.job!.nextAttemptAt; return { result: null, changed: true }; });
    }
    const before = calls;
    await service.tick(); assert.equal(calls, before, 'exhausted jobs do not contact the bank');
    rejectLastPage = false;
    await service.start(day, day); await service.tick(); await service.tick();
    const state = (await f.store.read(f.source)).sberArtel!;
    assert.equal(state.job, undefined); assert.equal(state.operations.length, 2); assert.equal(state.lastError, undefined);
  } finally { await f.close(); }
});

test('ARTEL scheduler progresses while NK is locked or rejected, and its own lease excludes a second caller', async () => {
  const f = await fixture(); let artelCalls = 0;
  const request: SberRequest = async (_env, options, prefix) => {
    if (prefix === nk.prefix) throw new SberHttpError(403);
    artelCalls++;
    return options.path.endsWith('/summary') ? summary('0') : { transactions: [], _links: [] };
  };
  try {
    await f.store.mutate(f.source, data => {
      for (const c of Object.values(sberConnections)) data[c.slot] = { ...emptySber(c), lastSuccessAt: new Date(Date.now() - BANK_SYNC_INTERVAL_MS - 1000).toISOString() };
      data.sber!.lease = { id: 'another-nk-server', until: Date.now() + 60000 };
      return { result: null, changed: true };
    });
    const first = await dispatchBanks(f.store, f.source, { ...f.env, ARTEL_BANK_SYNC_ENABLED: 'true' }, undefined, request);
    assert.equal(first.connections.find(c => c.id === artel.id)!.failed, false);
    assert.equal(artelCalls, 2);
    const s = new SberService(f.store, f.source, f.env, request, artel);
    await Promise.all([s.tick(), s.tick()]);
    assert.equal(artelCalls, 4, 'only one caller requested the next day');
    await f.store.mutate(f.source, data => { delete data.sber!.lease; return { result: null, changed: true }; });
    const next = await dispatchBanks(f.store, f.source, { ...f.env, ARTEL_BANK_SYNC_ENABLED: 'true' }, undefined, request);
    assert.equal(next.connections.find(c => c.id === nk.id)!.failed, true);
    assert.equal(next.connections.find(c => c.id === artel.id)!.failed, false);
    assert.equal(artelCalls, 6);
  } finally { await f.close(); }
});
