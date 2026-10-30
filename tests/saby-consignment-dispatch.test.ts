import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { signingActionRequest } from '../server/saby-signing';
import { continueEtrnDispatch, consignmentClientDispatchConfirmed, validateEtrnDispatch } from '../server/etrn-dispatch';
import { CONSIGNMENT_CARRIER_ACCEPTANCE, NATIVE_APPROVED_REDIRECTION_METHOD } from '../server/saby-consignment-evidence';
import { serializeSabyConsignmentNote } from '../server/saby-consignment-note';
import { serializeXml, xmlChildren } from '../server/saby-carrier-details';
import { parseXml } from '../server/saby-order-evidence';
import { encodeWindows1251 } from '../server/saby-transport-order';
import { SabyClient, type SabyObject, type SabyConfig } from '../server/saby-client';
import { currentSnapshot } from '../server/shipment-operations';
import { saveShipmentTrip } from '../server/shipment-trips';
import { enqueueAutomaticTripSaby } from '../server/trip-saby-workflow';
import { recordDriverTripAction, readDriverTrips } from '../server/driver-trips';
import type { OperationsData, OperationsStorage } from '../server/operations-store';
import { verifyPreparedLinkedConsignmentTitle, type EtrnDocument } from '../server/etrn-service';
import type { AccountUser } from '../web/src/auth-model';
import { integrationRuntime, integrationConfig, integrationPrepare, type IntegrationRpc } from './helpers/trip-saby-integration';
import { syntheticEtrnFixture } from './helpers/etrn-fixture';

