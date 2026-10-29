import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { SabyClient, SabyError, SabyRequestError, isSabyRequestIntent, isSabyResponseDiagnostic, type SabyRequestIntent } from '../server/saby-client';
import { integrationConfig } from './helpers/trip-saby-integration';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const document = { Тип: 'ConsignmentNote', Дата: '19.10.2026', Примечание: 'synthetic-marker', Вложение: [{ Файл: { ДвоичныеДанные: Buffer.from('<synthetic/>').toString('base64') } }] };

async function failure(run: () => Promise<unknown>): Promise<SabyRequestError> {
  try { await run(); } catch (error) { assert.ok(error instanceof SabyRequestError); return error; }
  throw new Error('Expected audited request error');
}

test('consignment intent binds exact outgoing JSON before fetch and remains compatible with parameterless hooks', async () => {
  const events: string[] = []; let saved: SabyRequestIntent | undefined;
  const config = integrationConfig();
  const client = new SabyClient(config, async (_url, init) => {
    events.push('fetch'); const body = String(init?.body), rpc = JSON.parse(body);
    assert.ok(saved); assert.equal(saved.bodySha256, sha(body)); assert.equal(saved.bodyBytes, Buffer.byteLength(body)); assert.equal(saved.requestId, rpc.id);
    assert.equal(saved.method, 'СБИС.ЗаписатьДокумент'); assert.ok(isSabyRequestIntent(saved));
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: { Идентификатор: 'created' } }));
  }).withRequestGuard(async () => { events.push('guard'); });
  const result = await client.writeConsignmentNote(document, async intent => { events.push('intent'); saved = intent; });
  assert.equal(result.Идентификатор, 'created'); assert.deepEqual(events, ['guard', 'intent', 'fetch']);
  await assert.rejects(client.writeDocument(document, async () => { throw new Error('journal unavailable'); }), /journal unavailable/);
  assert.equal(events.filter(event => event === 'fetch').length, 1);
});

test('HTTP500 keeps safe matching RPC error evidence and does not retry or prove rollback', async () => {
  let calls = 0, text = '';
  const client = new SabyClient(integrationConfig(), async (_url, init) => {
    calls++; const rpc = JSON.parse(String(init?.body)); text = JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { code: -32000, message: 'Не заполнен номер накладной', data: { trace: 'PRIVATE TRACE', xml: '<PRIVATE/>' } } });
    return new Response(text, { status: 500 });
  });
  const error = await failure(() => client.writeConsignmentNote(document));
  assert.ok(error instanceof SabyError); assert.equal(error.kind, 'transport'); assert.equal(error.uncertain, true); assert.equal(calls, 1);
  assert.equal(error.response?.message, 'Не заполнен номер накладной'); assert.equal(error.response?.rpcCode, -32000); assert.equal(error.response?.rpcIdMatches, true);
  assert.equal(error.response?.bodySha256, sha(text)); assert.equal(error.response?.bodyState, 'complete'); assert.ok(isSabyResponseDiagnostic(error.response));
  assert.doesNotMatch(JSON.stringify(error), /PRIVATE|<PRIVATE|trace|"data"/);
});

test('provider diagnostic removes known credentials, nested payloads, URLs and long opaque values', async () => {
  for (const message of [
    'Ошибка test-private-password раскрыта', 'Ошибка token=opaque-secret-value',
    'Ошибка <Файл secret="payload"/> tail', 'Ошибка {"payload":"private"}',
    'Ошибка https://example.test/?token=private', 'Ошибка AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
  ]) {
    const client = new SabyClient({ ...integrationConfig(), password: 'test-private-password' }, async (_url, init) => new Response(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(String(init?.body)).id, error: { code: -1, message, data: { detail: 'NEVER SAVE THIS' } } })));
    const error = await failure(() => client.writeConsignmentNote(document));
    assert.equal(error.uncertain, true); assert.ok(isSabyResponseDiagnostic(error.response));
    assert.doesNotMatch(JSON.stringify(error), /test-private-password|opaque-secret-value|payload|example\.test|AAAAAAAA|NEVER SAVE/);
  }
});

test('non-JSON, mismatched RPC and HTTP500 result remain uncertain without false document success', async () => {
  for (const make of [() => '<html>private-error</html>', () => JSON.stringify({ jsonrpc: '2.0', id: 999, error: { code: -1, message: 'Ошибка запроса' } }), () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: { Идентификатор: 'maybe-created' } })]) {
    const client = new SabyClient(integrationConfig(), async () => new Response(make(), { status: 500 }));
    const error = await failure(() => client.writeConsignmentNote(document));
    assert.equal(error.uncertain, true); assert.equal(error.response?.httpStatus, 500);
    assert.doesNotMatch(JSON.stringify(error), /private-error|maybe-created/);
  }
});

