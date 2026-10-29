import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { StoredUser } from '../server/auth';
import { ApiError } from '../server/api-error';
import { normalizeTbank } from '../server/banking/adapters';
import { operationId } from '../server/banking/domain';
import { bankingRoutes } from '../server/banking/routes';
import { BankingService } from '../server/banking/service';
import { createSnapshotMiddleware, loadSnapshot } from '../server/local-api';
import { OperationsStore } from '../server/operations-store';
import { currentSnapshot } from '../server/shipment-operations';
import type { BankListResult } from '../web/src/banking-model';
import { accountNumber, dollarAccount, fixtureConfig, fixtureDay, fixtureEnvironment, tbankRow } from './banking-fixtures';

const base = await loadSnapshot(resolve('data/local-xlsx-final'));
const source = base.provenance.sourceSha256;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const json = (value: unknown) => JSON.parse(JSON.stringify(value));
class CountingStore extends OperationsStore {
  reads = 0;
  override async read(sourceSha256: string) { this.reads++; return super.read(sourceSha256); }
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(resolve(tmpdir(), 'artel-bank-perf-'));
  const store = new CountingStore(directory), external = new OperationsStore(directory);
  const env = { ...fixtureEnvironment, ARTEL_BANK_SYNC_ENABLED: 'false' };
  let bankCalls = 0;
  const http = async () => { bankCalls++; throw new Error('List requests must not call a bank'); };
  const users: StoredUser[] = ['director', 'admin', 'employee', 'manager', 'logistician'].map(role => ({
    id: role, name: role, login: role, role: role as StoredUser['role'], managerId: null,
    sections: ['payments'], active: true, version: 1, salt: '0'.repeat(32), passwordHash: '0'.repeat(128),
  }));
  const row = (id: string, amount = '0.1', account = accountNumber, direction = 'Credit') => normalizeTbank(fixtureConfig(), { number: account, currency: account === dollarAccount ? 'USD' : 'RUB' }, fixtureDay, tbankRow(id, amount, account, direction));
  const oldSber = { ...row('legacy-sber'), id: operationId('sber-nk-artel', accountNumber, 'legacy-sber'), connectionId: 'sber-nk-artel', provider: 'sber' as const };
  await external.mutate(source, data => {
    data.accounts = { users, sessions: users.map(user => ({ userId: user.id, hash: hash(hash(user.id)), expiresAt: Date.now() + 600_000 })), attempts: {} };
    data.banking = {
      version: 1,
      connections: { 'tbank-nk-artel': { accounts: [{ number: accountNumber, currency: 'RUB' }, { number: dollarAccount, currency: 'USD' }], lastSuccessAt: '2026-09-14T11:00:00.000Z', lastCompletedPeriod: { from: fixtureDay, to: fixtureDay } } },
      operations: [...Array.from({ length: 24 }, (_, i) => row(`rub-${i}`)), row('usd-in', '1.2', dollarAccount), row('usd-out', '0.2', dollarAccount, 'Debit'), oldSber],
    };
    return { changed: true, result: null };
  });
  const service = new BankingService(store, source, env, http);
  const middleware = createSnapshotMiddleware(resolve('data/local-xlsx-final'), { operationsStore: store, bankEnvironment: env, bankRequest: http });
  const server = createServer((request, response) => middleware(request, response, () => { response.writeHead(404); response.end(); }));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => { await new Promise<void>(done => server.close(() => done())); await rm(directory, { recursive: true, force: true }); });
  const cookie = (id = 'director') => `artel_session=${hash(id)}`;
  const get = async (query = '', id = 'director') => {
    store.reads = 0;
    const response = await fetch(`${url}/api/banking?${query}`, { headers: { cookie: cookie(id) } });
    return { status: response.status, body: await response.json() as BankListResult, reads: store.reads };
  };
  return { store, external, service, cookie, get, row, bankCalls: () => bankCalls };
}

