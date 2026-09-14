import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { BankingService } from '../server/banking/service';
import { normalizeSber, normalizeTbank, sberAdapter, tbankAdapter } from '../server/banking/adapters';
import { BankHttpError, decryptTokens, encryptTokens, parseBankJson, type BankRequest } from '../server/banking/transport';
import { csv, emptyBanking, totals, upsertOperations } from '../server/banking/domain';
import { OperationsStore } from '../server/operations-store';
import { ApiError } from '../server/api-error';
import { createSnapshotMiddleware, loadSnapshot } from '../server/local-api';
import { currentSnapshot } from '../server/shipment-operations';
import { accountNumber, dollarAccount, fixtureConfig, fixtureDay, fixtureEnvironment, sberRow, tbankRow } from './banking-fixtures';

const basePromise = loadSnapshot();
async function runtime(http: BankRequest) {
  const directory = await mkdtemp(resolve(tmpdir(), 'artel-bank-test-')), store = new OperationsStore(directory), base = await basePromise;
  const service = new BankingService(store, base.provenance.sourceSha256, { ...fixtureEnvironment }, http);
  return { store, service, base, close: () => rm(directory, { recursive: true, force: true }) };
}
const simpleHttp: BankRequest = async (config, path) => path.includes('/oauth/token') ? { access_token: 'fixture-access', refresh_token: 'fixture-rotated', expires_in: '3600' } : config.definition.provider === 'sber' ? { transactions: [sberRow()], _links: [] } : { operations: [tbankRow('tbank-operation-1', '0.1', new URL(path, 'https://bank.test').searchParams.get('accountNumber')!)] };

test('bank decimals never pass through Number; payer/payee and debit/credit direction are preserved', () => {
  const raw = parseBankJson('{"amount":12345678901234567890.123456789,"id":9007199254740993,"text":"abc 12.2", "array":[1,true,null]}') as Record<string, unknown>;
  assert.equal(raw.amount, '12345678901234567890.123456789'); assert.equal(raw.id, '9007199254740993'); assert.equal(raw.text, 'abc 12.2');
  const sber = normalizeSber(fixtureConfig('sber'), { number: accountNumber, currency: 'RUB' }, fixtureDay, sberRow());
  assert.equal(sber.direction, 'outgoing'); assert.ok(sber.payee.name?.includes('КОМПЛЕКС')); assert.ok(sber.payer.name?.includes('АРТЕЛЬ')); assert.equal(sber.status, undefined); assert.equal(sber.vat, undefined);
  const tbank = normalizeTbank(fixtureConfig(), { number: accountNumber, currency: 'RUB' }, fixtureDay, { ...tbankRow(), authorizationDate: '2026-09-14T09:00:00Z' });
  assert.equal(tbank.bankData.authorizationDate, '2026-09-14T09:00:00Z');
  assert.equal(tbank.direction, 'incoming'); assert.equal(tbank.amount, '0.1'); assert.equal(tbank.currency, 'RUB'); assert.equal(tbank.counterpartyId, null); assert.deepEqual(tbank.allocations, []);
  assert.deepEqual(totals([tbank, { ...tbank, amount: '0.2' }, { ...tbank, currency: 'USD', amount: '10' }, { ...tbank, booked: false, amount: '500' }]), [{ currency: 'RUB', incoming: '0.3', outgoing: '0', count: 2 }, { currency: 'USD', incoming: '10', outgoing: '0', count: 1 }]);
  assert.throws(() => normalizeTbank(fixtureConfig(), { number: accountNumber, currency: 'RUB' }, fixtureDay, { ...tbankRow(), typeOfOperation: 'unknown' }));
  const stored = emptyBanking(); upsertOperations(stored, [tbank]);
  upsertOperations(stored, [{ ...tbank, amount: '0.2', purpose: undefined, bankData: {} }]);
  assert.equal(stored.operations.length, 1); assert.equal(stored.operations[0].amount, '0.2'); assert.equal(stored.operations[0].purpose, undefined); assert.deepEqual(stored.operations[0].bankData, {});
});

test('Sber pagination extracts only a validated next page, never following arbitrary credential destinations', async () => {
  const config = fixtureConfig('sber'), account = config.accounts[0];
  const adapter = sberAdapter(async () => ({ transactions: [sberRow()], _links: [{ rel: 'next', href: `?accountNumber=${accountNumber}&statementDate=${fixtureDay}&page=2` }] }));
  assert.equal((await adapter.page(config, 'not-real', account, fixtureDay)).nextCursor, '2');
  await assert.rejects(sberAdapter(async () => ({ transactions: [], _links: [{ rel: 'next', href: `https://evil.test/steal?accountNumber=${accountNumber}&statementDate=${fixtureDay}&page=2` }] })).page(config, 'not-real', account, fixtureDay));
  let captured = '';
  await tbankAdapter(async (_config, path) => { captured = path; return { operations: [] }; }).page(fixtureConfig(), '', account, fixtureDay);
  const params = new URL(captured, 'https://bank.test').searchParams;
  assert.equal(params.get('operationStatus'), 'Transaction'); assert.equal(params.get('from'), '2026-09-13T21:00:00.000Z'); assert.equal(params.get('to'), '2026-09-14T21:00:00.000Z');
});

