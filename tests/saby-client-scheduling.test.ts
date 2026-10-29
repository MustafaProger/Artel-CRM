import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from '../server/api-error';
import { SabyClient } from '../server/saby-client';
import { integrationConfig, integrationRuntime } from './helpers/trip-saby-integration';
import { createTripSabyScheduler } from '../server/trip-saby-scheduler';

const gate = () => { let release!: () => void; const promise = new Promise<void>(done => { release = done; }); return { promise, release }; };
async function until(check: () => boolean) { const end = Date.now() + 3_000; while (!check()) { if (Date.now() > end) throw new Error('Synthetic client did not make progress'); await new Promise(done => setTimeout(done, 5)); } }
const loginConfig = () => ({ ...integrationConfig(), sessionId: undefined, login: 'synthetic-user', password: 'synthetic-password', accountNumber: 'sender-account', carrierAccountNumber: 'carrier-account' });

test('parallel runtime jobs and nested guards share one authentication per account within four network slots', async () => {
  const f = await integrationRuntime(), authGate = gate(), readGate = gate();
  const auth = new Map<string, number>();
  let active = 0, maximum = 0;
  const send: typeof fetch = async (_input, init) => {
    active++; maximum = Math.max(maximum, active);
    try {
      const request = JSON.parse(String(init?.body));
      let result: unknown;
      if (request.method === 'СБИС.Аутентифицировать') {
        const account = request.params.Параметр.НомерАккаунта;
        auth.set(account, (auth.get(account) ?? 0) + 1); await authGate.promise; result = `${account}-session`;
      } else {
        const id = request.params.Документ.Идентификатор;
        const expected = id.startsWith('sender-') ? 'sender-account-session' : 'carrier-account-session';
        assert.equal(new Headers(init?.headers).get('X-SBISSessionID'), expected, 'accounts must never exchange cached sessions');
        await readGate.promise; result = { Идентификатор: id, Тип: 'TransportOrder' };
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
    } finally { active--; }
  };
  const config = loginConfig(), root = new SabyClient(config, send);
  const scheduler = createTripSabyScheduler({ ...f, config, client: root, enabled: true });
  try {
    const jobs = Array.from({ length: 8 }, (_, index) => {
      const guarded = scheduler.client.withRequestGuard(async () => undefined).withRequestGuard(async () => undefined);
      return Promise.all([guarded.readSigningOrder('sender', `sender-${index}`), guarded.readSigningOrder('carrier', `carrier-${index}`)]);
    });
    await until(() => auth.size === 2); assert.deepEqual([...auth.values()], [1, 1]); authGate.release();
    await until(() => active === 4); assert.equal(maximum, 4); readGate.release(); await Promise.all(jobs);
    const later = scheduler.client.withRequestGuard(async () => undefined);
    await Promise.all([later.readSigningOrder('sender', 'sender-later'), later.readSigningOrder('carrier', 'carrier-later')]);
    assert.deepEqual([...auth.values()], [1, 1]); assert.equal(maximum, 4);
  } finally { authGate.release(); readGate.release(); await scheduler.stop(); await f.close(); }
});

test('late concurrent 401 cannot invalidate another guarded job\'s refreshed session', async () => {
  const bothOld = gate(), refreshed = gate(), late401 = gate();
  let oldCalls = 0, authCalls = 0, newCalls = 0;
  const send: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body));
    if (request.method === 'СБИС.Аутентифицировать') { authCalls++; refreshed.release(); return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: 'fresh-session' })); }
    if (new Headers(init?.headers).get('X-SBISSessionID') === 'old-session') {
      const call = ++oldCalls; if (call === 2) bothOld.release(); await bothOld.promise;
      if (call === 2) await late401.promise;
      return new Response('', { status: 401 });
    }
    newCalls++; return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { Идентификатор: 'synthetic', Тип: 'TransportOrder' } }));
  };
  const root = new SabyClient({ ...loginConfig(), sessionId: 'old-session' }, send);
  const first = root.withRequestGuard(async () => undefined).readTransportOrder('synthetic');
  const second = root.withRequestGuard(async () => undefined).readTransportOrder('synthetic');
  await refreshed.promise; await first; late401.release(); await second;
  await root.withRequestGuard(async () => undefined).readTransportOrder('synthetic');
  assert.equal(oldCalls, 2); assert.equal(authCalls, 1); assert.equal(newCalls, 3);
});

test('a revoked guard cannot authenticate or use a session cached by another job', async () => {
  let authCalls = 0, reads = 0;
  const send: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body));
    const authenticating = request.method === 'СБИС.Аутентифицировать';
    if (authenticating) authCalls++; else reads++;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: authenticating ? 'shared-session' : { Идентификатор: 'synthetic', Тип: 'TransportOrder' } }));
  };
  const root = new SabyClient(loginConfig(), send);
  const denied = root.withRequestGuard(async () => { throw new ApiError(403, 'Synthetic revoked actor'); });
  await assert.rejects(denied.readTransportOrder('synthetic'), error => error instanceof ApiError && error.status === 403);
  assert.equal(authCalls, 0); assert.equal(reads, 0);
  await root.withRequestGuard(async () => undefined).readTransportOrder('synthetic');
  await assert.rejects(denied.readTransportOrder('synthetic'), error => error instanceof ApiError && error.status === 403);
  assert.equal(authCalls, 1); assert.equal(reads, 1);
});