test('bank list uses one fresh read with identical filters, pagination, exact totals and redacted data', async t => {
  const f = await fixture(t), data = await f.external.read(source);
  const before = await readFile(f.store.path, 'utf8'), financial = currentSnapshot(base, data);
  for (const query of ['', 'page=2&pageSize=10', 'page=999&pageSize=10', `account=${dollarAccount}`, 'direction=outgoing', 'status=Transaction', 'connection=absent', 'q=rub-2', 'from=2026-09-15']) {
    const expected = await f.service.list(new URLSearchParams(query));
    const response = await f.get(query);
    assert.equal(response.status, 200, query);
    assert.equal(response.reads, 1, 'the middleware, route authorization and list projection share one uninterrupted view');
    assert.deepEqual(response.body, json(expected), query);
    assert.ok(response.body.items.every(row => Object.keys(row.bankData).length === 0 && row.provider === 'tbank'));
    assert.ok(!JSON.stringify(response.body).includes('fixture-only-token'));
  }
  const full = (await f.get()).body;
  assert.equal(full.total, 26); assert.equal(full.storedCount, 26); assert.equal(full.items.length, 25);
  assert.deepEqual(full.totals, [{ currency: 'RUB', incoming: '2.4', outgoing: '0', count: 24 }, { currency: 'USD', incoming: '1.2', outgoing: '0.2', count: 2 }]);
  assert.deepEqual(full.statuses, ['Transaction']); assert.equal(full.connections[0].state, 'connected');
  assert.equal(full.scheduleEnabled, false);
  const last = (await f.get('page=999&pageSize=10')).body;
  assert.equal(last.page, 3); assert.equal(last.items.length, 6);
  for (const query of ['pageSize=11', 'page=0', 'from=2026-09-15&to=2026-09-14']) assert.equal((await f.get(query)).status, 400);
  assert.equal(await readFile(f.store.path, 'utf8'), before);
  assert.deepEqual(currentSnapshot(base, await f.external.read(source)), financial);
  assert.equal(f.bankCalls(), 0);
});

test('each banking GET sees external data, role and session changes without retaining a prior request view', async t => {
  const f = await fixture(t);
  for (const id of ['director', 'admin']) assert.equal((await f.get('', id)).status, 200);
  for (const id of ['employee', 'manager', 'logistician']) assert.equal((await f.get('', id)).status, 403);
  assert.equal((await f.get('', 'missing')).status, 401);
  await f.external.mutate(source, data => {
    data.banking!.operations.push(f.row('new-external-operation', '7'));
    data.banking!.connections['tbank-nk-artel'].lastError = 'Synthetic refresh failure';
    return { changed: true, result: null };
  });
  const updated = await f.get();
  assert.equal(updated.reads, 1); assert.equal(updated.body.total, 27);
  assert.equal(updated.body.totals[0].incoming, '9.4'); assert.equal(updated.body.connections[0].state, 'error');
  await f.external.mutate(source, data => { data.accounts!.users.find(user => user.id === 'admin')!.role = 'employee'; return { changed: true, result: null }; });
  assert.equal((await f.get('', 'admin')).status, 403);
  await f.external.mutate(source, data => { data.accounts!.sessions = []; return { changed: true, result: null }; });
  assert.equal((await f.get('', 'director')).status, 401);
  assert.equal(f.bankCalls(), 0);
});

test('non-list bank routes ignore an earlier view and reject revoked sessions before body or provider work', async t => {
  const f = await fixture(t), stale = await f.external.read(source);
  await f.external.mutate(source, data => { data.accounts!.sessions = []; return { changed: true, result: null }; });
  let bodies = 0;
  const server = createServer((request, response) => {
    void bankingRoutes(f.service, request, response, new URL(request.url!, 'http://localhost'), async () => { bodies++; return {}; }, stale).catch(error => {
      response.writeHead(error instanceof ApiError ? error.status : 500); response.end();
    });
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise<void>(done => server.close(() => done())));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`, id = stale.banking!.operations[0].id;
  for (const [method, path] of [['GET', '/api/banking/export'], ['GET', `/api/banking/operations/${id}`], ['GET', `/api/banking/operations/${id}/print`], ['POST', `/api/banking/operations/${id}/refresh`], ['POST', '/api/banking/connections/tbank-nk-artel/sync'], ['POST', '/api/banking']]) {
    f.store.reads = 0;
    const response = await fetch(url + path, { method, headers: { cookie: f.cookie() } });
    await response.text();
    assert.equal(response.status, 401, path); assert.equal(f.store.reads, 1, path);
  }
  assert.equal(bodies, 0); assert.equal(f.bankCalls(), 0);
});
