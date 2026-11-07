import assert from 'node:assert/strict';
import test from 'node:test';
import { SabyClient, SabyError, isSabyFailureDiagnostic, type SabyConfig } from '../server/saby-client';

const config: SabyConfig = {
  sessionId: 'synthetic-session', login: 'synthetic-login', password: 'synthetic-password', accountNumber: 'synthetic-account',
  customer: { inn: '0000000000', kpp: '000000000', name: 'Synthetic sender', address: 'Synthetic address' },
  carrier: { inn: '1111111111', kpp: '111111111', name: 'Synthetic carrier', address: 'Synthetic address' },
};
type Rpc = { id: number; method: string };
const rpcFailure = (request: Rpc, error: unknown = { code: -32000, message: 'synthetic provider error' }) => ({ jsonrpc: '2.0', id: request.id, error });
const json = (body: unknown, status = 500) => new Response(JSON.stringify(body), { status });
function api(response: (request: Rpc) => Response, options: Partial<SabyConfig> = {}) {
  const calls: Rpc[] = [];
  const send: typeof fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as Rpc; calls.push(request);
    return response(request);
  };
  const client = new SabyClient({ ...config, ...options }, send);
  return { calls, client, write: () => client.reserveNumberedDocument({ Тип: 'ConsignmentNote', Примечание: 'synthetic-marker' }) };
}
async function failure(action: () => Promise<unknown>): Promise<SabyError> {
  try { await action(); } catch (error) { assert.ok(error instanceof SabyError); return error; }
  throw new Error('Expected a controlled SabyError');
}
function assertTransportFallback(error: SabyError) {
  assert.equal(error.kind, 'transport');
  assert.equal(error.uncertain, true);
  assert.deepEqual(error.diagnostic, { method: 'СБИС.ЗаписатьДокумент', phase: 'response', category: 'transport', httpStatus: 500 });
}

test('HTTP 500 matching JSON-RPC retains only safe numeric diagnostics and never retries a write', async () => {
  const secret = 'PRIVATE_PROVIDER_MESSAGE_CREDENTIAL_AND_STACK';
  const remote = api(request => json(rpcFailure(request, { code: -32042, message: secret, data: { password: secret }, stack: secret })));
  const error = await failure(remote.write);
  assert.equal(error.kind, 'transport');
  assert.equal(error.uncertain, true);
  assert.deepEqual(error.diagnostic, { method: 'СБИС.ЗаписатьДокумент', phase: 'response', category: 'provider_error', httpStatus: 500, rpcCode: -32042 });
  assert.ok(isSabyFailureDiagnostic(error.diagnostic));
  assert.equal(JSON.stringify({ ...error, message: error.message, stack: error.stack }).includes(secret), false);
  assert.deepEqual(remote.calls.map(row => row.method), ['СБИС.ЗаписатьДокумент']);
});

test('HTTP 500 recognizes the audited payment code without exposing surrounding provider text', async () => {
  const secret = 'PRIVATE_PAYMENT_FAILURE_DETAILS';
  const remote = api(request => json(rpcFailure(request, { code: -32602, message: secret, data: { reason: `${secret}: 0001.006.406.020; ${secret}` } })));
  const error = await failure(remote.write);
  assert.equal(error.uncertain, true);
  assert.deepEqual(error.diagnostic, { method: 'СБИС.ЗаписатьДокумент', phase: 'response', category: 'carrier_payment_missing', httpStatus: 500, rpcCode: -32602, formatCode: '0001.006.406.020' });
  assert.ok(isSabyFailureDiagnostic(error.diagnostic));
  assert.equal(JSON.stringify({ ...error, message: error.message }).includes(secret), false);
  assert.equal(remote.calls.length, 1);
});