test('network capacity precedes lease guards, write markers and transport timeout', async () => {
  const entered = gate(), capacity = gate();
  let guardCalls = 0, markerCalls = 0, fetchCalls = 0;
  const run = async <T>(action: () => Promise<T>) => { entered.release(); await capacity.promise; return action(); };
  const send: typeof fetch = async (_input, init) => {
    fetchCalls++; assert.equal(init?.signal?.aborted, false, 'time in the queue cannot consume the HTTP timeout');
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(String(init?.body)).id, result: {} }));
  };
  const client = new SabyClient({ ...integrationConfig(), timeoutMs: 5 }, send, undefined, run).withRequestGuard(async () => { guardCalls++; });
  const operation = client.call('СБИС.ВыполнитьДействие', {}, true, false, async () => { markerCalls++; });
  await entered.promise;
  assert.equal(guardCalls, 0); assert.equal(markerCalls, 0); assert.equal(fetchCalls, 0);
  await new Promise(done => setTimeout(done, 25));
  capacity.release(); await operation;
  assert.equal(guardCalls, 1); assert.equal(markerCalls, 1); assert.equal(fetchCalls, 1);
});

test('a lease invalidated while queued prevents both the write marker and HTTP request', async () => {
  const entered = gate(), capacity = gate();
  let validLease = true, markers = 0, requests = 0;
  const run = async <T>(action: () => Promise<T>) => { entered.release(); await capacity.promise; return action(); };
  const client = new SabyClient(integrationConfig(), async () => { requests++; return new Response(); }, undefined, run)
    .withRequestGuard(async () => { if (!validLease) throw new ApiError(409, 'Synthetic expired lease'); });
  const operation = client.call('СБИС.ВыполнитьДействие', {}, true, false, async () => { markers++; });
  await entered.promise; validLease = false; capacity.release();
  await assert.rejects(operation, error => error instanceof ApiError && error.status === 409);
  assert.equal(markers, 0); assert.equal(requests, 0);
});

test('capacity remains occupied until the complete JSON response has been consumed', async () => {
  const headers = gate(), body = gate();
  let active = 0;
  const run = async <T>(action: () => Promise<T>) => { active++; try { return await action(); } finally { active--; } };
  const send: typeof fetch = async (_input, init) => {
    const id = JSON.parse(String(init?.body)).id;
    headers.release();
    return new Response(new ReadableStream({ async start(controller) { await body.promise; controller.enqueue(new TextEncoder().encode(JSON.stringify({ jsonrpc: '2.0', id, result: {} }))); controller.close(); } }));
  };
  const operation = new SabyClient(integrationConfig(), send, undefined, run).call('СБИС.ПрочитатьДокумент', {});
  await headers.promise; await new Promise(done => setTimeout(done, 10));
  assert.equal(active, 1); body.release(); await operation; assert.equal(active, 0);
});

test('attachment downloads keep capacity through the last body chunk and inherit the final guard', async () => {
  const downloading = gate(), body = gate();
  let active = 0, guards = 0;
  const run = async <T>(action: () => Promise<T>) => { active++; try { return await action(); } finally { active--; } };
  const send: typeof fetch = async (_input, init) => {
    if (init?.method === 'GET') {
      downloading.release();
      return new Response(new ReadableStream({ async start(controller) { await body.promise; controller.enqueue(new TextEncoder().encode('<synthetic/>')); controller.close(); } }));
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(String(init?.body)).id, result: { Идентификатор: 'synthetic', Тип: 'TransportOrder', Вложение: [{ Идентификатор: 'title', Файл: { Имя: 'synthetic.xml', Ссылка: 'https://disk.saby.ru/synthetic.xml' } }] } }));
  };
  const client = new SabyClient(integrationConfig(), send, undefined, run).withRequestGuard(async () => { guards++; });
  const operation = client.downloadTransportOrderAttachment('synthetic', 'title');
  await downloading.promise; await new Promise(done => setTimeout(done, 10));
  assert.equal(active, 1); assert.equal(guards, 2);
  body.release(); assert.equal(new TextDecoder().decode((await operation).bytes), '<synthetic/>'); assert.equal(active, 0);
});

test('a separate carrier account inherits the shared request capacity for authentication and document reads', async () => {
  let budgets = 0, fetches = 0;
  const run = async <T>(action: () => Promise<T>) => { budgets++; return action(); };
  const send: typeof fetch = async (_input, init) => {
    fetches++; const request = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: request.method === 'СБИС.Аутентифицировать' ? 'synthetic-carrier-session' : { Идентификатор: 'synthetic', Тип: 'TransportOrder' } }));
  };
  const client = new SabyClient({ ...integrationConfig(), login: 'synthetic', password: 'synthetic', accountNumber: 'sender-account', carrierAccountNumber: 'carrier-account' }, send, undefined, run);
  await client.readCarrierOrder('synthetic');
  assert.equal(fetches, 2); assert.equal(budgets, fetches);
});

test('stalled HTTP rejection body is bounded and cancelled before returning request capacity', async () => {
  for (const status of [401, 403, 500]) {
    let cancelled = false, released = false;
    const run = async <T>(action: () => Promise<T>) => { try { return await action(); } finally { assert.equal(cancelled, true); released = true; } };
    const client = new SabyClient({ ...integrationConfig(), timeoutMs: 20 }, async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status }), undefined, run);
    await assert.rejects(client.call('СБИС.ПрочитатьДокумент', {}));
    assert.equal(released, true);
  }
});
