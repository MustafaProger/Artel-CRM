import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createSnapshotMiddleware } from '../server/local-api';
import { ApiError } from '../server/api-error';
import { OperationsStore } from '../server/operations-store';
import { SabyClient, type SabyObject } from '../server/saby-client';
import { parseXml } from '../server/saby-order-evidence';
import { getTripSigningPreview, validateTripSigning } from '../server/trip-saby-signing';
import { getTripSabyWorkflow, runTripSabyWorkflow, validateTripSabyData } from '../server/trip-saby-workflow';
import { dispatchTripSaby } from '../server/trip-saby-scheduler';
import { integrationApi, integrationConfig, integrationRuntime, type IntegrationRpc } from './helpers/trip-saby-integration';

const fingerprints = { sender: 'abcdef'.repeat(6) + 'abcd', carrier: 'fedcba'.repeat(6) + 'fedc' };
type Side = keyof typeof fingerprints;
async function fixture() {
  const rt = await integrationRuntime(); const baseApi = integrationApi();
  const config = { ...integrationConfig(), login: 'synthetic', password: 'synthetic', accountNumber: 'sender-account', carrierAccountNumber: 'carrier-account', carrierResponsible: { surname: 'Тестовый', name: 'Тест', patronymic: 'Тестович', phone: '+79990000000' } };
  const calls: Array<{ side: Side; method: string }> = []; let carrierBytes = Buffer.alloc(0);
  let carrierDoc: SabyObject | undefined;
  const senderDoc = () => [...baseApi.docs.values()].find(d => d.Тип === 'TransportOrder')!;
  let lose: 'prepare' | 'execute' | null = null; let pending = false; let wrongCertificate = false; let missingReply = false; let serviceAttachment = false;
  let hook: ((side: Side, req: IntegrationRpc) => Promise<void>) | undefined;
  const certificate = (side: Side) => { const org = side === 'sender' ? config.customer : config.carrier; return { Certificate: { Type: 'Client', CertificateInfo: { Thumbprint: fingerprints[side], IsValid: true, IsQualified: true, NotBefore: '2020-01-01T00:00:00Z', NotAfter: '2099-01-01T00:00:00Z', SubjectName: { '1.2.643.100.4': org.inn, '2.5.4.4': 'Тестовый', '2.5.4.42': 'Подписант' } } }, OurCompany: { Inn: org.inn, Kpp: org.kpp } }; };
  const stage = (side: Side) => ({ Идентификатор: `stage-${side}`, Название: side === 'sender' ? 'Отправка' : 'Утверждение', Действие: [{ Название: side === 'sender' ? 'Отправить' : 'Утвердить', ТребуетПодписания: 'Да' }] });
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
    calls.push({ side, method: req.method }); await hook?.(side, req);
    const json = (value: unknown) => baseApi.json(req, value);
    if (req.method === 'СБИС.Аутентифицировать') return json('carrier-session');
    if (req.method === 'sabyCertificate.List') return json([certificate(side)]);
    if (req.method === 'sabyCertificate.Read') return json(certificate(wrongCertificate ? (side === 'sender' ? 'carrier' : 'sender') : side));
    if (req.method === 'СБИС.ПрочитатьДокумент' && side === 'carrier') return json(carrierDoc);
    if (req.method === 'СБИС.ЗаписатьВложение') { carrierBytes = Buffer.from(String(((req.params.Документ.Вложение as SabyObject[])[0].Файл as SabyObject).ДвоичныеДанные), 'base64'); return json(carrierDoc); }
    if (req.method === 'СБИС.ПодготовитьДействие') {
      if (side === 'carrier' && !(carrierDoc!.Вложение as SabyObject[]).some(a => a.Подтип === '1110362')) await addReply();
      if (lose === 'prepare') { lose = null; throw new Error('Synthetic timeout'); }
      if (side === 'sender' && serviceAttachment && !(senderDoc().Вложение as SabyObject[]).some(a => a.Идентификатор === 'service-file')) (senderDoc().Вложение as SabyObject[]).push({ Идентификатор: 'service-file', Направление: 'Исходящий', Файл: { Имя: 'service.xml', Ссылка: 'https://disk.saby.ru/service.xml' } });
      const doc = structuredClone(side === 'sender' ? senderDoc() : carrierDoc!);
      const resultStage = (doc.Этап as SabyObject[])[0]; resultStage.Вложение = (doc.Вложение as SabyObject[]).filter(a => a.Подтип === (side === 'sender' ? '1110361' : '1110362') || side === 'sender' && a.Идентификатор === 'service-file').map(a => ({ ...a, ТребуемоеДействие: 'Подписать' })); return json(doc);
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
    return { changed: true, result: null };
  });
  const client = () => new SabyClient(config, send);
  let deliveries = 0;
  const run = (extra: Partial<Parameters<typeof runTripSabyWorkflow>[0]> = {}) => runTripSabyWorkflow({ ...rt, client: client(), initiatorId: 'owner', createDelivery: async input => { deliveries++; return { id: `etrn-${input.shipmentId}`, status: 'draft', lastError: null }; }, ...extra });
  await run();
  const preview = () => getTripSigningPreview({ ...rt, client: client() });
  const request = async () => { const p = await preview(); assert.equal(p.ready, true, p.blockers.join(' ')); return { requestId: randomUUID(), previewToken: p.previewToken!, senderSignatureId: fingerprints.sender, carrierSignatureId: fingerprints.carrier, confirmed: true as const }; };
  return { ...rt, config, send, run, preview, request, calls, senderDoc, carrierDoc: () => carrierDoc!, exposeCarrier, setLose: (value: typeof lose) => { lose = value; }, setPending: (v: boolean) => { pending = v; }, setWrongCertificate: (v: boolean) => { wrongCertificate = v; }, setServiceAttachment: (v: boolean) => { serviceAttachment = v; }, setMissingReply: (v: boolean) => { missingReply = v; }, setHook: (fn: typeof hook) => { hook = fn; }, record: async () => (await rt.store.read(rt.source)).tripSaby!.trips[rt.tripId], writes: () => calls.filter(c => ['СБИС.ПодготовитьДействие', 'СБИС.ВыполнитьДействие'].includes(c.method)), deliveries: () => deliveries };
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

test('revocation during final signing preflight prevents the execute HTTP request and retains non-repeatable intent', async () => {
  const f = await fixture(); try {
    let revoked = false;
    f.setHook(async (_side, req) => {
      if (!revoked && req.method === 'СБИС.ПрочитатьДокумент' && (await f.record()).signing?.sender.executeAttempted) {
        revoked = true; await f.store.mutate(f.source, data => { data.accounts!.users.find(u => u.id === 'actor')!.active = false; return { changed: true, result: null }; });
      }
    });
    const request = await f.request(); await assert.rejects(f.run({ signingStart: { request, requestedBy: 'actor' } }), e => e instanceof ApiError && e.status === 403);
    assert.equal(f.calls.filter(c => c.method === 'СБИС.ВыполнитьДействие').length, 0);
    assert.equal((await f.record()).signing!.sender.executeAttempted, true); assert.equal(f.deliveries(), 0);
  } finally { await f.close(); }
});

test('changed stage during final signing preflight prevents execution, and a partial carrier fill cannot be signed', async () => {
  for (const kind of ['stage', 'partial'] as const) {
    const f = await fixture(); try {
      if (kind === 'stage') f.setHook(async (_side, req) => {
        if (req.method === 'sabyCertificate.Read' && (await f.record()).signing?.sender.executeAttempted) f.senderDoc().ТекущиеЭтапы = [{ Идентификатор: 'different-stage' }];
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
