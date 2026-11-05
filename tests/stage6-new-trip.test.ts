import { enrollTripSabyAfterDriver } from '../server/trip-saby-autostart';
import { seedLegacyDriverAttempt } from './helpers/legacy-driver-attempt';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { OperationsStore } from '../server/operations-store';
import { SabyClient, type SabyConfig, type SabyObject } from '../server/saby-client';
import { parseXml } from '../server/saby-order-evidence';
import { serializeXml, xmlChildren } from '../server/saby-carrier-details';
import { encodeWindows1251 } from '../server/saby-transport-order';
import { serializeSabyConsignmentNote } from '../server/saby-consignment-note';
import { NATIVE_APPROVED_REDIRECTION_METHOD, CONSIGNMENT_CARRIER_ACCEPTANCE } from '../server/saby-consignment-evidence';
import { runTripSabyWorkflow } from '../server/trip-saby-workflow';
import { exchangePreparedEtrn } from '../server/etrn-service';
import { currentSnapshot } from '../server/shipment-operations';
import { saveShipmentTrip } from '../server/shipment-trips';
import { recordDriverTripAction, readDriverTrips } from '../server/driver-trips';
import type { AccountUser } from '../web/src/auth-model';
import { integrationApi, integrationConfig, integrationRuntime, integrationSettings, type IntegrationRpc } from './helpers/trip-saby-integration';