test('oversized non200 diagnostics are capped, cancelled and hashed as a marked prefix', async () => {
  let cancelled = false;
  const prefix = 'x'.repeat(70_000);
  const client = new SabyClient(integrationConfig(), async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(Buffer.from(prefix)); }, cancel() { cancelled = true; } }), { status: 500 }));
  const error = await failure(() => client.writeConsignmentNote(document));
  assert.equal(cancelled, true); assert.equal(error.response?.bodyState, 'truncated'); assert.equal(error.response?.bodyBytes, 65_536);
  assert.equal(error.response?.bodySha256, sha(prefix.slice(0, 65_536))); assert.equal(error.response?.message, undefined); assert.equal(error.uncertain, true);
});

test('stalled non200 body obeys transport timeout and releases capacity after cancellation', async () => {
  let cancelled = false, active = 0;
  const run = async <T>(action: () => Promise<T>) => { active++; try { return await action(); } finally { active--; } };
  const client = new SabyClient({ ...integrationConfig(), timeoutMs: 20 }, async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 500 }), undefined, run);
  const error = await failure(() => client.writeConsignmentNote(document));
  assert.equal(error.response?.bodyState, 'timeout'); assert.equal(error.uncertain, true); assert.equal(cancelled, true); assert.equal(active, 0);
});

test('transport throw preserves the dispatched intent without copying the original error or retrying', async () => {
  let calls = 0; let saved: SabyRequestIntent | undefined;
  const client = new SabyClient(integrationConfig(), async () => { calls++; throw new Error('PRIVATE NETWORK TRACE'); });
  const error = await failure(() => client.writeConsignmentNote(document, async intent => { saved = intent; }));
  assert.deepEqual(error.request, saved); assert.equal(error.response, undefined); assert.equal(error.uncertain, true); assert.equal(calls, 1);
  assert.doesNotMatch(JSON.stringify(error), /PRIVATE/);
});

test('authentication diagnostics never retain credentials, credential hashes or session response fingerprints', async () => {
  const client = new SabyClient({ ...integrationConfig(), sessionId: undefined, accountNumber: 'synthetic-account', login: 'synthetic-login', password: 'synthetic-password' }, async (_url, init) => new Response(JSON.stringify({ jsonrpc: '2.0', id: JSON.parse(String(init?.body)).id, error: { code: -1, message: 'synthetic-password' } }), { status: 500 }));
  const error = await failure(() => client.writeConsignmentNote(document));
  assert.equal(error.request.method, 'СБИС.Аутентифицировать'); assert.equal(error.request.bodySha256, undefined); assert.equal(error.request.bodyBytes, undefined);
  assert.equal(error.response?.bodySha256, undefined); assert.equal(error.response?.message, undefined); assert.ok(isSabyRequestIntent(error.request)); assert.ok(isSabyResponseDiagnostic(error.response));
  assert.doesNotMatch(JSON.stringify(error), /synthetic-password|synthetic-login/);
});

test('durable write callback prevents automatic 401 retry and keeps definite rejection semantics', async () => {
  let writes = 0;
  const client = new SabyClient({ ...integrationConfig(), login: 'synthetic', password: 'synthetic', accountNumber: 'synthetic' }, async () => { writes++; return new Response('', { status: 401 }); });
  const error = await failure(() => client.writeConsignmentNote(document, async () => {}));
  assert.equal(writes, 1); assert.equal(error.uncertain, false); assert.equal(error.kind, 'authorization'); assert.equal(error.response?.httpStatus, 401);
});

test('audit validators reject extra payload fields, corrupt fingerprints and unbounded messages', () => {
  const intent = { version: 1, method: 'СБИС.ЗаписатьДокумент', requestId: 1, requestedAt: '2026-10-21T10:00:00.000Z', bodySha256: 'a'.repeat(64), bodyBytes: 123 };
  assert.ok(isSabyRequestIntent(intent)); assert.equal(isSabyRequestIntent({ ...intent, params: {} }), false); assert.equal(isSabyRequestIntent({ ...intent, bodySha256: 'secret' }), false);
  const response = { receivedAt: intent.requestedAt, httpStatus: 500, bodyState: 'complete', bodySha256: 'b'.repeat(64), bodyBytes: 0 };
  assert.ok(isSabyResponseDiagnostic(response)); assert.equal(isSabyResponseDiagnostic({ ...response, data: {} }), false); assert.equal(isSabyResponseDiagnostic({ ...response, message: 'a'.repeat(513) }), false);
});

test('direct NK client rejects empty reservation and bare creation before authentication while reads remain available', async () => {
  let requests = 0;
  const client = new SabyClient(integrationConfig(), async (_url, init) => {
    requests++; const request = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { Идентификатор: 'existing', Тип: 'ConsignmentNote' } }));
  }).forNkDirectEtrn();
  await assert.rejects(client.reserveNumberedDocument({ Тип: 'ConsignmentNote' }), (error: unknown) => error instanceof SabyError && error.kind === 'validation' && !error.uncertain);
  for (const payload of [{ Тип: 'ConsignmentNote' }, { Тип: 'ConsignmentNote', Вложение: [] }, { Тип: 'ConsignmentNote', Вложение: {} }]) await assert.rejects(client.writeConsignmentNote(payload), SabyError);
  assert.equal(requests, 0);
  assert.equal((await client.readConsignmentNote('existing')).Идентификатор, 'existing'); assert.equal(requests, 1);
});
