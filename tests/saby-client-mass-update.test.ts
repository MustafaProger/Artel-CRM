import assert from 'node:assert/strict';
import test from 'node:test';
import { SabyClient, SabyError, isSabyFailureDiagnostic, type SabyObject } from '../server/saby-client';
import { integrationConfig, type IntegrationRpc } from './helpers/trip-saby-integration';

test('sender mass update changes one attachment by revision only with durable intent before HTTP', async () => {
  const events: string[] = []; const config = { ...integrationConfig(), login: 'synthetic-login', password: 'synthetic-password', accountNumber: 'sender', carrierAccountNumber: 'carrier' };
  const calls: IntegrationRpc[] = [];
  const client = new SabyClient(config, async (_url, init) => {
    events.push('http'); const request = JSON.parse(String(init?.body)) as IntegrationRpc; calls.push(request);
    assert.equal(new Headers(init?.headers).get('X-SBISSessionID'), config.sessionId);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {} }));
  });
  await client.writeTransportOrderAttachment('frozen-revision', 'frozen-title', 'original.xml', Buffer.from('<synthetic/>'), async () => { events.push('intent'); });
  assert.deepEqual(events, ['intent', 'http']);
  assert.equal(calls.length, 1); assert.equal(calls[0].method, 'СБИС.ЗаписатьВложение');
  assert.deepEqual(calls[0].params, { Документ: { Редакция: { Идентификатор: 'frozen-revision' }, Вложение: [{ Идентификатор: 'frozen-title', Файл: { Имя: 'original.xml', ДвоичныеДанные: Buffer.from('<synthetic/>').toString('base64') } }] } });
});

test('invalid mass update or failed intent never reaches HTTP', async () => {
  let calls = 0; const client = new SabyClient(integrationConfig(), async () => { calls++; throw new Error('Must not send'); });
  for (const input of [ ['', 'id', 'file.xml', Buffer.from('x')], ['rev', '', 'file.xml', Buffer.from('x')], ['rev', 'id', '../file.xml', Buffer.from('x')], ['rev', 'id', 'file.xml', Buffer.alloc(0)] ] as const) await assert.rejects(client.writeTransportOrderAttachment(...input, async () => {}), error => error instanceof SabyError && error.kind === 'validation');
  await assert.rejects(client.writeTransportOrderAttachment('rev', 'id', 'file.xml', Buffer.from('x'), async () => { throw new Error('Intent persistence failed'); }), /Intent persistence failed/);
  assert.equal(calls, 0);
});

test('mass update never retries HTTP 401 and both mutation RPCs keep controlled diagnostics', async () => {
  for (const status of [401, 500]) {
    let calls = 0; let intents = 0;
    const client = new SabyClient({ ...integrationConfig(), login: 'synthetic-login', password: 'synthetic-password', accountNumber: 'sender' }, async () => { calls++; return new Response('private response', { status }); });
    await assert.rejects(client.writeTransportOrderAttachment('rev', 'id', 'file.xml', Buffer.from('x'), async () => { intents++; }), error => {
      assert.ok(error instanceof SabyError); assert.ok(isSabyFailureDiagnostic(error.diagnostic));
      assert.deepEqual(error.diagnostic, { method: 'СБИС.ЗаписатьВложение', phase: 'response', category: status === 401 ? 'authorization' : 'transport', httpStatus: status });
      assert.equal(error.uncertain, status === 500); return true;
    });
    assert.equal(calls, 1); assert.equal(intents, 1);
  }
  const document: SabyObject = { Тип: 'TransportOrder' };
  const client = new SabyClient(integrationConfig(), async () => new Response('private response', { status: 500 }));
  await assert.rejects(client.writeDocument(document), error => error instanceof SabyError && error.diagnostic?.method === 'СБИС.ЗаписатьДокумент' && isSabyFailureDiagnostic(error.diagnostic));
});
