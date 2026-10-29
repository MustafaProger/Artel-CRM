import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from 'node:test';
import { ApiError } from '../server/api-error';
import type { OperationsData } from '../server/operations-store';
import { bankingRoutes } from '../server/banking/routes';
import { sberRoutes } from '../server/banking/sber-routes';
import type { BankingService } from '../server/banking/service';
import type { SberService } from '../server/banking/sber-service';

const operationId = 'b'.repeat(64);
type ServiceAction = 'list' | 'listFromData' | 'rows' | 'operation' | 'start' | 'tick' | 'enrich' | 'print';
const cases: { path: string; method: 'GET' | 'POST'; actions: ServiceAction[] }[] = [
  { path: '/api/banking', method: 'GET', actions: ['listFromData'] },
  { path: '/api/banking/export', method: 'GET', actions: ['rows'] },
  { path: `/api/banking/operations/${operationId}`, method: 'GET', actions: ['operation'] },
  { path: `/api/banking/operations/${operationId}/print`, method: 'GET', actions: ['print'] },
  { path: `/api/banking/operations/${operationId}/refresh`, method: 'POST', actions: ['enrich'] },
  { path: '/api/banking/connections/tbank-nk-artel/sync', method: 'POST', actions: ['start', 'tick'] },
  { path: '/api/banking/connections/tbank-nk-artel/continue', method: 'POST', actions: ['tick'] },
  { path: '/api/banking/sber/statements', method: 'GET', actions: ['list'] },
  { path: `/api/banking/sber/operations/${operationId}`, method: 'GET', actions: ['operation'] },
  { path: `/api/banking/sber/operations/${operationId}/refresh`, method: 'POST', actions: ['enrich'] },
  { path: '/api/banking/sber/sync', method: 'POST', actions: ['start'] },
  { path: '/api/banking/sber/continue', method: 'POST', actions: ['tick'] },
];

function fixture(entry: typeof cases[number], revokeAt?: 'body' | ServiceAction, demote = false) {
  const token = 'a'.repeat(64);
  const accounts: NonNullable<OperationsData['accounts']> = {
    users: [{ id: 'security-test-admin', name: 'Synthetic admin', login: 'synthetic.admin', role: 'admin', managerId: null, active: true, version: 1, passwordHash: '0'.repeat(128), salt: '0'.repeat(32) }],
    sessions: [{ hash: createHash('sha256').update(token).digest('hex'), userId: 'security-test-admin', expiresAt: Date.now() + 60000 }],
    attempts: {},
  };
  const calls: ServiceAction[] = [];
  const sent: unknown[] = [];
  const revoke = () => {
    if (demote) { accounts.users[0].role = 'employee'; accounts.users[0].sections = ['payments']; }
    else accounts.sessions = [];
  };
  const result = (action: ServiceAction, value: unknown) => async () => {
    calls.push(action);
    if (revokeAt === action) revoke();
    return value;
  };
  const service = {
    source: 'synthetic-security-test',
    store: { read: async () => ({ accounts }) },
    listFromData: () => { calls.push('listFromData'); return { items: [] }; },
    list: result('list', { items: [] }), rows: result('rows', []),
    operation: result('operation', { id: operationId }), enrich: result('enrich', { id: operationId }),
    print: result('print', Buffer.from('%PDF-synthetic')), start: result('start', { pending: true }), tick: result('tick', { pending: false }),
  };
  const request = { method: entry.method, url: entry.path, headers: { cookie: `artel_session=${token}` } } as IncomingMessage;
  const response = { writeHead: (...args: unknown[]) => { sent.push(args); }, end: (value: unknown) => { sent.push(value); } } as unknown as ServerResponse;
  const readBody = async () => {
    if (revokeAt === 'body') revoke();
    return { from: '2026-10-01', to: '2026-10-02' };
  };
  const run = () => entry.path.startsWith('/api/banking/sber/')
    ? sberRoutes(service as unknown as SberService, request, response, new URL(entry.path, 'http://localhost'), readBody)
    : bankingRoutes(service as unknown as BankingService, request, response, new URL(entry.path, 'http://localhost'), readBody);
  return { run, calls, sent, revoke, accounts, request, response };
}

for (const entry of cases) {
  test(`bank request preserves successful behavior without repeating work: ${entry.method} ${entry.path}`, async () => {
    const f = fixture(entry);
    await f.run();
    assert.deepEqual(f.calls, entry.actions);
    assert.equal(f.sent.length, 2);
    assert.equal((f.sent[0] as unknown[])[0], 200);
  });

  for (const demote of [false, true]) {
    // The performance release projects this list synchronously from the same
    // fresh view used for authorization. It has no provider/body await at which
    // another request could revoke access; validate revocation before projection.
    if (entry.path === '/api/banking') {
      test(`synchronous bank list rejects ${demote ? 'privilege removal' : 'session revocation'} before projection`, async () => {
        const f = fixture(entry, undefined, demote);
        f.revoke();
        await assert.rejects(f.run, error => error instanceof ApiError && error.status === (demote ? 403 : 401));
        assert.deepEqual(f.calls, []);
        assert.deepEqual(f.sent, []);
      });
      continue;
    }
    test(`bank response is withheld after ${demote ? 'privilege removal' : 'session revocation'} during work: ${entry.method} ${entry.path}`, async () => {
      const f = fixture(entry, entry.actions.at(-1), demote);
      await assert.rejects(f.run, error => error instanceof ApiError && error.status === (demote ? 403 : 401));
      assert.deepEqual(f.calls, entry.actions);
      assert.deepEqual(f.sent, []);
    });
  }

  if (entry.method === 'POST') test(`bank request revoked while reading body performs no work: ${entry.path}`, async () => {
    const f = fixture(entry, 'body');
    await assert.rejects(f.run, error => error instanceof ApiError && error.status === 401);
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.sent, []);
  });
}

test('bank sync does not start a provider tick after access was revoked while queueing the job', async () => {
  const f = fixture(cases.find(entry => entry.path === '/api/banking/connections/tbank-nk-artel/sync')!, 'start');
  await assert.rejects(f.run, error => error instanceof ApiError && error.status === 401);
  assert.deepEqual(f.calls, ['start']);
  assert.deepEqual(f.sent, []);
});


test('synchronous bank list authorizes the fresh read before projection and has no provider or body boundary', async () => {
  for (const mode of ['active', 'revoked', 'demoted'] as const) {
    const f = fixture({ path: '/api/banking', method: 'GET', actions: ['list'] }, undefined, mode === 'demoted');
    let reads = 0, projections = 0;
    const service = {
      source: 'synthetic-security-test',
      store: { read: async () => { reads++; if (mode !== 'active') f.revoke(); return { accounts: f.accounts }; } },
      listFromData: (data: OperationsData) => { assert.equal(data.accounts, f.accounts); projections++; return { items: [] }; },
      list: () => { throw new Error('The synchronous list must not call the async service method'); },
    };
    const run = () => bankingRoutes(service as unknown as BankingService, f.request, f.response, new URL('/api/banking', 'http://localhost'), async () => { throw new Error('A GET must not read a body'); });
    if (mode === 'active') { await run(); assert.equal(projections, 1); assert.equal(f.sent.length, 2); }
    else { await assert.rejects(run, error => error instanceof ApiError && error.status === (mode === 'demoted' ? 403 : 401)); assert.equal(projections, 0); assert.deepEqual(f.sent, []); }
    assert.equal(reads, 1);
  }
});
