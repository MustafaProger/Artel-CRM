import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { continueEtrnDispatch, consignmentClientDispatchConfirmed, validateEtrnDispatch } from '../server/etrn-dispatch';
import { CONSIGNMENT_CARRIER_ACCEPTANCE } from '../server/saby-consignment-evidence';
import { serializeSabyConsignmentNote } from '../server/saby-consignment-note';
import { parseXml } from '../server/saby-order-evidence';
import { encodeWindows1251 } from '../server/saby-transport-order';
import { SabyClient, type SabyObject, type SabyConfig } from '../server/saby-client';
import { currentSnapshot } from '../server/shipment-operations';
import { saveShipmentTrip } from '../server/shipment-trips';
import { enqueueAutomaticTripSaby } from '../server/trip-saby-workflow';
import { recordDriverTripAction, readDriverTrips } from '../server/driver-trips';
import type { OperationsData, OperationsStorage } from '../server/operations-store';
import type { EtrnDocument } from '../server/etrn-service';
import type { AccountUser } from '../web/src/auth-model';
import { integrationRuntime, integrationConfig, integrationPrepare, type IntegrationRpc } from './helpers/trip-saby-integration';
import { syntheticEtrnFixture } from './helpers/etrn-fixture';

const fps = { sender: 'ab'.repeat(20), carrier: 'cd'.repeat(20) };
type Side = keyof typeof fps;
const party = (org: { inn: string; kpp: string }) => org.inn.length === 10 ? { СвЮЛ: { ИНН: org.inn, КПП: org.kpp } } : { СвФЛ: { ИНН: org.inn } };
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function fixture() {
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
  const doc: EtrnDocument = { id: 'consignment-synthetic', number: '71', status: 'draft', revision: 'revision-synthetic', url: null, remoteStatus: 'Черновик', lastError: null, gisStatus: null, signatureStatus: 'not_signed', availableActions: [], updatedAt: '2026-10-07T09:00:00.000Z', createdAt: '2026-10-07T09:00:00.000Z', marker: 'ARTEL-CRM:ETRN:synthetic', attemptId: randomUUID(), snapshot, payloadHash: hash(snapshot), artifacts: [], leaseId: null, leaseUntil: null };
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
  const t1 = serializeSabyConsignmentNote(snapshot, doc.attemptId, doc.createdAt, doc.number);
  let senderBytes = t1.xml, senderSignature = Buffer.from('synthetic');
  const parsed = parseXml(t1.xml); const content = parsed.children.find(node => typeof node !== 'string' && node.name === 'Документ')!;
  if (typeof content === 'string') throw new Error('fixture XML');
  const consignment = content.children.find(node => typeof node !== 'string' && node.name === 'СодИнфГО')!;
  if (typeof consignment === 'string') throw new Error('fixture XML');
  let t2 = Buffer.from(`<?xml version="1.0" encoding="utf-8"?><Файл ИдФайл="ON_TRNACLPPRIN_SYNTHETIC" ВерсПрог="Saby" ВерсФорм="5.01"><Документ КНД="1110340" ПоФактХЖ="Транспортная накладная, информация перевозчика о приеме груза" ДатИнфПрвПрием="01.04.2025" ВрИнфПрвПрием="11:12:13"><ИдИнфГО ИдФайлИнфГО="${parsed.attributes.ИдФайл}" ДатФайлИнфГО="${content.attributes.ДатИнфГО}" ВрФайлИнфГО="${content.attributes.ВрИнфГО}" ЭП="c3ludGhldGlj"/><СодИнфПрвПрием УИД_ТрН="${consignment.attributes.УИД_ТрН}" СодОпер="${CONSIGNMENT_CARRIER_ACCEPTANCE}"/><Подписант СтатПодп="1"><ФИО Фамилия="ПеревозчикТестовый" Имя="Тест"/></Подписант></Документ></Файл>`);
  const stage = (side: Side) => ({ Идентификатор: `stage-${side}`, Название: side === 'sender' ? 'Отправка' : 'Получение груза', Действие: [{ Название: side === 'sender' ? 'Погружен' : 'Принят', ТребуетПодписания: 'Да', Сертификат: { Отпечаток: fps[side], Ключ: { Тип: 'Отложенный', Активирован: 'Да' } } }] });
  let signedSender = false, signedCarrier = false, carrierPrepared = false, receipt = true, loss: 'prepare' | 'execute' | 'fill-accepted' | 'fill-unsent' | null = null, pending = false;
  const requests: { side: Side; req: IntegrationRpc }[] = [];
  const document = (side: Side): SabyObject => {
    const own = side === 'sender' ? config.customer : config.carrier;
    const file = (which: Side) => ({ Идентификатор: `title-${which}`, Подтип: which === 'sender' ? '1110339' : '1110340', ВерсияФормата: '5.01', Направление: which === side ? 'Исходящий' : 'Входящий', Файл: { Имя: which === 'sender' ? t1.name : 'carrier.xml', Ссылка: `https://disk.saby.ru/${which}.xml` }, ...((which === 'sender' ? signedSender : signedCarrier) ? { Подпись: [{ Сертификат: { Отпечаток: fps[which], ИНН: (which === 'sender' ? config.customer : config.carrier).inn }, Файл: { Ссылка: `https://disk.saby.ru/${which}.sgn` } }] } : {}) });
    const recipientStage = { Идентификатор: 'recipient-stage', Название: 'Приемка груза', Исполнитель: [{ Контрагент: party(snapshot.profile.recipient) }] };
    const active = signedCarrier && receipt ? recipientStage : stage(side);
    return { Идентификатор: doc.id, Тип: 'ConsignmentNote', Номер: doc.number, Дата: '01.04.2025', Направление: side === 'sender' ? 'Исходящий' : 'Входящий', НашаОрганизация: party(own), Грузоотправитель: party(config.customer), ТранспортнаяКомпания: party(config.carrier), Грузополучатель: party(snapshot.profile.recipient), Стороны: { Отправитель: party(config.customer), Перевозчик: party(config.carrier), Получатель: party(snapshot.profile.recipient) }, Редакция: [{ Идентификатор: 'revision-synthetic', Актуален: 'Да' }], Состояние: { Код: signedCarrier ? '7' : side === 'sender' && signedSender ? '4' : side === 'sender' ? '0' : '10' }, Этап: [active], ТекущиеЭтапы: [{ Идентификатор: active.Идентификатор }], Вложение: [file('sender'), ...(carrierPrepared ? [file('carrier')] : [])] };
  };
  const cert = (side: Side) => { const org = side === 'sender' ? config.customer : config.carrier; return { Certificate: { Type: 'Client', CertificateInfo: { Thumbprint: fps[side], IsValid: true, IsQualified: true, NotBefore: '2020-01-01T00:00:00Z', NotAfter: '2099-01-01T00:00:00Z', SubjectName: { '1.2.643.100.4': org.inn, '2.5.4.4': 'Тестовый', '2.5.4.42': 'Подписант' } } }, OurCompany: { Inn: org.inn, Kpp: org.kpp } }; };
  const send: typeof fetch = async (url, init) => {
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
      if (failNextRead) { failNextRead = false; crashAfterManifest = false; throw new Error('synthetic crash after saved manifest'); }
      return json(document(side));
    }
    if (req.method === 'СБИС.ПодготовитьДействие') {
      if (side === 'carrier') carrierPrepared = true;
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
  return { ...rt, tripId, shipmentId, run, saved, requests, store, config, document, snapshot,
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
