import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { request as httpRequest } from 'node:http';
const { createProductionRuntime } = await import(process.env.ARTEL_SYNTHETIC_BUNDLE || '/app/server-render/production.mjs');

// These constants are copied from the repository's synthetic integration fixture.
// No production store, account, credential, signature or document is used.
const fixture = {"data":{"schemaVersion":2,"sourceSha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","revision":0,"shipments":{},"companies":[{"name":"Синтетический перевозчик","inn":"0392816475","kpp":"037195284","address":"Синтетический юридический адрес перевозчика","phone":"+70000000004","edoId":"SYNTHETICCARRIER","id":"carrier","roles":["carrier"],"managerLabels":[],"shipmentIds":[],"paymentIds":[],"flags":[]},{"id":"supplier","name":"Синтетический поставщик","inn":"7707083893","kpp":"770701001","address":"Синтетический юридический адрес","phone":"+70000000007","roles":["supplier"],"managerLabels":[],"shipmentIds":[],"paymentIds":[],"flags":[]},{"id":"customer","name":"ИП ПолучательТестовый Тест","inn":"010000000102","address":"Синтетический юридический адрес ИП","phone":"+70000000008","roles":["customer"],"managerLabels":[],"shipmentIds":[],"paymentIds":[],"flags":[]}],"directories":{"managers":[{"id":"manager","name":"Тест"}],"products":[{"id":"product","name":"ДТ","documentName":"Синтетическое дизельное топливо","transportProductKind":"diesel","cargoPackaging":"bulk","dangerousGoodsSource":"Синтетический паспорт","dangerousGoodsUnNumber":"1202","dangerousGoodsShippingName":"ТОПЛИВО ДИЗЕЛЬНОЕ","dangerousGoodsClass":"3","dangerousGoodsClassificationCode":"F1","dangerousGoodsPackingGroup":"III","dangerousGoodsHazardSign":"3","dangerousGoodsTunnelCode":"D/E"}],"paymentForms":[{"id":"payment","name":"б/нал"}],"vehicles":[{"id":"vehicle","carrierId":"carrier","plate":"Т001ЕЕ777","vehicleType":"Синтетическая цистерна","transportVehicleType":"Синтетическая цистерна","brand":"Синтетическая марка","capacityLitres":"25000","payloadTonnes":"20","payloadSource":"Синтетический ПТС","ownershipType":"1"}],"drivers":[{"id":"driver","carrierId":"carrier","name":"Тест","fullName":"ВодительТестовый Тест","phone":"+70000000003","inn":"048172639504","vehicleId":"vehicle"}],"addresses":[{"id":"loading","companyId":"supplier","kind":"loading","name":"Погрузка","address":"Синтетическая погрузка"},{"id":"delivery","companyId":"customer","kind":"delivery","name":"Доставка","address":"Синтетическая доставка","receiverName":"ПриёмщикТестовый Тест","receiverPhone":"+70000000009"}],"oilDepots":[{"id":"depot","name":"Синтетическая нефтебаза","address":"Синтетическая погрузка","ownerCompanyId":"supplier","loadingActorCompanyId":"supplier","infrastructureOwnerCompanyId":"supplier"}],"defaults":{"profit":"template-payment-form"},"duplicates":[],"customerManagers":[],"fleetSeedApplied":true},"paymentAllocations":[],"tripNumbers":{"shipment-trip-bcba86bc-8b97-422a-aae7-6231c7585156":1},"push":{"devices":[],"deliveries":{},"tripAssignments":{"shipment-trip-bcba86bc-8b97-422a-aae7-6231c7585156":{"token":"62f261b0-25ac-4d4c-9385-75f98e85bca7","driverId":"driver","at":1792489775592}}}},"config":{"sessionId":"private-integration-session","customer":{"name":"Синтетический отправитель","inn":"0148372956","kpp":"015927183","address":"Синтетический юридический адрес отправителя","phone":"+70000000001","edoId":"SYNTHETICSENDER"},"carrier":{"name":"Синтетический перевозчик","inn":"0392816475","kpp":"037195284","address":"Синтетический юридический адрес перевозчика","phone":"+70000000004","edoId":"SYNTHETICCARRIER"},"consignmentSigner":{"surname":"ПодписантТестовый","name":"Тест","patronymic":"","position":"Директор"},"transportProfile":{"function":"Заявка","contract":{"name":"Синтетический договор","number":"SYNTHETIC-CONTRACT","date":"2025-01-01","issuerInns":["0148372956","0392816475"]},"regulatoryInstructions":"","foodInstructions":"Отсутствуют","signatory":{"surname":"ПодписантТестовый","name":"Тест","position":"Директор","authorityMethod":"1"},"cargoByProductId":{"product":{"name":"Синтетический ДТ","condition":"Жидкий","packagingCode":"TY","packageCount":"1","massMethod":"03","distributable":"1","divisible":"1","heightMetres":"1","lengthMetres":"1","widthMetres":"1","dangerousGoods":null}},"vehicleById":{}}},"autofill":{"signerStatus":"1","instructions":{"redirectionParty":"Грузоотправитель","redirectionMethod":"Телефон","redirectionPhone":"+70000000001"},"loadingByAddressId":{"loading":{"loadingActorCompanyId":"supplier","infrastructureOwnerCompanyId":"supplier"}}}};
const hash = value => createHash('sha256').update(value).digest('hex');
let externalRequests = 0, cookie, runtime;
const originalFetch = globalThis.fetch;
globalThis.fetch = (...args) => providerSend(...args);
const previousAutofill = process.env.SABY_AUTOFILL_PROFILE_JSON;
process.env.SABY_AUTOFILL_PROFILE_JSON = JSON.stringify(fixture.autofill);
const root = await mkdtemp(resolve(tmpdir(), 'artel-direct-protocol-image-smoke-'));
const snapshot = resolve(root, 'snapshot'), store = resolve(root, 'operations');
await Promise.all([mkdir(snapshot), mkdir(store)]);
const source = fixture.data.sourceSha256;
const meta = { source_file: 'synthetic.xlsx', source_sha256: source, created_at_utc: '2026-10-20T00:00:00Z', source_kind: 'test', google_verified: false, formula_policy: '', ownership_policy: '' };
const validation = { status: 'ok', registry_verified: false, issue_counts: {}, cell_issues: [], record_flag_counts: {}, duplicate_record_candidates: [], legal_form_alias_candidate_groups: [], limitations: [] };
const files = {};
for (const name of ['companies', 'shipments', 'payments', 'stock_summaries', 'manager_labels', 'validation_report']) {
  const raw = JSON.stringify({ meta, data: name === 'validation_report' ? validation : [] });
  await writeFile(resolve(snapshot, `${name}.json`), raw);
  files[`${name}.json`] = { sha256: hash(raw), bytes: Buffer.byteLength(raw) };
}
await writeFile(resolve(snapshot, 'manifest.json'), JSON.stringify({ meta, counts: {}, files }));
await writeFile(resolve(store, 'operations.json'), JSON.stringify({ sha256: hash(JSON.stringify(fixture.data)), data: fixture.data }));
const origin = 'https://synthetic.example.test';
const partyEnv = (prefix, party) => Object.fromEntries(Object.entries(party).map(([key, value]) => [`${prefix}_${key === 'edoId' ? 'EDO_ID' : key.toUpperCase()}`, value]));
const env = {
  ARTEL_GEOCODER_ENABLED: 'false', ARTEL_CABINET_SYNC_ENABLED: 'false', ARTEL_PUBLIC_ORIGIN: origin,
  ARTEL_SNAPSHOT_DIR: snapshot, ARTEL_STORE_DIR: store, ARTEL_SETUP_TOKEN: 'synthetic-test-only',
  ARTEL_BANK_REQUESTS_ENABLED: 'false', ARTEL_BANK_SYNC_ENABLED: 'false', PORT: '0',
  SABY_SESSION_ID: 'synthetic-image-session', SABY_WORKFLOW_ENABLED: 'false',
  ...partyEnv('SABY_CUSTOMER', fixture.config.customer), ...partyEnv('SABY_CARRIER', fixture.config.carrier),
  SABY_NK_CONSIGNMENT_SIGNER_JSON: JSON.stringify({ surname: 'НКПодписантТестовый', name: 'Тест', patronymic: '', position: 'Директор' }),
  SABY_NK_REGULATORY_INSTRUCTIONS: 'Синтетические подтверждённые указания НК для проверки очереди.',
  SABY_TRANSPORT_PROFILE_JSON: JSON.stringify(fixture.config.transportProfile),
  SABY_AUTO_SIGNING_JSON: JSON.stringify({
    id: 'synthetic-image-autostart', enabled: true, mode: 'deferred', approvedAt: '2026-10-01T00:00:00.000Z',
    sender: { inn: fixture.config.customer.inn, kpp: fixture.config.customer.kpp, thumbprint: 'ab'.repeat(20) },
    carrier: { inn: fixture.config.carrier.inn, kpp: fixture.config.carrier.kpp, thumbprint: 'cd'.repeat(20) },
  }),
};
const request = (path, method = 'GET', body) => new Promise((done, reject) => {
  const payload = body ? JSON.stringify(body) : undefined;
  const req = httpRequest({ hostname: '127.0.0.1', port: runtime.server.address().port, path, method, headers: {
    host: 'synthetic.example.test', origin, 'content-type': 'application/json',
    ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}), ...(cookie ? { cookie } : {}),
  } }, response => {
    const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
    response.on('end', () => done(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : value])) })));
  }); req.on('error', reject); req.end(payload);
});
const call = async (path, method = 'GET', body) => {
  const response = await request(path, method, body);
  assert.ok([200, 201].includes(response.status), `${method} ${path}: ${await response.clone().text()}`);
  return response.json();
};
const disk = async () => JSON.parse(await readFile(resolve(store, 'operations.json'), 'utf8')).data;
const checks = [];
// All provider RPCs terminate here. The runtime under test is the actual image
// bundle; only the provider transport and isolated data store are synthetic.
const calls = [], documents = new Map(), titleBytes = new Map();
const fingerprint = 'cd'.repeat(20), operatorUid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
let mode = 'verifyDenied', tripId, firstId, secondId, employeeCookie, currentNative;
const json = (id, result) => new Response(JSON.stringify({ jsonrpc: '2.0', id, result }));
const party = org => ({ [/^\d{12}$/.test(org.inn) ? 'СвФЛ' : 'СвЮЛ']: { ИНН: org.inn, КПП: org.kpp, Название: org.name } });
const writes = () => calls.filter(row => ['СБИС.ЗаписатьДокумент', 'СБИС.ЗаписатьВложение', 'СБИС.ВыполнитьДействие'].includes(row.method));
const uploadCalls = () => calls.filter(row => row.method === 'СБИС.ЗаписатьДокумент');
const executeCalls = () => calls.filter(row => row.method === 'СБИС.ВыполнитьДействие');
const getDoc = data => data.etrn.trips[tripId].deliveries[firstId].document;
function document(id) {
  assert.ok(documents.has(id), 'Only the independently seeded provider ID may be read');
  const remote = structuredClone(documents.get(id));
  if (titleBytes.has(id)) remote.Вложение = [{ Идентификатор: `${id}-t1`, Подтип: '1110339', ВерсияФормата: '5.01', Направление: 'Исходящий', Файл: { Имя: `${id}.xml`, Ссылка: `https://disk.saby.ru/${id}.xml` } }];
  const stage = { Идентификатор: 'sender-stage', Название: 'Отправка', Действие: [{ Название: 'Погружен', ТребуетПодписания: 'Да', Сертификат: { Отпечаток: fingerprint, Ключ: { Тип: 'Отложенный', Активирован: 'Да' } } }] };
  remote.Этап = [stage]; remote.ТекущиеЭтапы = [{ Идентификатор: stage.Идентификатор }];
  // Current native Saby drafts expose these roles only in the canonical block.
  remote.Стороны = { Отправитель: remote.Грузоотправитель, Перевозчик: remote.ТранспортнаяКомпания, Получатель: remote.Грузополучатель };
  delete remote.Грузоотправитель; delete remote.ТранспортнаяКомпания; delete remote.Грузополучатель;
  return remote;
}
async function providerSend(url, init) {
  externalRequests++;
  assert.notEqual(mode, 'deny', 'Fresh direct workflow must stop before every provider request');
  if (init?.method === 'GET') {
    const target = new URL(url);
    assert.equal(target.hostname, 'disk.saby.ru');
    const id = target.pathname.slice(1).replace(/\.xml$/, '');
    assert.ok(titleBytes.has(id)); return new Response(titleBytes.get(id));
  }
  const req = JSON.parse(String(init?.body)); calls.push(req);
  const ok = result => json(req.id, result);
  if (req.method === 'СБИС.СписокНашихОрганизаций') return ok({ НашаОрганизация: mode === 'verifyDenied' ? [] : [{ ...party(fixture.config.carrier), ДокументооборотПодключен: 'Да' }] });
  if (req.method === 'СБИС.СписокДокументов') {
    if (mode === 'unknown500') return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32000, message: 'Synthetic list unavailable' } }), { status: 500 });
    return ok({ Документ: [], Навигация: { ЕстьЕще: 'Нет' } });
  }
  if (req.method === 'СБИС.ПрочитатьДокумент') return ok(document(req.params.Документ.Идентификатор));
  if (req.method === 'СБИС.ЗаписатьДокумент') {
    const sent = req.params.Документ;
    assert.equal(sent.Тип, 'ConsignmentNote');
    if (mode === 'create500') {
      assert.equal(sent.Идентификатор, undefined); assert.equal(sent.Номер, undefined); assert.match(sent.Вложение[0].Файл.Имя, /\.xml$/); assert.equal(sent.Вложение.length, 1);
      const xml = new TextDecoder('windows-1251').decode(Buffer.from(sent.Вложение[0].Файл.ДвоичныеДанные, 'base64'));
      assert.match(xml, /МасБрутОтгр="6745"/); assert.match(xml, /Объем="8"/); assert.doesNotMatch(xml, /НомерТрН=|УИД_ТрН=/);
      const saved = getDoc(await disk());
      assert.equal(saved.reservationAttempted, true); assert.equal(saved.uploadAttempted, true);
      assert.equal(saved.directDraftCreation.version, 'auto-number-v1');
      assert.equal(saved.writeAttempts.at(-1).request.bodySha256, hash(String(init.body)));
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32000, message: 'Synthetic create outcome unknown' } }), { status: 500 });
    }
    assert.equal(sent.Идентификатор, currentNative);
    assert.ok(documents.has(sent.Идентификатор), 'No create or allocator is simulated');
    assert.equal(sent.Номер, 'SYNTHETIC-NATIVE-701');
    assert.deepEqual(sent.Адресация, { Идентификатор: currentNative, Редакция: { Идентификатор: `${currentNative}-revision` } });
    assert.equal(sent.Вложение.length, 1);
    const bytes = Buffer.from(sent.Вложение[0].Файл.ДвоичныеДанные, 'base64');
    const xml = new TextDecoder('windows-1251').decode(bytes);
    assert.match(xml, /МасБрутОтгр="6745"/); assert.match(xml, /Объем="8"/); assert.doesNotMatch(xml, /УИД_ТрН=/);
    const saved = getDoc(await disk()), audit = saved.writeAttempts.at(-1);
    assert.equal(saved.uploadAttempted, true); assert.equal(audit.outcome, 'attempted');
    assert.equal(audit.request.requestId, req.id); assert.equal(audit.request.method, req.method);
    assert.equal(audit.request.bodySha256, hash(String(init.body))); assert.equal(audit.request.bodyBytes, Buffer.byteLength(String(init.body)));
    titleBytes.set(currentNative, bytes);
    if (mode === 'upload500') return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32000, message: 'Synthetic ambiguous upload', data: { XML: xml, token: 'must-not-be-persisted' } } }), { status: 500 });
    return ok(document(currentNative));
  }
  if (req.method.startsWith('sabyCertificate.')) {
    assert.ok(['sabyCertificate.Read', 'sabyCertificate.List'].includes(req.method));
    const certificate = {
    Certificate: { Type: 'Client', CertificateInfo: { Thumbprint: fingerprint, IsValid: true, IsQualified: true, NotBefore: '2020-01-01T00:00:00Z', NotAfter: '2099-01-01T00:00:00Z', SubjectName: { '1.2.643.100.4': fixture.config.carrier.inn, '2.5.4.4': 'НКПодписантТестовый', '2.5.4.42': 'Тест' } } },
    OurCompany: { Inn: fixture.config.carrier.inn, Kpp: fixture.config.carrier.kpp },
    }; return ok(req.method.endsWith('.List') ? [certificate] : certificate);
  }
  if (req.method === 'СБИС.ПодготовитьДействие') {
    const id = req.params.Документ.Идентификатор ?? currentNative;
    assert.equal(id, currentNative);
    if (mode === 'validUid') {
      const xml = new TextDecoder('windows-1251').decode(titleBytes.get(id)).replace('encoding="windows-1251"', 'encoding="utf-8"').replace('<СодИнфГО ', `<СодИнфГО УИД_ТрН="${operatorUid}" `);
      titleBytes.set(id, Buffer.from(xml));
    }
    const prepared = document(id); prepared.Этап[0].Вложение = prepared.Вложение.map(row => ({ ...row, ТребуемоеДействие: 'Подписать' }));
    return ok(prepared);
  }
  if (req.method === 'СБИС.ВыполнитьДействие') {
    assert.equal(mode, 'validUid');
    const saved = getDoc(await disk());
    assert.equal(saved.dispatch.operatorUid, operatorUid); assert.equal(saved.dispatch.sender.verified, true);
    assert.equal(saved.dispatch.sender.executeAttempted, true); assert.equal(saved.dispatch.sender.dispatchState, 'attempted');
    // No synthetic signature is manufactured: an uncertain result must block a retry.
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32000, message: 'Synthetic execute outcome unknown' } }), { status: 500 });
  }
  throw new Error(`Unexpected synthetic provider method: ${req.method}`);
}
const writeDisk = async data => {
  assert.equal(runtime, null, 'Synthetic seed changes require a stopped runtime');
  await writeFile(resolve(store, 'operations.json'), JSON.stringify({ sha256: hash(JSON.stringify(data)), data }));
};
const restart = async data => {
  await runtime?.stop(); runtime = null;
  if (data) await writeDisk(data);
  runtime = await createProductionRuntime(env); await runtime.start();
};
const protectedFacts = data => ({ authorization: data.etrn.trips[tripId].direct.authorization,
  loading: data.etrn.trips[tripId].loadingFacts, loadingDetails: data.etrn.trips[tripId].loadingDetails, progress: data.driverTripProgress[tripId],
  shipments: Object.fromEntries([firstId, secondId].map(id => [id, data.shipments[id]])),
});
const resume = async () => { cookie = employeeCookie; return call(`/api/shipment-trips/${tripId}/saby-workflow`, 'POST', {}); };
const seedNative = (baseline, id = 'synthetic-native-existing') => {
  const seeded = structuredClone(baseline), saved = getDoc(seeded), snap = saved.snapshot;
  currentNative = id;
  Object.assign(saved, { id, number: 'SYNTHETIC-NATIVE-701', status: 'unknown', lastError: null, reservationAttempted: true });
  documents.clear(); titleBytes.clear();
  documents.set(id, { Идентификатор: id, Тип: 'ConsignmentNote', Номер: saved.number, Дата: snap.fields.date.split('-').reverse().join('.'),
    Примечание: saved.marker, НашаОрганизация: party(snap.customerOrganization), Грузоотправитель: party(snap.customerOrganization), ТранспортнаяКомпания: party(snap.carrierOrganization), Грузополучатель: party(snap.profile.recipient),
    Направление: 'Исходящий', Редакция: [{ Идентификатор: `${id}-revision`, Актуален: 'Да' }], Состояние: { Код: '0' }, Вложение: [],
  });
  return seeded;
};
try {
  runtime = await createProductionRuntime(env); await runtime.start();
  const setup = await request('/api/auth/setup', 'POST', { name: 'Synthetic director', login: 'direct-protocol-qa', password: randomUUID(), setupToken: env.ARTEL_SETUP_TOKEN });
  assert.equal(setup.status, 200); cookie = setup.headers.get('set-cookie').split(';')[0]; employeeCookie = cookie;
  const issued = await call('/api/drivers/driver/access', 'POST', { version: 0, action: 'issue' });
  const fields = { organization_id: 'nk-artel', trip_flow_version: 'driver-v1', loading_at: '2026-10-20T09:15', supplier_id: 'supplier', carrier_id: 'carrier', oil_depot_id: 'depot', product_id: 'product', purchase_price_unspecified_unit: '50000', driver_id: 'driver', vehicle_id: 'vehicle', additional_costs: '0', trip_notes: 'Synthetic image direct safety' };
  const customers = [false, false].map((_, index) => ({ fields: { customer_id: 'customer', manager_id: 'manager', payment_form_id: 'payment', unloading_address_id: 'delivery', quantity_litres: index ? '9500' : '8000', sale_price_per_litre: '60', transport_amount: '1000', invoice_not_required: String(!index), etrn_not_required: 'false' } }));
  const created = await call('/api/shipment-trips', 'POST', { fields, customers, idempotencyKey: randomUUID() });
  tripId = created.trip.id; [firstId, secondId] = created.trip.customers.map(row => row.id);
  const currentLoading = await call(`/api/shipment-trips/${tripId}/etrn/loading-details`);
  assert.equal(currentLoading.mode, 'sender'); assert.equal(currentLoading.required, false); assert.equal(currentLoading.editable, true);
  assert.equal(currentLoading.details, null); assert.equal(currentLoading.infrastructureOwner.inn, '7707083893');
  assert.equal(externalRequests, 0);
  const login = await request('/api/auth/login', 'POST', { login: issued.access.login, password: issued.temporaryPassword });
  assert.equal(login.status, 200); cookie = login.headers.get('set-cookie').split(';')[0];
  const driverPath = `/api/driver/trips/${tripId}`, assigned = (await call(driverPath)).trip;
  const arrived = (await call(driverPath + '/arrive', 'POST', { versions: assigned.versions })).trip;
  await call(driverPath + '/depart', 'POST', { versions: arrived.versions, masses: arrived.deliveries.map((row, index) => ({ deliveryId: row.id, netTonnes: index ? '7.985' : '6.745' })) });
  const queued = await disk(), savedQueue = queued.etrn.trips[tripId];
  assert.equal(savedQueue.directAutostart.state, 'queued'); assert.equal(savedQueue.direct.authorization.automatic.source, 'driver_departure');
  assert.deepEqual(savedQueue.direct.deliveries.map(row => row.snapshot.profile.loading.grossMassTonnes), ['6.745', '7.985']);
  for (const row of savedQueue.direct.deliveries) {
    assert.equal(row.snapshot.profile.loadingActor.sameAsConsignor, true);
    assert.equal(row.snapshot.profile.loadingActor.basis, undefined);
    assert.equal(row.snapshot.profile.loadingActor.worker, undefined);
    assert.equal(row.snapshot.profile.infrastructureOwner.party.inn, '7707083893');
  }
  assert.equal(externalRequests, 0);
  // The remaining protocol cases intentionally model legacy phone grants and
  // their first-delivery stop boundary. New electronic delivery independence
  // is covered by the source/API suite. This stopped, synthetic-only store
  // reproduces the historical grant, without changing any driver or trip fact.
  assert.ok(savedQueue.direct.deliveries.every(row => row.snapshot.profile.instructions.redirectionMethod === 'Электронное уведомление перевозчика о переадресовке'));
  cookie = employeeCookie;
  const legacyTrip = (await call(`/api/shipment-trips/${tripId}`)).trip;
  for (const row of savedQueue.direct.deliveries) row.snapshot.profile.instructions.redirectionMethod = 'По телефону';
  savedQueue.direct.authorization.sourceHash = hash(JSON.stringify([source,tripId,legacyTrip.fields,legacyTrip.customers.map(row => [row.id,row.version,row.fields]),savedQueue.direct.deliveries,{loadingActorMode:'sender'}]));
  await restart(queued);
  const legacyWorkflow = await call(`/api/shipment-trips/${tripId}/saby-workflow`);
  assert.deepEqual(legacyWorkflow.blockers, []);
  checks.push('new_electronic_default_and_legacy_grant_compatibility');
  const facts = protectedFacts(queued);
  checks.push('autostart_preserved');

  await resume(); const fresh = await disk(), freshDoc = getDoc(fresh);
  assert.equal(writes().length, 0); assert.equal(freshDoc.reservationAttempted, false); assert.equal(freshDoc.uploadAttempted, false);
  assert.equal(freshDoc.id, null); assert.equal(freshDoc.writeAttempts, undefined); assert.ok(freshDoc.lastError);
  assert.equal(fresh.etrn.trips[tripId].deliveries[secondId], undefined); assert.deepEqual(protectedFacts(fresh), facts);
  await restart(); await resume(); assert.equal(writes().length, 0);
  checks.push('organization_access_required_before_create');
  mode = 'create500'; calls.length = 0; await restart(fresh); await resume();
  const lost = getDoc(await disk());
  assert.equal(uploadCalls().length, 1); assert.equal(lost.id, null); assert.equal(lost.writeAttempts[0].outcome, 'uncertain');
  assert.deepEqual(protectedFacts(await disk()), facts);
  mode = 'unknownEmpty'; await restart(); await resume();
  assert.equal(uploadCalls().length, 1); assert.equal(executeCalls().length, 0);
  assert.equal(getDoc(await disk()).reservationAttempted, true);
  checks.push('complete_unnumbered_title_create', 'lost_create_response_no_duplicate');

  for (const searchMode of ['unknownEmpty', 'unknown500']) {
    const unknown = structuredClone(fresh); Object.assign(getDoc(unknown), { reservationAttempted: true, status: 'unknown', lastError: 'Historical uncertain reservation' });
    mode = searchMode; calls.length = 0; await restart(unknown); await resume(); await restart(); await resume();
    const after = await disk(), doc = getDoc(after);
    assert.equal(writes().length, 0); assert.ok(calls.some(row => row.method === 'СБИС.СписокДокументов'));
    assert.equal(doc.id, null); assert.equal(doc.reservationAttempted, true); assert.equal(doc.uploadAttempted, false);
    assert.equal(doc.writeAttempts, undefined); assert.equal(after.etrn.trips[tripId].deliveries[secondId], undefined);
    assert.deepEqual(protectedFacts(after), facts);
  }
  checks.push('ambiguous_attempt_no_retry', 'two_delivery_isolation');

  const held = seedNative(fresh, 'synthetic-native-held'), heldDoc = getDoc(held);
  const originalUnknown = { ...structuredClone(heldDoc), id: null, number: undefined, revision: null };
  heldDoc.senderTitleVersion = 2;
  heldDoc.nativeAdoptionEvidence = {
    version: 'native-ui-adoption-v1', origin: 'independently_created_native_ui',
    nativeDocumentId: heldDoc.id, nativeNumber: heldDoc.number, nativeRevision: `${heldDoc.id}-revision`, nativeAttachmentId: `${heldDoc.id}-native-t1`,
    nativeXmlSha256: hash('synthetic native XML'), nativeReadSha256: hash(JSON.stringify(documents.get(heldDoc.id))), uiEvidenceSha256: hash('synthetic independent native UI creation'),
    planSha256: hash('synthetic reviewed adoption plan'), sourceSnapshotSha256: heldDoc.payloadHash,
    originalAttemptId: heldDoc.attemptId, originalMarker: heldDoc.marker, originalDocumentSha256: hash(JSON.stringify(originalUnknown)),
    originalReservationAttempted: true, originalReservationOutcome: 'unknown', originalWriteAttemptsCount: 0, originalWriteAttemptsSha256: hash('[]'),
    actorId: held.etrn.trips[tripId].direct.authorization.actorId, adoptedAt: new Date().toISOString(), stage: 'planned', holdForReview: true,
  };
  const heldGrant = structuredClone(held.etrn.trips[tripId].direct), requestsBeforeHold = externalRequests;
  mode = 'deny'; calls.length = 0; await restart(held); cookie = employeeCookie;
  await call(`/api/shipment-trips/${tripId}/saby-workflow`);
  const denied = await request(`/api/shipment-trips/${tripId}/saby-workflow`, 'POST', {});
  assert.equal(denied.status, 403); assert.match((await denied.json()).error, /сверку/);
  assert.equal(externalRequests, requestsBeforeHold); assert.equal(calls.length, 0);
  assert.deepEqual((await disk()).etrn.trips[tripId].direct, heldGrant);
  assert.deepEqual(getDoc(await disk()), heldDoc); assert.deepEqual(protectedFacts(await disk()), facts);
  checks.push('native_adoption_hold_blocks_dispatch');

  mode = 'upload500'; calls.length = 0; await restart(seedNative(fresh)); await resume();
  const uncertain = getDoc(await disk()), audit = structuredClone(uncertain.writeAttempts[0]);
  assert.equal(uploadCalls().length, 1); assert.equal(audit.outcome, 'uncertain'); assert.equal(audit.response.httpStatus, 500); assert.equal(audit.response.rpcCode, -32000);
  assert.equal(audit.response.rpcIdMatches, true); assert.equal(audit.response.message, 'Synthetic ambiguous upload');
  assert.doesNotMatch(JSON.stringify(audit), /must-not-be-persisted|<Файл|ДвоичныеДанные/);
  assert.equal(uncertain.id, currentNative); assert.equal(uncertain.uploadAttempted, true);
  mode = 'missingUid'; await restart(); await resume();
  const missingUid = getDoc(await disk());
  assert.equal(uploadCalls().length, 1); assert.equal(executeCalls().length, 0);
  assert.ok(calls.some(row => row.method === 'СБИС.ПодготовитьДействие'), JSON.stringify({ dispatch: missingUid.dispatch, error: missingUid.lastError, methods: calls.map(row => row.method) }));
  assert.equal(missingUid.dispatch.operatorUid, undefined); assert.match(missingUid.dispatch.lastError, /УИД/);
  assert.deepEqual(missingUid.writeAttempts[0], audit); assert.equal((await disk()).etrn.trips[tripId].deliveries[secondId], undefined);
  checks.push('known_id_no_second_create', 'http500_intent_durable_before_network', 'sanitized_diagnostic_persisted', 'missing_operator_uid_blocks_execute');

  mode = 'validUid'; calls.length = 0; await restart(seedNative(fresh, 'synthetic-native-uid')); await resume();
  const valid = getDoc(await disk());
  assert.equal(uploadCalls().length, 1); assert.equal(executeCalls().length, 1); assert.equal(valid.dispatch.operatorUid, operatorUid);
  assert.equal(valid.dispatch.sender.executeAttempted, true); assert.equal(valid.dispatch.completedAt, undefined);
  await restart(); await resume();
  assert.equal(uploadCalls().length, 1); assert.equal(executeCalls().length, 1);
  assert.equal(getDoc(await disk()).dispatch.operatorUid, operatorUid); assert.deepEqual(protectedFacts(await disk()), facts);
  assert.equal((await disk()).etrn.trips[tripId].deliveries[secondId], undefined);
  checks.push('operator_uid_persisted_before_execute', 'uncertain_execute_no_repeat_after_restart');
  console.log(JSON.stringify({ passed: true, synthetic: true, realProductionBundle: true, authenticatedHttp: true, schedulerDisabled: true, externalNetwork: false, syntheticProviderRequests: externalRequests, noRealBusinessRecords: true, checks }));
} finally {
  globalThis.fetch = originalFetch;
  if (previousAutofill === undefined) delete process.env.SABY_AUTOFILL_PROFILE_JSON; else process.env.SABY_AUTOFILL_PROFILE_JSON = previousAutofill;
  await runtime?.stop(); await rm(root, { recursive: true, force: true });
}
