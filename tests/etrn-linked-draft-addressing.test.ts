import assert from 'node:assert/strict';
import test from 'node:test';
import { SabyClient, SabyError, sabyObject, type SabyObject } from '../server/saby-client';
import { assertLinkedDraftUpdateAddressing, dispatchLinkedDraftUpdate } from '../server/etrn-linked-draft';
import { syntheticEtrnFixture } from './helpers/etrn-fixture';

const identity = { documentId: 'original-document', originalRevision: 'original-revision' };
const update = (): SabyObject => ({
  Идентификатор: identity.documentId,
  Адресация: { Идентификатор: identity.documentId, Редакция: { Идентификатор: identity.originalRevision } },
  Вложение: [{ Идентификатор: 'original-title', Файл: { Имя: 'original.xml', ДвоичныеДанные: Buffer.from('filled').toString('base64') } }],
});

/** Model document creation independently of the client assertion: nested addressing alone is insufficient. */
function provider(beforeRequest?: () => Promise<void>) {
  const { snapshot } = syntheticEtrnFixture();
  const bodies: SabyObject[] = [];
  let creations = 0, originalContents = 'original';
  const client = new SabyClient({ sessionId: 'synthetic', customer: snapshot.customerOrganization, carrier: snapshot.carrierOrganization }, async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as SabyObject; bodies.push(body);
    assert.equal(body.method, 'СБИС.ЗаписатьДокумент');
    const document = (body.params as SabyObject).Документ as SabyObject;
    let result: SabyObject;
    if (!document.Идентификатор) {
      result = { Идентификатор: `unintended-new-document-${++creations}`, Редакция: [{ Идентификатор: 'unintended-new-revision' }] };
    } else {
      const addressing = document.Адресация as SabyObject;
      assert.equal(document.Идентификатор, identity.documentId);
      assert.equal(addressing.Идентификатор, identity.documentId);
      assert.equal((addressing.Редакция as SabyObject).Идентификатор, identity.originalRevision);
      const file = ((document.Вложение as SabyObject[])[0].Файл as SabyObject);
      originalContents = Buffer.from(String(file.ДвоичныеДанные), 'base64').toString();
      result = { Идентификатор: identity.documentId, Редакция: [{ Идентификатор: identity.originalRevision }] };
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }), { status: 200 });
  }, beforeRequest);
  return { client, bodies, state: () => ({ creations, originalContents }) };
}

test('the former nested-only request reproduces a newly created ID and leaves the original untouched', async () => {
  const p = provider(), former = update(); delete former.Идентификатор;
  const result = await p.client.call('СБИС.ЗаписатьДокумент', { Документ: former }, true, false, async () => {});
  assert.ok(sabyObject(result)); assert.equal(result.Идентификатор, 'unintended-new-document-1');
  assert.deepEqual(p.state(), { creations: 1, originalContents: 'original' });
});

test('the corrected request passes through the real serializer with both original IDs and the original revision', async () => {
  const p = provider(); let durableIntent = false;
  const result = await dispatchLinkedDraftUpdate(p.client, update(), identity, async () => { durableIntent = true; });
  assert.equal(durableIntent, true); assert.ok(sabyObject(result)); assert.equal(result.Идентификатор, identity.documentId);
  assert.deepEqual(result.Редакция, [{ Идентификатор: identity.originalRevision }]);
  assert.deepEqual((p.bodies[0].params as SabyObject).Документ, update());
  assert.deepEqual(p.state(), { creations: 0, originalContents: 'filled' });
});

test('missing, empty or conflicting selectors never reach a provider call or durable intent', async () => {
  const changes: ((request: SabyObject) => void)[] = [
    request => { delete request.Идентификатор; },
    request => { request.Идентификатор = ''; },
    request => { request.Идентификатор = 'another-document'; },
    request => { delete request.Адресация; },
    request => { (request.Адресация as SabyObject).Идентификатор = ''; },
    request => { (request.Адресация as SabyObject).Идентификатор = 'another-document'; },
    request => { delete (request.Адресация as SabyObject).Редакция; },
    request => { ((request.Адресация as SabyObject).Редакция as SabyObject).Идентификатор = ''; },
    request => { ((request.Адресация as SabyObject).Редакция as SabyObject).Идентификатор = 'another-revision'; },
    request => { request.Редакция = { Идентификатор: identity.originalRevision }; },
    request => { request.Редакция = [{ Идентификатор: 'another-revision' }]; },
  ];
  for (const change of changes) {
    const p = provider(), request = update(); let durableIntent = false; change(request);
    await assert.rejects(dispatchLinkedDraftUpdate(p.client, request, identity, async () => { durableIntent = true; }), SabyError);
    assert.equal(durableIntent, false); assert.equal(p.bodies.length, 0);
    assert.deepEqual(p.state(), { creations: 0, originalContents: 'original' });
  }
});

test('invalid saved identity cannot be used as the expected selector contract', async () => {
  for (const expected of [{ documentId: '', originalRevision: identity.originalRevision }, { ...identity, originalRevision: '' }, { ...identity, originalRevision: 'bad\nrevision' }]) {
    const p = provider(); let durableIntent = false;
    assert.throws(() => assertLinkedDraftUpdateAddressing(update(), expected), SabyError);
    await assert.rejects(dispatchLinkedDraftUpdate(p.client, update(), expected, async () => { durableIntent = true; }), SabyError);
    assert.equal(durableIntent, false); assert.equal(p.bodies.length, 0);
  }
});

test('failed durable intent stops the real transport before HTTP', async () => {
  const p = provider();
  await assert.rejects(dispatchLinkedDraftUpdate(p.client, update(), identity, async () => { throw new Error('durable intent failed'); }), /durable intent failed/);
  assert.equal(p.bodies.length, 0); assert.deepEqual(p.state(), { creations: 0, originalContents: 'original' });
});

test('caller-held references cannot switch the frozen selector contract during request preparation', async () => {
  const request = update(), expected = { ...identity };
  const p = provider(async () => {
    request.Идентификатор = 'another-document';
    ((request.Адресация as SabyObject).Редакция as SabyObject).Идентификатор = 'another-revision';
    expected.documentId = 'another-document'; expected.originalRevision = 'another-revision';
  });
  await dispatchLinkedDraftUpdate(p.client, request, expected, async () => {});
  assert.deepEqual((p.bodies[0].params as SabyObject).Документ, update());
  assert.deepEqual(p.state(), { creations: 0, originalContents: 'filled' });
});
