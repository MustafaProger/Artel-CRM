import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { SabyClient, SabyError, sabyObject, type SabyObject } from '../server/saby-client';
import { serializeSabyConsignmentNote } from '../server/saby-consignment-note';
import { encodeWindows1251 } from '../server/saby-transport-order';
import { reconcileLinkedConsignmentDraft, validateLinkedDraftState, type LinkedDraftContext, type LinkedDraftDocument } from '../server/etrn-linked-draft';
import { verifyDraftRequestedFields } from '../server/saby-consignment-draft';
import { exchangeEtrn, exchangePreparedEtrn, preparedEtrnXml, saveTripLoadingFacts, type EtrnDocument } from '../server/etrn-service';
import { OperationsStore } from '../server/operations-store';
import { saveShipmentTrip } from '../server/shipment-trips';
import { ApiError } from '../server/api-error';
import { runTripSabyWorkflow, type CreateTripSabyDelivery } from '../server/trip-saby-workflow';
import { integrationApi, integrationConfig, integrationRuntime } from './helpers/trip-saby-integration';
import { syntheticEtrnFixture } from './helpers/etrn-fixture';

function fixture() {
  const { snapshot } = syntheticEtrnFixture();
  snapshot.profile.order = { number: '19', date: '2025-04-01' };
  const serialized = serializeSabyConsignmentNote(snapshot, '00000000-0000-4000-8000-000000000001', '2025-04-01T07:00:00Z', '17');
  const emptyRecipient = '<СвГП><РекИдентГП><ИдСв/><Контакт/></РекИдентГП><АдресДостГр/></СвГП>';
  let xml = encodeWindows1251(new TextDecoder('windows-1251').decode(serialized.xml)
    .replace(/<СвГП>.*?<\/СвГП>/s, emptyRecipient)
    .replace(/ (?:ФДатВрУбыт|НалКоорТочВрФУбыт|МасБрутОтгр|КолМестПрием)="[^"]*"/g, ''));
  const party = (organization: { inn: string; kpp: string }) => ({ СвЮЛ: { ИНН: organization.inn, КПП: organization.kpp } });
  const order: SabyObject = { Идентификатор: 'synthetic-order', Тип: 'TransportOrder', Номер: '19', Дата: '01.04.2025', НашаОрганизация: party(snapshot.customerOrganization), Контрагент: party(snapshot.carrierOrganization), ДокументСледствие: [{ ВидСвязи: 'ПоОснованию', Документ: { Идентификатор: 'synthetic-note', Тип: 'ConsignmentNote', Номер: '17', Дата: '01.04.2025' } }] };
  const remote: SabyObject = { Идентификатор: 'synthetic-note', Тип: 'ConsignmentNote', Номер: '17', Дата: '01.04.2025', Направление: 'Исходящий', Примечание: '',
    НашаОрганизация: party(snapshot.customerOrganization), Грузоотправитель: party(snapshot.customerOrganization), ТранспортнаяКомпания: party(snapshot.carrierOrganization),
    Регламент: { Идентификатор: 'synthetic-regulation', Название: 'Транспортная накладная' },
    ДокументОснование: [{ ВидСвязи: 'ПоОснованию', Документ: { Идентификатор: 'synthetic-order', Тип: 'TransportOrder', Номер: '19', Дата: '01.04.2025' } }],
    Редакция: [{ Идентификатор: 'synthetic-original-revision', Актуален: 'Да' }], Состояние: { Код: '0', Название: 'Документ редактируется' },
    Вложение: [{ Идентификатор: 'synthetic-title', Подтип: '1110339', ВерсияФормата: '5.01', Удален: 'Нет', Подпись: [], Файл: { Имя: serialized.name } }],
  };
  let document: LinkedDraftDocument = { id: null, marker: 'ARTEL-CRM:ETRN:synthetic', snapshot };
  const updates: Partial<LinkedDraftDocument>[] = [], writes: SabyObject[] = [];
  let check = () => {};
  let beforeCall = () => {};
  let afterCall = () => {};
  let responseId = 'synthetic-note';
  let signatureRefreshField: string | null = null, readSequence = 0;
  class Client extends SabyClient {
    constructor() { super({ sessionId: 'synthetic-session', customer: snapshot.customerOrganization, carrier: snapshot.carrierOrganization }, async () => { throw new Error('Network forbidden'); }); }
    override async readTransportOrder(id: string) { assert.equal(id, order.Идентификатор); return structuredClone(order); }
    override async readConsignmentNote(id: string) {
      assert.equal(id, remote.Идентификатор);
      const result = structuredClone(remote);
      if (signatureRefreshField) ((result.Вложение as SabyObject[])[0]).Подпись = [{ Сертификат: { Отпечаток: 'synthetic' }, Файл: { Имя: 'sender.sgn', [signatureRefreshField]: `synthetic-${++readSequence}` } }];
      return result;
    }
    override async downloadAttachment(id: string, attachmentId: string, expectedRevision?: string | null) {
      assert.equal(id, remote.Идентификатор); assert.equal(attachmentId, 'synthetic-title');
      assert.equal(expectedRevision, (remote.Редакция as SabyObject[])[0].Идентификатор);
      return { id: attachmentId, name: String(((remote.Вложение as SabyObject[])[0].Файл as SabyObject).Имя), extension: 'xml', mimeType: 'application/xml', bytes: new Uint8Array(xml) };
    }
    override async call(method: string, params: SabyObject, writing = false, directory = false, beforeDispatch?: () => Promise<void>) {
      assert.equal(method, 'СБИС.ЗаписатьДокумент'); assert.equal(writing, true); assert.equal(directory, false);
      beforeCall();
      assert.ok(beforeDispatch); await beforeDispatch();
      const request = params.Документ as SabyObject;
      if (!request.Идентификатор) { writes.push(structuredClone(request)); return { Идентификатор: 'synthetic-unintended-new-document' }; }
      assert.equal(document.id, remote.Идентификатор); assert.equal(document.number, remote.Номер);
      assert.equal(document.linkedDraft?.writeAttempted, true); assert.equal(document.linkedDraft?.writeConfirmed, false);
      assert.deepEqual(request.Адресация, { Идентификатор: remote.Идентификатор, Редакция: { Идентификатор: document.linkedDraft.originalRevision } });
      assert.equal(request.Идентификатор, remote.Идентификатор); assert.equal(Object.hasOwn(request, 'Редакция'), false);
      writes.push(structuredClone(request));
      const file = (request.Вложение as SabyObject[])[0].Файл as SabyObject;
      xml = Buffer.from(String(file.ДвоичныеДанные), 'base64');
      remote.Грузополучатель = structuredClone(request.Грузополучатель);
      remote.Редакция = [{ Идентификатор: 'synthetic-original-revision', Актуален: 'Да' }];
      afterCall();
      return { Идентификатор: responseId };
    }
  }
  const context: LinkedDraftContext = {
    client: new Client(), order: { id: 'synthetic-order', number: '19', date: '2025-04-01' }, deliveryCount: 1,
    current: () => document, update: async patch => { updates.push(structuredClone(patch)); document = { ...document, ...structuredClone(patch) }; }, checkAccess: async () => check(),
  };
  return { snapshot, serialized, remote, order, context, writes, updates, run: () => reconcileLinkedConsignmentDraft(context), doc: () => document, xml: () => xml,
    refreshSignatureField: (field: string) => { signatureRefreshField = field; },
    replaceXml: (value: Uint8Array) => { xml = Buffer.from(value); }, restart: () => { document = JSON.parse(JSON.stringify(document)) as LinkedDraftDocument; },
    setCheck: (value: () => void) => { check = value; }, beforeCall: (value: () => void) => { beforeCall = value; }, afterCall: (value: () => void) => { afterCall = value; }, responseId: (value: string) => { responseId = value; },
  };
}

test('fills the single native linked draft once, binding and persisting immutable evidence before dispatch', async () => {
  const f = fixture(), before = Buffer.from(f.xml());
  const result = await f.run(); assert.equal(result?.Идентификатор, 'synthetic-note');
  assert.equal(f.writes.length, 1); const request = f.writes[0], state = f.doc().linkedDraft!;
  assert.equal(f.updates[0].id, 'synthetic-note'); assert.equal(f.updates[0].number, '17'); assert.equal(f.updates[0].linkedDraft?.writeAttempted, false);
  assert.deepEqual(Buffer.from(state.beforeBase64, 'base64'), before); assert.equal(state.originalMarker, ''); assert.equal(state.sourceOrderId, 'synthetic-order');
  assert.equal(state.writeAttempted, true); assert.equal(state.writeConfirmed, true); assert.ok(state.confirmedAt);
  assert.equal((f.remote.Редакция as SabyObject[])[0].Идентификатор, state.originalRevision);
  assert.deepEqual(request.ДокументОснование, f.remote.ДокументОснование); assert.deepEqual(request.Регламент, f.remote.Регламент); assert.equal(request.Примечание, '');
  assert.deepEqual(request.Адресация, { Идентификатор: 'synthetic-note', Редакция: { Идентификатор: 'synthetic-original-revision' } });
  assert.equal(request.Идентификатор, f.remote.Идентификатор); assert.equal(Object.hasOwn(request, 'Редакция'), false);
  assert.equal(((request.Вложение as SabyObject[])[0].Файл as SabyObject).Имя, f.serialized.name);
  assert.equal((request.Вложение as SabyObject[])[0].Идентификатор, 'synthetic-title');
  verifyDraftRequestedFields(f.xml(), f.snapshot, '17'); validateLinkedDraftState(state, 'synthetic-note');
  f.restart(); await f.run(); assert.equal(f.writes.length, 1);
});

test('no linked documents return null without creating or reserving any document', async () => {
  const f = fixture(); delete f.order.ДокументСледствие;
  assert.equal(await f.run(), null); assert.equal(f.writes.length, 0); assert.equal(f.updates.length, 0);
});

test('read-only refresh never adopts an unbound note or writes an unfinished bound draft', async () => {
  const f = fixture(); f.context.readOnly = true;
  await assert.rejects(f.run(), SabyError); assert.equal(f.updates.length, 0); assert.equal(f.writes.length, 0);
  const g = fixture(); g.beforeCall(() => { throw new Error('stop before dispatch'); });
  await assert.rejects(g.run(), /stop before dispatch/); assert.equal(g.doc().linkedDraft?.writeAttempted, false);
  g.context.readOnly = true; await assert.rejects(g.run(), SabyError);
  assert.equal(g.writes.length, 0); assert.equal(g.doc().linkedDraft?.writeAttempted, false);
  const h = fixture(); h.afterCall(() => { throw new SabyError('transport', 'Synthetic lost response', true); });
  await assert.rejects(h.run(), SabyError); h.context.readOnly = true;
  await h.run(); assert.equal(h.writes.length, 1); assert.equal(h.doc().linkedDraft?.writeConfirmed, true);
});

test('an existing matching recipient keeps native extra requisites and readback guards the preserved headers', async () => {
  const f = fixture();
  const recipient = { Идентификатор: 'native-recipient-id', СвЮЛ: { ИНН: f.snapshot.profile.recipient.inn, КПП: f.snapshot.profile.recipient.kpp, Название: 'Ранее сохранённое название' }, ДополнительныеРеквизиты: { Отдел: 'Синтетический отдел' } };
  f.remote.Грузополучатель = structuredClone(recipient);
  await f.run(); assert.deepEqual(f.writes[0].Грузополучатель, recipient);
  (f.remote.Грузополучатель as SabyObject).ДополнительныеРеквизиты = { Отдел: 'Изменённый отдел' };
  await assert.rejects(f.run(), SabyError); assert.equal(f.writes.length, 1);
  const g = fixture(); g.afterCall(() => { (g.remote.Грузоотправитель as SabyObject).ДругаяИнформация = 'changed'; });
  await assert.rejects(g.run(), SabyError); assert.equal(g.doc().linkedDraft?.writeConfirmed, false); assert.equal(g.writes.length, 1);
});

test('only insertion of the exact recipient into an originally empty counterpart restores the full header digest', async () => {
  for (const original of [undefined, null, {}]) {
    const f = fixture(); if (original !== undefined) f.remote.Контрагент = original;
    f.afterCall(() => {
      f.remote.Контрагент = { СвЮЛ: { ИНН: f.snapshot.profile.recipient.inn, КПП: f.snapshot.profile.recipient.kpp, Название: 'Получатель' } };
      f.remote.Ответственный = { Имя: 'Служебное дополнение' }; f.remote.Подразделение = { Название: 'Служебное дополнение' };
    });
    await f.run(); assert.equal(f.doc().linkedDraft?.writeConfirmed, true);
    const pinned = structuredClone(f.doc().linkedDraft); f.restart(); await f.run();
    assert.deepEqual(f.doc().linkedDraft, pinned); assert.equal(f.writes.length, 1);
  }
});

test('counterpart insertion refuses another recipient, a populated original counterpart or any other protected header change', async () => {
  const mutations: ((f: ReturnType<typeof fixture>) => void)[] = [
    f => { ((f.remote.Контрагент as SabyObject).СвЮЛ as SabyObject).ИНН = '0000000000'; },
    f => { ((f.remote.Контрагент as SabyObject).СвЮЛ as SabyObject).КПП = '000000000'; },
    f => { (f.remote.Грузоотправитель as SabyObject).Дополнение = 'changed'; },
    f => { (f.remote.ТранспортнаяКомпания as SabyObject).Дополнение = 'changed'; },
    f => { (f.remote.НашаОрганизация as SabyObject).Дополнение = 'changed'; },
    f => { (f.remote.Регламент as SabyObject).Название = 'changed'; },
  ];
  for (const mutate of mutations) {
    const f = fixture(); f.afterCall(() => {
      f.remote.Контрагент = { СвЮЛ: { ИНН: f.snapshot.profile.recipient.inn, КПП: f.snapshot.profile.recipient.kpp } }; mutate(f);
    });
    await assert.rejects(f.run(), SabyError); assert.equal(f.doc().linkedDraft?.writeConfirmed, false); assert.equal(f.doc().linkedDraft?.writeAttempted, true);
    f.restart(); await assert.rejects(f.run(), SabyError); assert.equal(f.writes.length, 1);
  }
  for (const original of ['other', 'matching-with-extra', 'existing-recipient-role']) {
    const f = fixture(), recipient = { СвЮЛ: { ИНН: f.snapshot.profile.recipient.inn, КПП: f.snapshot.profile.recipient.kpp } };
    if (original === 'existing-recipient-role') f.remote.Грузополучатель = structuredClone(recipient);
    else f.remote.Контрагент = original === 'other' ? { СвЮЛ: { ИНН: f.snapshot.carrierOrganization.inn, КПП: f.snapshot.carrierOrganization.kpp } } : { ...structuredClone(recipient), Дополнение: 'original' };
    f.afterCall(() => { f.remote.Контрагент = structuredClone(recipient); });
    await assert.rejects(f.run(), SabyError); assert.equal(f.doc().linkedDraft?.writeConfirmed, false); assert.equal(f.writes.length, 1);
  }
});

test('ambiguous links and multiple deliveries never bind or write a native draft', async () => {
  for (const mode of ['duplicate', 'other-note', 'multiple-deliveries', 'malformed'] as const) {
    const f = fixture();
    if (mode === 'multiple-deliveries') f.context.deliveryCount = 2;
    else (f.order.ДокументСледствие as SabyObject[]).push(mode === 'malformed' ? {} : { ВидСвязи: 'ПоОснованию', Документ: { Идентификатор: mode === 'duplicate' ? 'synthetic-note' : 'other-note', Тип: 'ConsignmentNote' } });
    await assert.rejects(f.run(), SabyError); assert.equal(f.writes.length, 0); assert.equal(f.updates.length, 0);
  }
});

test('wrong reciprocal identity, sender, carrier, number, date or marker cannot adopt a draft', async () => {
  const changes: ((f: ReturnType<typeof fixture>) => void)[] = [
    f => { f.remote.ДокументОснование = []; },
    f => { ((f.remote.ДокументОснование as SabyObject[])[0].Документ as SabyObject).Идентификатор = 'other-order'; },
    f => { (f.order.ДокументСледствие as SabyObject[])[0].Документ = { Идентификатор: 'synthetic-note', Тип: 'ConsignmentNote', Номер: 'wrong' }; },
    f => { f.remote.НашаОрганизация = { СвЮЛ: { ИНН: 'other', КПП: 'other' } }; },
    f => { f.remote.Грузоотправитель = { СвЮЛ: { ИНН: 'other', КПП: 'other' } }; },
    f => { f.remote.ТранспортнаяКомпания = { СвЮЛ: { ИНН: 'other', КПП: 'other' } }; },
    f => { f.remote.Грузополучатель = { СвЮЛ: { ИНН: 'other', КПП: 'other' } }; },
    f => { f.remote.Примечание = 'another-workflow'; },
    f => { f.remote.Дата = '02.04.2025'; },
    f => { f.order.Номер = 'wrong-order-number'; },
    f => { f.order.Дата = '02.04.2025'; },
    f => { f.doc().id = 'already-bound-other-id'; },
  ];
  for (const change of changes) {
    const f = fixture(); change(f); await assert.rejects(f.run(), SabyError); assert.equal(f.writes.length, 0); assert.equal(f.updates.length, 0);
  }
});

test('signed, non-draft, multi-file or deleted-title native documents are never modified', async () => {
  const changes: ((f: ReturnType<typeof fixture>) => void)[] = [
    f => { f.remote.Состояние = { Код: '7' }; },
    f => { f.remote.Подпись = [{ Сертификат: { Отпечаток: 'synthetic' } }]; },
    f => { (f.remote.Вложение as SabyObject[])[0].Подпись = [{ Сертификат: { Отпечаток: 'synthetic' } }]; },
    f => { f.remote.Дополнительно = { Подпись: [{ Идентификатор: 'synthetic-signature' }] }; },
    f => { (f.remote.Вложение as SabyObject[]).push({ Идентификатор: 'deleted-file', Удален: 'Да' }); },
    f => { (f.remote.Вложение as SabyObject[])[0].Удален = 'Да'; },
    f => { (f.remote.Вложение as SabyObject[])[0].ВерсияФормата = '5.00'; },
  ];
  for (const change of changes) {
    const f = fixture(); change(f); await assert.rejects(f.run(), SabyError); assert.equal(f.writes.length, 0); assert.equal(f.updates.length, 0);
  }
});

test('metadata, revision, XML, links or signatures changing immediately before dispatch block the write', async () => {
  const changes: ((f: ReturnType<typeof fixture>) => void)[] = [
    f => { f.remote.Регламент = { Идентификатор: 'another-regulation', Название: 'Другой регламент' }; },
    f => { f.remote.Редакция = [{ Идентификатор: 'another-revision', Актуален: 'Да' }]; },
    f => { f.replaceXml(encodeWindows1251(new TextDecoder('windows-1251').decode(f.xml()).replace('Синтетический груз', 'Другой груз'))); },
    f => { f.order.ДокументСледствие = []; },
    f => { (f.order.ДокументСледствие as SabyObject[]).push({ ВидСвязи: 'ПоОснованию', Документ: { Идентификатор: 'another-note', Тип: 'ConsignmentNote' } }); },
    f => { f.remote.Подпись = [{ Идентификатор: 'signature' }]; },
  ];
  for (const change of changes) {
    const f = fixture(); f.beforeCall(() => change(f));
    await assert.rejects(f.run(), SabyError); assert.equal(f.writes.length, 0); assert.equal(f.doc().linkedDraft?.writeAttempted, false); assert.equal(f.doc().id, 'synthetic-note');
  }
});

test('authorization and failed durable intent never reach an external write', async () => {
  const f = fixture(); let revoked = false;
  f.beforeCall(() => { revoked = true; }); f.setCheck(() => { if (revoked) throw new Error('access revoked'); });
  await assert.rejects(f.run(), /access revoked/); assert.equal(f.writes.length, 0); assert.equal(f.doc().linkedDraft?.writeAttempted, false);
  const g = fixture(); const update = g.context.update;
  g.context.update = async patch => { if (patch.linkedDraft?.writeAttempted) throw new Error('intent not saved'); await update(patch); };
  await assert.rejects(g.run(), /intent not saved/); assert.equal(g.writes.length, 0); assert.equal(g.doc().linkedDraft?.writeAttempted, false);
});

test('lost response after write is reconciled by reading the same filled XML after restart without retry', async () => {
  const f = fixture(); f.afterCall(() => { throw new SabyError('transport', 'Synthetic lost response', true); });
  await assert.rejects(f.run(), SabyError); assert.equal(f.writes.length, 1); assert.equal(f.doc().linkedDraft?.writeAttempted, true); assert.equal(f.doc().linkedDraft?.writeConfirmed, false);
  f.restart(); const result = await f.run(); assert.equal(result?.Идентификатор, 'synthetic-note'); assert.equal(f.writes.length, 1); assert.equal(f.doc().linkedDraft?.writeConfirmed, true);
});

test('unconfirmed attempted write with unchanged original bytes never writes again', async () => {
  const f = fixture(), before = Buffer.from(f.xml());
  f.afterCall(() => { f.replaceXml(before); delete f.remote.Грузополучатель; throw new SabyError('transport', 'Synthetic unknown result', true); });
  await assert.rejects(f.run(), SabyError); f.restart(); await assert.rejects(f.run(), SabyError);
  assert.equal(f.writes.length, 1); assert.equal(f.doc().linkedDraft?.writeConfirmed, false);
});

test('a conflicting write response retains the intended ID and prohibits another write', async () => {
  const f = fixture(); f.responseId('unexpected-id');
  await assert.rejects(f.run(), SabyError); assert.equal(f.doc().id, 'synthetic-note'); assert.equal(f.doc().linkedDraft?.writeAttempted, true);
  f.restart(); await f.run(); assert.equal(f.writes.length, 1);
});

test('a provider-created revision is not confirmed or retried even when the expected XML is present', async () => {
  const f = fixture(); f.afterCall(() => { f.remote.Редакция = [{ Идентификатор: 'unexpected-new-revision', Актуален: 'Да' }]; });
  await assert.rejects(f.run(), /Редакция существующей ЭТрН изменилась/);
  assert.equal(f.doc().id, 'synthetic-note'); assert.equal(f.doc().linkedDraft?.writeAttempted, true); assert.equal(f.doc().linkedDraft?.writeConfirmed, false);
  f.restart(); await assert.rejects(f.run(), /Редакция существующей ЭТрН изменилась/); assert.equal(f.writes.length, 1);
});

test('changing persisted document or revision identity before dispatch prevents durable intent and provider calls', async () => {
  for (const change of [
    (f: ReturnType<typeof fixture>) => { f.doc().id = 'other-document'; },
    (f: ReturnType<typeof fixture>) => { f.doc().linkedDraft!.documentId = 'other-document'; },
    (f: ReturnType<typeof fixture>) => { f.doc().linkedDraft!.originalRevision = 'other-revision'; },
  ]) {
    const f = fixture(); f.beforeCall(() => change(f)); await assert.rejects(f.run(), SabyError);
    assert.equal(f.writes.length, 0); assert.equal(f.doc().linkedDraft?.writeAttempted, false);
  }
});

test('already filled native draft is adopted through read-only proof with no write', async () => {
  const f = fixture(); f.replaceXml(f.serialized.xml);
  f.remote.Грузополучатель = { СвЮЛ: { ИНН: f.snapshot.profile.recipient.inn, КПП: f.snapshot.profile.recipient.kpp } };
  const result = await f.run(); assert.equal(result?.Идентификатор, 'synthetic-note'); assert.equal(f.writes.length, 0);
  assert.equal(f.doc().linkedDraft?.writeAttempted, false); assert.equal(f.doc().linkedDraft?.writeConfirmed, true);
});

test('confirmed native draft stays read-only after signing and adding downstream titles', async () => {
  const f = fixture(); await f.run();
  f.remote.Состояние = { Код: '7' }; f.remote.Редакция = [{ Идентификатор: 'later-signed-revision', Актуален: 'Да' }];
  (f.remote.Вложение as SabyObject[])[0].Подпись = [{ Сертификат: { Отпечаток: 'synthetic-signature' } }];
  (f.remote.Вложение as SabyObject[]).push({ Идентификатор: 'carrier-title', Подтип: '1110340', ВерсияФормата: '5.01', Файл: { Имя: 'carrier.xml' } });
  f.restart(); assert.ok(await f.run()); assert.equal(f.writes.length, 1);
  f.replaceXml(encodeWindows1251(new TextDecoder('windows-1251').decode(f.xml()).replace('Синтетический груз', 'Изменённый груз')));
  await assert.rejects(f.run(), SabyError); assert.equal(f.writes.length, 1);
});

test('stored evidence rejects changed bytes, hashes, document IDs and malformed flags', async () => {
  const f = fixture(); await f.run(); const state = f.doc().linkedDraft!;
  const changes: ((copy: Record<string, unknown>) => void)[] = [
    copy => { copy.beforeBase64 = Buffer.from('changed').toString('base64'); },
    copy => { copy.filledHash = 'f'.repeat(64); },
    copy => { copy.documentId = 'other-id'; },
    copy => { copy.originalStateCode = '7'; },
    copy => { copy.writeAttempted = 'yes'; },
    copy => { copy.confirmedAt = null; },
    copy => { copy.attachmentName = '../bad.xml'; },
    copy => { copy.secret = 'forbidden'; },
  ];
  for (const change of changes) { const copy = structuredClone(state) as unknown as Record<string, unknown>; change(copy); assert.throws(() => validateLinkedDraftState(copy, 'synthetic-note')); }
  assert.doesNotThrow(() => validateLinkedDraftState(undefined)); assert.throws(() => validateLinkedDraftState(state, null));
  assert.ok(sabyObject(state));
});

/** Start the wrapper at its accepted, driver-ready boundary with a real validated store. */
async function storeFixture() {
  const rt = await integrationRuntime(), api = integrationApi(), shipmentId = rt.trip.customers[0].id;
  const jsonHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  try {
    await rt.store.mutate(rt.source, data => ({ result: saveShipmentTrip(rt.base, data, {
      fields: rt.trip.fields, customers: [{ id: shipmentId, fields: rt.trip.customers[0].fields }],
      versions: Object.fromEntries(rt.trip.customers.map(row => [row.id, row.version])),
    }, rt.tripId), changed: true }));
    const waitingDelivery = async () => ({ status: 'error' as const, id: null, lastError: 'Synthetic loading wait', waitingForLoading: true });
    await runTripSabyWorkflow({ ...rt, client: api.client(), createDelivery: waitingDelivery }); api.accept();
    const accepted = await runTripSabyWorkflow({ ...rt, client: api.client(), createDelivery: waitingDelivery });
    assert.equal(accepted.carrierConfirmed, true);
    const facts = rt.facts(); facts.deliveries = { [shipmentId]: facts.deliveries[shipmentId] };
    await saveTripLoadingFacts({ ...rt, client: api.client() }, facts, 'synthetic-employee');
    await rt.store.mutate(rt.source, data => {
      const workflow = data.tripSaby!.trips[rt.tripId];
      assert.equal(workflow.deliveries.length, 1);
      const original = structuredClone(workflow.snapshot);
      workflow.snapshot.fields.trip_flow_version = 'driver-v1'; workflow.payloadHash = jsonHash(workflow.snapshot);
      workflow.driverFlow = { state: 'ready', processingAllowanceHours: 10, draftSnapshot: original, draftAttachment: { id: 'synthetic-original-title', revision: workflow.order.revision!, name: 'synthetic-original.xml', sha256: 'a'.repeat(64) } };
      return { result: undefined, changed: true };
    });
    const workflow = (await rt.store.read(rt.source)).tripSaby!.trips[rt.tripId];
    const order = structuredClone(api.docs.get(workflow.order.id!)!);
    order.ДокументСледствие = [{ ВидСвязи: 'ПоОснованию', Документ: { Идентификатор: 'native-store-note', Тип: 'ConsignmentNote', Номер: '17', Дата: '01.04.2025' } }];
    const input: CreateTripSabyDelivery = { shipmentId, snapshot: structuredClone(workflow.deliveries[0].snapshot), order: { id: workflow.order.id!, number: workflow.order.number!, date: workflow.order.date! }, carrierEvidence: workflow.carrierEvidence!, remoteOrder: order };
    const snapshot = structuredClone(input.snapshot); snapshot.profile.order = { number: input.order.number, date: input.order.date };
    snapshot.profile.loading = { arrivedAt: facts.arrivedAt, departedAt: facts.departedAt, ...facts.deliveries[shipmentId] };
    const serialized = serializeSabyConsignmentNote(snapshot, '00000000-0000-4000-8000-000000000001', '2025-04-01T07:00:00Z', '17');
    let xml = encodeWindows1251(new TextDecoder('windows-1251').decode(serialized.xml)
      .replace(/<СвГП>.*?<\/СвГП>/s, '<СвГП><РекИдентГП><ИдСв/><Контакт/></РекИдентГП><АдресДостГр/></СвГП>')
      .replace(/ (?:ФДатВрУбыт|НалКоорТочВрФУбыт|МасБрутОтгр|КолМестПрием)="[^"]*"/g, '')
      .replace(/<Подписант(?=[\s>])[^>]*>.*?<\/Подписант>/s, '<Подписант СтатПодп="1"/>'));
    const party = (value: { inn: string; kpp: string }) => ({ СвЮЛ: { ИНН: value.inn, КПП: value.kpp } });
    const note: SabyObject = { Идентификатор: 'native-store-note', Тип: 'ConsignmentNote', Номер: '17', Дата: '01.04.2025', Примечание: '',
      НашаОрганизация: party(snapshot.customerOrganization), Грузоотправитель: party(snapshot.customerOrganization), ТранспортнаяКомпания: party(snapshot.carrierOrganization),
      Регламент: { Идентификатор: 'native-store-regulation', Название: 'Транспортная накладная' }, Состояние: { Код: '0' },
      ДокументОснование: [{ ВидСвязи: 'ПоОснованию', Документ: { Идентификатор: input.order.id, Тип: 'TransportOrder', Номер: input.order.number, Дата: '01.04.2025' } }],
      Редакция: [{ Идентификатор: 'native-store-revision', Актуален: 'Да' }],
      Вложение: [{ Идентификатор: 'native-store-title', Подтип: '1110339', ВерсияФормата: '5.01', Файл: { Имя: serialized.name } }],
    };
    const writes: SabyObject[] = []; let reserves = 0, lookups = 0, beforeDispatchHook = async () => {};
    let store = rt.store;
    const readDocument = async () => (await store.read(rt.source)).etrn?.trips[rt.tripId]?.deliveries[shipmentId]?.document;
    class StoreClient extends SabyClient {
      constructor(private readonly guard?: () => Promise<void>) { super(integrationConfig(), async () => { throw new Error('Network forbidden'); }, guard); }
      override withRequestGuard(checkAccess: () => Promise<void>): SabyClient {
        // Keep the synthetic transport and independent lease guard on every wrapper.
        return new StoreClient(async () => { await this.guard?.(); await checkAccess(); });
      }
      override async verifyOrganizations() { await this.guard?.(); }
      override async reserveNumberedDocument(): Promise<SabyObject> { await this.guard?.(); reserves++; throw new Error('A native draft must never reserve another document'); }
      override async findDocuments() { await this.guard?.(); lookups++; return []; }
      override async readTransportOrder(id: string) { await this.guard?.(); assert.equal(id, input.order.id); return structuredClone(order); }
      override async readConsignmentNote(id: string) { await this.guard?.(); assert.equal(id, note.Идентификатор); return structuredClone(note); }
      override async downloadAttachment(id: string, attachmentId: string, revision?: string | null) {
        await this.guard?.();
        assert.equal(id, 'native-store-note'); assert.equal(attachmentId, 'native-store-title'); assert.equal(revision, 'native-store-revision');
        return { id: attachmentId, name: serialized.name, extension: 'xml', mimeType: 'application/xml', bytes: new Uint8Array(xml) };
      }
      override async call(method: string, params: SabyObject, writing = false, directory = false, beforeDispatch?: () => Promise<void>) {
        assert.equal(method, 'СБИС.ЗаписатьДокумент'); assert.equal(writing, true); assert.equal(directory, false);
        await beforeDispatchHook(); await this.guard?.(); assert.ok(beforeDispatch); await beforeDispatch();
        // Reopen OperationsStore at the dispatch boundary, independently of callback closure state.
        const durable = await new OperationsStore(resolve(rt.directory, 'store')).read(rt.source);
        const saved = durable.etrn!.trips[rt.tripId].deliveries[shipmentId].document!;
        assert.equal(saved.id, 'native-store-note'); assert.equal(saved.nativeDraftEnabled, true); assert.equal(saved.linkedDraft?.writeAttempted, true); assert.equal(saved.linkedDraft?.writeConfirmed, false);
        assert.ok(saved.leaseId); assert.ok(saved.leaseUntil && Date.parse(saved.leaseUntil) > Date.now());
        const request = params.Документ as SabyObject; writes.push(structuredClone(request));
        if (!request.Идентификатор) return { Идентификатор: 'synthetic-unintended-new-document' };
        assert.equal(request.Идентификатор, 'native-store-note');
        assert.deepEqual(request.Адресация, { Идентификатор: 'native-store-note', Редакция: { Идентификатор: 'native-store-revision' } });
        const file = (request.Вложение as SabyObject[])[0].Файл as SabyObject; xml = Buffer.from(String(file.ДвоичныеДанные), 'base64'); note.Грузополучатель = structuredClone(request.Грузополучатель);
        return { Идентификатор: 'native-store-note' };
      }
    }
    const client = new StoreClient();
    return { ...rt, client, shipmentId, input, snapshot, order, note, writes, readDocument, serialized,
      run: () => exchangePreparedEtrn({ ...rt, store, client }, input),
      refresh: () => exchangeEtrn({ ...rt, store, client }, shipmentId, true),
      restart: () => { store = new OperationsStore(resolve(rt.directory, 'store')); },
      counts: () => ({ reserves, lookups }), setBeforeDispatch: (fn: () => Promise<void>) => { beforeDispatchHook = fn; },
      seedHistoricalAttempt: async () => {
        await store.mutate(rt.source, data => {
          const at = new Date().toISOString();
          const document: EtrnDocument = { id: null, revision: null, number: undefined, status: 'unknown', url: null, remoteStatus: null, lastError: 'Synthetic historical uncertainty',
            updatedAt: at, createdAt: at, marker: `ARTEL-CRM:ETRN:${randomUUID()}`, attemptId: randomUUID(), payloadHash: jsonHash(snapshot), snapshot: structuredClone(snapshot),
            artifacts: [], signatureStatus: 'unknown', gisStatus: null, availableActions: [], leaseId: null, leaseUntil: null, reservationAttempted: true, uploadAttempted: false };
          data.etrn!.trips[rt.tripId].deliveries[shipmentId] = { profile: snapshot.profile, snapshot, preparedHash: jsonHash(snapshot), document, updatedAt: at, sourceOrderId: input.order.id };
          return { result: undefined, changed: true };
        });
      },
    };
  } catch (error) { await rt.close(); throw error; }
}


test('a delayed native link stays pending across restart and adopts the later exact note without creating another', async () => {
  const f = await storeFixture();
  try {
    const links = structuredClone(f.order.ДокументСледствие);
    f.order.ДокументСледствие = [];
    const waiting = { status: 'pending', id: null, lastError: null, waitingForNativeDraft: true };
    assert.deepEqual(await f.run(), waiting);
    const first = (await f.readDocument())!;
    assert.equal(first.reservationAttempted, false); assert.equal(first.uploadAttempted, false);
    assert.equal(first.leaseId, null); assert.equal(first.linkedDraft, undefined);
    assert.deepEqual(f.counts(), { reserves: 0, lookups: 0 }); assert.equal(f.writes.length, 0);
    f.restart(); assert.deepEqual(await f.run(), waiting);
    const second = (await f.readDocument())!;
    for (const key of ['attemptId', 'marker', 'payloadHash', 'snapshot'] as const) assert.deepEqual(second[key], first[key]);
    assert.equal(f.writes.length, 0);
    f.order.ДокументСледствие = links;
    const ready = await f.run(); assert.equal(ready.status, 'draft', ready.lastError ?? '');
    assert.equal(ready.id, 'native-store-note'); assert.equal(f.writes.length, 1);
    f.restart(); assert.equal((await f.run()).status, 'draft'); assert.equal(f.writes.length, 1);
    assert.deepEqual(f.counts(), { reserves: 0, lookups: 0 });
  } finally { await f.close(); }
});

test('ambiguous native links after a safe wait remain an error and never create or update documents', async () => {
  const f = await storeFixture();
  try {
    const links = structuredClone(f.order.ДокументСледствие) as SabyObject[];
    f.order.ДокументСледствие = [];
    assert.equal((await f.run()).waitingForNativeDraft, true);
    f.order.ДокументСледствие = [...links, ...links];
    const result = await f.run();
    assert.equal(result.status, 'error'); assert.equal(result.waitingForNativeDraft, undefined);
    assert.match(result.lastError!, /одна ЭТрН/); assert.equal(f.writes.length, 0);
    assert.deepEqual(f.counts(), { reserves: 0, lookups: 0 });
  } finally { await f.close(); }
});

test('OperationsStore wrapper adopts native driver draft once and refreshes after restart using frozen order data without reserving another document', async () => {
  const f = await storeFixture();
  try {
    const result = await f.run(); assert.equal(result.status, 'draft', result.lastError ?? ''); assert.equal(result.id, 'native-store-note');
    const doc = (await f.readDocument())!; assert.equal(doc.nativeDraftEnabled, true); assert.equal(doc.linkedDraft?.writeConfirmed, true); assert.equal(doc.leaseId, null);
    assert.deepEqual(f.counts(), { reserves: 0, lookups: 0 }); assert.equal(f.writes.length, 1);
    const data = await f.store.read(f.source), preview = preparedEtrnXml(f.base, data, f.tripId, f.shipmentId, f.client.config);
    assert.deepEqual(preview.xml, Buffer.from(doc.linkedDraft!.filledBase64, 'base64')); assert.equal(preview.name, f.serialized.name);
    assert.equal(doc.orderDraftVersion, 1); assert.equal(doc.senderTitleVersion, 2);
    assert.ok(doc.linkedDraft?.allocation);
    assert.match(new TextDecoder('windows-1251').decode(preview.xml), /<Подписант[^>]*СтатПодп="1"[^>]*><ФИО/);
    assert.notDeepEqual(preview.xml, serializeSabyConsignmentNote(doc.snapshot, doc.attemptId, doc.createdAt, doc.number).xml);
    f.restart(); await f.refresh(); await f.run();
    const refreshed = (await f.readDocument())!; assert.equal(refreshed.status, 'draft'); assert.deepEqual(refreshed.linkedDraft, doc.linkedDraft); assert.equal(refreshed.leaseId, null);
    assert.equal(f.writes.length, 1); assert.deepEqual(f.counts(), { reserves: 0, lookups: 0 });
  } finally { await f.close(); }
});

test('OperationsStore wrapper leaves historical unflagged uncertain attempts on marker-only reconciliation', async () => {
  const f = await storeFixture();
  try {
    await f.seedHistoricalAttempt(); const before = (await f.readDocument())!;
    const result = await f.run(); assert.equal(result.status, 'unknown'); assert.equal(result.id, null); assert.match(result.lastError!, /Повторное создание запрещено/);
    const after = (await f.readDocument())!; assert.equal(after.nativeDraftEnabled, undefined); assert.equal(after.linkedDraft, undefined);
    assert.equal(after.attemptId, before.attemptId); assert.equal(after.marker, before.marker); assert.equal(after.reservationAttempted, true);
    assert.equal(f.writes.length, 0); assert.deepEqual(f.counts(), { reserves: 0, lookups: 1 });
  } finally { await f.close(); }
});

test('OperationsStore wrapper blocks a lease expiring between persisted binding and dispatch without setting attempted', async () => {
  const f = await storeFixture();
  try {
    f.setBeforeDispatch(async () => {
      await f.store.mutate(f.source, data => { const doc = data.etrn!.trips[f.tripId].deliveries[f.shipmentId].document!; assert.ok(doc.linkedDraft); doc.leaseUntil = '2020-01-01T00:00:00Z'; return { result: undefined, changed: true }; });
    });
    await assert.rejects(f.run(), error => error instanceof ApiError && error.status === 409);
    const doc = (await f.readDocument())!; assert.equal(doc.id, 'native-store-note'); assert.equal(doc.linkedDraft?.writeAttempted, false); assert.equal(doc.leaseId, null);
    assert.equal(f.writes.length, 0); assert.equal(f.counts().reserves, 0);
  } finally { await f.close(); }
});


test('read-only refresh uses a verified prepared title only after the original fill was confirmed', async () => {
  const f = fixture(); await f.run();
  const old = f.xml();
  const changed = encodeWindows1251(new TextDecoder('windows-1251').decode(old).replace('ВерсПрог="', 'ВерсПрог="Prepared '));
  f.replaceXml(changed);
  let verified = 0;
  f.context.readOnly = true;
  f.context.verifyPreparedTitle = (remote, bytes) => { assert.equal(remote.Идентификатор, f.doc().id); assert.deepEqual(Buffer.from(bytes), Buffer.from(changed)); verified++; };
  await f.run(); assert.equal(verified, 1); assert.equal(f.writes.length, 1);
  f.context.verifyPreparedTitle = () => { throw new Error('changed signed title'); };
  await assert.rejects(f.run(), /changed signed title/); assert.equal(f.writes.length, 1);
  f.context.verifyPreparedTitle = () => { throw new Error('must not run before confirmed fill'); };
  f.doc().linkedDraft!.writeConfirmed = false; f.doc().linkedDraft!.confirmedAt = null;
  f.replaceXml(old); await f.run(); assert.equal(f.writes.length, 1);
});


test('signed refresh ignores rotating signature download URLs but rejects changed signature content metadata', async () => {
  const f = fixture(); await f.run(); f.context.readOnly = true;
  f.refreshSignatureField('Ссылка'); await f.run(); assert.equal(f.writes.length, 1);
  f.refreshSignatureField('Хеш'); await assert.rejects(f.run(), /изменились во время сверки/); assert.equal(f.writes.length, 1);
});