const fingerprints = { sender: 'abcdef'.repeat(6) + 'abcd', carrier: 'fedcba'.repeat(6) + 'fedc' };
const vehicleIdentity = { vin: 'XTA12345678901234', stsNumber: '9900123456' };
type Side = keyof typeof fingerprints;
async function newTripFixture(options: { shipmentDate: string; documentDate: string; deliveryCount: number }, afterDriver = false) {
  const previousSettings = process.env.SABY_AUTOFILL_PROFILE_JSON;
  if (afterDriver) process.env.SABY_AUTOFILL_PROFILE_JSON = JSON.stringify(integrationSettings);
  const original = await integrationRuntime(); const baseApi = integrationApi();
  const rt = { ...original };
  const config: SabyConfig = { ...integrationConfig(), login: 'synthetic', password: 'synthetic', accountNumber: 'sender-account', carrierAccountNumber: 'carrier-account', carrierResponsible: { surname: 'Тестовый', name: 'Тест', patronymic: 'Тестович', phone: '+79990000000' } };
  config.automaticSigning = { id: 'synthetic-auto-policy', enabled: true, approvedAt: '2025-01-01T00:00:00.000Z', mode: 'deferred', sender: { inn: config.customer.inn, kpp: config.customer.kpp, thumbprint: fingerprints.sender }, carrier: { inn: config.carrier.inn, kpp: config.carrier.kpp, thumbprint: fingerprints.carrier } };
  const calls: Array<{ side: Side; req: IntegrationRpc }> = []; let carrierBytes = Buffer.alloc(0);
  let carrierDoc: SabyObject | undefined;
  const senderDoc = () => [...baseApi.docs.values()].find(d => d.Тип === 'TransportOrder')!;
  const certificate = (side: Side) => { const org = side === 'sender' ? config.customer : config.carrier; return { Certificate: { Type: 'Client', CertificateInfo: { Thumbprint: fingerprints[side], IsValid: true, IsQualified: true, NotBefore: '2020-01-01T00:00:00Z', NotAfter: '2099-01-01T00:00:00Z', SubjectName: { '1.2.643.100.4': org.inn, '2.5.4.4': 'Тестовый', '2.5.4.42': 'Подписант' } } }, OurCompany: { Inn: org.inn, Kpp: org.kpp } }; };
  const stage = (side: Side) => ({ Идентификатор: `stage-${side}`, Название: side === 'sender' ? 'Отправка' : 'Утверждение', Действие: [{ Название: side === 'sender' ? 'Отправить' : 'Утвердить', ТребуетПодписания: 'Да', Сертификат: { Отпечаток: fingerprints[side], Ключ: { Тип: 'Отложенный', Активирован: 'Да' } } }] });
  const annotate = (doc: SabyObject, side: Side) => { doc.Направление = side === 'sender' ? 'Исходящий' : 'Входящий'; doc.Этап = [stage(side)]; doc.ТекущиеЭтапы = [{ Идентификатор: stage(side).Идентификатор, Наименование: stage(side).Название }]; for (const a of doc.Вложение as SabyObject[]) a.Направление = (a.Подтип === '1110361') === (side === 'sender') ? 'Исходящий' : 'Входящий'; };
  const sign = (doc: SabyObject, side: Side) => { const files = (doc.Вложение as SabyObject[]).filter(a => a.Подтип === (side === 'sender' ? '1110361' : '1110362')); for (const file of files) file.Подпись = [{ Сертификат: { Отпечаток: fingerprints[side].toUpperCase(), ИНН: (side === 'sender' ? config.customer : config.carrier).inn }, Файл: { Ссылка: `https://disk.saby.ru/${side}.sgn` } }]; };
  async function exposeCarrier() {
    const doc = senderDoc(); delete doc.Код; doc.Состояние = { Код: '4', Название: 'Доставлено' }; sign(doc, 'sender');
    carrierDoc = structuredClone(doc); carrierDoc.НашаОрганизация = doc.Контрагент; carrierDoc.Контрагент = doc.НашаОрганизация; carrierDoc.Состояние = { Код: '10' };
    await addReply();
    annotate(carrierDoc, 'carrier');
  }
  async function addReply() {
    const doc = senderDoc();
    const source = await baseApi.send(`https://disk.saby.ru/${String(doc.Идентификатор)}.xml`, { method: 'GET' });
    const xml = parseXml(new Uint8Array(await source.arrayBuffer())); const content = xml.children.find(n => typeof n !== 'string' && n.name === 'Документ')!; assert.notEqual(typeof content, 'string'); if (typeof content === 'string') return;
    carrierBytes = Buffer.from(`<?xml version="1.0" encoding="utf-8"?><Файл ВерсПрог="synthetic" ВерсФорм="5.01" ИдФайл="ON_ZAKZVPR_SYNTHETIC"><Документ КНД="1110362" ДатИнфПрв="01.04.2025" ВрИнфПрв="12:01:00" НаимЭкСубСост="Синтетический перевозчик"><ИдИнфГО ИдФайлИнфГО="${xml.attributes.ИдФайл}" ДатФайлИнфГО="${content.attributes.ДатИнфГО}" ВрФайлИнфГО="${content.attributes.ВрИнфГО}" ЭП="c3ludGhldGlj"/><СодИнфПрв УИД_Зак="${(content.children.find(n => typeof n !== 'string' && n.name === 'СодИнфГО') as import('../server/saby-order-evidence').XmlNode).attributes.УИД_Зак}" СодОпер="1"/><ПодпИнфПрв Должн="Директор" СпосПодтПолном="1"><ФИО Фамилия="Тестовый" Имя="Подписант"/></ПодпИнфПрв></Документ></Файл>`);
    (carrierDoc!.Вложение as SabyObject[]).push({ Идентификатор: 'carrier-title', Подтип: '1110362', ВерсияФормата: '5.01', Направление: 'Исходящий', Файл: { Имя: 'carrier.xml', Ссылка: 'https://disk.saby.ru/carrier.xml' } });
  }
  type Note = { senderId: string; carrierId: string; remote: SabyObject; t1: Buffer; t2?: Buffer; name: string; signedSender: boolean; signedCarrier: boolean; uid: string; recipient: SabyObject };
  const notes = new Map<string, Note>();
  let nativeCreated = false;
  let frozenNativeSnapshots: unknown[] = [];
  const party = (org: { inn: string; kpp?: string }) => org.inn.length === 10 ? { СвЮЛ: { ИНН: org.inn, КПП: org.kpp } } : { СвФЛ: { ИНН: org.inn } };
  const noteStage = (side: Side) => ({ Идентификатор: `note-stage-${side}`, Название: side === 'sender' ? 'Отправка' : 'Получение груза', Действие: [{ Название: side === 'sender' ? 'Погружен' : 'Принят', ТребуетПодписания: 'Да', Сертификат: { Отпечаток: fingerprints[side], Ключ: { Тип: 'Отложенный', Активирован: 'Да' } } }] });
  const noteDocument = (note: Note, side: Side): SabyObject => {
    const id = String(note.remote.Идентификатор), revision = String((note.remote.Редакция as SabyObject[])[0].Идентификатор);
    const file = (which: Side) => ({ Идентификатор: which === 'sender' ? note.senderId : note.carrierId, Подтип: which === 'sender' ? '1110339' : '1110340', ВерсияФормата: '5.01', Удален: 'Нет', Редакция: { Идентификатор: revision, Номер: '1' }, Направление: which === side ? 'Исходящий' : 'Входящий', СсылкаВКабинет: `https://tms.saby.ru/opendoc.html?guid=${id}&org=238&f3=238&client=42&file=${note.senderId}&ver=1`, Файл: { Имя: which === 'sender' ? note.name : 'carrier-note.xml', Ссылка: `https://disk.saby.ru/note/${id}/${which}.xml` }, Подпись: (which === 'sender' ? note.signedSender : note.signedCarrier) ? [{ Сертификат: { Отпечаток: fingerprints[which], ИНН: (which === 'sender' ? config.customer : config.carrier).inn }, Файл: { Ссылка: `https://disk.saby.ru/note/${id}/${which}.sgn` } }] : [] });
    const active = note.signedCarrier ? { Идентификатор: `recipient-${id}`, Название: 'Приемка груза', Исполнитель: [{ Контрагент: note.recipient }] } : noteStage(side);
    return { ...structuredClone(note.remote), НашаОрганизация: party(side === 'sender' ? config.customer : config.carrier), Направление: side === 'sender' ? 'Исходящий' : 'Входящий', Состояние: { Код: note.signedCarrier ? '7' : note.signedSender ? side === 'sender' ? '4' : '10' : '0' }, Этап: [active], ТекущиеЭтапы: [{ Идентификатор: active.Идентификатор }], Вложение: [...(note.t1.length ? [file('sender')] : []), ...(note.t2 ? [file('carrier')] : [])] };
  };
  const exposeNative = async () => {
    if (nativeCreated) return;
    nativeCreated = true;
    const workflow = (await rt.store.read(rt.source)).tripSaby!.trips[rt.tripId];
    assert.equal(workflow.driverFlow?.state, 'ready');
    frozenNativeSnapshots = workflow.deliveries.map(row => structuredClone(row.snapshot));
    const order = senderDoc(), id = '11111111-1111-4111-8111-111111111111', number = '51';
    const snapshots = workflow.deliveries.map(row => { const snapshot = structuredClone(row.snapshot); snapshot.profile.order = { number: String(order.Номер), date: workflow.snapshot.fields.date }; return snapshot; });
    const serialized = snapshots.map(snapshot => serializeSabyConsignmentNote(snapshot, randomUUID(), new Date().toISOString(), number, { senderTitleVersion: 2, documentDate: options.documentDate }));
    const root = parseXml(serialized[0].xml), info = xmlChildren(xmlChildren(root, 'Документ')[0], 'СодИнфГО')[0];
    const cargo = xmlChildren(info, 'СвГруз')[0];
    cargo.children = serialized.flatMap(value => structuredClone(xmlChildren(xmlChildren(xmlChildren(parseXml(value.xml), 'Документ')[0], 'СодИнфГО')[0], 'СвГруз')[0].children));
    for (const cargoItem of xmlChildren(cargo, 'ОпГруз')) cargoItem.attributes.Объем = Number(cargoItem.attributes.Объем).toFixed(2);
    const recipient = xmlChildren(info, 'СвГП')[0], index = info.children.indexOf(recipient);
    info.children[index] = { name: 'СвГП', attributes: {}, children: [{ name: 'РекИдентГП', attributes: {}, children: [{ name: 'ИдСв', attributes: {}, children: [] }, { name: 'Контакт', attributes: {}, children: [] }] }, { name: 'АдресДостГр', attributes: {}, children: [] }] };
    const loading = xmlChildren(info, 'СвПогруз')[0];
    for (const key of ['ФДатВрУбыт', 'НалКоорТочВрФУбыт', 'МасБрутОтгр', 'КолМестПрием']) delete loading.attributes[key];
    const note: Note = { senderId: randomUUID(), carrierId: randomUUID(), remote: { Идентификатор: id, Тип: 'ConsignmentNote', Номер: number, Дата: options.documentDate, Примечание: '', НашаОрганизация: party(config.customer), Грузоотправитель: party(config.customer), ТранспортнаяКомпания: party(config.carrier), Регламент: { Идентификатор: 'synthetic-note-regulation', Название: 'Транспортная накладная' }, ДокументОснование: [{ ВидСвязи: 'ПоОснованию', Документ: { Идентификатор: order.Идентификатор, Тип: 'TransportOrder', Номер: order.Номер, Дата: order.Дата } }], Редакция: [{ Идентификатор: randomUUID(), Актуален: 'Да' }] }, t1: Buffer.from(encodeWindows1251('<?xml version="1.0" encoding="windows-1251"?>' + serializeXml(root))), name: serialized[0].name, signedSender: false, signedCarrier: false, uid: randomUUID(), recipient: party(snapshots[0].profile.recipient) };
    notes.set(id, note); order.ДокументСледствие = [{ ВидСвязи: 'ПоОснованию', Документ: { Идентификатор: id, Тип: 'ConsignmentNote', Номер: number, Дата: options.documentDate } }];
    carrierDoc!.ДокументСледствие = structuredClone(order.ДокументСледствие);
  };
  const noteRequest = async (req: IntegrationRpc, side: Side): Promise<Response | undefined> => {
    const json = (value: unknown) => baseApi.json(req, value), input = req.params.Документ;
    if (req.method === 'СБИС.СписокДокументов' && req.params.Фильтр.Тип === 'ConsignmentNote') return json({ Документ: [...notes.values()].map(note => noteDocument(note, side)), Навигация: { ЕстьЕще: 'Нет', РазмерСтраницы: '200', Страница: '0' } });
    let note = input && (notes.get(String(input.Идентификатор)) ?? [...notes.values()].find(row => (row.remote.Редакция as SabyObject[])[0].Идентификатор === (input.Редакция as SabyObject | undefined)?.Идентификатор));
    if (req.method === 'СБИС.ЗаписатьВложение') {
      const revision = (input.Редакция as SabyObject).Идентификатор;
      note = [...notes.values()].find(row => (row.remote.Редакция as SabyObject[])[0].Идентификатор === revision);
      if (!note) return;
      const file = (input.Вложение as SabyObject[])[0], bytes = Buffer.from(String((file.Файл as SabyObject).ДвоичныеДанные), 'base64');
      if (file.Идентификатор === note.carrierId) note.t2 = bytes; else note.t1 = bytes;
      return json(noteDocument(note, side));
    }
    if (req.method === 'СБИС.ЗаписатьДокумент' && input.Тип === 'ConsignmentNote') {
      if (!note) {
        assert.equal(input.Идентификатор, undefined);
        const id = randomUUID(); note = { senderId: randomUUID(), carrierId: randomUUID(), remote: { ...structuredClone(input), Идентификатор: id, Номер: String(51 + notes.size), Редакция: [{ Идентификатор: randomUUID(), Актуален: 'Да' }] }, t1: Buffer.alloc(0), name: '', signedSender: false, signedCarrier: false, uid: randomUUID(), recipient: structuredClone(input.Грузополучатель) as SabyObject };
        notes.set(id, note);
        const link = { ВидСвязи: 'ПоОснованию', Документ: { Идентификатор: id, Тип: 'ConsignmentNote', Номер: note.remote.Номер, Дата: note.remote.Дата } };
        (senderDoc().ДокументСледствие as SabyObject[]).push(link); carrierDoc!.ДокументСледствие = structuredClone(senderDoc().ДокументСледствие);
      } else {
        const revision = note.remote.Редакция;
        Object.assign(note.remote, structuredClone(input)); note.remote.Редакция = revision;
        if (input.Грузополучатель) note.recipient = structuredClone(input.Грузополучатель) as SabyObject;
      }
      if (input.Вложение) { const file = ((input.Вложение as SabyObject[])[0].Файл as SabyObject); note.t1 = Buffer.from(String(file.ДвоичныеДанные), 'base64'); note.name = String(file.Имя); }
      return json(noteDocument(note, side));
    }
    if (!note) return;
    if (req.method === 'СБИС.ПрочитатьДокумент') return json(noteDocument(note, side));
    if (req.method === 'СБИС.ПодготовитьДействие') {
      if (side === 'sender') {
        const root = parseXml(note.t1), doc = xmlChildren(root, 'Документ')[0], info = xmlChildren(doc, 'СодИнфГО')[0];
        info.attributes.УИД_ТрН = note.uid;
        xmlChildren(xmlChildren(info, 'УказГО')[0], 'СвПА')[0].attributes.СпосПерУкПА = NATIVE_APPROVED_REDIRECTION_METHOD;
        const date = doc.attributes.ДатИнфГО.split('.').reverse().join('') + doc.attributes.ВрИнфГО.replaceAll(':', '');
        info.children.push({ name: 'ИнфПол', attributes: { ИдФайлИнфПол: randomUUID() }, children: [{ name: 'ТекстИнф', attributes: { Идентиф: 'Документ.СсылкаНаВложение', Значение: `https://tms.saby.ru/opendoc.html?guid=${note.remote.Идентификатор}&org=238&f3=238&client=42&file=${note.senderId}&ver=1&date=${date}` }, children: [] }] });
        note.t1 = Buffer.from(encodeWindows1251('<?xml version="1.0" encoding="windows-1251"?>' + serializeXml(root)));
      } else if (!note.t2) {
        const root = parseXml(note.t1), doc = xmlChildren(root, 'Документ')[0];
        note.t2 = Buffer.from(`<?xml version="1.0" encoding="utf-8"?><Файл ИдФайл="ON_TRNACLPPRIN_${note.remote.Идентификатор}" ВерсПрог="Saby" ВерсФорм="5.01"><Документ КНД="1110340" ПоФактХЖ="Транспортная накладная, информация перевозчика о приеме груза" ДатИнфПрвПрием="${options.documentDate}" ВрИнфПрвПрием="11:12:13"><ИдИнфГО ИдФайлИнфГО="${root.attributes.ИдФайл}" ДатФайлИнфГО="${doc.attributes.ДатИнфГО}" ВрФайлИнфГО="${doc.attributes.ВрИнфГО}" ЭП="c3ludGhldGlj"/><СодИнфПрвПрием УИД_ТрН="${note.uid}" СодОпер="${CONSIGNMENT_CARRIER_ACCEPTANCE}"/><Подписант СтатПодп="1"><ФИО Фамилия="Тестовый" Имя="Подписант"/></Подписант></Документ></Файл>`);
      }
      const result = noteDocument(note, side);
      (result.Этап as SabyObject[])[0].Вложение = (result.Вложение as SabyObject[]).filter(file => file.Подтип === (side === 'sender' ? '1110339' : '1110340')).map(file => ({ ...file, ТребуемоеДействие: 'Подписать' }));
      return json(result);
    }
    if (req.method === 'СБИС.ВыполнитьДействие') { if (side === 'sender') note.signedSender = true; else note.signedCarrier = true; return json(noteDocument(note, side)); }
    throw new Error(`Unexpected native simulator request ${req.method}`);
  };

  const send: typeof fetch = async (url, init) => {
    if (init?.method === 'GET' && String(url).includes('/note/')) {
      const [, id, file] = new URL(String(url)).pathname.split('/').filter(Boolean); const note = notes.get(id); assert.ok(note);
      return new Response(file.endsWith('.sgn') ? Buffer.from('synthetic') : file === 'sender.xml' ? note.t1 : note.t2);
    }
    if (init?.method === 'GET' && String(url).endsWith('.sgn')) return new Response(Buffer.from('synthetic'));
    if (init?.method === 'GET') return String(url).includes('carrier.xml') ? new Response(carrierBytes) : baseApi.send(url, init);
    const req = JSON.parse(String(init?.body)) as IntegrationRpc;
    const side: Side = new Headers(init?.headers).get('X-SBISSessionID') === 'carrier-session' ? 'carrier' : 'sender';
    calls.push({ side, req });
    const json = (value: unknown) => baseApi.json(req, value);
    const noteResponse = await noteRequest(req, side); if (noteResponse) return noteResponse;
    if (req.method === 'СБИС.Аутентифицировать') return json('carrier-session');
    if (req.method === 'sabyCertificate.List') return json([certificate(side)]);
    if (req.method === 'sabyCertificate.Read') return json(certificate(side));
    if (req.method === 'СБИС.ПрочитатьДокумент' && side === 'carrier') return json(carrierDoc);
    if (req.method === 'СБИС.ЗаписатьВложение' && side === 'carrier') { carrierBytes = Buffer.from(String(((req.params.Документ.Вложение as SabyObject[])[0].Файл as SabyObject).ДвоичныеДанные), 'base64'); return json(carrierDoc); }
    if (req.method === 'СБИС.ПодготовитьДействие') {
      if (side === 'carrier' && !(carrierDoc!.Вложение as SabyObject[]).some(a => a.Подтип === '1110362')) await addReply();
      const doc = structuredClone(side === 'sender' ? senderDoc() : carrierDoc!);
      const resultStage = (doc.Этап as SabyObject[])[0]; resultStage.Вложение = (doc.Вложение as SabyObject[]).filter(a => a.Подтип === (side === 'sender' ? '1110361' : '1110362')).map(a => ({ ...a, ТребуемоеДействие: 'Подписать' }));
      return json(doc);
    }
    if (req.method === 'СБИС.ВыполнитьДействие') {
      if (side === 'sender') await exposeCarrier();
        else { sign(carrierDoc!, 'carrier'); carrierDoc!.Состояние = { Код: '7' }; senderDoc().Состояние = { Код: '7' }; const reply = structuredClone((carrierDoc!.Вложение as SabyObject[]).find(a => a.Подтип === '1110362')!); reply.Направление = 'Входящий'; (senderDoc().Вложение as SabyObject[]).push(reply); await exposeNative(); }
      return json(side === 'sender' ? senderDoc() : carrierDoc);
    }
    const result = await baseApi.send(url, init);
    if (req.method === 'СБИС.ЗаписатьДокумент') { annotate(senderDoc(), 'sender'); senderDoc().Состояние = { Код: '0' }; delete senderDoc().Код; }
    return result;
  };
  await rt.store.mutate(rt.source, data => {
    data.accounts = { users: [{ id: 'actor', login: 'actor', name: 'Тестовый сотрудник', role: 'director', managerId: null, active: true, version: 1, passwordHash: 'a'.repeat(128), salt: 'a'.repeat(32) }, { id: 'owner', login: 'owner', name: 'Другой директор', role: 'director', managerId: null, active: true, version: 1, passwordHash: 'b'.repeat(128), salt: 'b'.repeat(32) }], sessions: [], attempts: {} };
    Object.assign(data.directories!.drivers[0], { inn: '010000000102', licenseSeries: '9900', licenseNumber: '123456', licenseIssuedAt: '2024-01-01' });
    Object.assign(data.directories!.vehicles[0], { vin: vehicleIdentity.vin, stsSeries: '9900', stsNumber: '123456' });
    return { changed: true, result: null };
  });
  const created = await rt.store.mutate(rt.source, data => {
    const fields = Object.fromEntries(['organization_id', 'supplier_id', 'carrier_id', 'oil_depot_id', 'product_id', 'purchase_price_unspecified_unit', 'driver_id', 'vehicle_id', 'additional_costs'].map(key => [key, original.trip.fields[key]]));
    Object.assign(fields, { trip_flow_version: 'driver-v1', loading_at: options.shipmentDate + 'T09:15' });
    const customers = original.trip.customers.slice(0, options.deliveryCount).map((row, index) => ({ fields: { ...Object.fromEntries(['customer_id', 'manager_id', 'payment_form_id', 'sale_price_per_litre', 'transport_amount', 'unloading_address_id'].map(key => [key, row.fields[key]])), quantity_litres: options.deliveryCount === 1 ? '15048' : index ? '5500' : '12000' } }));
    const result = saveShipmentTrip(rt.base, data, { fields, customers, idempotencyKey: randomUUID() }, undefined, 'actor');
    if (afterDriver) enrollTripSabyAfterDriver({ base: rt.base, data, tripId: result.trip.id, actorId: 'actor', config });
    else { const queued = seedLegacyDriverAttempt({ base: rt.base, data, tripId: result.trip.id, actorId: 'actor', config, prepare: rt.prepare });
    assert.equal(queued.enqueued, true, queued.blockers.join(' ')); }
    return { changed: true, result };
  });
  rt.trip = created.trip; rt.tripId = created.trip.id;
  const driver: AccountUser = { id: 'driver-user', login: 'driver-user', name: 'Тестовый водитель', role: 'driver', driverId: 'driver', managerId: null, active: true, version: 1, sections: [] };
  await rt.store.mutate(rt.source, data => { data.accounts!.users.push({ ...driver, passwordHash: 'c'.repeat(128), salt: 'c'.repeat(32) }); return { result: null, changed: true }; });
  const driverAction = (action: 'arrive' | 'depart') => rt.store.mutate(rt.source, data => {
    const trip = readDriverTrips(currentSnapshot(rt.base, data), driver, rt.tripId, '', data).trip!;
    return recordDriverTripAction(rt.base, data, driver, rt.tripId, action, { versions: trip.versions, ...(action === 'depart' ? { masses: trip.deliveries.map((row, index) => ({ deliveryId: row.id, netTonnes: index ? '4.4' : '9.6' })) } : {}) }, config);
  });
  const client = () => new SabyClient(config, send);
  const run = (extra: Partial<Parameters<typeof runTripSabyWorkflow>[0]> = {}) => runTripSabyWorkflow({ ...rt, client: client(), initiatorId: 'actor', createDelivery: (input, sharedClient) => exchangePreparedEtrn({ ...rt, client: sharedClient }, input), ...extra });
  if (!afterDriver) await run();
  return { notes, frozenNativeSnapshots: () => frozenNativeSnapshots, driverAction, ...rt, close: async () => { if (previousSettings === undefined) delete process.env.SABY_AUTOFILL_PROFILE_JSON; else process.env.SABY_AUTOFILL_PROFILE_JSON = previousSettings; await rt.close(); }, run, calls, record: async () => (await rt.store.read(rt.source)).tripSaby!.trips[rt.tripId], writes: () => calls.filter(c => ['СБИС.ЗаписатьДокумент', 'СБИС.ЗаписатьВложение', 'СБИС.ПодготовитьДействие', 'СБИС.ВыполнитьДействие'].includes(c.req.method)) };
}