test('repeat and parallel synchronization is idempotent and leaves shipments, allocations, directories and imported payments unchanged', async () => {
  let requests = 0;
  const r = await runtime(async (...args) => { requests++; await new Promise(resolve => setTimeout(resolve, 10)); return simpleHttp(...args); });
  try {
    const before = await r.store.read(r.base.provenance.sourceSha256), beforeSnapshot = currentSnapshot(r.base, before);
    await r.service.start('sber-nk-artel', fixtureDay, fixtureDay);
    await Promise.all([r.service.tick('sber-nk-artel'), r.service.tick('sber-nk-artel')]);
    assert.equal(requests, 2); // token + one page
    await r.service.start('sber-nk-artel', fixtureDay, fixtureDay); await r.service.tick('sber-nk-artel');
    await r.service.start('sber-artel', fixtureDay, fixtureDay); await r.service.tick('sber-artel');
    const after = await r.store.read(r.base.provenance.sourceSha256), afterSnapshot = currentSnapshot(r.base, after);
    assert.equal(after.banking?.operations.length, 2); assert.notEqual(after.banking!.operations[0].id, after.banking!.operations[1].id);
    assert.deepEqual(after.shipments, before.shipments); assert.deepEqual(after.paymentAllocations, before.paymentAllocations); assert.deepEqual(after.companies, before.companies); assert.deepEqual(after.directories, before.directories);
    assert.deepEqual(afterSnapshot.shipments, beforeSnapshot.shipments); assert.deepEqual(afterSnapshot.payments, beforeSnapshot.payments); assert.deepEqual(afterSnapshot.overview, beforeSnapshot.overview);
    const list = await r.service.list(new URLSearchParams()); assert.ok(list.connections[0].lastSuccessAt); assert.ok(!JSON.stringify(list).includes('fixture-access')); assert.ok(!JSON.stringify(after).includes('fixture-rotated'));
  } finally { await r.close(); }
});

test('partial pages and bank failures retain prior data; retry resumes cursor and replaces a complete day without counting changed IDs twice', async () => {
  let mode = 'first', calls = 0;
  const r = await runtime(async (config, path, token, form) => {
    if (config.definition.provider === 'sber') return simpleHttp(config, path, token, form);
    calls++; const cursor = new URL(path, 'https://bank.test').searchParams.get('cursor');
    if (mode === 'first') return { operations: [tbankRow('original')] };
    if (!cursor) return { operations: [tbankRow('replacement', '3')], nextCursor: 'page2' };
    if (mode === 'error') throw new BankHttpError(503);
    return { operations: [tbankRow('second', '4')] };
  });
  try {
    // One account isolates the pagination scenario.
    r.service.env.ARTEL_BANK_TBANK_NK_ACCOUNTS = JSON.stringify([{ number: accountNumber, currency: 'RUB' }]);
    await r.service.start('tbank-nk-artel', fixtureDay, fixtureDay); await r.service.tick('tbank-nk-artel');
    const firstSuccess = (await r.service.list(new URLSearchParams())).connections[2].lastSuccessAt;
    mode = 'error'; await r.service.start('tbank-nk-artel', fixtureDay, fixtureDay); await r.service.tick('tbank-nk-artel');
    assert.equal((await r.service.rows(new URLSearchParams()))[0].bankOperationId, 'original');
    await r.service.tick('tbank-nk-artel'); const failed = await r.service.list(new URLSearchParams());
    assert.equal(failed.total, 1); assert.equal(failed.connections[2].state, 'error'); assert.equal(failed.connections[2].lastSuccessAt, firstSuccess);
    const before = calls; await r.service.tick('tbank-nk-artel'); assert.equal(calls, before); // backoff
    mode = 'recovered'; await r.service.start('tbank-nk-artel', fixtureDay, fixtureDay); await r.service.tick('tbank-nk-artel');
    const recovered = await r.service.list(new URLSearchParams()); assert.equal(recovered.total, 2); assert.equal(recovered.totals[0].incoming, '7'); assert.equal(recovered.connections[2].lastError, undefined);
    assert.equal((await r.store.read(r.base.provenance.sourceSha256)).banking!.archivedOperations![0].bankOperationId, 'original');
  } finally { r.service.env.ARTEL_BANK_TBANK_NK_ACCOUNTS = fixtureEnvironment.ARTEL_BANK_TBANK_NK_ACCOUNTS; await r.close(); }
});