test('unapproved and embedded format codes are not promoted to diagnostic fields', async () => {
  const remote = api(request => json(rpcFailure(request, { code: 42, message: '0001.006.406.021 10001.006.406.020 0001.006.406.0201', data: { formatCode: 'not-allowlisted' } })));
  const error = await failure(remote.write);
  assert.equal(error.diagnostic?.rpcCode, 42);
  assert.equal(error.diagnostic?.formatCode, undefined);
  assert.equal(error.diagnostic?.category, 'provider_error');
});

for (const status of [400, 404, 409, 429, 500, 502, 503]) test(`HTTP ${status} validated write error remains uncertain and is not automatically retried`, async () => {
  const remote = api(request => json(rpcFailure(request), status));
  const error = await failure(remote.write);
  assert.equal(error.kind, 'transport');
  assert.equal(error.uncertain, true);
  assert.equal(error.diagnostic?.httpStatus, status);
  assert.equal(remote.calls.length, 1);
});

const invalidEnvelopes: [string, (request: Rpc) => unknown][] = [
  ['mismatched request ID', request => ({ ...rpcFailure(request), id: request.id + 1 })],
  ['string request ID', request => ({ ...rpcFailure(request), id: String(request.id) })],
  ['wrong protocol version', request => ({ ...rpcFailure(request), jsonrpc: '1.0' })],
  ['both result and error', request => ({ ...rpcFailure(request), result: { Идентификатор: 'untrusted' } })],
  ['nonobject error', request => rpcFailure(request, '0001.006.406.020')],
  ['missing numeric code', request => rpcFailure(request, { message: '0001.006.406.020' })],
  ['string code', request => rpcFailure(request, { code: '-32000', message: '0001.006.406.020' })],
  ['fractional code', request => rpcFailure(request, { code: 1.5, message: '0001.006.406.020' })],
  ['out of range code', request => rpcFailure(request, { code: 2_147_483_648, message: '0001.006.406.020' })],
  ['nonstring error message', request => rpcFailure(request, { code: -32000, message: { format: '0001.006.406.020' } })],
];
for (const [name, envelope] of invalidEnvelopes) test(`HTTP 500 ${name} cannot classify an unvalidated body`, async () => {
  const remote = api(request => json(envelope(request)));
  assertTransportFallback(await failure(remote.write));
  assert.equal(remote.calls.length, 1);
});

test('HTML and truncated JSON use the generic HTTP error without retaining response text', async () => {
  for (const body of ['<html>PRIVATE_HTML_PASSWORD</html>', '{"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"PRIVATE_TRUNCATED']) {
    const remote = api(() => new Response(body, { status: 500 }));
    const error = await failure(remote.write);
    assertTransportFallback(error);
    assert.equal(JSON.stringify({ ...error, message: error.message }).includes('PRIVATE_'), false);
  }
});

test('invalid UTF-8 cannot turn a corrupted HTTP error into a validated JSON-RPC diagnostic', async () => {
  const remote = api(request => {
    const body = Buffer.from(JSON.stringify(rpcFailure(request, { code: -32000, message: 'X' })));
    body[body.indexOf(Buffer.from('"X"')) + 1] = 0xff;
    return new Response(body, { status: 500 });
  });
  assertTransportFallback(await failure(remote.write));
});

test('oversized streamed bodies are canceled even with a misleading Content-Length', async () => {
  let canceled = false;
  const remote = api(request => {
    const prefix = new TextEncoder().encode(JSON.stringify(rpcFailure(request)));
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(prefix); controller.enqueue(new Uint8Array(64 * 1024)); },
      cancel() { canceled = true; },
    });
    return new Response(stream, { status: 500, headers: { 'Content-Length': '1' } });
  });
  assertTransportFallback(await failure(remote.write));
  assert.equal(canceled, true);
  assert.equal(remote.calls.length, 1);
});

test('Content-Length above the error limit cancels without accepting even a valid short body', async () => {
  let canceled = false;
  const remote = api(request => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify(rpcFailure(request)))); },
    cancel() { canceled = true; },
  }), { status: 500, headers: { 'Content-Length': String(64 * 1024 + 1) } }));
  assertTransportFallback(await failure(remote.write));
  assert.equal(canceled, true);
});