for (const afterDriver of [false, true]) for (const scenario of [
  { label: '52 two deliveries: October30 to November1', shipmentDate: '2026-10-30', documentDate: '01.11.2026', deliveryCount: 2 },
  { label: '54 one rounded-volume delivery: October31 to November1', shipmentDate: '2026-10-31', documentDate: '01.11.2026', deliveryCount: 1 },
  { label: 'same day', shipmentDate: '2026-11-01', documentDate: '01.11.2026', deliveryCount: 1 },
  { label: 'new year', shipmentDate: '2026-12-31', documentDate: '01.01.2027', deliveryCount: 2 },
  { label: 'Moscow midnight with unchanged UTC day', shipmentDate: '2026-10-31', documentDate: '01.11.2026', deliveryCount: 1, start: '2026-10-31T20:58:00Z', nativeTime: '2026-10-31T21:01:00Z' },
]) test(`continuous NEW driver trip to native note, both selected signatures and frozen recipient: ${afterDriver ? 'after-driver' : 'legacy'} ${scenario.label}`, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(scenario.start ?? scenario.shipmentDate + 'T06:00:00Z') });
  const f = await newTripFixture(scenario, afterDriver);
  try {
    if (afterDriver) { assert.equal((await f.store.read(f.source)).tripSaby?.trips[f.tripId], undefined); assert.equal(f.calls.length, 0); }
    else assert.equal((await f.record()).phase, 'awaiting_driver');
    assert.equal(f.notes.size, 0);
    await f.driverAction('arrive'); t.mock.timers.tick(60_000); await f.driverAction('depart');
    const before = await f.store.read(f.source), facts = structuredClone(before.etrn!.trips[f.tripId].loadingFacts), grant = structuredClone(before.tripSaby!.trips[f.tripId].autoAuthorization);
    const nativeIso = scenario.documentDate.split('.').reverse().join('-');
    t.mock.timers.setTime(Date.parse(scenario.nativeTime ?? nativeIso + 'T08:00:00Z'));
    const result = await f.run();
    assert.equal(result.phase, 'completed', JSON.stringify(result));
    const data = await f.store.read(f.source), workflow = data.tripSaby!.trips[f.tripId];
    assert.equal(workflow.signing?.sender.state, 'confirmed'); assert.equal(workflow.signing?.carrier.state, 'confirmed');
    assert.ok(workflow.stage6CompletedAt); assert.deepEqual(workflow.autoAuthorization, grant); assert.deepEqual(data.etrn!.trips[f.tripId].loadingFacts, facts);
    assert.equal(f.notes.size, scenario.deliveryCount);
    assert.deepEqual(workflow.deliveries.map(row => row.snapshot), f.frozenNativeSnapshots());
    const noteCreates = f.calls.filter(({ req }) => req.method === 'СБИС.ЗаписатьДокумент' && req.params.Документ.Тип === 'ConsignmentNote' && !req.params.Документ.Идентификатор);
    assert.equal(noteCreates.length, scenario.deliveryCount - 1);
    assert.equal(f.calls.filter(({ req }) => req.method === 'СБИС.ЗаписатьДокумент' && req.params.Документ.Идентификатор === '11111111-1111-4111-8111-111111111111').length, 1);
    for (const [index, delivery] of workflow.deliveries.entries()) {
      const note = data.etrn!.trips[f.tripId].deliveries[delivery.shipmentId].document!;
      assert.equal(note.snapshot.fields.date, scenario.shipmentDate);
      assert.equal(note.dispatch?.sender.state, 'confirmed'); assert.equal(note.dispatch?.carrier.state, 'confirmed'); assert.ok(note.dispatch?.completedAt);
      for (const side of ['sender', 'carrier'] as const) assert.equal(note.dispatch![side].binding!.certificateThumbprint, grant!.selection[side]);
      assert.equal(note.dispatch?.recipientAcceptedAt, undefined, 'Handoff does not claim the recipient T3 signature');
      for (const side of ['sender', 'carrier'] as const) {
        const requests = f.calls.filter(call => call.side === side && (call.req.params.Документ?.Редакция as SabyObject | undefined)?.Идентификатор === note.dispatch![side].binding!.revision);
        assert.equal(requests.filter(({ req }) => req.method === 'СБИС.ВыполнитьДействие').length, 1);
        assert.equal(requests.filter(({ req }) => req.method === 'СБИС.ПодготовитьДействие').length, side === 'sender' ? 1 : 2);
      }
      const remote = f.notes.get(note.id!)!; assert.equal(remote.signedSender, true); assert.equal(remote.signedCarrier, true);
      assert.deepEqual(remote.recipient, note.snapshot.profile.recipient.inn.length === 10 ? { СвЮЛ: { ИНН: note.snapshot.profile.recipient.inn, КПП: note.snapshot.profile.recipient.kpp, Название: note.snapshot.profile.recipient.name } } : { СвФЛ: { ИНН: note.snapshot.profile.recipient.inn, Фамилия: note.snapshot.profile.recipient.person!.surname, Имя: note.snapshot.profile.recipient.person!.name, Отчество: note.snapshot.profile.recipient.person!.patronymic, ЧастноеЛицо: 'Нет' } });
      const info = xmlChildren(xmlChildren(parseXml(remote.t1), 'Документ')[0], 'СодИнфГО')[0];
      assert.equal(info.attributes.ДатаЗак, scenario.shipmentDate.split('-').reverse().join('.'));
      assert.equal(info.attributes.ДатаТрН, index === 0 ? scenario.documentDate : scenario.shipmentDate.split('-').reverse().join('.'));
      if (index === 0) { assert.equal(note.id, '11111111-1111-4111-8111-111111111111'); assert.equal(note.linkedDraft?.documentDate, scenario.documentDate); assert.equal(note.reservationAttempted, false); }
    }
    const writes = f.writes().length;
    await f.run({ store: new OperationsStore(`${f.directory}/store`) });
    assert.equal(f.writes().length, writes); assert.equal(f.notes.size, scenario.deliveryCount);
  } finally { await f.close(); }
});