test('search, statuses, accounts, periods, pagination, per-currency summaries and CSV use the same selection', async () => {
  const r = await runtime(async () => ({ operations: Array.from({length: 31}, (_, i) => tbankRow(`tbank-operation-${i}`, '0.1')) }));
  try {
    await r.service.start('tbank-nk-artel', fixtureDay, fixtureDay); await r.service.tick('tbank-nk-artel');
    const p2 = await r.service.list(new URLSearchParams('page=2&pageSize=10')); assert.equal(p2.total, 31); assert.equal(p2.items.length, 10); assert.equal(p2.totals[0].incoming, '3.1');
    for (const q of ['7812345678','Клиент тестовый','договору','tbank-operation-2']) assert.ok((await r.service.list(new URLSearchParams({ q }))).total > 0);
    assert.equal((await r.service.list(new URLSearchParams({ account: dollarAccount }))).total, 0);
    assert.equal((await r.service.list(new URLSearchParams({ direction: 'outgoing' }))).total, 0);
    assert.equal((await r.service.list(new URLSearchParams({ from: '2026-09-13', to: '2026-09-13' }))).total, 0);
    assert.equal((await r.service.list(new URLSearchParams({ status: 'Transaction' }))).total, 31);
    const query = new URLSearchParams({ q: 'tbank-operation-2' }), selected = await r.service.rows(query), filtered = await r.service.list(query);
    assert.equal(selected.length, filtered.total); assert.equal(csv(selected).split('\r\n').length, filtered.total + 1);
    assert.ok(csv([{ ...selected[0], purpose: '=HYPERLINK("bad")' }]).includes("'=HYPERLINK"));
    await assert.rejects(r.service.list(new URLSearchParams('from=2026-09-15&to=2026-09-14')));
  } finally { await r.close(); }
});

test('bank tokens are authenticated encrypted and bound to each connection; raw secret keys are redacted', () => {
  const encrypted = encryptTokens({ access_token: 'sample-access', refresh_token: 'sample-refresh' }, '1'.repeat(64), 'sber-artel');
  assert.equal(decryptTokens(encrypted, '1'.repeat(64), 'sber-artel').refresh_token, 'sample-refresh'); assert.throws(() => decryptTokens(encrypted, '1'.repeat(64), 'sber-nk-artel'));
  const row = normalizeSber(fixtureConfig('sber'), { number: accountNumber, currency: 'RUB' }, fixtureDay, { ...sberRow(), access_token: 'do-not-store', nested: { clientSecret: 'also-not-stored' } });
  assert.ok(!JSON.stringify(row).includes('do-not-store')); assert.ok(!JSON.stringify(row).includes('also-not-stored'));
});

test('an expired synchronization lease cannot overwrite the result of its successor', async () => {
  let release!: () => void, started!: () => void, pages = 0;
  const waiting = new Promise<void>(resolve => { release = resolve; }), pageStarted = new Promise<void>(resolve => { started = resolve; });
  const r = await runtime(async (config, path, token, form) => {
    if (path.includes('/oauth/token')) return simpleHttp(config, path, token, form);
    pages++;
    if (pages === 1) { started(); await waiting; return { transactions: [sberRow('same-bank-id', '1')], _links: [] }; }
    return { transactions: [sberRow('same-bank-id', '2')], _links: [] };
  });
  try {
    await r.service.start('sber-nk-artel', fixtureDay, fixtureDay);
    const slow = r.service.tick('sber-nk-artel'); await pageStarted;
    await r.store.mutate(r.base.provenance.sourceSha256, data => { const state = data.banking!.connections['sber-nk-artel']; state.lease!.until = 0; state.requestNotBefore = 0; return {result:null,changed:true}; });
    await r.service.tick('sber-nk-artel'); release(); await slow;
    const list = await r.service.list(new URLSearchParams()); assert.equal(list.total, 1); assert.equal(list.items[0].amount, '2'); assert.equal(list.connections[0].lastError, undefined);
  } finally { release(); await r.close(); }
});