test('the limit counts UTF-8 bytes rather than characters', async () => {
  const remote = api(request => json(rpcFailure(request, { code: -32000, message: 'я'.repeat(33 * 1024) })));
  assertTransportFallback(await failure(remote.write));
});

test('an unfinished response is time-bounded, canceled and never parsed as a complete error', async () => {
  let canceled = false;
  const remote = api(request => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify(rpcFailure(request)))); },
    cancel() { canceled = true; },
  }), { status: 500 }), { timeoutMs: 20 });
  const error = await Promise.race([failure(remote.write), new Promise<never>((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('HTTP error body did not time out')), 1000); timer.unref();
  })]);
  assertTransportFallback(error);
  assert.equal(canceled, true);
  assert.equal(remote.calls.length, 1);
});

test('a failed body stream retains HTTP uncertainty without leaking its thrown error', async () => {
  const remote = api(() => new Response(new ReadableStream<Uint8Array>({
    start(controller) { controller.error(new Error('PRIVATE_STREAM_FAILURE')); },
  }), { status: 500 }));
  const error = await failure(remote.write);
  assertTransportFallback(error);
  assert.equal(JSON.stringify({ ...error, message: error.message }).includes('PRIVATE_STREAM_FAILURE'), false);
});

test('an unavailable locked body falls back to a controlled uncertain transport error', async () => {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const remote = api(request => {
    const response = json(rpcFailure(request));
    reader = response.body!.getReader();
    return response;
  });
  try { assertTransportFallback(await failure(remote.write)); }
  finally { await reader?.cancel(); reader?.releaseLock(); }
});

for (const status of [401, 403]) test(`guarded HTTP ${status} remains definite and never repeats the armed write`, async () => {
  let armed = 0;
  const remote = api(request => json(rpcFailure(request, { code: -32000, message: '0001.006.406.020 PRIVATE_DENIED' }), status));
  const error = await failure(() => remote.client.call('СБИС.ЗаписатьДокумент', { Документ: { Тип: 'ConsignmentNote' } }, true, false, async () => { armed++; }));
  assert.equal(error.kind, status === 401 ? 'authorization' : 'permission');
  assert.equal(error.uncertain, false);
  assert.equal(error.diagnostic?.httpStatus, status);
  assert.equal(error.diagnostic?.rpcCode, undefined);
  assert.equal(error.diagnostic?.formatCode, undefined);
  assert.equal(armed, 1);
  assert.deepEqual(remote.calls.map(row => row.method), ['СБИС.ЗаписатьДокумент']);
});

test('a definite unguarded HTTP 401 still refreshes a read session once', async () => {
  let reads = 0;
  const remote = api(request => {
    if (request.method === 'СБИС.Аутентифицировать') return json({ jsonrpc: '2.0', id: request.id, result: 'new-synthetic-session' }, 200);
    if (++reads === 1) return json(rpcFailure(request), 401);
    return json({ jsonrpc: '2.0', id: request.id, result: { Идентификатор: 'synthetic-document' } }, 200);
  });
  assert.equal((await remote.client.readDocument('synthetic-document')).Идентификатор, 'synthetic-document');
  assert.deepEqual(remote.calls.map(row => row.method), ['СБИС.ПрочитатьДокумент', 'СБИС.Аутентифицировать', 'СБИС.ПрочитатьДокумент']);
});

for (const status of [429, 500, 503]) test(`HTTP ${status} read RPC diagnostics preserve transport recovery without a terminal validation block`, async () => {
  const remote = api(request => json(rpcFailure(request), status));
  const error = await failure(() => remote.client.readDocument('synthetic-document'));
  assert.equal(error.kind, 'transport');
  assert.equal(error.uncertain, false);
  assert.equal(error.diagnostic?.rpcCode, -32000);
  assert.equal(remote.calls.length, 1);
});
