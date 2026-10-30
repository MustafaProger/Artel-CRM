import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { syntheticEtrnFixture, sender, carrier } from './helpers/etrn-fixture';
import { SabyClient, SabyError, sabyConfigurationBlockers, type SabyObject } from '../server/saby-client';
import { assertSigningBinding, createCarrierDraftBinding, createSigningBinding, signingManifestHash, type SabySigningCertificate } from '../server/saby-signing';
import { buildSabyConsignmentDocument, CONSIGNMENT_SENDER_OPERATION, sabyConsignmentBlockers, serializeSabyConsignmentNote } from '../server/saby-consignment-note';
import { verifyConsignmentSenderBusiness } from '../server/saby-consignment-evidence';
import { encodeWindows1251 } from '../server/saby-transport-order';

const fp = 'b'.repeat(40);
const config = { login: 'synthetic', password: 'synthetic', accountNumber: 'artel-test', carrierAccountNumber: 'nk-test', sessionId: 'artel-test-session', customer: sender, carrier,
  consignmentSigner: { surname: 'АРТЭЛЬ', name: 'Тест', patronymic: '', position: 'Директор' },
  nkConsignmentSigner: { surname: 'НК', name: 'Тест', patronymic: '', position: 'Директор' } };
const certificate: SabySigningCertificate = { thumbprint: fp, organizationInn: carrier.inn, organizationKpp: carrier.kpp, qualified: true, valid: true, notBefore: '2020-01-01T00:00:00Z', notAfter: '2099-01-01T00:00:00Z', type: 'Client', ownerName: 'Синтетический' };
const party = { СвЮЛ: { ИНН: carrier.inn, КПП: carrier.kpp } };
function remote(side: 'sender' | 'carrier'): SabyObject {
  const stage = { Идентификатор: `stage-${side}`, Название: side === 'sender' ? 'Отправка' : 'Получение груза',
    Действие: [{ Название: side === 'sender' ? 'Погружен' : 'Принят', ТребуетПодписания: 'Да', Сертификат: { Отпечаток: fp, Ключ: { Тип: 'Отложенный', Активирован: 'Да' } } }] };
  return { Идентификатор: 'direct-document', Тип: 'ConsignmentNote', Направление: 'Исходящий', НашаОрганизация: party, Грузоотправитель: party, ТранспортнаяКомпания: party,
    Редакция: [{ Идентификатор: 'revision', Актуален: 'Да' }], Состояние: { Код: side === 'sender' ? '0' : '4' },
    Этап: [stage], ТекущиеЭтапы: [{ Идентификатор: stage.Идентификатор }],
    Вложение: [{ Идентификатор: 't1', Подтип: '1110339', ВерсияФормата: '5.01', Направление: 'Исходящий',
      ...(side === 'carrier' ? { Подпись: [{ Сертификат: { Отпечаток: fp, ИНН: carrier.inn } }] } : {}) }] };
}
function fixture() {
  const { snapshot } = syntheticEtrnFixture();
  snapshot.documentMode = 'nk-direct-v1';
  snapshot.fields.organization_id = 'nk-artel';
  snapshot.customerOrganization = { ...carrier };
  snapshot.profile.order = { number: 'Без номера', date: snapshot.fields.date! };
  return snapshot;
}
const serialize = (snapshot = fixture()) => serializeSabyConsignmentNote(snapshot, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2025-04-01T09:20:30Z', '27-1').xml;

test('direct client isolates NK session and scopes both titles without altering ordinary client', async () => {
  const requests: Array<{ method: string; account?: string; session: string | null }> = [];
  let guards = 0, budgets = 0;
  const send: typeof fetch = async (_url, init) => {
    const req = JSON.parse(String(init?.body));
    requests.push({ method: req.method, account: req.params.Параметр?.НомерАккаунта, session: new Headers(init?.headers).get('X-SBISSessionID') });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: req.method === 'СБИС.Аутентифицировать' ? 'nk-test-session' : {} }));
  };
  const root = new SabyClient(config, send).withRequestGuard(async () => { guards++; }).withRequestBudget(async action => { budgets++; return action(); });
  const direct = root.forNkDirectEtrn();
  assert.equal(direct.config.customer.inn, carrier.inn);
  assert.equal(direct.config.consignmentSigner?.surname, 'НК');
  assert.equal(root.config.consignmentSigner?.surname, 'АРТЭЛЬ');
  await direct.readSigningCertificate('sender', fp);
  await direct.readSigningCertificate('carrier', fp);
  assert.equal(requests.filter(row => row.method === 'СБИС.Аутентифицировать').length, 1);
  assert.equal(requests[0].account, 'nk-test');
  assert.ok(requests.slice(1).every(row => row.session === 'nk-test-session'));
  assert.equal(guards, 3); assert.equal(budgets, 3);
  await assert.rejects(direct.writeDocument({ Тип: 'TransportOrder' }), SabyError);
  assert.equal(requests.length, 3);
  assert.ok(sabyConfigurationBlockers({ ...config, customer: carrier }).length);
  assert.deepEqual(sabyConfigurationBlockers(direct.config), []);
});