const fps = { sender: 'ab'.repeat(20), carrier: 'cd'.repeat(20) };
type Side = keyof typeof fps;
const party = (org: { inn: string; kpp: string }) => org.inn.length === 10 ? { СвЮЛ: { ИНН: org.inn, КПП: org.kpp } } : { СвФЛ: { ИНН: org.inn } };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function fixture(native?: 'phone' | 'electronic', alias?: 'valid' | 'title' | 'signature' | 'recipient') {
  const rt = await integrationRuntime();
  const config: SabyConfig = { ...integrationConfig(), login: 'synthetic-login', password: 'synthetic-secret', accountNumber: 'sender-account', carrierAccountNumber: 'carrier-account' };
  config.automaticSigning = { id: 'synthetic-dispatch-policy', enabled: true, approvedAt: '2026-01-01T00:00:00.000Z', mode: 'deferred', sender: { inn: config.customer.inn, kpp: config.customer.kpp, thumbprint: fps.sender }, carrier: { inn: config.carrier.inn, kpp: config.carrier.kpp, thumbprint: fps.carrier } };
  const created = await rt.store.mutate(rt.source, data => {
    data.accounts = { users: [{ id: 'actor', login: 'actor', name: 'Синтетический руководитель', role: 'director', managerId: null, active: true, version: 1, passwordHash: 'a'.repeat(128), salt: 'a'.repeat(32) }], sessions: [], attempts: {} };
    const fields = Object.fromEntries(['organization_id', 'supplier_id', 'carrier_id', 'oil_depot_id', 'product_id', 'purchase_price_unspecified_unit', 'driver_id', 'vehicle_id', 'additional_costs'].map(key => [key, rt.trip.fields[key]]));
    Object.assign(fields, { trip_flow_version: 'driver-v1', loading_at: '2026-10-07T09:15' });
    const customers = rt.trip.customers.map(row => ({ fields: Object.fromEntries(['customer_id', 'manager_id', 'payment_form_id', 'quantity_litres', 'sale_price_per_litre', 'transport_amount', 'unloading_address_id'].map(key => [key, row.fields[key]])) }));
    const result = saveShipmentTrip(rt.base, data, { fields, customers, idempotencyKey: randomUUID() }, undefined, 'actor');
    const queued = enqueueAutomaticTripSaby({ base: rt.base, data, tripId: result.trip.id, actorId: 'actor', config, prepare: integrationPrepare }); assert.equal(queued.enqueued, true);
    return { result, changed: true };
  });
  const actor: AccountUser = { id: 'driver-user', login: 'driver-user', name: 'Синтетический водитель', role: 'driver', driverId: 'driver', managerId: null, active: true, version: 1 };
  for (const action of ['arrive', 'depart'] as const) await rt.store.mutate(rt.source, data => {
    const trip = readDriverTrips(currentSnapshot(rt.base, data), actor, created.trip.id, '', data).trip!;
    return recordDriverTripAction(rt.base, data, actor, created.trip.id, action, { versions: trip.versions, ...(action === 'depart' ? { masses: trip.deliveries.map(row => ({ deliveryId: row.id, netTonnes: '5' })) } : {}) });
  });
  // Isolate this protocol unit from the separately tested order signer. Its prerequisite
  // evidence is a synthetic seed; every ETRN dispatch mutation is validated below.
  let state = await rt.store.read(rt.source);
  const tripId = created.trip.id, shipmentId = created.trip.customers[0].id;
  const workflow = state.tripSaby!.trips[tripId];
  workflow.driverFlow!.state = 'ready';
  workflow.carrierEvidence = { revision: 'order-revision' } as never;
  workflow.signing = { sender: { state: 'confirmed' }, carrier: { state: 'confirmed' } } as never;
  const snapshot = syntheticEtrnFixture().snapshot;
  snapshot.tripId = tripId; snapshot.shipmentId = shipmentId;
  if (native) snapshot.profile.instructions.redirectionMethod = native === 'phone' ? 'По телефону' : NATIVE_APPROVED_REDIRECTION_METHOD;
  const doc: EtrnDocument = { id: '11111111-1111-4111-8111-111111111111', number: '71', status: 'draft', revision: '22222222-2222-4222-8222-222222222222', url: null, remoteStatus: 'Черновик', lastError: null, gisStatus: null, signatureStatus: 'not_signed', availableActions: [], updatedAt: '2026-10-07T09:00:00.000Z', createdAt: '2026-10-07T09:00:00.000Z', marker: 'ARTEL-CRM:ETRN:synthetic', attemptId: randomUUID(), snapshot, payloadHash: hash(snapshot), artifacts: [], leaseId: null, leaseUntil: null };
  if (native) { doc.orderDraftVersion = 1; doc.senderTitleVersion = 2; }
  state.etrn!.trips[tripId].deliveries[shipmentId] = { profile: snapshot.profile, snapshot, preparedHash: hash(snapshot), document: doc, updatedAt: doc.updatedAt };
  let queue: Promise<unknown> = Promise.resolve();
  let crashAfterManifest = false, failNextRead = false;
  const store: OperationsStorage = {
    read: async () => structuredClone(state),
    mutate: async (_source, change) => {
      const pending = queue.catch(() => undefined).then(async () => {
        const next = structuredClone(state), result = await change(next);
        if (result.changed) {
          const step = next.etrn!.trips[tripId].deliveries[shipmentId].document!.dispatch?.sender;
          if (crashAfterManifest && step?.prepared && !step.verified) failNextRead = true;
          validateEtrnDispatch(next.etrn!.trips[tripId].deliveries[shipmentId].document!.dispatch, doc.id); next.revision++; state = next; }
        return result.result;
      });
      queue = pending; return pending;
    },
  };
  const t1 = serializeSabyConsignmentNote(snapshot, doc.attemptId, doc.createdAt, doc.number, { senderTitleVersion: doc.senderTitleVersion });
  let senderBytes = t1.xml, senderSignature = Buffer.from('synthetic');
  const parsed = parseXml(t1.xml); const content = parsed.children.find(node => typeof node !== 'string' && node.name === 'Документ')!;
  if (typeof content === 'string') throw new Error('fixture XML');
  const consignment = content.children.find(node => typeof node !== 'string' && node.name === 'СодИнфГО')!;
  if (typeof consignment === 'string') throw new Error('fixture XML');
  const uid = native ? '33333333-3333-4333-8333-333333333333' : consignment.attributes.УИД_ТрН;
  const attachmentIds = { sender: '44444444-4444-4444-8444-444444444444', carrier: '55555555-5555-4555-8555-555555555555' };
  const incomingId = '77777777-7777-4777-8777-777777777777';
  const incomingRevision = '88888888-8888-4888-8888-888888888888';
  const cabinetUrl = `https://tms.saby.ru/opendoc.html?guid=${alias ? incomingId : doc.id}&org=238&f3=238&client=42&file=${attachmentIds.sender}&ver=1`;
  let t2 = Buffer.from(`<?xml version="1.0" encoding="utf-8"?><Файл ИдФайл="ON_TRNACLPPRIN_SYNTHETIC" ВерсПрог="Saby" ВерсФорм="5.01"><Документ КНД="1110340" ПоФактХЖ="Транспортная накладная, информация перевозчика о приеме груза" ДатИнфПрвПрием="01.04.2025" ВрИнфПрвПрием="11:12:13"><ИдИнфГО ИдФайлИнфГО="${parsed.attributes.ИдФайл}" ДатФайлИнфГО="${content.attributes.ДатИнфГО}" ВрФайлИнфГО="${content.attributes.ВрИнфГО}" ЭП="c3ludGhldGlj"/><СодИнфПрвПрием УИД_ТрН="${uid}" СодОпер="${CONSIGNMENT_CARRIER_ACCEPTANCE}"/><Подписант СтатПодп="1"><ФИО Фамилия="ПеревозчикТестовый" Имя="Тест"/></Подписант></Документ></Файл>`);
  const stage = (side: Side) => ({ Идентификатор: `stage-${side}`, Название: side === 'sender' ? 'Отправка' : 'Получение груза', Действие: [{ Название: side === 'sender' ? 'Погружен' : 'Принят', ТребуетПодписания: 'Да', Сертификат: { Отпечаток: fps[side], Ключ: { Тип: 'Отложенный', Активирован: 'Да' } } }] });
  let signedSender = false, signedCarrier = false, carrierPrepared = false, receipt = true, loss: 'prepare' | 'execute' | 'fill-accepted' | 'fill-unsent' | null = null, pending = false;
  let regenerateCarrierTitle = false, nativeRecipientSummary = false;
  const requests: { side: Side; req: IntegrationRpc }[] = [];
  const document = (side: Side): SabyObject => {
    const own = side === 'sender' ? config.customer : config.carrier;
    const revision = side === 'carrier' && alias ? incomingRevision : doc.revision;
    const file = (which: Side) => ({ Идентификатор: attachmentIds[which], Редакция: { Идентификатор: revision, Номер: '1' }, СсылкаВКабинет: cabinetUrl, Подтип: which === 'sender' ? '1110339' : '1110340', ВерсияФормата: '5.01', Направление: which === side ? 'Исходящий' : 'Входящий', Файл: { Имя: which === 'sender' ? t1.name : 'carrier.xml', Ссылка: `https://disk.saby.ru/${which === 'sender' && side === 'carrier' && alias ? 'carrier-copy' : which}.xml` }, ...((which === 'sender' ? signedSender : signedCarrier) ? { Подпись: [{ Сертификат: { Отпечаток: fps[which], ИНН: (which === 'sender' ? config.customer : config.carrier).inn }, Файл: { Ссылка: `https://disk.saby.ru/${which === 'sender' && side === 'carrier' && alias ? 'carrier-source' : which}.sgn` } }] } : {}) });
    const recipientStage = { Идентификатор: 'recipient-stage', Название: 'Приемка груза', Исполнитель: [{ Контрагент: party(snapshot.profile.recipient) }] };
    const active = signedCarrier && receipt ? recipientStage : stage(side);
    return { Идентификатор: side === 'carrier' && alias ? incomingId : doc.id, Тип: 'ConsignmentNote', Номер: doc.number, Дата: '01.04.2025', Направление: side === 'sender' ? 'Исходящий' : 'Входящий', НашаОрганизация: party(own), Грузоотправитель: party(config.customer), ТранспортнаяКомпания: party(config.carrier), Грузополучатель: party(snapshot.profile.recipient), Стороны: { Отправитель: party(config.customer), Перевозчик: party(config.carrier), Получатель: party(alias === 'recipient' && side === 'carrier' ? config.carrier : snapshot.profile.recipient) }, Редакция: [{ Идентификатор: revision, Актуален: 'Да' }], Состояние: { Код: signedCarrier ? '7' : side === 'sender' && signedSender ? '4' : side === 'sender' ? '0' : '10' }, ...(nativeRecipientSummary && signedCarrier && side === 'sender' ? { Контрагент: party(snapshot.profile.recipient), ТекущиеЭтапы: [{ Идентификатор: active.Идентификатор, Наименование: active.Название }] } : { Этап: [active], ТекущиеЭтапы: [{ Идентификатор: active.Идентификатор }] }), Вложение: [file('sender'), ...(carrierPrepared ? [file('carrier')] : [])] };
  };
  const cert = (side: Side) => { const org = side === 'sender' ? config.customer : config.carrier; return { Certificate: { Type: 'Client', CertificateInfo: { Thumbprint: fps[side], IsValid: true, IsQualified: true, NotBefore: '2020-01-01T00:00:00Z', NotAfter: '2099-01-01T00:00:00Z', SubjectName: { '1.2.643.100.4': org.inn, '2.5.4.4': 'Тестовый', '2.5.4.42': 'Подписант' } } }, OurCompany: { Inn: org.inn, Kpp: org.kpp } }; };
  const send: typeof fetch = async (url, init) => {
    if (init?.method === 'GET' && String(url).endsWith('carrier-copy.xml') && alias === 'title') return new Response(Buffer.from('different title'));
    if (init?.method === 'GET' && String(url).endsWith('carrier-source.sgn') && alias === 'signature') return new Response(Buffer.from('different signature'));
    if (init?.method === 'GET') return new Response(String(url).endsWith('.sgn') ? senderSignature : String(url).includes('carrier.xml') ? t2 : senderBytes);
    const req = JSON.parse(String(init?.body)) as IntegrationRpc;
    const side: Side = new Headers(init?.headers).get('X-SBISSessionID') === 'synthetic-carrier-session' ? 'carrier' : 'sender';
    requests.push({ side, req });
    const json = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }));
    if (req.method === 'СБИС.Аутентифицировать') return json('synthetic-carrier-session');
    if (req.method === 'sabyCertificate.Read') return json(cert(side));
    if (req.method === 'sabyCertificate.List') return json([cert(side)]);
    if (req.method === 'СБИС.ЗаписатьВложение') {
      if (loss === 'fill-unsent') { loss = null; throw new Error('synthetic unknown unaccepted carrier fill'); }
      const files = req.params.Документ.Вложение as SabyObject[];
      t2 = Buffer.from(String((files[0].Файл as SabyObject).ДвоичныеДанные), 'base64');
      if (loss === 'fill-accepted') { loss = null; throw new Error('synthetic lost accepted carrier fill'); }
      return json(document(side));
    }
    if (req.method === 'СБИС.ПрочитатьДокумент') {
      assert.equal(req.params.Документ.Идентификатор, side === 'carrier' && alias ? incomingId : doc.id);
      if (failNextRead) { failNextRead = false; crashAfterManifest = false; throw new Error('synthetic crash after saved manifest'); }
      return json(document(side));
    }
    if (req.method === 'СБИС.ПодготовитьДействие') {
      if (side === 'carrier') {
        if (carrierPrepared && regenerateCarrierTitle) { attachmentIds.carrier = '99999999-9999-4999-8999-999999999999'; regenerateCarrierTitle = false; }
        carrierPrepared = true;
      }
      if (side === 'sender' && native) {
        const root = parseXml(senderBytes), docNode = xmlChildren(root, 'Документ')[0], info = xmlChildren(docNode, 'СодИнфГО')[0];
        info.attributes.УИД_ТрН = uid;
        xmlChildren(xmlChildren(info, 'УказГО')[0], 'СвПА')[0].attributes.СпосПерУкПА = NATIVE_APPROVED_REDIRECTION_METHOD;
        const date = docNode.attributes.ДатИнфГО.split('.').reverse().join('') + docNode.attributes.ВрИнфГО.replaceAll(':', '');
        info.children.push({ name: 'ИнфПол', attributes: { ИдФайлИнфПол: '66666666-6666-4666-8666-666666666666' }, children: [{ name: 'ТекстИнф', attributes: { Идентиф: 'Документ.СсылкаНаВложение', Значение: `${cabinetUrl}&date=${date}` }, children: [] }] });
        senderBytes = encodeWindows1251('<?xml version="1.0" encoding="windows-1251"?>' + serializeXml(root));
      }
      if (loss === 'prepare') { loss = null; throw new Error('synthetic lost Prepare'); }
      const result = document(side); (result.Этап as SabyObject[])[0].Вложение = (result.Вложение as SabyObject[]).filter(row => row.Подтип === (side === 'sender' ? '1110339' : '1110340')).map(row => ({ ...row, ТребуемоеДействие: 'Подписать' }));
      return json(result);
    }
    if (req.method === 'СБИС.ВыполнитьДействие') {
      if (!pending) { if (side === 'sender') signedSender = true; else signedCarrier = true; }
      if (loss === 'execute') { loss = null; throw new Error('synthetic lost Execute'); }
      return json(document(side));
    }
    throw new Error(`Unsupported synthetic method ${req.method}`);
  };
  const run = () => continueEtrnDispatch({ base: rt.base, store, tripId, authorize: () => undefined, client: new SabyClient(config, send) }, shipmentId);
  const saved = () => state.etrn!.trips[tripId].deliveries[shipmentId].document!;
  return { ...rt, tripId, shipmentId, run, saved, requests, store, config, document, snapshot, senderBytes: () => senderBytes,
    approveElectronic: () => {
      const w = state.tripSaby!.trips[tripId]; const answerText = 'Принять электронное уведомление для этого рейса';
      const approval = { version: 1 as const, tripId, workflowAttemptId: w.attemptId, authorizationSha256: hash(w.autoAuthorization), answerText, answerSha256: createHash('sha256').update(answerText).digest('hex'), recordedAt: new Date().toISOString() };
      state.etrn!.trips[tripId].orderRedirectionApproval = approval; saved().orderRedirectionApproval = structuredClone(approval);
    },
    completeExternalSender: () => { signedSender = true; pending = false; },
    completeExternalCarrier: () => { signedSender = true; signedCarrier = true; carrierPrepared = true; pending = false; },
    nativeSummary: () => { nativeRecipientSummary = true; },
    regenerateCarrier: () => { regenerateCarrierTitle = true; },
    failAfterManifest: () => { crashAfterManifest = true; },
    mutate: (fn: (value: OperationsData) => void) => { fn(state); },
    setReceipt: (value: boolean) => { receipt = value; }, setPending: (value: boolean) => { pending = value; }, setLoss: (value: typeof loss) => { loss = value; },
    changeSender: () => { senderBytes = encodeWindows1251(new TextDecoder('windows-1251').decode(t1.xml).replace('Синтетический груз', 'Иной синтетический груз')); },
    changeSenderSignature: () => { senderSignature = Buffer.from('different-synthetic-signature'); },
    removeCarrierAcceptance: () => { t2 = Buffer.from(t2.toString('utf8').replace(/ УИД_ТрН="[^"]*"/, '').replace(/ СодОпер="[^"]*"/, '')); },
    writes: () => requests.filter(row => ['СБИС.ПодготовитьДействие', 'СБИС.ВыполнитьДействие', 'СБИС.ЗаписатьВложение'].includes(row.req.method)),
  };
}

