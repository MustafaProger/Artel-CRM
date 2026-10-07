import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createSnapshotMiddleware } from '../server/local-api';
import { ApiError } from '../server/api-error';
import { OperationsStore, type OperationsStorage } from '../server/operations-store';
import { SabyClient, type SabyConfig, type SabyObject } from '../server/saby-client';
import { parseXml, type XmlNode } from '../server/saby-order-evidence';
import { serializeXml } from '../server/saby-carrier-details';
import { encodeWindows1251 } from '../server/saby-transport-order';
import { getTripSigningPreview, validateTripSigning } from '../server/trip-saby-signing';
import { enqueueAutomaticTripSaby, getTripSabyWorkflow, runTripSabyWorkflow, validateTripSabyData } from '../server/trip-saby-workflow';
import { dispatchTripSaby } from '../server/trip-saby-scheduler';
import { integrationApi, integrationConfig, integrationRuntime, integrationSettings, type IntegrationRpc } from './helpers/trip-saby-integration';

const fingerprints = { sender: 'abcdef'.repeat(6) + 'abcd', carrier: 'fedcba'.repeat(6) + 'fedc' };
const vehicleIdentity = { vin: 'XTA12345678901234', stsNumber: '9900123456' };
const legacyBusinessMessage = 'Saby изменил сведения ответа НК при подготовке. Подписание остановлено; требуется сверка.';
function xmlNode(root: XmlNode, name: string): XmlNode {
  if (root.name === name) return root;
  for (const child of root.children) if (typeof child !== 'string') { try { return xmlNode(child, name); } catch { /* Continue to the next child. */ } }
  throw new Error(`Missing synthetic XML element: ${name}`);
}
const addVehicleIdentity = (xml: XmlNode) => Object.assign(xmlNode(xml, 'ТС').attributes, { НомерВИН: vehicleIdentity.vin, НомСТС: vehicleIdentity.stsNumber });
type Side = keyof typeof fingerprints;
async function fixture(options: { automatic?: boolean; createOrder?: boolean; prepareMetadataOnly?: boolean } = {}) {
  const rt = await integrationRuntime(); const baseApi = integrationApi();
  const config: SabyConfig = { ...integrationConfig(), login: 'synthetic', password: 'synthetic', accountNumber: 'sender-account', carrierAccountNumber: 'carrier-account', carrierResponsible: { surname: 'Тестовый', name: 'Тест', patronymic: 'Тестович', phone: '+79990000000' } };
  if (options.automatic) config.automaticSigning = { id: 'synthetic-auto-policy', enabled: true, approvedAt: '2025-01-01T00:00:00.000Z', mode: 'deferred', sender: { inn: config.customer.inn, kpp: config.customer.kpp, thumbprint: fingerprints.sender }, carrier: { inn: config.carrier.inn, kpp: config.carrier.kpp, thumbprint: fingerprints.carrier } };
  const calls: Array<{ side: Side; method: string; keyType?: string }> = []; let carrierBytes = Buffer.alloc(0);
  let carrierDoc: SabyObject | undefined;
  const senderDoc = () => [...baseApi.docs.values()].find(d => d.Тип === 'TransportOrder')!;
  let lose: 'prepare' | 'execute' | null = null; let pending = false; let wrongCertificate = false; let missingReply = false; let serviceAttachment = false;
  let hook: ((side: Side, req: IntegrationRpc) => Promise<void | Response>) | undefined;
  let carrierPreparation: ((xml: XmlNode) => void) | undefined;
  const changeCarrier = (change: (xml: XmlNode) => void) => { const xml = parseXml(carrierBytes); change(xml); carrierBytes = encodeWindows1251('<?xml version="1.0" encoding="windows-1251"?>' + serializeXml(xml)); };
  const certificate = (side: Side) => { const org = side === 'sender' ? config.customer : config.carrier; return { Certificate: { Type: 'Client', CertificateInfo: { Thumbprint: fingerprints[side], IsValid: true, IsQualified: true, NotBefore: '2020-01-01T00:00:00Z', NotAfter: '2099-01-01T00:00:00Z', SubjectName: { '1.2.643.100.4': org.inn, '2.5.4.4': 'Тестовый', '2.5.4.42': 'Подписант' } } }, OurCompany: { Inn: org.inn, Kpp: org.kpp } }; };
  const stage = (side: Side) => ({ Идентификатор: `stage-${side}`, Название: side === 'sender' ? 'Отправка' : 'Утверждение', Действие: [{ Название: side === 'sender' ? 'Отправить' : 'Утвердить', ТребуетПодписания: 'Да', ...(options.automatic ? { Сертификат: { Отпечаток: fingerprints[side], Ключ: { Тип: 'Отложенный', Активирован: 'Да' } } } : {}) }] });
  const annotate = (doc: SabyObject, side: Side) => { doc.Направление = side === 'sender' ? 'Исходящий' : 'Входящий'; doc.Этап = [stage(side)]; doc.ТекущиеЭтапы = [{ Идентификатор: stage(side).Идентификатор, Наименование: stage(side).Название }]; for (const a of doc.Вложение as SabyObject[]) a.Направление = (a.Подтип === '1110361') === (side === 'sender') ? 'Исходящий' : 'Входящий'; };
  const sign = (doc: SabyObject, side: Side) => { const files = (doc.Вложение as SabyObject[]).filter(a => a.Подтип === (side === 'sender' ? '1110361' : '1110362') || side === 'sender' && a.Идентификатор === 'service-file'); for (const file of files) file.Подпись = [{ Сертификат: { Отпечаток: fingerprints[side].toUpperCase(), ИНН: (side === 'sender' ? config.customer : config.carrier).inn }, Файл: { Ссылка: `https://disk.saby.ru/${side}.sgn` } }]; };
  async function exposeCarrier() {
    const doc = senderDoc(); delete doc.Код; doc.Состояние = { Код: '4', Название: 'Доставлено' }; sign(doc, 'sender');
    carrierDoc = structuredClone(doc); carrierDoc.НашаОрганизация = doc.Контрагент; carrierDoc.Контрагент = doc.НашаОрганизация; carrierDoc.Состояние = { Код: '10' };
    if (!missingReply) await addReply();
    annotate(carrierDoc, 'carrier');
  }
  async function addReply() {
    const doc = senderDoc();
    const source = await baseApi.send(`https://disk.saby.ru/${String(doc.Идентификатор)}.xml`, { method: 'GET' });
    const xml = parseXml(new Uint8Array(await source.arrayBuffer())); const content = xml.children.find(n => typeof n !== 'string' && n.name === 'Документ')!; assert.notEqual(typeof content, 'string'); if (typeof content === 'string') return;
    carrierBytes = Buffer.from(`<?xml version="1.0" encoding="utf-8"?><Файл ВерсПрог="synthetic" ВерсФорм="5.01" ИдФайл="ON_ZAKZVPR_SYNTHETIC"><Документ КНД="1110362" ДатИнфПрв="01.04.2025" ВрИнфПрв="12:01:00" НаимЭкСубСост="Синтетический перевозчик"><ИдИнфГО ИдФайлИнфГО="${xml.attributes.ИдФайл}" ДатФайлИнфГО="${content.attributes.ДатИнфГО}" ВрФайлИнфГО="${content.attributes.ВрИнфГО}" ЭП="c3ludGhldGlj"/><СодИнфПрв УИД_Зак="${(content.children.find(n => typeof n !== 'string' && n.name === 'СодИнфГО') as import('../server/saby-order-evidence').XmlNode).attributes.УИД_Зак}" СодОпер="1"/><ПодпИнфПрв Должн="Директор" СпосПодтПолном="1"><ФИО Фамилия="Тестовый" Имя="Подписант"/></ПодпИнфПрв></Документ></Файл>`);
    (carrierDoc!.Вложение as SabyObject[]).push({ Идентификатор: 'carrier-title', Подтип: '1110362', ВерсияФормата: '5.01', Направление: 'Исходящий', Файл: { Имя: 'carrier.xml', Ссылка: 'https://disk.saby.ru/carrier.xml' } });
  }
  const send: typeof fetch = async (url, init) => {
    if (init?.method === 'GET' && String(url).includes('service.xml')) return new Response('synthetic-service-file');
    if (init?.method === 'GET') return String(url).includes('carrier.xml') ? new Response(carrierBytes) : baseApi.send(url, init);
    const req = JSON.parse(String(init?.body)) as IntegrationRpc;
    const side: Side = new Headers(init?.headers).get('X-SBISSessionID') === 'carrier-session' ? 'carrier' : 'sender';
    const action = ((req.params.Документ?.Этап as SabyObject)?.Действие as SabyObject[] | undefined)?.[0];
    const keyType = ((action?.Сертификат as SabyObject)?.Ключ as SabyObject)?.Тип;
    calls.push({ side, method: req.method, ...(typeof keyType === 'string' ? { keyType } : {}) });
    const override = await hook?.(side, req); if (override instanceof Response) return override;
    const json = (value: unknown) => baseApi.json(req, value);
    if (req.method === 'СБИС.Аутентифицировать') return json('carrier-session');
    if (req.method === 'sabyCertificate.List') return json([certificate(side)]);
    if (req.method === 'sabyCertificate.Read') return json(certificate(wrongCertificate ? (side === 'sender' ? 'carrier' : 'sender') : side));
    if (req.method === 'СБИС.ПрочитатьДокумент' && side === 'carrier') return json(carrierDoc);
    if (req.method === 'СБИС.ЗаписатьВложение') { carrierBytes = Buffer.from(String(((req.params.Документ.Вложение as SabyObject[])[0].Файл as SabyObject).ДвоичныеДанные), 'base64'); return json(carrierDoc); }
    if (req.method === 'СБИС.ПодготовитьДействие') {
      if (side === 'carrier' && !(carrierDoc!.Вложение as SabyObject[]).some(a => a.Подтип === '1110362')) await addReply();
      if (side === 'carrier' && carrierPreparation) changeCarrier(carrierPreparation);
      if (lose === 'prepare') { lose = null; throw new Error('Synthetic timeout'); }
      if (side === 'sender' && serviceAttachment && !(senderDoc().Вложение as SabyObject[]).some(a => a.Идентификатор === 'service-file')) (senderDoc().Вложение as SabyObject[]).push({ Идентификатор: 'service-file', Направление: 'Исходящий', Файл: { Имя: 'service.xml', Ссылка: 'https://disk.saby.ru/service.xml' } });
      const doc = structuredClone(side === 'sender' ? senderDoc() : carrierDoc!);
      const resultStage = (doc.Этап as SabyObject[])[0]; resultStage.Вложение = (doc.Вложение as SabyObject[]).filter(a => a.Подтип === (side === 'sender' ? '1110361' : '1110362') || side === 'sender' && a.Идентификатор === 'service-file').map(a => ({ ...a, ТребуемоеДействие: 'Подписать' }));
      if (options.prepareMetadataOnly) for (const action of resultStage.Действие as SabyObject[]) delete action.Сертификат;
      return json(doc);
    }
    if (req.method === 'СБИС.ВыполнитьДействие') {
      if (!pending) {
        if (side === 'sender') await exposeCarrier();
        else { sign(carrierDoc!, 'carrier'); carrierDoc!.Состояние = { Код: '7' }; senderDoc().Состояние = { Код: '7' }; const reply = structuredClone((carrierDoc!.Вложение as SabyObject[]).find(a => a.Подтип === '1110362')!); reply.Направление = 'Входящий'; (senderDoc().Вложение as SabyObject[]).push(reply); }
      } else (side === 'sender' ? senderDoc() : carrierDoc!).Состояние = { Код: '23' };
      if (lose === 'execute') { lose = null; throw new Error('Synthetic timeout'); }
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
  const client = () => new SabyClient(config, send);
  let deliveries = 0;
  const run = (extra: Partial<Parameters<typeof runTripSabyWorkflow>[0]> = {}) => runTripSabyWorkflow({ ...rt, client: client(), initiatorId: 'owner', createDelivery: async input => { deliveries++; return { id: `etrn-${input.shipmentId}`, status: 'draft', lastError: null }; }, ...extra });
  if (options.createOrder !== false) await run();
  const preview = () => getTripSigningPreview({ ...rt, client: client() });
  const request = async () => { const p = await preview(); assert.equal(p.ready, true, p.blockers.join(' ')); return { requestId: randomUUID(), previewToken: p.previewToken!, senderSignatureId: fingerprints.sender, carrierSignatureId: fingerprints.carrier, confirmed: true as const }; };
  return { ...rt, config, send, run, preview, request, calls, senderDoc, carrierDoc: () => carrierDoc!, exposeCarrier, changeCarrier, changeSource: baseApi.prepareSender, setCarrierPreparation: (change: typeof carrierPreparation) => { carrierPreparation = change; }, setLose: (value: typeof lose) => { lose = value; }, setPending: (v: boolean) => { pending = v; }, setWrongCertificate: (v: boolean) => { wrongCertificate = v; }, setServiceAttachment: (v: boolean) => { serviceAttachment = v; }, setMissingReply: (v: boolean) => { missingReply = v; }, setHook: (fn: typeof hook) => { hook = fn; }, record: async () => (await rt.store.read(rt.source)).tripSaby!.trips[rt.tripId], writes: () => calls.filter(c => ['СБИС.ПодготовитьДействие', 'СБИС.ВыполнитьДействие'].includes(c.method)), deliveries: () => deliveries };
}

/** Reconstruct the old persisted shape from an actual synthetic preparation with no execution. */
async function legacyCarrierFixture() {
  const f = await fixture();
  await f.exposeCarrier(); f.setCarrierPreparation(addVehicleIdentity); f.setLose('prepare');
  await f.run({ signingStart: { request: await f.request(), requestedBy: 'actor' } });
  const stopped = (await f.record()).signing!.carrier;
  assert.ok(stopped.binding && stopped.businessHash); assert.equal(stopped.prepared, undefined); assert.equal(stopped.executeAttempted, undefined);
  await f.store.mutate(f.source, data => { const step = data.tripSaby!.trips[f.tripId].signing!.carrier; step.state = 'blocked'; step.message = legacyBusinessMessage; return { changed: true, result: null }; });
  return f;
}

test('GET preview, old POST and scheduler never initiate signing; public projection contains no signing bytes or private state', async () => {
  const f = await fixture(); try {
    const p = await f.preview(); assert.equal(p.ready, true); await f.run();
    await dispatchTripSaby({ ...f, config: f.config, enabled: true, send: f.send });
    assert.equal(f.writes().length, 0); assert.equal((await f.record()).signing, undefined);
    assert.doesNotMatch(JSON.stringify(p), /private|password|session|payloadHash|snapshot|bytes|ДвоичныеДанные/);
  } finally { await f.close(); }
});

test('explicit request signs both sides once, fills carrier first, stores durable manifests, and gates ETRN on exact signatures', async () => {
  const f = await fixture(); try {
    const request = await f.request(); const result = await f.run({ signingStart: { request, requestedBy: 'actor' } });
    assert.equal(result.signing?.state, 'completed', JSON.stringify(result)); assert.equal(result.phase, 'completed'); assert.equal(f.deliveries(), 2);
    assert.deepEqual(f.writes().map(c => `${c.side}:${c.method}`), ['sender:СБИС.ПодготовитьДействие', 'sender:СБИС.ВыполнитьДействие', 'carrier:СБИС.ПодготовитьДействие', 'carrier:СБИС.ВыполнитьДействие']);
    const fill = f.calls.findIndex(c => c.method === 'СБИС.ЗаписатьВложение'); assert.ok(fill < f.calls.findIndex(c => c.side === 'carrier' && c.method === 'СБИС.ПодготовитьДействие'));
    await f.run({ signingStart: { request, requestedBy: 'actor' }, store: new OperationsStore(`${f.directory}/store`) }); assert.equal(f.writes().length, 4);
    const record = await f.record(); validateTripSabyData({ trips: { [f.tripId]: record } });
    assert.doesNotMatch(JSON.stringify(result.signing), /binding|preparedHash|attachments|requestedBy|requestId|previewToken|bytes/);
  } finally { await f.close(); }
});

test('existing signed sender with uppercase fingerprint is adopted without a second send', async () => {
  const f = await fixture(); try {
    await f.exposeCarrier(); const request = await f.request(); const result = await f.run({ signingStart: { request, requestedBy: 'actor' } });
    assert.equal(result.signing?.state, 'completed', JSON.stringify(result)); assert.equal(f.writes().filter(c => c.side === 'sender').length, 0); assert.equal(f.writes().filter(c => c.side === 'carrier').length, 2);
  } finally { await f.close(); }
});

for (const stage of ['prepare', 'execute'] as const) test(`lost ${stage} response is reconciled after restart without repeating the same remote mutation`, async () => {
  const f = await fixture(); try {
    f.setLose(stage); const request = await f.request(); const first = await f.run({ signingStart: { request, requestedBy: 'actor' } }); assert.notEqual(first.signing?.state, 'completed');
    const senderWrites = f.writes().filter(c => c.side === 'sender').length;
    const second = await f.run({ signingStart: { request, requestedBy: 'actor' }, store: new OperationsStore(`${f.directory}/store`) });
    assert.equal(f.writes().filter(c => c.side === 'sender').length, senderWrites);
    if (stage === 'prepare') { assert.equal(second.signing?.sender.state, 'unknown'); assert.equal(f.deliveries(), 0); }
    else assert.equal(second.signing?.state, 'completed', JSON.stringify(second));
  } finally { await f.close(); }
});

test('pending approval state 23 does not confirm a signature or start carrier/ETRN', async () => {
  const f = await fixture(); try {
    f.setPending(true); const request = await f.request(); const first = await f.run({ signingStart: { request, requestedBy: 'actor' } });
    assert.equal(first.signing?.sender.state, 'waiting'); await f.run(); assert.equal(f.writes().length, 2); assert.equal(f.deliveries(), 0);
  } finally { await f.close(); }
});

test('stale preview, missing confirmation, wrong-side certificate and changed revision are fail closed', async () => {
  for (const mode of ['stale', 'confirmation', 'certificate', 'revision'] as const) {
    const f = await fixture(); try {
      const request = await f.request();
      if (mode === 'stale') request.previewToken = '0'.repeat(64);
      if (mode === 'confirmation') Object.assign(request, { confirmed: false });
      if (mode === 'certificate') f.setWrongCertificate(true);
      if (mode === 'revision') f.senderDoc().Редакция = [{ Идентификатор: 'new-revision', Актуален: 'Да' }];
      if (mode === 'certificate') { const result = await f.run({ signingStart: { request, requestedBy: 'actor' } }); assert.equal(result.signing?.sender.state, 'blocked'); }
      else await assert.rejects(f.run({ signingStart: { request, requestedBy: 'actor' } }), ApiError);
      assert.equal(f.writes().length, 0); assert.equal(f.deliveries(), 0);
    } finally { await f.close(); }
  }
});

test('concurrent starts share durable lease and execute once; revoked signing actor blocks the scheduler independently of creator', async () => {
  const f = await fixture(); try {
    const request = await f.request(); let release!: () => void; let entered!: () => void; const waiting = new Promise<void>(r => { release = r; }); const started = new Promise<void>(r => { entered = r; });
    f.setHook(async (_side, req) => { if (req.method === 'СБИС.ПодготовитьДействие') { entered(); await waiting; } });
    const first = f.run({ signingStart: { request, requestedBy: 'actor' } }); await started;
    await assert.rejects(f.run({ signingStart: { request, requestedBy: 'actor' } }), e => e instanceof ApiError && e.status === 409);
    f.setPending(true); release(); await first; f.setHook(undefined);
    await f.store.mutate(f.source, data => { data.accounts!.users.find(u => u.id === 'actor')!.active = false; return { changed: true, result: null }; });
    const before = f.calls.length; const result = await dispatchTripSaby({ ...f, config: f.config, enabled: true, send: f.send });
    assert.equal(result.denied, 1); assert.equal(f.calls.length, before); assert.equal(f.writes().length, 2);
  } finally { await f.close(); }
});

test('stored manifest validators reject private bytes, tampered digest, side mismatch and malformed new intent while accepting legacy records', async () => {
  const f = await fixture(); try {
    validateTripSigning(undefined); const request = await f.request(); f.setPending(true); await f.run({ signingStart: { request, requestedBy: 'actor' } });
    const record = await f.record(); validateTripSigning(record.signing);
    for (const change of [
      (v: SabyObject) => { v.secret = 'not allowed'; },
      (v: SabyObject) => { ((v.sender as SabyObject).prepared as SabyObject).preparedHash = '0'.repeat(64); },
      (v: SabyObject) => { ((((v.sender as SabyObject).prepared as SabyObject).attachments as SabyObject[])[0]).bytes = [1, 2]; },
      (v: SabyObject) => { ((v.sender as SabyObject).binding as SabyObject).side = 'carrier'; },
      (v: SabyObject) => { (v.sender as SabyObject).dispatchState = 'not_sent'; },
      (v: SabyObject) => { (v.sender as SabyObject).diagnostic = { method: 'СБИС.ВыполнитьДействие', phase: 'response', category: 'provider_error', message: 'private vendor payload' }; },
    ]) { const value = structuredClone(record.signing) as unknown as SabyObject; change(value); assert.throws(() => validateTripSigning(value)); }
    const publicValue = getTripSabyWorkflow({ ...f, data: await f.store.read(f.source), config: f.config }); assert.doesNotMatch(JSON.stringify(publicValue.signing), /preparedHash|private|snapshot|bytes/);
  } finally { await f.close(); }
});


test('missing reply is prepared separately, filled, then prepared and signed; lost draft response is read back without duplicate initialization', async () => {
  for (const lost of [false, true]) {
    const f = await fixture(); try {
      f.setMissingReply(true); await f.exposeCarrier(); const request = await f.request();
      if (lost) f.setLose('prepare');
      let result = await f.run({ signingStart: { request, requestedBy: 'actor' } });
      if (lost) { assert.equal(result.signing?.carrier.state, 'unknown'); result = await f.run(); }
      assert.equal(result.signing?.state, 'completed', JSON.stringify(result));
      assert.equal(f.writes().filter(c => c.side === 'carrier' && c.method === 'СБИС.ПодготовитьДействие').length, 2);
      assert.equal(f.writes().filter(c => c.side === 'carrier' && c.method === 'СБИС.ВыполнитьДействие').length, 1);
    } finally { await f.close(); }
  }
});


test('unknown preparation performs fresh read-back and can adopt a later external signature without preparing or sending again', async () => {
  const f = await fixture(); try {
    f.setLose('prepare'); const request = await f.request(); await f.run({ signingStart: { request, requestedBy: 'actor' } });
    const reads = f.calls.filter(c => c.method === 'СБИС.ПрочитатьДокумент').length;
    await f.run(); assert.ok(f.calls.filter(c => c.method === 'СБИС.ПрочитатьДокумент').length > reads);
    await f.exposeCarrier(); const result = await f.run();
    assert.equal(result.signing?.state, 'completed', JSON.stringify(result));
    assert.equal(f.writes().filter(c => c.side === 'sender').length, 1);
  } finally { await f.close(); }
});


test('service files explicitly selected by Saby are included in durable signing evidence even without title subtype', async () => {
  const f = await fixture(); try {
    f.setServiceAttachment(true); const request = await f.request(); const result = await f.run({ signingStart: { request, requestedBy: 'actor' } });
    assert.equal(result.signing?.state, 'completed', JSON.stringify(result));
    const record = await f.record(); assert.equal(record.signing!.sender.prepared!.attachments.length, 2); assert.equal(record.signing!.sender.prepared!.attachments[1].subtype, '');
    validateTripSabyData({ trips: { [f.tripId]: record } });
  } finally { await f.close(); }
});

test('revocation during final signing preflight prevents the execute HTTP request and retains an unsent verified intent', async () => {
  const f = await fixture(); try {
    let revoked = false;
    f.setHook(async (_side, req) => {
      if (!revoked && req.method === 'СБИС.ПрочитатьДокумент' && (await f.record()).signing?.sender.dispatchState === 'not_sent') {
        revoked = true; await f.store.mutate(f.source, data => { data.accounts!.users.find(u => u.id === 'actor')!.active = false; return { changed: true, result: null }; });
      }
    });
    const request = await f.request(); await assert.rejects(f.run({ signingStart: { request, requestedBy: 'actor' } }), e => e instanceof ApiError && e.status === 403);
    assert.equal(f.calls.filter(c => c.method === 'СБИС.ВыполнитьДействие').length, 0);
    assert.equal((await f.record()).signing!.sender.executeAttempted, undefined); assert.equal((await f.record()).signing!.sender.dispatchState, 'not_sent'); assert.equal(f.deliveries(), 0);
  } finally { await f.close(); }
});

test('changed stage during final signing preflight prevents execution, and a partial carrier fill cannot be signed', async () => {
  for (const kind of ['stage', 'partial'] as const) {
    const f = await fixture(); try {
      if (kind === 'stage') f.setHook(async (_side, req) => {
        if (req.method === 'sabyCertificate.Read' && (await f.record()).signing?.sender.dispatchState === 'not_sent') f.senderDoc().ТекущиеЭтапы = [{ Идентификатор: 'different-stage' }];
      });
      else await f.store.mutate(f.source, data => { delete data.directories!.drivers[0].licenseNumber; return { changed: true, result: null }; });
      const request = await f.request(); const result = await f.run({ signingStart: { request, requestedBy: 'actor' } });
      if (kind === 'stage') { assert.equal(result.signing?.sender.state, 'blocked'); assert.equal(f.calls.filter(c => c.method === 'СБИС.ВыполнитьДействие').length, 0); }
      else { assert.equal(result.carrierFill?.state, 'partial'); assert.equal(result.signing?.carrier.state, 'waiting'); assert.equal(f.writes().filter(c => c.side === 'carrier').length, 0); }
      assert.equal(f.deliveries(), 0);
    } finally { await f.close(); }
  }
});

test('a legacy saved order gains carrier fill and a scheduler initiator only after explicit signing start', async () => {
  const f = await fixture(); try {
    await f.store.mutate(f.source, data => { const record = data.tripSaby!.trips[f.tripId]; delete record.initiatorId; delete record.carrierFill; return { changed: true, result: null }; });
    const request = await f.request(); const result = await f.run({ signingStart: { request, requestedBy: 'actor' } });
    assert.equal(result.signing?.state, 'completed', JSON.stringify(result)); assert.equal((await f.record()).initiatorId, 'actor');
  } finally { await f.close(); }
});


test('HTTP signing routes enforce auth, methods and explicit confirmation; ordinary GET never mutates', async () => {
  const f = await fixture(); const token = 'c'.repeat(64);
  await f.store.mutate(f.source, data => { data.accounts!.sessions.push({ userId: 'actor', hash: createHash('sha256').update(token).digest('hex'), expiresAt: Date.now() + 60_000 }); return { result: null, changed: true }; });
  const middleware = createSnapshotMiddleware(f.snapshotDirectory, { operationsStore: f.store, sabyClient: new SabyClient(f.config, f.send) });
  const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end(); }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const path = `/api/shipment-trips/${f.tripId}/saby-workflow`;
  const http = (suffix: string, method = 'GET', body?: unknown, authenticated = true) => fetch(origin + path + suffix, { method, headers: { 'Content-Type': 'application/json', ...(authenticated ? { Cookie: `artel_session=${token}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  try {
    assert.equal((await http('/signing', 'GET', undefined, false)).status, 401);
    assert.equal((await http('/signing/start')).status, 405);
    assert.equal((await http('/signing', 'POST', {})).status, 405);
    assert.equal((await http('/signing/start', 'POST', {})).status, 400);
    const preview = await http('/signing'); assert.equal(preview.status, 200); const p = await preview.json(); assert.equal(p.ready, true); assert.equal(f.writes().length, 0);
    const request = { requestId: randomUUID(), previewToken: p.previewToken, senderSignatureId: fingerprints.sender, carrierSignatureId: fingerprints.carrier, confirmed: true };
    f.setPending(true); const started = await http('/signing/start', 'POST', request); assert.equal(started.status, 200); assert.equal((await started.json()).signing.sender.state, 'waiting');
    const before = f.writes().length; assert.equal((await http('')).status, 200); assert.equal(f.writes().length, before);
    await f.store.mutate(f.source, data => { const actor = data.accounts!.users.find(u => u.id === 'actor')!; actor.role = 'employee'; actor.sections = []; return { changed: true, result: null }; });
    assert.equal((await http('/signing')).status, 403); assert.equal((await http('/signing/start', 'POST', request)).status, 403); assert.equal(f.writes().length, before);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await f.close(); }
});

test('the active signing requester authorizes background continuation independently of the old document creator', async () => {
  const f = await fixture(); try {
    f.setPending(true); const request = await f.request(); await f.run({ signingStart: { request, requestedBy: 'actor' } });
    await f.store.mutate(f.source, data => { data.accounts!.users.find(u => u.id === 'owner')!.active = false; return { changed: true, result: null }; });
    const result = await dispatchTripSaby({ ...f, config: f.config, enabled: true, send: f.send });
    assert.equal(result.continued, 1); assert.equal(result.denied, 0); assert.equal(f.writes().length, 2);
  } finally { await f.close(); }
});

test('known VIN and STS added by Saby are accepted during the first carrier preparation and protect the complete prepared files', async () => {
  const f = await fixture(); try {
    f.setCarrierPreparation(addVehicleIdentity);
    const result = await f.run({ signingStart: { request: await f.request(), requestedBy: 'actor' } });
    assert.equal(result.signing?.state, 'completed', JSON.stringify(result));
    const carrier = (await f.record()).signing!.carrier;
    assert.equal(carrier.preparedVerified, true); assert.equal(carrier.executeAttempted, true); assert.equal(carrier.recovery, undefined);
    assert.equal(f.writes().filter(c => c.side === 'carrier').length, 2);
  } finally { await f.close(); }
});

test('a failed semantic check retains an unverified complete manifest and can never be used for signing or signed adoption', async () => {
  const f = await fixture(); try {
    f.setCarrierPreparation(xml => { addVehicleIdentity(xml); xmlNode(xml, 'ТС').attributes.НомерВИН = 'XTA99999999999999'; });
    const result = await f.run({ signingStart: { request: await f.request(), requestedBy: 'actor' } });
    assert.equal(result.signing?.carrier.state, 'blocked');
    const step = (await f.record()).signing!.carrier;
    assert.ok(step.prepared); assert.equal(step.preparedVerified, false); assert.equal(step.executeAttempted, undefined);
    const before = f.writes().length;
    // A crash can leave the unverified manifest in unknown/preparing, and an external signature
    // still cannot turn unchecked content into an authorized manifest.
    await f.store.mutate(f.source, data => { data.tripSaby!.trips[f.tripId].signing!.carrier.state = 'unknown'; return { changed: true, result: null }; });
    (f.carrierDoc().Вложение as SabyObject[]).find(a => a.Подтип === '1110362')!.Подпись = [{ Сертификат: { Отпечаток: fingerprints.carrier, ИНН: f.config.carrier.inn } }];
    f.carrierDoc().Состояние = { Код: '7' };
    await f.run({ allowSigningRecovery: true }); await dispatchTripSaby({ ...f, config: f.config, enabled: true, send: f.send });
    assert.equal(f.writes().length, before); assert.equal((await f.record()).signing!.carrier.preparedVerified, false);
    const corrupt = structuredClone((await f.record()).signing)!; corrupt.carrier.state = 'confirmed';
    assert.throws(() => validateTripSigning(corrupt));
    assert.equal(f.deliveries(), 0);
  } finally { await f.close(); }
});

test('legacy carrier recovery requires an explicit reconciliation and preserves the original fill digest, binding and history', async () => {
  const f = await legacyCarrierFixture(); try {
    const original = await f.record(); const initialWrites = f.writes().length;
    await f.preview(); await f.run(); await dispatchTripSaby({ ...f, config: f.config, enabled: true, send: f.send });
    assert.equal(f.writes().length, initialWrites); assert.equal((await f.record()).signing!.carrier.recovery, undefined);
    const result = await f.run({ allowSigningRecovery: true });
    assert.equal(result.signing?.state, 'completed', JSON.stringify(result));
    const record = await f.record(); const step = record.signing!.carrier;
    assert.deepEqual(step.recovery!.originalBinding, original.signing!.carrier.binding);
    assert.equal(step.businessHash, original.signing!.carrier.businessHash); assert.equal(step.recovery!.originalBusinessHash, step.businessHash);
    assert.equal(step.recovery!.originalMessage, legacyBusinessMessage); assert.equal(step.recovery!.requestedBy, 'owner');
    assert.notEqual(step.recovery!.acceptedBusinessHash, step.businessHash);
    assert.equal(record.carrierFill!.intent!.afterHash, original.carrierFill!.intent!.afterHash);
    assert.deepEqual(record.history!.slice(0, original.history!.length), original.history);
    assert.equal(step.preparedVerified, true); assert.equal(f.writes().length, initialWrites + 2);
    validateTripSabyData({ trips: { [f.tripId]: record } });
    const corrupted = structuredClone(record.signing)!; corrupted.carrier.recovery!.originalBinding.stageId = 'changed-original-stage';
    assert.throws(() => validateTripSigning(corrupted));
    await f.run({ allowSigningRecovery: true, store: new OperationsStore(`${f.directory}/store`) });
    assert.equal(f.writes().length, initialWrites + 2);
    assert.doesNotMatch(JSON.stringify(result.signing), /recovery|originalBinding|businessHash|requestedBy|preparedVerified/);
  } finally { await f.close(); }
});

test('lost controlled reprepare is consumed durably and reconciled after restart without retry or execution', async () => {
  const f = await legacyCarrierFixture(); try {
    const before = f.writes().length; f.setLose('prepare');
    const first = await f.run({ allowSigningRecovery: true }); assert.equal(first.signing?.carrier.state, 'unknown');
    const stopped = (await f.record()).signing!.carrier;
    assert.equal(stopped.recovery!.prepareAttempted, true); assert.equal(stopped.prepared, undefined); assert.equal(stopped.executeAttempted, undefined);
    const reads = f.calls.filter(c => c.method === 'СБИС.ПрочитатьДокумент').length;
    await f.run({ allowSigningRecovery: true, store: new OperationsStore(`${f.directory}/store`) });
    await dispatchTripSaby({ ...f, config: f.config, enabled: true, send: f.send });
    assert.ok(f.calls.filter(c => c.method === 'СБИС.ПрочитатьДокумент').length > reads);
    assert.equal(f.writes().length, before + 1); assert.equal(f.deliveries(), 0);
    assert.equal((await f.record()).signing!.carrier.recovery!.id, stopped.recovery!.id);
  } finally { await f.close(); }
});

test('a read-only recovery preflight failure retains the original block and permits a later explicit reconciliation', async () => {
  const f = await legacyCarrierFixture(); try {
    let failed = false;
    f.setHook(async (side, req) => { if (!failed && side === 'carrier' && req.method === 'СБИС.ПрочитатьДокумент') { failed = true; throw new Error('Synthetic read timeout'); } });
    const before = f.writes().length; await f.run({ allowSigningRecovery: true });
    const stopped = (await f.record()).signing!.carrier;
    assert.equal(stopped.state, 'blocked'); assert.equal(stopped.message, legacyBusinessMessage); assert.equal(stopped.recovery, undefined);
    assert.equal(f.writes().length, before);
    f.setHook(undefined); const result = await f.run({ allowSigningRecovery: true });
    assert.equal(result.signing?.state, 'completed', JSON.stringify(result)); assert.equal(f.writes().length, before + 2);
  } finally { await f.close(); }
});

test('legacy recovery rejects a changed value, source link, signature authority, stage, or inconsistent frozen vehicle without new preparation', async () => {
  for (const mode of ['vin', 'source', 'authority', 'signature', 'stage', 'frozen'] as const) {
    const f = await legacyCarrierFixture(); try {
      if (mode === 'vin') f.changeCarrier(xml => { xmlNode(xml, 'ТС').attributes.НомерВИН = 'XTA99999999999999'; });
      if (mode === 'source') f.changeCarrier(xml => { xmlNode(xml, 'ИдИнфГО').attributes.ИдФайлИнфГО = 'changed-source'; });
      if (mode === 'authority') f.changeCarrier(xml => { xmlNode(xml, 'ПодпИнфПрв').attributes.СпосПодтПолном = '6'; });
      if (mode === 'signature') (f.carrierDoc().Вложение as SabyObject[]).find(a => a.Подтип === '1110362')!.Подпись = [{ Сертификат: { Отпечаток: fingerprints.carrier, ИНН: f.config.carrier.inn } }];
      if (mode === 'stage') f.carrierDoc().ТекущиеЭтапы = [{ Идентификатор: 'changed-stage', Наименование: 'Утверждение' }];
      if (mode === 'frozen') await f.store.mutate(f.source, data => { const row = data.tripSaby!.trips[f.tripId].deliveries[1]; row.snapshot.vehicle.vin = 'XTA99999999999999'; row.payloadHash = createHash('sha256').update(JSON.stringify(row.snapshot)).digest('hex'); return { changed: true, result: null }; });
      const before = f.writes().length; const result = await f.run({ allowSigningRecovery: true });
      assert.equal(result.signing?.carrier.state, 'blocked', mode); assert.equal(f.writes().length, before, mode);
      assert.equal((await f.record()).signing!.carrier.recovery, undefined, mode); assert.equal(f.deliveries(), 0, mode);
    } finally { await f.close(); }
  }
});

test('business changes during controlled reprepare retain the manifest as unverified and block execution forever', async () => {
  const f = await legacyCarrierFixture(); try {
    f.setCarrierPreparation(xml => { xmlNode(xml, 'ПодпИнфПрв').attributes.Должн = 'Изменённая должность'; });
    const before = f.writes().length; const result = await f.run({ allowSigningRecovery: true });
    assert.equal(result.signing?.carrier.state, 'blocked');
    const step = (await f.record()).signing!.carrier;
    assert.ok(step.prepared); assert.ok(step.recovery); assert.equal(step.preparedVerified, false); assert.equal(step.executeAttempted, undefined);
    await f.run({ allowSigningRecovery: true }); await f.run();
    assert.equal(f.writes().length, before + 1); assert.equal(f.deliveries(), 0);
  } finally { await f.close(); }
});

test('a source change during first preparation or controlled reprepare cannot authorize unchanged carrier contents', async () => {
  for (const recovery of [false, true]) {
    const f = await (recovery ? legacyCarrierFixture() : fixture()); try {
      f.setCarrierPreparation(() => f.changeSource());
      const before = f.writes().filter(c => c.side === 'carrier').length;
      await f.run(recovery ? { allowSigningRecovery: true } : { signingStart: { request: await f.request(), requestedBy: 'actor' } });
      const step = (await f.record()).signing!.carrier;
      assert.equal(step.state, 'blocked'); assert.ok(step.prepared); assert.equal(step.preparedVerified, false); assert.equal(step.executeAttempted, undefined);
      assert.equal(f.writes().filter(c => c.side === 'carrier').length, before + 1); assert.equal(f.deliveries(), 0);
    } finally { await f.close(); }
  }
});

test('revoking the separate reconciliation requester stops final HTTP and future scheduler continuation', async () => {
  const f = await legacyCarrierFixture(); try {
    let revoked = false;
    f.setHook(async (side, req) => {
      if (!revoked && side === 'carrier' && req.method === 'СБИС.ПрочитатьДокумент' && (await f.record()).signing!.carrier.dispatchState === 'not_sent') {
        revoked = true; await f.store.mutate(f.source, data => { data.accounts!.users.find(u => u.id === 'owner')!.active = false; return { changed: true, result: null }; });
      }
    });
    const before = f.writes().length;
    await assert.rejects(f.run({ allowSigningRecovery: true }), e => e instanceof ApiError && e.status === 403);
    assert.equal(f.writes().length, before + 1); assert.equal(f.calls.some(c => c.side === 'carrier' && c.method === 'СБИС.ВыполнитьДействие'), false);
    const calls = f.calls.length; const background = await dispatchTripSaby({ ...f, config: f.config, enabled: true, send: f.send });
    assert.equal(background.denied, 1); assert.equal(f.calls.length, calls);
  } finally { await f.close(); }
});

test('only the authenticated ordinary workflow POST enables legacy recovery; both GET endpoints remain read-only', async () => {
  const f = await legacyCarrierFixture(); const token = 'd'.repeat(64);
  await f.store.mutate(f.source, data => { data.accounts!.sessions.push({ userId: 'actor', hash: createHash('sha256').update(token).digest('hex'), expiresAt: Date.now() + 60_000 }); return { changed: true, result: null }; });
  const middleware = createSnapshotMiddleware(f.snapshotDirectory, { operationsStore: f.store, sabyClient: new SabyClient(f.config, f.send) });
  const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end(); }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/shipment-trips/${f.tripId}/saby-workflow`;
  const headers = { 'Content-Type': 'application/json', Cookie: `artel_session=${token}` };
  try {
    const before = f.writes().length;
    assert.equal((await fetch(url, { headers })).status, 200); assert.equal((await fetch(`${url}/signing`, { headers })).status, 200);
    assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
    assert.equal(f.writes().length, before); assert.equal((await f.record()).signing!.carrier.recovery, undefined);
    const response = await fetch(url, { method: 'POST', headers, body: '{}' });
    assert.equal(response.status, 200); const result = await response.json(); assert.equal(result.signing.state, 'completed', JSON.stringify(result));
    assert.equal((await f.record()).signing!.carrier.recovery!.requestedBy, 'actor'); assert.equal(f.writes().length, before + 2);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await f.close(); }
});

async function enqueue(f: Awaited<ReturnType<typeof fixture>>, actorId = 'actor') {
  return f.store.mutate(f.source, data => { const result = enqueueAutomaticTripSaby({ ...f, data, actorId }); return { changed: result.enqueued, result }; });
}

for (const side of ['sender', 'carrier'] as const) test(`a ${side} read-only preflight outage resumes its exact saved manifest once after restart without another Prepare`, async () => {
  const f = await fixture({ automatic: true, createOrder: false }); try {
    await enqueue(f);
    f.setHook(async (requestSide, request) => {
      if (requestSide === side && request.method === 'sabyCertificate.List' && (await f.record()).signing?.[side].dispatchState === 'not_sent') throw new Error('Synthetic read-only outage');
    });
    await f.run();
    const stopped = (await f.record()).signing![side];
    assert.equal(stopped.state, 'waiting'); assert.equal(stopped.dispatchState, 'not_sent'); assert.equal(stopped.preparedVerified, true); assert.equal(stopped.executeAttempted, undefined);
    assert.deepEqual(stopped.diagnostic, { method: 'sabyCertificate.List', phase: 'dispatch', category: 'transport' });
    assert.equal(f.writes().filter(call => call.side === side && call.method === 'СБИС.ПодготовитьДействие').length, 1);
    assert.equal(f.writes().filter(call => call.side === side && call.method === 'СБИС.ВыполнитьДействие').length, 0);
    f.setHook(async (requestSide, request) => {
      if (requestSide === side && request.method === 'СБИС.ВыполнитьДействие') {
        const stored = (await f.record()).signing![side]; assert.equal(stored.dispatchState, 'attempted'); assert.equal(stored.executeAttempted, true); assert.deepEqual(stored.prepared, stopped.prepared);
      }
    });
    const resumed = await dispatchTripSaby({ ...f, store: new OperationsStore(`${f.directory}/store`), config: f.config, enabled: true, send: f.send });
    assert.equal(resumed.continued, 1); assert.equal(resumed.failed, 0);
    const completed = (await f.record()).signing![side]; assert.equal(completed.state, 'confirmed'); assert.equal(completed.dispatchState, 'acknowledged'); assert.deepEqual(completed.prepared, stopped.prepared);
    assert.equal(f.writes().filter(call => call.side === side && call.method === 'СБИС.ПодготовитьДействие').length, 1);
    assert.equal(f.writes().filter(call => call.side === side && call.method === 'СБИС.ВыполнитьДействие').length, 1);
    await dispatchTripSaby({ ...f, config: f.config, enabled: true, send: f.send }); assert.equal(f.writes().filter(call => call.side === side && call.method === 'СБИС.ВыполнитьДействие').length, 1);
  } finally { await f.close(); }
});

test('unsent carrier resumption rejects changed prepared bytes or its signed source before any new mutation', async () => {
  for (const changed of ['reply', 'source'] as const) {
    const f = await fixture({ automatic: true, createOrder: false }); try {
      await enqueue(f);
      f.setHook(async (side, request) => { if (side === 'carrier' && request.method === 'sabyCertificate.List' && (await f.record()).signing?.carrier.dispatchState === 'not_sent') throw new Error('Synthetic preflight outage'); });
      await f.run(); assert.equal((await f.record()).signing!.carrier.dispatchState, 'not_sent'); const writes = f.writes().length;
      if (changed === 'reply') f.changeCarrier(xml => { xml.attributes.ВерсПрог = 'changed-after-verification'; });
      else f.changeSource();
      f.setHook(undefined); await f.run({ store: new OperationsStore(`${f.directory}/store`) });
      assert.equal(f.writes().length, writes); assert.equal(f.deliveries(), 0);
      const record = await f.record(); assert.equal(changed === 'reply' ? record.signing!.carrier.state : record.signing!.sender.state, 'blocked');
      assert.equal(record.signing!.carrier.executeAttempted, undefined);
    } finally { await f.close(); }
  }
});

test('a carrier source-read outage resumes semantic verification of new saved files with exact business and vehicle checks', async () => {
  for (const mode of ['unchanged', 'vehicle_added', 'legacy_unverified'] as const) {
    const f = await fixture({ automatic: true, createOrder: false }); try {
      await enqueue(f); if (mode === 'vehicle_added') f.setCarrierPreparation(addVehicleIdentity);
      f.setHook(async (side, request) => {
        const carrier = (await f.record()).signing?.carrier;
        if (side === 'sender' && request.method === 'sabyCertificate.List' && carrier?.dispatchState === 'not_sent' && carrier.preparedVerified === false) throw new Error('Synthetic unavailable signed-source verification');
      });
      await f.run(); const stopped = (await f.record()).signing!.carrier;
      assert.equal(stopped.preparedVerified, false); assert.equal(stopped.dispatchState, 'not_sent'); assert.equal(stopped.executeAttempted, undefined); assert.equal(stopped.state, 'waiting');
      assert.ok(stopped.businessHash); assert.ok(stopped.prepared); const writes = f.writes().length;
      if (mode === 'legacy_unverified') await f.store.mutate(f.source, data => { delete data.tripSaby!.trips[f.tripId].signing!.carrier.dispatchState; return { changed: true, result: null }; });
      f.setHook(undefined); await f.run({ store: new OperationsStore(`${f.directory}/store`) });
      const current = (await f.record()).signing!.carrier; assert.deepEqual(current.prepared, stopped.prepared);
      if (mode === 'legacy_unverified') { assert.equal(current.preparedVerified, false); assert.equal(current.state, 'blocked'); assert.equal(f.writes().length, writes); }
      else {
        assert.equal(current.preparedVerified, true); assert.equal(current.state, 'confirmed'); assert.equal(current.dispatchState, 'acknowledged');
        assert.equal(f.writes().filter(call => call.side === 'carrier' && call.method === 'СБИС.ПодготовитьДействие').length, 1);
        assert.equal(f.writes().filter(call => call.side === 'carrier' && call.method === 'СБИС.ВыполнитьДействие').length, 1);
      }
    } finally { await f.close(); }
  }
});

test('a legacy prepared record without a dispatch marker is never reinterpreted as safely unsent', async () => {
  for (const attempted of [true, false]) {
    const f = await fixture({ automatic: true, createOrder: false }); try {
      await enqueue(f);
      f.setHook(async (side, request) => { if (side === 'sender' && request.method === 'sabyCertificate.List' && (await f.record()).signing?.sender.dispatchState === 'not_sent') throw new Error('Synthetic preflight outage'); });
      await f.run();
      await f.store.mutate(f.source, data => { const step = data.tripSaby!.trips[f.tripId].signing!.sender; delete step.dispatchState; if (attempted) step.executeAttempted = true; step.state = 'unknown'; return { result: null, changed: true }; });
      const original = (await f.record()).signing!.sender; const writes = f.writes().length; f.setHook(undefined);
      await f.run({ store: new OperationsStore(`${f.directory}/store`) });
      const current = (await f.record()).signing!.sender;
      assert.equal(current.state, 'unknown'); assert.equal(current.dispatchState, undefined); assert.equal(current.executeAttempted, original.executeAttempted); assert.deepEqual(current.prepared, original.prepared); assert.equal(f.writes().length, writes);
    } finally { await f.close(); }
  }
});

for (const failure of ['generic', 'fee'] as const) test(`provider ${failure} rejection retains only safe diagnostics and cannot resend the dispatched action`, async () => {
  const f = await fixture({ automatic: true, createOrder: false }); try {
    const side = failure === 'fee' ? 'carrier' : 'sender';
    await enqueue(f);
    f.setHook(async (requestSide, request) => {
      if (requestSide === side && request.method === 'СБИС.ВыполнитьДействие') return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: failure === 'fee' ? 'private-payload-password; violation 0001.006.406.020' : 'private-payload-password', data: { session: 'private-session', stack: 'private-stack' } } }));
    });
    await f.run(); const step = (await f.record()).signing![side];
    assert.equal(step.dispatchState, 'rejected'); assert.equal(step.executeAttempted, true);
    assert.deepEqual(step.diagnostic, { method: 'СБИС.ВыполнитьДействие', phase: 'response', category: failure === 'fee' ? 'carrier_payment_missing' : 'provider_error', rpcCode: -32000, ...(failure === 'fee' ? { formatCode: '0001.006.406.020' } : {}) });
    assert.doesNotMatch(JSON.stringify(await f.record()), /private-payload|private-session|private-stack/);
    const projected = getTripSabyWorkflow({ ...f, data: await f.store.read(f.source), config: f.config }); assert.doesNotMatch(JSON.stringify(projected.signing), /diagnostic|dispatchState|rpcCode/);
    f.setHook(undefined); const writes = f.writes().length; await f.run({ store: new OperationsStore(`${f.directory}/store`) }); assert.equal(f.writes().length, writes);
    if (failure === 'fee') assert.match((await f.record()).signing!.carrier.message!, /расчёта платы.*0001\.006\.406\.020/);
  } finally { await f.close(); }
});

test('a dispatched Execute without any visible remote effect remains uncertain and is never resent after restart', async () => {
  const f = await fixture({ automatic: true, createOrder: false }); try {
    await enqueue(f);
    f.setHook(async (_side, request) => { if (request.method === 'СБИС.ВыполнитьДействие') throw new Error('Synthetic connection lost before receiving provider result'); });
    await f.run();
    const stopped = (await f.record()).signing!.sender;
    assert.equal(stopped.dispatchState, 'attempted'); assert.equal(stopped.executeAttempted, true); assert.equal(stopped.state, 'unknown');
    assert.deepEqual(stopped.diagnostic, { method: 'СБИС.ВыполнитьДействие', phase: 'dispatch', category: 'transport' });
    f.setHook(undefined); const writes = f.writes().length;
    await dispatchTripSaby({ ...f, store: new OperationsStore(`${f.directory}/store`), config: f.config, enabled: true, send: f.send });
    assert.equal(f.writes().length, writes); assert.equal((await f.record()).signing!.sender.dispatchState, 'attempted'); assert.equal((await f.record()).signing!.sender.state, 'unknown'); assert.equal(f.deliveries(), 0);
  } finally { await f.close(); }
});

test('a ready saved trip freezes an automatic outbox before RPC and the scheduler signs both sides once without another start', async () => {
  const f = await fixture({ automatic: true, createOrder: false }); try {
    const queued = await enqueue(f); assert.equal(queued.enqueued, true, queued.blockers.join(' ')); assert.equal(f.calls.length, 0);
    const original = await f.record(); assert.ok(original.autoAuthorization); assert.equal(original.order.id, null); assert.equal(original.signing, undefined);
    validateTripSabyData({ trips: { [f.tripId]: original } });
    const before = getTripSabyWorkflow({ ...f, data: await f.store.read(f.source), monitoringEnabled: true });
    assert.equal(before.automation?.enabled, true); assert.equal(before.automation?.enrolled, true);
    const result = await dispatchTripSaby({ ...f, config: f.config, enabled: true, send: f.send, tripId: f.tripId });
    assert.equal(result.continued, 1); assert.equal(result.denied, 0);
    const record = await f.record(); assert.equal(record.signing!.sender.state, 'confirmed'); assert.equal(record.signing!.carrier.state, 'confirmed');
    assert.equal(record.signing!.mode, 'automatic'); assert.equal(record.signing!.requestId, original.autoAuthorization!.requestId); assert.equal(record.signing!.requestedBy, 'actor');
    assert.deepEqual(f.calls.filter(call => call.method === 'СБИС.ВыполнитьДействие').map(call => call.keyType), ['Отложенный', 'Отложенный']);
    assert.equal(record.phase, 'awaiting_loading');
    const writes = f.writes().length; await dispatchTripSaby({ ...f, store: new OperationsStore(`${f.directory}/store`), config: f.config, enabled: true, send: f.send }); assert.equal(f.writes().length, writes);
    const projection = getTripSabyWorkflow({ ...f, data: await f.store.read(f.source) });
    assert.equal(projection.signing?.mode, 'automatic'); assert.doesNotMatch(JSON.stringify(projection.automation), /requestId|policyHash|thumbprint|requestedBy/);
  } finally { await f.close(); }
});

test('automatic enrollment leaves unfinished trips editable and never upgrades existing workflows', async () => {
  const f = await fixture({ automatic: true, createOrder: false }); try {
    await f.store.mutate(f.source, data => { data.directories!.products[0].documentName = ''; return { changed: true, result: null }; });
    const notReady = await enqueue(f); assert.equal(notReady.enqueued, false); assert.ok(notReady.blockers.length); assert.equal((await f.store.read(f.source)).tripSaby?.trips[f.tripId], undefined); assert.equal(f.calls.length, 0);
    const preview = getTripSabyWorkflow({ ...f, data: await f.store.read(f.source) }); assert.equal(preview.locked, false); assert.equal(preview.ready, false);
    await f.store.mutate(f.source, data => { data.directories!.products[0].documentName = 'Синтетический ДТ'; return { changed: true, result: null }; });
    await f.run(); const old = await f.record(); assert.equal(old.autoAuthorization, undefined);
    assert.equal((await enqueue(f)).enqueued, false); assert.deepEqual(await f.record(), old); assert.equal(f.writes().length, 0);
  } finally { await f.close(); }
});

test('revoked saver or changed policy prevents queued RPC, and malformed policy does not break trip saving', async () => {
  for (const mode of ['actor', 'disabled', 'tuple', 'invalid'] as const) {
    const f = await fixture({ automatic: true, createOrder: false }); try {
      if (mode === 'invalid') {
        f.config.automaticSigningError = 'Synthetic invalid policy'; const result = await enqueue(f); assert.equal(result.enqueued, false); assert.ok(result.blockers.length); assert.equal((await f.store.read(f.source)).tripSaby?.trips[f.tripId], undefined); continue;
      }
      assert.equal((await enqueue(f)).enqueued, true);
      if (mode === 'actor') await f.store.mutate(f.source, data => { data.accounts!.users.find(user => user.id === 'actor')!.active = false; return { changed: true, result: null }; });
      if (mode === 'disabled') f.config.automaticSigning!.enabled = false;
      if (mode === 'tuple') f.config.automaticSigning!.sender.thumbprint = 'a'.repeat(40);
      const result = await dispatchTripSaby({ ...f, config: f.config, enabled: true, send: f.send });
      assert.equal(result.denied, 1, mode); assert.equal(f.calls.length, 0, mode);
    } finally { await f.close(); }
  }
});

test('automatic lost execution remains read-only after restart and old manual intents retain confirmation mode', async () => {
  const f = await fixture({ automatic: true, createOrder: false }); try {
    await enqueue(f); f.setLose('execute');
    await f.run(); const senderWrites = f.writes().filter(call => call.side === 'sender').length;
    await f.run({ store: new OperationsStore(`${f.directory}/store`) }); assert.equal(f.writes().filter(call => call.side === 'sender').length, senderWrites);
    assert.equal((await f.record()).signing!.mode, 'automatic');
  } finally { await f.close(); }
  const legacy = await fixture({ automatic: true }); try {
    legacy.setPending(true); const request = await legacy.request(); await legacy.run({ signingStart: { request, requestedBy: 'actor' } });
    const record = await legacy.record(); assert.equal(record.autoAuthorization, undefined); assert.equal(record.signing!.mode, undefined);
    assert.equal(legacy.calls.find(call => call.method === 'СБИС.ВыполнитьДействие')!.keyType, 'ОтложенныйСПодтверждением');
    const writes = legacy.writes().length; legacy.senderDoc().Состояние = { Код: '0' };
    await dispatchTripSaby({ ...legacy, config: legacy.config, enabled: true, send: legacy.send }); assert.equal(legacy.writes().length, writes);
    assert.equal((await legacy.record()).signing!.sender.state, 'unknown'); assert.equal((await legacy.record()).signing!.sender.executeAttempted, true);
  } finally { await legacy.close(); }
});

test('automatic mode never falls back to confirmation, and disabling policy at final preflight prevents execute HTTP', async () => {
  for (const mode of ['capability', 'disable'] as const) {
    const f = await fixture({ automatic: true, createOrder: false }); try {
      await enqueue(f); let disabled = false;
      f.setHook(async (side, request) => {
        if (side !== 'sender' || request.method !== 'СБИС.ПрочитатьДокумент') return;
        if (mode === 'capability') for (const stage of f.senderDoc().Этап as SabyObject[]) for (const action of stage.Действие as SabyObject[]) delete action.Сертификат;
        else if ((await f.record()).signing?.sender.dispatchState === 'not_sent') { disabled = true; f.config.automaticSigning!.enabled = false; }
      });
      if (mode === 'disable') await assert.rejects(f.run(), error => error instanceof ApiError && error.status === 403);
      else { const result = await f.run(); assert.equal(result.signing?.sender.state, 'blocked'); }
      assert.equal(f.calls.some(call => call.method === 'СБИС.ВыполнитьДействие'), false);
      const record = await f.record(); assert.equal(record.signing!.mode, 'automatic');
      if (disabled) {
        assert.equal(record.signing!.sender.executeAttempted, undefined); assert.equal(record.signing!.sender.dispatchState, 'not_sent');
        const before = f.writes().length; const denied = await dispatchTripSaby({ ...f, config: f.config, enabled: true, send: f.send }); assert.equal(denied.denied, 1); assert.equal(f.writes().length, before);
        f.config.automaticSigning!.enabled = true; f.setHook(undefined);
        const reconciled = await f.run(); assert.equal(reconciled.signing?.state, 'completed'); assert.equal(f.writes().filter(call => call.side === 'sender' && call.method === 'СБИС.ПодготовитьДействие').length, 1);
      } else assert.equal(f.writes().length, 0);
      const corrupted = structuredClone(record); corrupted.signing!.mode = 'with_confirmation';
      assert.throws(() => validateTripSabyData({ trips: { [f.tripId]: corrupted } }));
    } finally { await f.close(); }
  }
});

test('revocation committed while the dispatch marker waits is checked in the marker transaction before HTTP', async () => {
  for (const mode of ['actor', 'policy'] as const) {
    const f = await fixture({ automatic: true, createOrder: false }); try {
      await enqueue(f); let intercepted = false;
      const store: OperationsStorage = {
        read: f.store.read.bind(f.store),
        mutate: async (source, mutation) => {
          const before = (await f.store.read(source)).tripSaby?.trips[f.tripId]?.signing?.sender;
          if (!intercepted && before?.dispatchState === 'not_sent' && before.preparedVerified) {
            // This runs after the client's request guard, as the marker enters persistence.
            intercepted = true;
            if (mode === 'actor') await f.store.mutate(source, data => { data.accounts!.users.find(user => user.id === 'actor')!.active = false; return { result: null, changed: true }; });
            else f.config.automaticSigning!.enabled = false;
          }
          return f.store.mutate(source, mutation);
        },
      };
      await assert.rejects(f.run({ store }), error => error instanceof ApiError && error.status === 403);
      assert.equal(intercepted, true); assert.equal(f.calls.some(call => call.method === 'СБИС.ВыполнитьДействие'), false);
      const step = (await f.record()).signing!.sender; assert.equal(step.dispatchState, 'not_sent'); assert.equal(step.executeAttempted, undefined);
      const denied = await dispatchTripSaby({ ...f, config: f.config, enabled: true, send: f.send }); assert.equal(denied.denied, 1);
    } finally { await f.close(); }
  }
});

async function waitFor(check: () => Promise<boolean>, description: string) {
  const until = Date.now() + 5_000;
  while (!(await check())) { if (Date.now() > until) assert.fail(description); await new Promise(resolve => setTimeout(resolve, 10)); }
}
async function automaticHttpFixture() {
  const f = await fixture({ automatic: true, createOrder: false }); const token = 'e'.repeat(64);
  const previousSettings = process.env.SABY_AUTOFILL_PROFILE_JSON; process.env.SABY_AUTOFILL_PROFILE_JSON = JSON.stringify(integrationSettings);
  await f.store.mutate(f.source, data => { data.accounts!.sessions.push({ userId: 'actor', hash: createHash('sha256').update(token).digest('hex'), expiresAt: Date.now() + 60_000 }); return { changed: true, result: null }; });
  const middleware = createSnapshotMiddleware(f.snapshotDirectory, { operationsStore: f.store, sabyClient: new SabyClient(f.config, f.send) });
  const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end(); }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/shipment-trips`;
  const headers = { 'Content-Type': 'application/json', Cookie: `artel_session=${token}` };
  const fields = Object.fromEntries(Object.entries(f.trip.fields).filter(([key]) => !['loading_address', 'loading_map_url', 'loading_latitude', 'loading_longitude'].includes(key)));
  const customers = f.trip.customers.map(row => ({ fields: Object.fromEntries(Object.entries(row.fields).filter(([key]) => !['unloading_address', 'unloading_map_url', 'unloading_latitude', 'unloading_longitude'].includes(key))) }));
  return { ...f, input: { idempotencyKey: randomUUID(), fields, customers }, http: (path: string, method: string, body?: unknown) => fetch(url + path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), close: async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previousSettings === undefined) delete process.env.SABY_AUTOFILL_PROFILE_JSON; else process.env.SABY_AUTOFILL_PROFILE_JSON = previousSettings;
    await f.close();
  } };
}

test('HTTP save commits trip and auto outbox atomically, responds before unavailable Saby, then scheduler completes without another POST', async () => {
  const f = await automaticHttpFixture(); let release!: () => void; let held = true; let entered = false; let tripId = '';
  const pause = new Promise<void>(resolve => { release = resolve; });
  f.setHook(async (_side, request) => { if (request.method === 'СБИС.СписокНашихОрганизаций' && held) { entered = true; await pause; throw new Error('Synthetic temporary provider outage'); } });
  try {
    const saved = await f.http('', 'POST', f.input); assert.equal(saved.status, 201); const body = await saved.json(); tripId = body.trip.id;
    const persisted = (await f.store.read(f.source)).tripSaby!.trips[tripId]; assert.ok(persisted.autoAuthorization); assert.equal(persisted.autoAuthorization.requestedBy, 'actor');
    assert.equal(persisted.order.id, null); assert.equal(f.calls.some(call => call.method === 'СБИС.ЗаписатьДокумент'), false);
    await waitFor(async () => entered, 'post-save dispatch must reach provider');
    release(); await waitFor(async () => { const row = (await f.store.read(f.source)).tripSaby!.trips[tripId]; return row.phase !== 'submitting' && !row.leaseId; }, 'post-save provider failure must release lease');
    assert.equal((await f.store.read(f.source)).tripSaby!.trips[tripId].phase, 'unknown');
    held = false; f.setHook(undefined);
    const resumed = await dispatchTripSaby({ ...f, store: new OperationsStore(`${f.directory}/store`), config: f.config, enabled: true, send: f.send, tripId });
    assert.equal(resumed.continued, 1); assert.equal(resumed.denied, 0);
    const completed = (await f.store.read(f.source)).tripSaby!.trips[tripId]; assert.equal(completed.signing!.carrier.state, 'confirmed');
    assert.equal(completed.signing!.requestId, persisted.autoAuthorization.requestId); assert.equal(completed.signing!.mode, 'automatic');
    const writes = f.writes().length; const replay = await f.http('', 'POST', f.input); assert.equal(replay.status, 201); assert.equal((await replay.json()).trip.id, tripId); assert.equal(f.writes().length, writes);
  } finally { held = false; release(); if (tripId && (await f.store.read(f.source)).tripSaby?.trips[tripId]) await waitFor(async () => !(await f.store.read(f.source)).tripSaby!.trips[tripId].leaseId, 'background cleanup'); await f.close(); }
});

test('HTTP unfinished save stays editable; create replay cannot enroll it, but a later ready PATCH does', async () => {
  const f = await automaticHttpFixture(); let tripId = '';
  try {
    await f.store.mutate(f.source, data => { data.directories!.products[0].documentName = ''; return { changed: true, result: null }; });
    const created = await f.http('', 'POST', f.input); assert.equal(created.status, 201); const body = await created.json(); tripId = body.trip.id;
    assert.equal((await f.store.read(f.source)).tripSaby?.trips[tripId], undefined); assert.equal(f.calls.length, 0);
    const blocked = await f.http(`/${tripId}/saby-workflow`, 'GET'); const view = await blocked.json(); assert.equal(view.ready, false); assert.equal(view.locked, false); assert.ok(view.blockers.length);
    await f.store.mutate(f.source, data => { data.directories!.products[0].documentName = 'Синтетический ДТ'; return { changed: true, result: null }; });
    const replay = await f.http('', 'POST', f.input); assert.equal(replay.status, 201); assert.equal((await f.store.read(f.source)).tripSaby?.trips[tripId], undefined); assert.equal(f.calls.length, 0);
    f.setPending(true);
    const patch = { fields: f.input.fields, customers: f.input.customers.map((row, index) => ({ ...row, id: body.trip.customers[index].id })), versions: Object.fromEntries(body.trip.customers.map((row: { id: string; version: number }) => [row.id, row.version])) };
    const saved = await f.http(`/${tripId}`, 'PATCH', patch); assert.equal(saved.status, 200, await saved.text());
    await waitFor(async () => { const row = (await f.store.read(f.source)).tripSaby?.trips[tripId]; return !!row && row.phase !== 'submitting' && !row.leaseId; }, 'ready edit background completion');
    const record = (await f.store.read(f.source)).tripSaby!.trips[tripId]; assert.ok(record.autoAuthorization); assert.equal(record.signing!.sender.state, 'waiting');
    assert.equal(f.calls.filter(call => call.method === 'СБИС.ВыполнитьДействие').length, 1);
  } finally { if (tripId && (await f.store.read(f.source)).tripSaby?.trips[tripId]) await waitFor(async () => !(await f.store.read(f.source)).tripSaby!.trips[tripId].leaseId, 'background cleanup'); await f.close(); }
});

test('new automatic drafts with empty current stages sign once through the scheduler', async () => {
  const f = await fixture({ automatic: true, createOrder: false, prepareMetadataOnly: true }); try {
    await enqueue(f);
    f.setHook(async (side, req) => { if (side === 'sender' && req.method === 'СБИС.ПрочитатьДокумент') f.senderDoc().ТекущиеЭтапы = []; });
    const result = await dispatchTripSaby({ ...f, config: f.config, enabled: true, send: f.send });
    assert.equal(result.failed, 0); assert.equal((await f.record()).phase, 'awaiting_loading');
    assert.equal((await f.record()).signing!.carrier.state, 'confirmed');
    const writes = f.writes().length;
    await dispatchTripSaby({ ...f, store: new OperationsStore(`${f.directory}/store`), config: f.config, enabled: true, send: f.send });
    assert.equal(f.writes().length, writes); assert.equal(f.deliveries(), 0);
    assert.equal(f.calls.filter(c => c.side === 'sender' && c.method === 'СБИС.ПодготовитьДействие').length, 1);
    assert.equal(f.calls.filter(c => c.side === 'sender' && c.method === 'СБИС.ВыполнитьДействие').length, 1);
  } finally { await f.close(); }
});

test('only an untouched automatic sender preflight failure can resume after the stage parser fix', async () => {
  for (const mode of ['resume', 'revoked', 'policy', 'other_error', 'prepare_evidence', 'dispatch_evidence', 'manual'] as const) {
    const f = await fixture({ automatic: true, createOrder: false }); try {
      await enqueue(f);
      f.setHook(async (side, req) => { if (side === 'sender' && req.method === 'СБИС.ПрочитатьДокумент') f.senderDoc().ТекущиеЭтапы = [{ Идентификатор: 'unavailable' }]; });
      await f.run(); const blocked = (await f.record()).signing!.sender;
      assert.equal(blocked.state, 'blocked'); assert.equal(blocked.binding, undefined); assert.equal(blocked.prepared, undefined); assert.equal(blocked.executeAttempted, undefined);
      const before = f.writes().length;
      f.setHook(async (side, req) => { if (side === 'sender' && req.method === 'СБИС.ПрочитатьДокумент') f.senderDoc().ТекущиеЭтапы = []; });
      await f.store.mutate(f.source, data => {
        const record = data.tripSaby!.trips[f.tripId]; const step = record.signing!.sender;
        if (mode === 'revoked') data.accounts!.users.find(u => u.id === 'actor')!.active = false;
        if (mode === 'other_error') step.message = 'Different validation failure';
        if (mode === 'dispatch_evidence') step.executeAttempted = false;
        if (mode === 'manual') { delete record.autoAuthorization; delete record.signing!.mode; }
        return { changed: true, result: null };
      });
      // A valid binding is durable evidence even when Prepare never returned a manifest.
      if (mode === 'prepare_evidence') {
        f.setHook(undefined); f.senderDoc().ТекущиеЭтапы = [{ Идентификатор: 'stage-sender' }];
        f.setLose('prepare'); await f.run();
        assert.ok((await f.record()).signing!.sender.binding);
        await f.store.mutate(f.source, data => {
          Object.assign(data.tripSaby!.trips[f.tripId].signing!.sender, { state: 'blocked', message: blocked.message, diagnostic: blocked.diagnostic });
          return { changed: true, result: null };
        });
      }
      if (mode === 'policy') f.config.automaticSigning!.enabled = false;
      const writes = f.writes().length;
      const result = await dispatchTripSaby({ ...f, store: new OperationsStore(`${f.directory}/store`), config: f.config, enabled: true, send: f.send });
      if (mode === 'resume') {
        assert.equal((await f.record()).signing!.carrier.state, 'confirmed'); assert.equal((await f.record()).phase, 'awaiting_loading');
        assert.equal(f.calls.filter(c => c.side === 'sender' && c.method === 'СБИС.ПодготовитьДействие').length, 1);
        assert.equal(f.calls.filter(c => c.side === 'sender' && c.method === 'СБИС.ВыполнитьДействие').length, 1);
      } else { assert.equal(f.writes().length, writes, mode); if (['policy', 'revoked'].includes(mode)) assert.equal(result.denied, 1); }
      if (mode !== 'resume' && mode !== 'prepare_evidence') assert.equal(f.writes().length, before, mode);
    } finally { await f.close(); }
  }
});