test('same-company direct signing freezes actual provider role and never creates an order binding', () => {
  const scoped = new SabyClient(config).forNkDirectEtrn().config;
  const first = createSigningBinding(remote('sender'), 'sender', certificate, scoped, 'Отложенный', 'ConsignmentNote');
  assert.equal(first.routePolicy, 'nk-direct-v1');
  const second = createCarrierDraftBinding(remote('carrier'), certificate, scoped, 'Отложенный', 'ConsignmentNote');
  assert.equal(second.documentDirection, 'Исходящий');
  assert.equal(second.actionStateCode, '4');
  assert.equal(second.attachmentSubtype, '1110340');
  assert.equal(second.organizationInn, second.counterpartyInn);
  assert.throws(() => createSigningBinding(remote('sender'), 'sender', certificate, scoped, 'Отложенный'), SabyError);
  assert.throws(() => assertSigningBinding({ ...first, routePolicy: undefined, documentDirection: undefined, actionStateCode: undefined }), SabyError);
  const files = [{ id: 't1', name: 't1.xml', subtype: '1110339', sha256: 'a'.repeat(64) }];
  assert.notEqual(signingManifestHash({ binding: first, attachments: files }), signingManifestHash({ binding: { ...first, documentDirection: 'Входящий' }, attachments: files }));
});

test('source signature download selects exact current T2 without weakening the default T1 check', async () => {
  const document = remote('carrier');
  const signature = Buffer.from('synthetic-carrier-signature');
  document.Вложение = [{ Идентификатор: 't2', Подтип: '1110340', ВерсияФормата: '5.01',
    Подпись: [{ Сертификат: { Отпечаток: fp }, Файл: { ДвоичныеДанные: signature.toString('base64') } }] }];
  let reads = 0;
  const send: typeof fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    if (request.method !== 'СБИС.Аутентифицировать') {
      assert.equal(request.method, 'СБИС.ПрочитатьДокумент'); reads++;
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id,
      result: request.method === 'СБИС.Аутентифицировать' ? 'synthetic-nk-session' : document }));
  };
  const client = new SabyClient(config, send).forNkDirectEtrn();
  assert.deepEqual(Buffer.from(await client.downloadSigningSignature('carrier', 'direct-document', 't2', 'revision', fp, 'ConsignmentNote', '1110340')), signature);
  await assert.rejects(client.downloadSigningSignature('carrier', 'direct-document', 't2', 'revision', fp, 'ConsignmentNote'), SabyError);
  await assert.rejects(client.downloadSigningSignature('carrier', 'direct-document', 't2', 'old-revision', fp, 'ConsignmentNote', '1110340'), SabyError);
  await assert.rejects(client.downloadSigningSignature('carrier', 'direct-document', 't2', 'revision', 'c'.repeat(40), 'ConsignmentNote', '1110340'), SabyError);
  assert.equal(reads, 4);
  await assert.rejects(client.downloadSigningSignature('carrier', 'direct-document', 't2', 'revision', fp, undefined, '1110340'), SabyError);
  assert.equal(reads, 4);
});

test('missing, historical, service or unsigned-source carrier stages cannot begin direct Prepare', () => {
  const scoped = new SabyClient(config).forNkDirectEtrn().config;
  for (const mutate of [
    (doc: SabyObject) => { delete doc.ТекущиеЭтапы; },
    (doc: SabyObject) => { doc.ТекущиеЭтапы = []; },
    (doc: SabyObject) => { doc.ТекущиеЭтапы = [{ Идентификатор: 'old' }]; },
    (doc: SabyObject) => { (doc.Этап as SabyObject[])[0].Служебный = 'Да'; },
    (doc: SabyObject) => { (doc.Вложение as SabyObject[])[0].Подпись = []; },
    (doc: SabyObject) => { doc.НашаОрганизация = { СвЮЛ: { ИНН: sender.inn, КПП: sender.kpp } }; },
  ]) {
    const doc = remote('carrier'); mutate(doc);
    assert.throws(() => createCarrierDraftBinding(doc, certificate, scoped, 'Отложенный', 'ConsignmentNote'), SabyError);
  }
});