test('recipient completion requires one current named stage assigned to exact recipient', () => {
  const recipient = { inn: '0261947385', kpp: '026817294' };
  const stage = { Идентификатор: 'recipient-stage', Название: 'Приемка груза', Исполнитель: [{ Контрагент: party(recipient) }] };
  const remote = { Этап: [stage], ТекущиеЭтапы: [{ Идентификатор: stage.Идентификатор }] };
  assert.equal(consignmentClientDispatchConfirmed(remote, recipient), true);
  for (const value of [{ ...remote, ТекущиеЭтапы: [] }, { ...remote, Этап: [stage, stage] }, { ...remote, КоличествоОшибок: 1 }, { ...remote, ЧастичныеДанные: 'Да' }, { ...remote, Этап: [{ ...stage, Завершен: 'Да' }] }, { ...remote, Этап: [{ ...stage, Название: 'Получение груза' }] }, { ...remote, Этап: [{ ...stage, Исполнитель: [{ Контрагент: party({ ...recipient, kpp: '999999999' }) }] }] }]) assert.equal(consignmentClientDispatchConfirmed(value, recipient), false);
  assert.equal(consignmentClientDispatchConfirmed({ ...remote, Состояние: { Код: '7' }, Этап: [], ТекущиеЭтапы: [] }, recipient), false);
});