test('storage CAS conflicts retry without replaying bank requests or losing the rest of the CRM', async () => {
  let calls = 0;
  const r = await runtime(async (...args) => { calls++; return simpleHttp(...args); });
  try {
    let conflicts = 2;
    const service = new BankingService({ read: source => r.store.read(source), mutate: async (source, update) => { if (conflicts-- > 0) throw new ApiError(409, 'simulated CAS conflict'); return r.store.mutate(source, update); } }, r.base.provenance.sourceSha256, { ...fixtureEnvironment }, r.service.http);
    await service.start('sber-nk-artel', fixtureDay, fixtureDay); await service.tick('sber-nk-artel');
    assert.equal(calls, 2); assert.equal((await service.rows(new URLSearchParams())).length, 1);
  } finally { await r.close(); }
});

test('401 refresh preserves the rotated refresh token instead of reusing an obsolete initial token', async () => {
  let tokens = 0, pages = 0, refreshUsed = '';
  const r = await runtime(async (_config, path, _token, form) => {
    if (path.includes('/oauth/token')) { tokens++; refreshUsed = form!.get('refresh_token')!; return { access_token: `fixture-access-${tokens}`, refresh_token: `fixture-rotated-${tokens}`, expires_in: '3600' }; }
    if (++pages === 1) throw new BankHttpError(401);
    return { transactions: [sberRow()], _links: [] };
  });
  try {
    await r.service.start('sber-nk-artel', fixtureDay, fixtureDay); await r.service.tick('sber-nk-artel');
    await r.service.start('sber-nk-artel', fixtureDay, fixtureDay); await r.service.tick('sber-nk-artel');
    assert.equal(tokens, 2); assert.equal(refreshUsed, 'fixture-rotated-1'); assert.equal((await r.service.list(new URLSearchParams())).connections[0].state, 'connected');
  } finally { await r.close(); }
});

test('webhooks only queue reconciliation; repeated delivery never creates or accounts for a movement', async () => {
  const r = await runtime(simpleHttp);
  try {
    await assert.rejects(r.service.webhook('tbank-nk-artel', 'Bearer wrong', {accountNumber}));
    await r.service.webhook('tbank-nk-artel', 'Bearer fixture-only-webhook', { accountNumber, operationId: 'event-not-statement-id' });
    await r.service.webhook('tbank-nk-artel', 'Bearer fixture-only-webhook', { accountNumber, operationId: 'event-not-statement-id' });
    const data = (await r.store.read(r.base.provenance.sourceSha256)).banking!;
    assert.equal(data.operations.length, 0); assert.equal(data.connections['tbank-nk-artel'].webhookHashes?.length, 1); assert.equal(data.connections['tbank-nk-artel'].webhookPending, true);
  } finally { await r.close(); }
});

test('financial endpoints require CRM login and management role, including details, export, refresh and print; scheduler rejects untrusted calls', async () => {
  const r = await runtime(simpleHttp);
  const middleware = createSnapshotMiddleware(undefined, { operationsStore: r.store, bankEnvironment: fixtureEnvironment, bankRequest: simpleHttp });
  const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end(); }));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (path: string, cookie = '', body?: unknown) => fetch(baseUrl + path, { ...(body ? {method:'POST',body:JSON.stringify(body)} : {}), headers: { cookie, 'Content-Type':'application/json' } });
  try {
    assert.equal((await request('/api/banking')).status, 401);
    const password = randomBytes(20).toString('hex');
    const setup = await request('/api/auth/setup', '', { name: 'QA', login: 'qa.director', password }), cookie = setup.headers.get('set-cookie')!.split(';')[0];
    const snapshot = await (await request('/api/snapshot', cookie)).json();
    assert.equal((await request('/api/banking', cookie)).status, 200);
    await request('/api/auth/users', cookie, { name: 'Manager', login: 'manager', password, role: 'manager', managerId: snapshot.directories.managers[0].id });
    const login = await request('/api/auth/login', '', {login:'manager',password}), managerCookie = login.headers.get('set-cookie')!.split(';')[0];
    for (const [path, body] of [['/api/banking', undefined], ['/api/banking/export', undefined], [`/api/banking/operations/${'0'.repeat(64)}`, undefined], [`/api/banking/operations/${'0'.repeat(64)}/print`, undefined], ['/api/banking/connections/sber-artel/sync', {from:fixtureDay,to:fixtureDay}], [`/api/banking/operations/${'0'.repeat(64)}/refresh`, {}]] as const) assert.equal((await request(path, managerCookie, body)).status, 403, path);
    assert.equal((await request('/api/banking/dispatch')).status, 403);
    assert.equal((await request('/api/banking/webhooks/tbank-nk-artel', '', {accountNumber})).status, 403);
    assert.equal((await request('/api/banking/connections/sber-artel/sync', cookie, {from:'2010-01-01',to:fixtureDay})).status, 400);
  } finally { await new Promise<void>(done => server.close(() => done())); await r.close(); }
});