test('direct XML passes FNS 5.01 with mandatory no-number attributes and no order linkage', () => {
  const snapshot = fixture();
  assert.deepEqual(sabyConsignmentBlockers(snapshot), []);
  const xml = serialize(snapshot);
  const text = new TextDecoder('windows-1251').decode(xml);
  assert.match(text, /НомЗак="Без номера" ДатаЗак="01.04.2025"/);
  assert.doesNotMatch(text, /ИдЗак|TransportOrder|SYNTHETIC-ORDER/);
  const request = buildSabyConsignmentDocument(snapshot, 'synthetic-marker', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2025-04-01T09:20:30Z', '27-1');
  assert.deepEqual(request.Грузоотправитель, request.ТранспортнаяКомпания);
  assert.notDeepEqual(request.Грузополучатель, request.ТранспортнаяКомпания);
  const folder = mkdtempSync(resolve(tmpdir(), 'nk-direct-xsd-'));
  try {
    writeFileSync(resolve(folder, 'title.xml'), xml);
    execFileSync('xmllint', ['--noout', '--schema', resolve('tests/fixtures/saby/consignment-note-1110339-5.01.xsd'), resolve(folder, 'title.xml')], { stdio: 'pipe' });
  } finally { rmSync(folder, { recursive: true, force: true }); }
  snapshot.profile.order.number = '';
  assert.ok(sabyConsignmentBlockers(snapshot).some(message => message.includes('Без номера')));
});

test('v2 direct titles preserve both saved masses, volumes, roles and dates without inventing a number or UID', () => {
  const options = { senderTitleVersion: 2 as const };
  const attempt = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const created = '2026-10-21T10:00:00.000Z';
  const folder = mkdtempSync(resolve(tmpdir(), 'nk-direct-v2-xsd-'));
  try {
    for (const [litres, tonnes, kg, volume, number] of [
      ['8000', '6.745', '6745', '8', 'SABY-SYNTHETIC-041'],
      ['9500', '7.985', '7985', '9.5', 'SABY-SYNTHETIC-042'],
    ]) {
      const snapshot = fixture();
      snapshot.fields.date = '2026-10-19';
      snapshot.fields.loading_planned_at = '2026-10-20T11:00:00';
      snapshot.fields.unloading_planned_at = '2026-10-20T17:00:00';
      snapshot.fields.quantity_litres = litres;
      snapshot.tripTotalLitres = '17500'; snapshot.tripTotalMassTonnes = '14.730';
      snapshot.profile.vehicle.capacityCubicMetres = '20';
      snapshot.profile.order.date = '2026-10-19';
      snapshot.profile.deliveryMassTonnes = tonnes;
      snapshot.profile.loading = { arrivedAt: '2026-10-20T11:28:20', departedAt: '2026-10-20T11:28:37' };
      snapshot.profile.cargo.dangerousGoods = { unNumber: '1202', shippingName: 'Синтетический опасный груз', class: '3', classificationCode: 'F1', packingGroup: 'III. Вещество с низкой степенью опасности', hazardSign: '3', tunnelCode: 'D/E' };
      const before = structuredClone(snapshot);
      assert.throws(() => serializeSabyConsignmentNote(snapshot, attempt, created, undefined, options), /не подтвердил номер/);
      assert.throws(() => buildSabyConsignmentDocument(snapshot, 'synthetic-marker', attempt, created, '', options), /не подтвердил номер/);
      const serialized = serializeSabyConsignmentNote(snapshot, attempt, created, number, options);
      const text = new TextDecoder('windows-1251').decode(serialized.xml);
      assert.equal(serialized.uid, '');
      assert.doesNotMatch(text, /УИД_ТрН=|CRM-aaaaaaaa|ИдЗак|TransportOrder/);
      assert.ok(text.includes(`СодОпер="${CONSIGNMENT_SENDER_OPERATION}"`));
      assert.match(text, /ПоФактХЖ="Транспортная накладная, информация грузоотправителя"/);
      assert.match(text, /ГрУп="III"/);
      assert.match(text, new RegExp(`НомерТрН="${number}" ДатаТрН="19.10.2026" НомЗак="Без номера" ДатаЗак="19.10.2026"`));
      assert.match(text, new RegExp(`МасБрутЗнач="${kg}"`));
      assert.match(text, new RegExp(`МасБрутОтгр="${kg}"`));
      assert.ok(text.includes(`Объем="${volume}"`));
      assert.match(text, /ФДатВрПриб="20.10.2026T11:28:20\+03:00"/);
      assert.match(text, /ФДатВрУбыт="20.10.2026T11:28:37\+03:00"/);
      const request = buildSabyConsignmentDocument(snapshot, 'synthetic-marker', attempt, created, number, options);
      assert.deepEqual(request.НашаОрганизация, request.Грузоотправитель);
      assert.deepEqual(request.Грузоотправитель, request.ТранспортнаяКомпания);
      assert.notDeepEqual(request.Грузополучатель, request.ТранспортнаяКомпания);
      assert.equal(request.Номер, number); assert.equal(request.Дата, '19.10.2026');
      const file = resolve(folder, `${litres}.xml`); writeFileSync(file, serialized.xml);
      execFileSync('xmllint', ['--noout', '--schema', resolve('tests/fixtures/saby/consignment-note-1110339-5.01.xsd'), file], { stdio: 'pipe' });
      assert.deepEqual(snapshot, before);
      const legacy = serializeSabyConsignmentNote(snapshot, attempt, created, number);
      assert.equal(legacy.uid, attempt);
      assert.match(new TextDecoder('windows-1251').decode(legacy.xml), new RegExp(`УИД_ТрН="${attempt}"`));
      assert.match(new TextDecoder('windows-1251').decode(legacy.xml), /ГрУп="III\. Вещество с низкой степенью опасности"/);
      assert.match(new TextDecoder('windows-1251').decode(legacy.xml), /СодОпер="Составление транспортной накладной грузоотправителем"/);
      assert.deepEqual(serializeSabyConsignmentNote(snapshot, attempt, created, number, {}), legacy);
    }
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('direct address policy tolerates valid changed coordinates only with exact full addresses and masses', () => {
  const snapshot = fixture();
  snapshot.fields.loading_latitude = '55.123'; snapshot.fields.loading_longitude = '37.456';
  snapshot.fields.unloading_latitude = '56.123'; snapshot.fields.unloading_longitude = '38.456';
  const frozen = serialize(snapshot);
  const text = new TextDecoder('windows-1251').decode(frozen);
  const changed = encodeWindows1251(text.replace('Широта="55.123"', 'Широта="55.124"'));
  assert.throws(() => verifyConsignmentSenderBusiness(changed, frozen), SabyError);
  verifyConsignmentSenderBusiness(changed, frozen, 'address-direct-v1');
  for (const mutation of [
    text.replace('Широта="55.123"', 'Широта="95.123"'),
    text.replace('Синтетическая площадка погрузки', 'Другой адрес'),
    text.replace('МасБрутОтгр="5123.125"', 'МасБрутОтгр="5123.126"'),
    text.replace('ИННЮЛ="0261947385"', 'ИННЮЛ="0261947386"'),
  ]) assert.throws(() => verifyConsignmentSenderBusiness(encodeWindows1251(mutation), frozen, 'address-direct-v1'), SabyError);
});

test('native adoption evidence preserves uncertain reservation provenance and requires complete verification receipt', async () => {
  const { createHash } = await import('node:crypto');
  const { validateNativeAdoptionEvidence } = await import('../server/etrn-service');
  const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const snapshot = fixture(), h = 'a'.repeat(64), at = '2026-10-21T11:00:00Z';
  const doc = {
    id: 'native-2', number: '2', senderTitleVersion: 2, snapshot, payloadHash: hash(snapshot), attemptId: 'original-unknown', marker: 'original-marker', reservationAttempted: true,
    uploadAttempted: false, artifacts: [], writeAttempts: [], nativeAdoptionEvidence: {
      version: 'native-ui-adoption-v1', origin: 'independently_created_native_ui', nativeDocumentId: 'native-2', nativeNumber: '2', nativeRevision: 'original-revision', nativeAttachmentId: 'original-title',
      nativeXmlSha256: h, nativeReadSha256: h, uiEvidenceSha256: h, planSha256: h, sourceSnapshotSha256: hash(snapshot), originalAttemptId: 'original-unknown', originalMarker: 'original-marker', originalDocumentSha256: h,
      originalReservationAttempted: true, originalReservationOutcome: 'unknown', originalWriteAttemptsCount: 0, originalWriteAttemptsSha256: hash([]), actorId: 'actor', adoptedAt: at, stage: 'planned', holdForReview: true,
    },
  } as unknown as import('../server/etrn-service').EtrnDocument;
  validateNativeAdoptionEvidence(doc);
  for (const mutate of [
    (row: typeof doc) => { row.nativeAdoptionEvidence!.holdForReview = false; },
    (row: typeof doc) => { row.reservationAttempted = false; },
    (row: typeof doc) => { row.attemptId = 'replacement-attempt'; },
    (row: typeof doc) => { row.nativeAdoptionEvidence!.originalReservationOutcome = 'not_attempted'; },
    (row: typeof doc) => { row.nativeAdoptionEvidence!.stage = 'verified'; },
    (row: typeof doc) => { row.nativeAdoptionEvidence!.verified = { at, revision: 'new', attachmentId: 'title', xmlSha256: h, remoteSha256: h }; },
  ]) { const changed = structuredClone(doc); mutate(changed); assert.throws(() => validateNativeAdoptionEvidence(changed)); }
  doc.uploadAttempted = true;
  doc.artifacts = [{ key: 'k', attachmentId: 'title', revision: 'new', name: 'title.xml', extension: 'xml', sha256: h, size: 1, content: 'eA==' }];
  Object.assign(doc.nativeAdoptionEvidence!, { stage: 'verified', verified: { at, revision: 'new', attachmentId: 'title', xmlSha256: h, remoteSha256: h } });
  validateNativeAdoptionEvidence(doc);
  doc.nativeAdoptionEvidence!.holdForReview = false;
  validateNativeAdoptionEvidence(doc);
  for (const key of ['at', 'revision', 'attachmentId', 'xmlSha256', 'remoteSha256']) {
    const changed = structuredClone(doc); delete (changed.nativeAdoptionEvidence!.verified as unknown as Record<string, unknown>)[key];
    assert.throws(() => validateNativeAdoptionEvidence(changed));
  }
  const second = structuredClone(doc); second.reservationAttempted = false;
  second.nativeAdoptionEvidence!.originalReservationAttempted = false;
  second.nativeAdoptionEvidence!.originalReservationOutcome = 'not_attempted';
  validateNativeAdoptionEvidence(second);
});

test('native sender amendment binds exact user text, source, prior grant and current attachment without replacing history', async () => {
  const { createHash } = await import('node:crypto');
  const { validateNativeSenderAmendment, nativeSenderAmendmentOptions } = await import('../server/etrn-service');
  const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const answerText = 'Принять электронное уведомление Saby';
  const snapshot = fixture(); snapshot.profile.instructions.redirectionMethod = 'По телефону';
  const documentId = '11111111-1111-4111-8111-111111111111', revision = '22222222-2222-4222-8222-222222222222', attachmentId = '33333333-3333-4333-8333-333333333333';
  const h = 'a'.repeat(64), xmlHash = 'b'.repeat(64), at = '2026-10-21T12:00:00Z';
  const direct = { attemptId: 'original-direct-attempt', authorization: { actorId: 'original-actor', mode: 'sign_and_send' }, deliveries: [{ shipmentId: snapshot.shipmentId, snapshot }] } as unknown as import('../server/nk-direct-etrn').NkDirectEtrnRecord;
  const doc = {
    id: documentId, number: '2', senderTitleVersion: 2, snapshot, payloadHash: hash(snapshot), attemptId: 'original-document-attempt', marker: 'original-marker', reservationAttempted: true,
    uploadAttempted: true, artifacts: [{ attachmentId }], writeAttempts: [], nativeAdoptionEvidence: {
      version: 'native-ui-adoption-v1', origin: 'independently_created_native_ui', nativeDocumentId: documentId, nativeNumber: '2', nativeRevision: revision, nativeAttachmentId: attachmentId,
      nativeXmlSha256: h, nativeReadSha256: h, uiEvidenceSha256: h, planSha256: h, sourceSnapshotSha256: hash(snapshot), originalAttemptId: 'original-document-attempt', originalMarker: 'original-marker', originalDocumentSha256: h,
      originalReservationAttempted: true, originalReservationOutcome: 'unknown', originalWriteAttemptsCount: 0, originalWriteAttemptsSha256: hash([]), actorId: 'original-adopter', adoptedAt: at, stage: 'verified', holdForReview: false,
      verified: { at, revision, attachmentId, xmlSha256: h, remoteSha256: h },
    },
    nativeSenderAmendment: {
      version: 'native-redirection-approval-v1', tripId: snapshot.tripId, documentId, documentNumber: '2', documentRevision: revision, attachmentId, payloadHash: hash(snapshot),
      directAttemptId: direct.attemptId, authorizationSha256: hash(direct.authorization), originalPreparedHash: null, sourceXmlSha256: h,
      beforeMethod: 'По телефону', afterMethod: 'Электронное уведомление перевозчика о переадресовке', source: 'explicit_user_instruction', answerText,
      approvalReference: 'synthetic-user-instruction-reference', recordedAt: at, approvalTextSha256: createHash('sha256').update(answerText).digest('hex'),
    },
  } as unknown as import('../server/etrn-service').EtrnDocument;
  const frozen = structuredClone({ doc, direct }); validateNativeSenderAmendment(doc, snapshot.tripId, direct); assert.deepEqual({ doc, direct }, frozen);
  for (const key of ['tripId', 'documentId', 'documentNumber', 'documentRevision', 'attachmentId', 'payloadHash', 'directAttemptId', 'authorizationSha256', 'sourceXmlSha256', 'beforeMethod', 'afterMethod', 'source', 'answerText', 'approvalTextSha256']) {
    const changed = structuredClone(doc); (changed.nativeSenderAmendment as unknown as Record<string, unknown>)[key] = 'wrong';
    assert.throws(() => validateNativeSenderAmendment(changed, snapshot.tripId, direct), key);
  }
  const otherGrant = structuredClone(direct); otherGrant.authorization.actorId = 'another-actor';
  assert.throws(() => validateNativeSenderAmendment(doc, snapshot.tripId, otherGrant));
  assert.throws(() => validateNativeSenderAmendment(doc, snapshot.tripId, undefined));
  const changedSource = structuredClone(doc); changedSource.snapshot.fields.quantity_litres = '1';
  assert.throws(() => validateNativeSenderAmendment(changedSource, snapshot.tripId, direct));
  const live = remote('sender'); live.Идентификатор = documentId; live.Номер = '2'; live.Редакция = [{ Идентификатор: revision, Актуален: 'Да' }];
  const cabinetUrl = `https://tms.saby.ru/opendoc.html?guid=${documentId}&org=234&f3=234&client=42&file=${attachmentId}&ver=1`;
  live.Вложение = [{ Идентификатор: attachmentId, Подтип: '1110339', ВерсияФормата: '5.01', Направление: 'Исходящий', Редакция: { Номер: '1' }, СсылкаВКабинет: cabinetUrl }];
  assert.equal(nativeSenderAmendmentOptions(doc, direct, live).phase, 'unprepared');
  for (const mutate of [(r:SabyObject)=>{r.Идентификатор='other';}, (r:SabyObject)=>{r.Номер='3';}, (r:SabyObject)=>{r.Редакция=[{Идентификатор:'other',Актуален:'Да'}];}, (r:SabyObject)=>{r.Вложение=[...(r.Вложение as SabyObject[]),...(r.Вложение as SabyObject[])];}]) {
    const changed = structuredClone(live); mutate(changed); assert.throws(() => nativeSenderAmendmentOptions(doc, direct, changed));
  }
  const binding = createSigningBinding(live, 'sender', certificate, new SabyClient(config).forNkDirectEtrn().config, 'Отложенный', 'ConsignmentNote');
  const attachments = [{ id: attachmentId, name: 'prepared.xml', subtype: '1110339', sha256: xmlHash }];
  const prepared = { binding, attachments, preparedHash: signingManifestHash({ binding, attachments }) };
  doc.dispatch = { version: 1, sender: { state: 'blocked', binding, prepared }, carrier: { state: 'not_started' } };
  doc.nativeSenderAmendment!.originalPreparedHash = prepared.preparedHash; doc.nativeSenderAmendment!.sourceXmlSha256 = xmlHash;
  validateNativeSenderAmendment(doc, snapshot.tripId, direct); assert.equal(nativeSenderAmendmentOptions(doc, direct, live).phase, 'prepared');
  const wrongManifest = structuredClone(doc); wrongManifest.dispatch!.sender.prepared!.preparedHash = h;
  assert.throws(() => validateNativeSenderAmendment(wrongManifest, snapshot.tripId, direct));
  const wrongBytes = structuredClone(doc); wrongBytes.dispatch!.sender.prepared!.attachments[0].sha256 = h;
  assert.throws(() => validateNativeSenderAmendment(wrongBytes, snapshot.tripId, direct));
  assert.deepEqual(direct, frozen.direct);
});