test('consignment T1 and T2 prepare and execute once, then exact recipient evidence completes dispatch', async () => {
  const f = await fixture();
  try {
    const result = await f.run(); assert.ok(result.completedAt, result.lastError ?? 'no completion');
    assert.equal(f.saved().dispatch?.sender.state, 'confirmed'); assert.equal(f.saved().dispatch?.carrier.state, 'confirmed');
    assert.deepEqual(f.writes().map(row => `${row.side}:${row.req.method}`), ['sender:СБИС.ПодготовитьДействие', 'sender:СБИС.ВыполнитьДействие', 'carrier:СБИС.ПодготовитьДействие', 'carrier:СБИС.ПодготовитьДействие', 'carrier:СБИС.ВыполнитьДействие']);
    for (const row of f.writes().filter(row => row.req.method === 'СБИС.ВыполнитьДействие')) assert.equal((((row.req.params.Документ.Этап as SabyObject).Действие as SabyObject[])[0].Название), row.side === 'sender' ? 'Погружен' : 'Принят');
    const count = f.writes().length; f.setReceipt(false);
    assert.equal((await f.run()).completedAt, result.completedAt); assert.equal(f.writes().length, count);
  } finally { await f.close(); }
});

test('both signatures without recipient assignment never complete or archive dispatch', async () => {
  const f = await fixture();
  try {
    f.setReceipt(false); const first = await f.run(); assert.equal(first.completedAt, null);
    assert.equal(f.saved().dispatch?.sender.state, 'confirmed'); assert.equal(f.saved().dispatch?.carrier.state, 'confirmed');
    assert.match(first.lastError ?? '', /приёмки|клиент/);
    const count = f.writes().length; assert.equal((await f.run()).completedAt, null); assert.equal(f.writes().length, count);
    f.setReceipt(true); assert.ok((await f.run()).completedAt); assert.equal(f.writes().length, count);
  } finally { await f.close(); }
});

test('lost preparation stays unknown without repeat; lost accepted Execute reconciles without duplicate', async () => {
  for (const loss of ['prepare', 'execute'] as const) {
    const f = await fixture();
    try {
      f.setLoss(loss); const first = await f.run(); assert.equal(first.completedAt, null);
      const initial = f.writes().filter(row => row.side === 'sender');
      assert.equal(initial.filter(row => row.req.method === 'СБИС.ПодготовитьДействие').length, 1);
      const second = await f.run();
      assert.equal(f.writes().filter(row => row.side === 'sender' && row.req.method === 'СБИС.ПодготовитьДействие').length, 1);
      assert.equal(f.writes().filter(row => row.side === 'sender' && row.req.method === 'СБИС.ВыполнитьДействие').length, loss === 'prepare' ? 0 : 1);
      if (loss === 'execute') assert.ok(second.completedAt, second.lastError ?? ''); else assert.equal(second.completedAt, null);
    } finally { await f.close(); }
  }
});

test('pending Execute and changed original title cannot trigger duplicate or carrier signature', async () => {
  const f = await fixture();
  try {
    f.setPending(true); assert.equal((await f.run()).completedAt, null); const count = f.writes().length;
    assert.equal((await f.run()).completedAt, null); assert.equal(f.writes().length, count); assert.equal(f.writes().some(row => row.side === 'carrier'), false);
    f.changeSender(); assert.equal((await f.run()).completedAt, null); assert.equal(f.writes().length, count);
    assert.equal(f.saved().dispatch?.sender.state, 'blocked');
  } finally { await f.close(); }
});

test('restart after manifest persistence before business verification cannot repeat Prepare', async () => {
  const f = await fixture();
  try {
    f.failAfterManifest(); assert.equal((await f.run()).completedAt, null);
    assert.ok(f.saved().dispatch?.sender.prepared); assert.equal(f.saved().dispatch?.sender.verified, undefined);
    assert.equal(f.writes().length, 1); assert.equal(f.writes()[0].req.method, 'СБИС.ПодготовитьДействие');
    assert.equal((await f.run()).completedAt, null); assert.equal(f.writes().length, 1);
  } finally { await f.close(); }
});

test('carrier cannot sign a reply whose source signature differs from the selected signed T1', async () => {
  const f = await fixture();
  try {
    f.changeSenderSignature(); const result = await f.run();
    assert.equal(result.completedAt, null);
    assert.equal(f.saved().dispatch?.sender.state, 'confirmed');
    assert.equal(f.saved().dispatch?.carrier.state, 'blocked');
    assert.equal(f.writes().some(row => row.side === 'carrier' && row.req.method === 'СБИС.ВыполнитьДействие'), false);
    const count = f.writes().length;
    assert.equal((await f.run()).completedAt, null); assert.equal(f.writes().length, count);
  } finally { await f.close(); }
});

test('carrier acceptance fill commits once and reconciles an uncertain response without another write', async () => {
  for (const loss of [null, 'fill-accepted', 'fill-unsent'] as const) {
    const f = await fixture();
    try {
      f.removeCarrierAcceptance(); f.setLoss(loss);
      const first = await f.run();
      assert.ok(f.saved().dispatch?.carrierFill?.attempted);
      assert.equal(f.writes().filter(row => row.req.method === 'СБИС.ЗаписатьВложение').length, 1);
      if (loss === null) assert.ok(first.completedAt, first.lastError ?? ''); else assert.equal(first.completedAt, null);
      const result = await f.run();
      assert.equal(f.writes().filter(row => row.req.method === 'СБИС.ЗаписатьВложение').length, 1);
      if (loss === 'fill-unsent') {
        assert.equal(result.completedAt, null);
        assert.equal(f.writes().some(row => row.side === 'carrier' && row.req.method === 'СБИС.ВыполнитьДействие'), false);
      } else assert.ok(result.completedAt, result.lastError ?? '');
    } finally { await f.close(); }
  }
});

test('changed consignment business snapshot is rejected before Prepare or Execute', async () => {
  const f = await fixture();
  try {
    f.changeSender(); const result = await f.run();
    assert.equal(result.completedAt, null); assert.equal(f.writes().length, 0);
    assert.equal(f.saved().dispatch?.sender.state, 'blocked');
  } finally { await f.close(); }
});

test('revoked initiator stops before any consignment network request', async () => {
  const f = await fixture();
  try {
    f.mutate(data => { data.accounts!.users[0].active = false; });
    await assert.rejects(f.run(), /доступ|отправка/i); assert.equal(f.requests.length, 0); assert.equal(f.saved().dispatch, undefined);
  } finally { await f.close(); }
});


test('new frozen electronic method signs native T1 and T2 without changing business terms', async () => {
  const f = await fixture('electronic');
  try { const result = await f.run(); assert.ok(result.completedAt, result.lastError ?? 'incomplete');
    assert.equal(f.writes().filter(r => r.side === 'sender' && r.req.method === 'СБИС.ПодготовитьДействие').length, 1);
    assert.equal(f.saved().dispatch?.carrier.state, 'confirmed');
  } finally { await f.close(); }
});

test('existing phone title resumes its exact saved manifest only after bound approval, without another Prepare', async () => {
  const f = await fixture('phone');
  try {
    assert.equal((await f.run()).completedAt, null); const manifest = structuredClone(f.saved().dispatch!.sender.prepared);
    assert.ok(manifest); assert.equal(f.saved().dispatch!.sender.executeAttempted, undefined);
    assert.equal((await f.run()).completedAt, null); assert.equal(f.writes().length, 1);
    f.approveElectronic(); const result = await f.run(); assert.ok(result.completedAt, result.lastError ?? 'incomplete');
    assert.deepEqual(f.saved().dispatch!.sender.prepared, manifest);
    assert.equal(f.writes().filter(r => r.side === 'sender' && r.req.method === 'СБИС.ПодготовитьДействие').length, 1);
    assert.equal(f.writes().filter(r => r.side === 'sender' && r.req.method === 'СБИС.ВыполнитьДействие').length, 1);
  } finally { await f.close(); }
});

test('approval cannot resume changed prepared bytes or a different authorization', async () => {
  for (const kind of ['bytes', 'grant'] as const) {
    const f = await fixture('phone');
    try { await f.run(); f.approveElectronic();
      if (kind === 'bytes') f.changeSender(); else f.mutate(data => { data.etrn!.trips[f.tripId].orderRedirectionApproval!.authorizationSha256 = 'f'.repeat(64); });
      await f.run().catch(() => undefined);
      assert.equal(f.writes().filter(r => r.req.method === 'СБИС.ВыполнитьДействие').length, 0);
      assert.equal(f.writes().filter(r => r.req.method === 'СБИС.ПодготовитьДействие').length, 1);
    } finally { await f.close(); }
  }
});


test('ordinary electronic ETRN binds distinct NK document and revision by identical signed T1', async () => {
  const f = await fixture('electronic', 'valid');
  try {
    await f.run();
    const d = f.saved();
    assert.equal(d.dispatch?.sender.state, 'confirmed');
    assert.equal(d.dispatch?.carrier.state, 'confirmed', d.dispatch?.lastError);
    assert.ok(d.dispatch?.completedAt);
    assert.equal(d.dispatch?.carrierIdentity?.documentId, '77777777-7777-4777-8777-777777777777');
    assert.equal(d.dispatch?.sender.prepared?.binding.documentId, d.id);
    assert.equal(d.dispatch?.carrier.prepared?.binding.documentId, d.dispatch?.carrierIdentity?.documentId);
    assert.equal(d.dispatch?.carrier.prepared?.binding.revision, '88888888-8888-4888-8888-888888888888');
    const writes = f.writes().length; await f.run(); assert.equal(f.writes().length, writes);
  } finally { await f.close(); }
});
for (const mismatch of ['title', 'signature', 'recipient'] as const) test(`different NK ${mismatch} blocks before any carrier write`, async () => {
  const f = await fixture('electronic', mismatch);
  try {
    await f.run();
    assert.equal(f.saved().dispatch?.sender.state, 'confirmed');
    assert.equal(f.saved().dispatch?.carrierIdentity, undefined);
    assert.equal(f.saved().dispatch?.carrier.executeAttempted, undefined);
    assert.equal(f.writes().filter(x => x.side === 'carrier').length, 0);
    assert.ok(f.saved().dispatch?.lastError);
  } finally { await f.close(); }
});

test('approved existing phone title resumes once and uses exact NK inbox copy', async () => {
  const f = await fixture('phone', 'valid');
  try {
    await f.run();
    const prepared = structuredClone(f.saved().dispatch?.sender.prepared);
    assert.ok(prepared);
    assert.equal(f.saved().dispatch?.sender.executeAttempted, undefined);
    const prepares = f.requests.filter(x => x.side === 'sender' && x.req.method === 'СБИС.ПодготовитьДействие').length;
    f.approveElectronic(); await f.run();
    assert.equal(f.saved().dispatch?.sender.state, 'confirmed');
    assert.equal(f.saved().dispatch?.carrier.state, 'confirmed', f.saved().dispatch?.lastError);
    assert.deepEqual(f.saved().dispatch?.sender.prepared, prepared);
    assert.equal(f.requests.filter(x => x.side === 'sender' && x.req.method === 'СБИС.ПодготовитьДействие').length, prepares);
  } finally { await f.close(); }
});

test('carrier identity evidence cannot be rebound to another prepared sender title', async () => {
  const f = await fixture('electronic', 'valid');
  try {
    await f.run();
    const d = structuredClone(f.saved());
    d.dispatch!.carrierIdentity!.titleSha256 = 'a'.repeat(64);
    assert.throws(() => validateEtrnDispatch(d.dispatch, d.id), /Unbound ETRN carrier identity/);
  } finally { await f.close(); }
});


test('Saby regenerated T2 is reconciled by reads and signed without repeating lost Prepare', async () => {
  const f = await fixture('electronic', 'valid');
  try {
    f.nativeSummary(); f.regenerateCarrier(); await f.run();
    const oldBinding = structuredClone(f.saved().dispatch?.carrier.binding);
    assert.ok(oldBinding);
    assert.equal(f.saved().dispatch?.carrier.prepared, undefined);
    assert.equal(f.saved().dispatch?.carrier.executeAttempted, undefined);
    const prepares = f.requests.filter(x => x.req.method === 'СБИС.ПодготовитьДействие').length;
    await f.run();
    const d = f.saved();
    assert.equal(d.dispatch?.carrier.state, 'confirmed', d.dispatch?.lastError);
    assert.ok(d.dispatch?.completedAt, d.dispatch?.lastError);
    assert.equal(d.signatureStatus, 'reported_by_saby');
    assert.equal(d.dispatch?.carrier.binding?.attachmentId, '99999999-9999-4999-8999-999999999999');
    assert.deepEqual(d.dispatch?.carrierReconciliation?.previousBinding, oldBinding);
    assert.equal(f.requests.filter(x => x.req.method === 'СБИС.ПодготовитьДействие').length, prepares);
    const writes = f.writes().length; await f.run(); assert.equal(f.writes().length, writes);
    const changed = structuredClone(d.dispatch!); changed.carrierReconciliation!.previousBinding.certificateThumbprint = 'f'.repeat(40);
    assert.throws(() => validateEtrnDispatch(changed, d.id), /Changed ETRN carrier reconciliation intent/);
  } finally { await f.close(); }
});

test('regenerated carrier title with changed acceptance never gains a manifest or Execute', async () => {
  const f = await fixture('electronic', 'valid');
  try {
    f.regenerateCarrier(); await f.run();
    const oldBinding = structuredClone(f.saved().dispatch?.carrier.binding);
    const writes = f.writes().length; f.removeCarrierAcceptance(); await f.run();
    assert.deepEqual(f.saved().dispatch?.carrier.binding, oldBinding);
    assert.equal(f.saved().dispatch?.carrier.prepared, undefined);
    assert.equal(f.saved().dispatch?.carrierReconciliation, undefined);
    assert.equal(f.saved().dispatch?.carrier.executeAttempted, undefined);
    assert.equal(f.writes().length, writes);
  } finally { await f.close(); }
});


test('native recipient summary requires verified titles, exact parties, state and one unambiguous current stage', () => {
  const recipient = { inn: '0261947385', kpp: '026817294' };
  const remote = { Тип: 'ConsignmentNote', Направление: 'Исходящий', Состояние: { Код: '4' }, Контрагент: party(recipient), Стороны: { Получатель: party(recipient) }, ТекущиеЭтапы: [{ Идентификатор: 'recipient-current', Наименование: 'Приемка груза' }] };
  assert.equal(consignmentClientDispatchConfirmed(remote, recipient), false);
  assert.equal(consignmentClientDispatchConfirmed(remote, recipient, true), true);
  for (const changed of [
    { ...remote, Контрагент: party({ ...recipient, inn: '0000000000' }) },
    { ...remote, Стороны: { Получатель: party({ ...recipient, inn: '0000000000' }) } },
    { ...remote, Состояние: { Код: '10' } }, { ...remote, ЧастичныеДанные: 'Да' },
    { ...remote, ТекущиеЭтапы: [{ Идентификатор: 'other', Наименование: 'Получение груза' }] },
    { ...remote, ТекущиеЭтапы: [...remote.ТекущиеЭтапы, ...remote.ТекущиеЭтапы] },
    { ...remote, ТекущиеЭтапы: [{ ...remote.ТекущиеЭтапы[0], Завершен: 'Да' }] },
    { ...remote, Этап: [{ Идентификатор: 'recipient-current', Название: 'Приемка груза', Исполнитель: [{ Контрагент: party({ ...recipient, inn: '0000000000' }) }] }] },
  ]) assert.equal(consignmentClientDispatchConfirmed(changed, recipient, true), false);
});


test('prepared linked refresh accepts exact verified T1 and refuses changed bytes, revision, ID or evidence', async () => {
  const f = await fixture('electronic');
  try {
    assert.ok((await f.run()).completedAt);
    const doc = structuredClone(f.saved());
    doc.linkedDraft = { writeConfirmed: true } as EtrnDocument['linkedDraft'];
    const remote = f.document('sender'), bytes = f.senderBytes();
    verifyPreparedLinkedConsignmentTitle(doc, remote, bytes);
    assert.throws(() => verifyPreparedLinkedConsignmentTitle(doc, remote, Buffer.from('changed')));
    assert.throws(() => verifyPreparedLinkedConsignmentTitle(doc, { ...remote, Идентификатор: randomUUID() }, bytes));
    assert.throws(() => verifyPreparedLinkedConsignmentTitle(doc, { ...remote, Редакция: [{ Идентификатор: randomUUID(), Актуален: 'Да' }] }, bytes));
    const unverified = structuredClone(doc); unverified.dispatch!.sender.verified = false;
    assert.throws(() => verifyPreparedLinkedConsignmentTitle(unverified, remote, bytes));
    const tampered = structuredClone(doc); tampered.dispatch!.sender.prepared!.attachments[0].sha256 = 'a'.repeat(64);
    assert.throws(() => verifyPreparedLinkedConsignmentTitle(tampered, remote, bytes));
    const business = structuredClone(doc); business.snapshot.profile.recipient.inn = '9999999999';
    assert.throws(() => verifyPreparedLinkedConsignmentTitle(business, remote, bytes));
  } finally { await f.close(); }
});


test('an externally completed NK title is adopted read-only after a stage preflight block', async () => {
  const f = await fixture('electronic', 'valid');
  try {
    f.setPending(true); await f.run();
    assert.equal(f.saved().dispatch?.sender.state, 'waiting');
    f.completeExternalCarrier(); f.nativeSummary();
    f.mutate(() => { f.saved().dispatch!.carrier = { state: 'blocked' }; });
    const before = structuredClone(f.saved()), writes = f.writes().length;
    await f.run(); const d = f.saved();
    assert.ok(d.dispatch?.completedAt, d.dispatch?.lastError);
    assert.equal(d.dispatch?.carrier.observedSignature, true);
    assert.equal(d.dispatch?.carrier.executeAttempted, undefined);
    assert.equal(d.dispatch?.carrier.dispatchState, undefined);
    assert.equal(d.dispatch?.carrier.binding?.stageId, 'observed-signed');
    assert.equal(f.writes().length, writes);
    assert.deepEqual(d.snapshot, before.snapshot); assert.deepEqual(d.dispatch?.sender.prepared, before.dispatch?.sender.prepared);
    validateEtrnDispatch(d.dispatch, d.id);
    assert.throws(() => signingActionRequest(d.dispatch!.carrier.binding!), /повторное действие запрещено/);
    await f.run(); assert.equal(f.writes().length, writes);
    for (const field of ['executeAttempted', 'dispatchState', 'observedSignature'] as const) {
      const changed = structuredClone(d.dispatch!);
      if (field === 'executeAttempted') changed.carrier.executeAttempted = true;
      else if (field === 'dispatchState') changed.carrier.dispatchState = 'acknowledged';
      else delete changed.carrier.observedSignature;
      assert.throws(() => validateEtrnDispatch(changed, d.id));
    }
  } finally { await f.close(); }
});

test('observed NK signatures reject changed acceptance and never replace an uncertain local Prepare', async () => {
  for (const mode of ['changed', 'unknown'] as const) {
    const f = await fixture('electronic', 'valid');
    try {
      f.setPending(true); await f.run();
      if (mode === 'unknown') { f.completeExternalSender(); f.setLoss('prepare'); await f.run(); assert.ok(f.saved().dispatch?.carrierDraft); }
      const before = structuredClone(f.saved().dispatch?.carrier);
      f.completeExternalCarrier(); if (mode === 'changed') f.removeCarrierAcceptance();
      const writes = f.writes().length; await f.run();
      assert.equal(f.writes().length, writes); assert.equal(f.saved().dispatch?.completedAt, undefined);
      assert.equal(f.saved().dispatch?.carrier.observedSignature, undefined);
      if (mode === 'unknown') assert.deepEqual(f.saved().dispatch?.carrier.binding, before?.binding);
    } finally { await f.close(); }
  }
});
