import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Company, Snapshot } from '../web/src/model';
import { verifySabySenderBusiness } from '../server/saby-order-evidence';
import { ApiError } from '../server/api-error';
import { emptyDirectories } from '../server/directory-operations';
import { OperationsStore } from '../server/operations-store';
import { saveShipmentTrip } from '../server/shipment-trips';
import { SabyClient, type SabyConfig, type SabyObject } from '../server/saby-client';
import { serializeSabyTransportOrder, type SabyTransportProfile } from '../server/saby-transport-order';
import { getTripSabyWorkflow, runTripSabyWorkflow, sabyCarrierAcceptance, validateTripSabyData, type PrepareTripSaby, type CreateTripSabyDelivery } from '../server/trip-saby-workflow';
import { hasSabyDocuments, submitSabyTrip } from '../server/saby-service';
import { syntheticEtrnFixture, sender, carrier } from './helpers/etrn-fixture';

const source = 'synthetic-trip-saby-workflow';
const profile: SabyTransportProfile = { function: 'Заказ', regulatoryInstructions: 'Синтетические требования', foodInstructions: 'Синтетическое значение', signatory: { surname: 'Тестов', name: 'Тест', position: 'Директор', authorityMethod: '1' }, cargoByProductId: { product: { name: 'Синтетический ДТ', condition: 'Жидкий', packagingCode: 'TY', packageCount: '1', massMethod: '03', distributable: '1', divisible: '1', heightMetres: '1', lengthMetres: '1', widthMetres: '1', dangerousGoods: null } }, vehicleById: { vehicle: { type: 'Синтетическая цистерна', payloadTonnes: '20', capacityCubicMetres: '25' } } };
const config = (): SabyConfig => ({ sessionId: 'private-workflow-session', customer: sender, carrier, transportProfile: profile });
const company = (id: string, role: string): Company => ({ id, name: `Тест ${id}`, roles: [role], managerLabels: [], shipmentIds: [], paymentIds: [], flags: [] });
const base = (): Snapshot => {
  const zero = { total: '0', numericCount: 0, missingCount: 0 };
  return { provenance: { sourceSha256: source, sourceKind: 'synthetic', sourceFile: 'synthetic', exportedAt: '2026-01-01', googleVerified: false, registryVerified: false, formulaPolicy: '', ownershipPolicy: '', valueBasis: '', sourceFilesVerified: false, counts: {}, dateRange: { from: null, to: null } }, companies: [company('supplier', 'supplier'), company('customer', 'customer')], shipments: [], payments: [], stocks: [], managers: [], monthly: [], quality: { status: 'synthetic', issueCounts: {}, issues: [], recordFlagCounts: { shipments: {}, payments: {} }, flaggedShipmentCount: 0, flaggedPaymentCount: 0, duplicateCandidates: [], aliasCandidates: [], multipleManagerCompanyIds: [], limitations: [] }, overview: { shipmentCount: 0, paymentCount: 0, companyCount: 2, liters: zero, revenue: zero, cost: zero, incoming: zero, outgoing: zero, missingShipmentDates: 0, missingPaymentDates: 0 } };
};
const prepare: PrepareTripSaby = (_snapshot, _data, trip) => ({
  scenario: 'artel_customer', blockers: [],
  order: { tripId: trip.id, shipmentId: trip.id, version: 1, fields: { ...trip.fields, quantity_litres: '14000', quantity_gross_tonnes: '12' }, customer: sender, supplier: carrier, driver: { name: 'Синтетический водитель', phone: '+70000000003' }, vehicle: { plate: 'Т000ТТ00', type: 'Цистерна' }, customerOrganization: sender, carrierOrganization: carrier, profile, deliveries: trip.customers.map(row => ({ shipmentId: row.id, fields: row.fields, customer: sender })), loadingInfrastructureOwner: { name: 'Синтетическая площадка', inn: '0000000000' }, allowedOperationTime: '19:00:00+03:00', intermediateStops: [{ afterShipmentId: trip.customers[0].id, name: 'Собственная точка', address: 'Синтетический адрес остановки' }] },
  deliveries: trip.customers.map(row => ({ shipmentId: row.id, snapshot: { ...syntheticEtrnFixture().snapshot, tripId: trip.id, shipmentId: row.id } })),
});
async function runtime() {
  const directory = await mkdtemp(resolve(tmpdir(), 'artel-trip-saby-')); const store = new OperationsStore(directory); const snapshot = base();
  await store.mutate(source, data => { data.directories = { ...emptyDirectories(), fleetSeedApplied: true, managers: [{ id: 'manager', name: 'Тест' }], products: [{ id: 'product', name: 'Тест' }], paymentForms: [{ id: 'payment', name: 'б/нал' }], vehicles: [{ id: 'vehicle', plate: 'Т001ЕЕ777' }], drivers: [{ id: 'driver', name: 'Тестов Тест Тестович', vehicleId: 'vehicle' }], oilDepots: [{ id: 'depot', name: 'Тестовая нефтебаза', address: 'Тестовый адрес погрузки', ownerCompanyId: 'supplier' }], addresses: [{ id: 'loading', companyId: 'supplier', kind: 'loading', name: 'Тестовая погрузка', address: 'Тестовый адрес погрузки' }, { id: 'delivery', companyId: 'customer', kind: 'delivery', name: 'Тестовая доставка', address: 'Тестовый адрес доставки' }] }; return { result: undefined, changed: true }; });
  const created = await store.mutate(source, data => ({ result: saveShipmentTrip(snapshot, data, { fields: { date: '2026-09-30', supplier_id: 'supplier', product_id: 'product', purchase_price_unspecified_unit: '50000', quantity_tonnes: '12', driver_id: 'driver', vehicle_id: 'vehicle', oil_depot_id: 'depot', loading_planned_at: '2026-09-30T09:00', additional_costs: '0' }, customers: [0, 1].map(index => ({ fields: { customer_id: 'customer', manager_id: 'manager', payment_form_id: 'payment', quantity_litres: index ? '6000' : '8000', sale_price_per_litre: '60', transport_amount: '1000', unloading_address_id: 'delivery', unloading_planned_at: '2026-09-30T09:00' } })) }), changed: true }));
  return { base: snapshot, store, tripId: created.trip.id, prepare, authorize: () => undefined, directory, trip: created.trip, close: () => rm(directory, { recursive: true, force: true }) };
}
type Rpc = { method: string; params: Record<string, SabyObject>; id: number };
function fakeApi() {
  const calls: Rpc[] = []; const docs = new Map<string, SabyObject>(); let carrierXml = ''; let senderXml = new Uint8Array();
  const json = (req: Rpc, result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }));
  const send: typeof fetch = async (_url, init) => {
    if (init?.method === 'GET') return new Response(String(_url).includes('carrier.xml') ? Buffer.from(carrierXml, 'utf8') : senderXml);
    const req = JSON.parse(String(init?.body)) as Rpc; calls.push(req);
    if (req.method === 'СБИС.СписокНашихОрганизаций') return json(req, { НашаОрганизация: [{ СвЮЛ: req.params.Фильтр.НашаОрганизация.СвЮЛ, ДокументооборотПодключен: 'Да' }] });
    if (req.method === 'СБИС.ЗаписатьДокумент') {
      const input = req.params.Документ; if (input.Вложение) senderXml = Buffer.from(String(((input.Вложение as SabyObject[])[0].Файл as SabyObject).ДвоичныеДанные), 'base64'); const id = String(input.Идентификатор ?? `remote-${docs.size + 1}`);
      const doc: SabyObject = { ...docs.get(id), ...input, Идентификатор: id, Номер: input.Номер ?? String(41 + docs.size), Редакция: [{ Идентификатор: `${id}-revision`, Актуален: 'Да' }], Состояние: { Название: 'Черновик' }, Код: { Состояние: '0' }, СсылкаДляНашаОрганизация: `https://online.saby.ru/document/${id}`, Вложение: input.Вложение ? [{ Идентификатор: 'title-one', Файл: { Имя: 'sender.xml', Ссылка: 'https://disk.saby.ru/sender.xml' }, Подтип: '1110361', ВерсияФормата: '5.01' }] : [] };
      docs.set(id, doc); return json(req, doc);
    }
    if (req.method === 'СБИС.ПрочитатьДокумент') return json(req, docs.get(String(req.params.Документ.Идентификатор)));
    if (req.method === 'СБИС.СписокДокументов') return json(req, { Документ: [...docs.values()], Навигация: { ЕстьЕще: 'Нет' } });
    throw new Error('Unexpected synthetic method');
  };
  const accept = () => {
    const doc = [...docs.values()][0]; doc.Код = { Состояние: '7' }; doc.Состояние = { Название: 'Утверждено' };
    const upload = calls.find(row => row.method === 'СБИС.ЗаписатьДокумент' && row.params.Документ.Вложение)!.params.Документ;
    const file = (upload.Вложение as SabyObject[])[0].Файл as SabyObject;
    const originalXml = new TextDecoder('windows-1251').decode(Buffer.from(String(file.ДвоичныеДанные), 'base64'));
    carrierXml = `<?xml version="1.0" encoding="utf-8"?><Файл><Документ КНД="1110362"><ИдИнфГО ИдФайлИнфГО="${String(file.Имя).replace(/\.xml$/, '')}" ДатФайлИнфГО="${/ДатИнфГО="([^"]+)"/.exec(originalXml)![1]}" ВрФайлИнфГО="${/ВрИнфГО="([^"]+)"/.exec(originalXml)![1]}" ЭП="synthetic-sender-signature"/><СодИнфПрв СодОпер="1" УИД_Зак="synthetic-uid"/></Документ></Файл>`;
    (doc.Вложение as SabyObject[]).push({ Идентификатор: 'carrier-title', Файл: { Имя: 'carrier.xml', Ссылка: 'https://disk.saby.ru/carrier.xml' }, Подтип: '1110362', ВерсияФормата: '5.01', Подпись: [{ Сертификат: { Отпечаток: 'synthetic-carrier-certificate' } }] });
  };
  return { send, docs, calls, json, accept, corruptCarrier: () => { carrierXml = carrierXml.replace('СодОпер="1"', 'СодОпер="2"'); }, writes: () => calls.filter(req => req.method === 'СБИС.ЗаписатьДокумент') };
}
const neverCreate = async () => { throw new Error('Carrier has not confirmed'); };
const success = async (input: CreateTripSabyDelivery) => ({ status: 'draft' as const, id: `etrn-${input.shipmentId}`, lastError: null });

test('whole-trip preflight and ordinary save do not call Saby; any missing delivery fails closed', async () => {
  const rt = await runtime(); const api = fakeApi();
  try {
    assert.equal(api.calls.length, 0);
    const data = await rt.store.read(source); assert.equal(getTripSabyWorkflow({ ...rt, data, config: config() }).status, 'not_sent');
    for (const fail of ['blocker', 'missing'] as const) {
      const incomplete: PrepareTripSaby = (...args) => { const value = prepare(...args); if (fail === 'blocker') value.blockers.push('Недостающий подтверждённый факт'); if (fail === 'missing') value.deliveries.pop(); return value; };
      await assert.rejects(runTripSabyWorkflow({ ...rt, prepare: incomplete, client: new SabyClient(config(), api.send), createDelivery: neverCreate }), error => error instanceof ApiError && error.status === 422);
    }
    assert.equal(api.calls.length, 0); assert.equal((await rt.store.read(source)).tripSaby, undefined);
  } finally { await rt.close(); }
});
test('one registry-numbered trip order preserves repeated recipient deliveries and waits for signed carrier title', async () => {
  const rt = await runtime(); const api = fakeApi(); const client = new SabyClient(config(), api.send);
  try {
    const waiting = await runTripSabyWorkflow({ ...rt, client, createDelivery: neverCreate });
    assert.equal(waiting.phase, 'awaiting_carrier'); assert.equal(waiting.status, 'not_sent'); assert.equal(waiting.order?.exchangeStage, 'sender_action_required'); assert.equal(waiting.carrierConfirmed, false); assert.equal(waiting.order?.number, '41'); assert.equal(api.docs.size, 1); assert.equal(api.writes().length, 2);
    const [reserve, upload] = api.writes().map(row => row.params.Документ); assert.equal(reserve.Номер, undefined); assert.equal(reserve.Вложение, undefined); assert.equal(upload.Идентификатор, 'remote-1'); assert.equal(upload.Номер, '41');
    const file = (upload.Вложение as SabyObject[])[0].Файл as SabyObject; const bytes = Buffer.from(String(file.ДвоичныеДанные), 'base64'); const xml = new TextDecoder('windows-1251').decode(bytes);
    assert.equal((xml.match(/Опер="Выгрузка"/g) ?? []).length, 2); assert.match(xml, /НомЗак="41"/); assert.doesNotMatch(xml, /НомЗак="CRM-/); assert.match(xml, /Объем="14"/); assert.match(xml, /МасБрутЗнач="12000"/); assert.match(xml, /ПредВрОпер="19:00:00\+03:00"/); assert.match(xml, /Собственная точка/);
    const path = resolve(rt.directory, 'order.xml'); await writeFile(path, bytes); const validation = spawnSync('xmllint', ['--noout', '--schema', resolve('tests/fixtures/saby/transport-order-1110361-5.01.xsd'), path], { encoding: 'utf8' }); assert.equal(validation.status, 0, validation.stderr);
    const privateData = await rt.store.read(source); validateTripSabyData(privateData.tripSaby); assert.equal(hasSabyDocuments(privateData, rt.tripId), true);
    await assert.rejects(submitSabyTrip({ ...rt, client }), error => error instanceof ApiError && error.status === 409);
    await runTripSabyWorkflow({ ...rt, client, createDelivery: neverCreate }); assert.equal(api.writes().length, 2);
    api.accept(); const seen: CreateTripSabyDelivery[] = [];
    const complete = await runTripSabyWorkflow({ ...rt, client, createDelivery: async input => { seen.push(input); return success(input); } });
    assert.equal(complete.phase, 'completed'); assert.equal(complete.carrierConfirmed, true); assert.equal(seen.length, 2); assert.notEqual(seen[0].shipmentId, seen[1].shipmentId); assert.equal(seen[0].order.id, seen[1].order.id); assert.equal(seen[0].order.number, '41');
    assert.doesNotMatch(JSON.stringify(complete), /snapshot|private-workflow-session|payloadHash/);
    assert.deepEqual(complete.carrierHandoff, { driverName: 'Синтетический водитель', driverPhone: '+70000000003', vehiclePlate: 'Т000ТТ00', vehicleType: 'Цистерна' });
    assert.doesNotMatch(await readFile(resolve(rt.directory, 'operations.json'), 'utf8'), /private-workflow-session/);
    const restarted = new OperationsStore(rt.directory); await runTripSabyWorkflow({ ...rt, store: restarted, client, createDelivery: neverCreate }); assert.equal(api.writes().length, 2);
  } finally { await rt.close(); }
});
test('carrier acceptance requires code 7 and current signed 1110362, never a sender signature or label', () => {
  const current: SabyObject = { Редакция: [{ Идентификатор: 'rev', Актуален: 'Да' }], Код: { Состояние: '7' }, Вложение: [{ Идентификатор: 'carrier', Подтип: '1110362', ВерсияФормата: '5.01', Подпись: [{ Сертификат: { Отпечаток: 'synthetic' } }] }] };
  assert.ok(sabyCarrierAcceptance(current));
  assert.ok(sabyCarrierAcceptance({ ...current, Вложение: [{ ...(current.Вложение as SabyObject[])[0], Редакция: { Номер: '1', ДатаВремя: '01.04.2025 11:00:00' } }] }));
  for (const changed of [ { Код: { Состояние: '4' } }, { Код: { Состояние: '9' } }, { Код: {}, Состояние: { Название: 'Утверждено' } }, { Вложение: [{ ...(current.Вложение as SabyObject[])[0], Подтип: '1110361' }] }, { Вложение: [{ ...(current.Вложение as SabyObject[])[0], Подпись: [] }] }, { Вложение: [{ ...(current.Вложение as SabyObject[])[0], Удален: 'Да' }] }, { Вложение: [{ ...(current.Вложение as SabyObject[])[0], Редакция: 'old' }] } ]) assert.equal(sabyCarrierAcceptance({ ...current, ...changed }), null);
});
test('lost reservation response searches the whole date for its marker and never creates a second order', async () => {
  const rt = await runtime(); const api = fakeApi(); let lose = true;
  const send: typeof fetch = async (url, init) => { const response = await api.send(url, init); const req = JSON.parse(String(init?.body)); if (req.method === 'СБИС.ЗаписатьДокумент' && lose) { lose = false; throw new Error('private-network'); } return response; };
  try {
    const client = new SabyClient(config(), send); assert.equal((await runTripSabyWorkflow({ ...rt, client, createDelivery: neverCreate })).phase, 'unknown'); assert.equal(api.writes().length, 1);
    const [id, doc] = [...api.docs][0]; api.docs.clear(); assert.equal((await runTripSabyWorkflow({ ...rt, client, createDelivery: neverCreate })).phase, 'unknown'); assert.equal(api.writes().length, 1);
    api.docs.set(id, doc); assert.equal((await runTripSabyWorkflow({ ...rt, client, createDelivery: neverCreate })).phase, 'awaiting_carrier'); assert.equal(api.writes().length, 2); assert.equal(api.docs.size, 1);
    assert.equal(api.calls.find(req => req.method === 'СБИС.СписокДокументов')!.params.Фильтр.Маска, undefined);
  } finally { await rt.close(); }
});
test('unknown upload reads the same ID and never uploads again if the title is still missing', async () => {
  const rt = await runtime(); const api = fakeApi();
  const send: typeof fetch = async (url, init) => { const req = JSON.parse(String(init?.body)); if (req.method === 'СБИС.ЗаписатьДокумент' && req.params.Документ.Вложение) throw new Error('lost-upload'); return api.send(url, init); };
  try {
    const client = new SabyClient(config(), send); const first = await runTripSabyWorkflow({ ...rt, client, createDelivery: neverCreate }); assert.equal(first.phase, 'unknown'); assert.equal(first.order?.id, 'remote-1');
    await runTripSabyWorkflow({ ...rt, client: new SabyClient(config(), api.send), createDelivery: neverCreate }); assert.equal(api.writes().length, 1); assert.equal(api.docs.size, 1);
  } finally { await rt.close(); }
});
test('double click is excluded by durable trip lease, including during number reservation', async () => {
  const rt = await runtime(); const api = fakeApi(); let release!: () => void; let entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; }); const started = new Promise<void>(resolve => { entered = resolve; });
  const send: typeof fetch = async (url, init) => { if (JSON.parse(String(init?.body)).method === 'СБИС.ЗаписатьДокумент') { entered(); await blocked; } return api.send(url, init); };
  try {
    const client = new SabyClient(config(), send); const first = runTripSabyWorkflow({ ...rt, client, createDelivery: neverCreate }); await started;
    await assert.rejects(runTripSabyWorkflow({ ...rt, client, createDelivery: neverCreate }), error => error instanceof ApiError && error.status === 409);
    release(); assert.equal((await first).phase, 'awaiting_carrier'); assert.equal(api.docs.size, 1);
  } finally { release(); await rt.close(); }
});
test('partial delivery success survives restart and later deliveries retain original frozen snapshots', async () => {
  const rt = await runtime(); const api = fakeApi(); const client = new SabyClient(config(), api.send);
  try {
    await runTripSabyWorkflow({ ...rt, client, createDelivery: neverCreate }); api.accept(); let calls = 0;
    const first = await runTripSabyWorkflow({ ...rt, client, createDelivery: async input => { calls++; return calls === 1 ? success(input) : { status: 'unknown', id: `etrn-${input.shipmentId}`, lastError: 'Нужна сверка' }; } });
    assert.equal(first.phase, 'unknown'); assert.equal(first.deliveries[0].status, 'draft'); assert.ok(first.deliveries[1].id);
    const resumed: string[] = [];
    const final = await runTripSabyWorkflow({ ...rt, store: new OperationsStore(rt.directory), prepare: () => { throw new Error('Do not replace frozen preparation'); }, client, createDelivery: async input => { resumed.push(input.shipmentId); assert.equal(input.snapshot.profile.cargo.name, syntheticEtrnFixture().profile.cargo.name); return success(input); } });
    assert.equal(final.phase, 'completed'); assert.deepEqual(resumed, [first.deliveries[1].shipmentId]); assert.equal(api.writes().length, 2);
  } finally { await rt.close(); }
});
test('revocation after reservation preserves ID but stops XML upload and returns permission error', async () => {
  const rt = await runtime(); const api = fakeApi(); let revoked = false;
  const send: typeof fetch = async (url, init) => { const response = await api.send(url, init); if (JSON.parse(String(init?.body)).method === 'СБИС.ЗаписатьДокумент') revoked = true; return response; };
  try {
    await assert.rejects(runTripSabyWorkflow({ ...rt, client: new SabyClient(config(), send), authorize: () => { if (revoked) throw new ApiError(403, 'Нет доступа'); }, createDelivery: neverCreate }), error => error instanceof ApiError && error.status === 403);
    assert.equal(api.writes().length, 1); assert.equal((await rt.store.read(source)).tripSaby!.trips[rt.tripId].order.id, 'remote-1');
  } finally { await rt.close(); }
});
test('mutated frozen workflow snapshots are rejected by store validation', async () => {
  const rt = await runtime(); const api = fakeApi();
  try {
    await runTripSabyWorkflow({ ...rt, client: new SabyClient(config(), api.send), createDelivery: neverCreate });
    const data = await rt.store.read(source); const saved = structuredClone(data.tripSaby); saved!.trips[rt.tripId].snapshot.fields.quantity_tonnes = '1'; assert.throws(() => validateTripSabyData(saved));
    const order = prepare(rt.base, data, rt.trip, config()).order; assert.equal(serializeSabyTransportOrder(order, '11111111-1111-4111-8111-111111111111', '2026-09-30T09:00:00Z', '42').number, '42');
  } finally { await rt.close(); }
});

test('missing actual loading facts wait without ETRN writes and resume after employee confirmation', async () => {
  const rt = await runtime(); const api = fakeApi(); const client = new SabyClient(config(), api.send);
  try {
    await runTripSabyWorkflow({ ...rt, client, createDelivery: neverCreate }); api.accept();
    const waiting = await runTripSabyWorkflow({ ...rt, client, createDelivery: async () => ({ status: 'error', id: null, lastError: 'Сотрудник должен указать факты погрузки', waitingForLoading: true }) });
    assert.equal(waiting.phase, 'awaiting_loading'); assert.equal(waiting.status, 'sent'); assert.equal(waiting.carrierConfirmed, true);
    const resumed = await runTripSabyWorkflow({ ...rt, client, createDelivery: success }); assert.equal(resumed.phase, 'completed'); assert.equal(api.writes().length, 2);
  } finally { await rt.close(); }
});
test('signed carrier metadata with rejected XML cannot create any consignment notes', async () => {
  const rt = await runtime(); const api = fakeApi(); const client = new SabyClient(config(), api.send);
  try {
    await runTripSabyWorkflow({ ...rt, client, createDelivery: neverCreate }); api.accept(); api.corruptCarrier();
    const result = await runTripSabyWorkflow({ ...rt, client, createDelivery: neverCreate }); assert.equal(result.phase, 'unknown'); assert.equal(result.carrierConfirmed, false); assert.match(result.lastError!, /именно этой заявки/);
  } finally { await rt.close(); }
});

test('revocation after durable intent but before the HTTP call does not manufacture an unknown external write', async () => {
  const rt = await runtime(); const api = fakeApi(); let revokeOnce = true;
  try {
    const client = new SabyClient(config(), api.send);
    await assert.rejects(runTripSabyWorkflow({ ...rt, client, authorize: (_snapshot, data) => { const row = data.tripSaby?.trips[rt.tripId]; if (revokeOnce && row?.reservationAttempted && !row.order.id) { revokeOnce = false; throw new ApiError(403, 'Доступ отозван'); } }, createDelivery: neverCreate }), error => error instanceof ApiError && error.status === 403);
    assert.equal(api.writes().length, 0); const data = await rt.store.read(source); assert.equal(data.tripSaby!.trips[rt.tripId].reservationAttempted, false);
    const resumed = await runTripSabyWorkflow({ ...rt, client, createDelivery: neverCreate }); assert.equal(resumed.phase, 'awaiting_carrier'); assert.equal(api.docs.size, 1);
  } finally { await rt.close(); }
});

test('sender business evidence compares XML structure and refuses entities, duplicate attributes, changed parties and route', async () => {
  const rt = await runtime();
  try {
    const data = await rt.store.read(source); const order = prepare(rt.base, data, rt.trip, config()).order;
    const frozen = serializeSabyTransportOrder(order, '11111111-1111-4111-8111-111111111111', '2026-09-30T09:00:00Z', '41').xml;
    const xml = new TextDecoder('windows-1251').decode(frozen).replace('encoding="windows-1251"', 'encoding="utf-8"');
    const normalized = xml.replace('КНД="1110361" Функция="Заказ"', 'Функция="Заказ" КНД="1110361"').replaceAll('><', '>\n<');
    assert.ok(verifySabySenderBusiness(Buffer.from(normalized), frozen));
    for (const corrupt of [
      xml.replace('ИННЮЛ="0148372956"', 'ИННЮЛ="0392816475"'),
      xml.replace('Тестовый адрес доставки', 'Другой адрес доставки'),
      xml.replace('<Файл ', '<!DOCTYPE Файл [<!ENTITY injected "test">]><Файл '),
      xml.replace('ВерсПрог="Artel-CRM"', 'ВерсПрог="&injected;"'),
      xml.replace('ВерсПрог="Artel-CRM"', 'ВерсПрог="Artel-CRM" ВерсПрог="Saby"'),
    ]) assert.throws(() => verifySabySenderBusiness(Buffer.from(corrupt), frozen));
  } finally { await rt.close(); }
});

test('structured order stages persist across restart without duplicate writes or repetitive history', async () => {
  const rt = await runtime(); const api = fakeApi(); const client = new SabyClient(config(), api.send);
  try {
    const first = await runTripSabyWorkflow({ ...rt, client, createDelivery: neverCreate });
    assert.equal(first.order?.remoteStateCode, '0'); assert.equal(first.history.length, 1); assert.ok(first.lastCheckedAt);
    const doc = api.docs.get(first.order!.id!)!;
    doc.Код = { Состояние: '23' };
    const signing = await runTripSabyWorkflow({ ...rt, client, createDelivery: neverCreate });
    assert.equal(signing.order?.exchangeStage, 'signature_pending'); assert.equal(signing.status, 'not_sent');
    for (const [code, stage] of [['3', 'sending_to_carrier'], ['4', 'carrier_details_required'], ['7', 'carrier_confirmation_pending']] as const) {
      doc.Код = { Состояние: code }; doc.Состояние = { Название: 'Произвольная надпись' };
      const result = await runTripSabyWorkflow({ ...rt, store: new OperationsStore(rt.directory), client, createDelivery: neverCreate });
      assert.equal(result.status, 'sent'); assert.equal(result.order?.exchangeStage, stage); assert.equal(result.carrierConfirmed, false);
      const repeated = await runTripSabyWorkflow({ ...rt, client, createDelivery: neverCreate });
      assert.deepEqual(repeated.history, result.history);
    }
    const saved = await rt.store.read(source); validateTripSabyData(saved.tripSaby);
    assert.equal(saved.tripSaby!.trips[rt.tripId].history!.length, 5); assert.equal(api.writes().length, 2);
    assert.doesNotMatch(JSON.stringify(saved.tripSaby!.trips[rt.tripId].history), /Синтетический|phone|certificate|ФИО|Подпись/);
  } finally { await rt.close(); }
});

test('failed reads preserve successful check time and legacy metadata does not claim sent', async () => {
  const rt = await runtime(); const api = fakeApi();
  try {
    await runTripSabyWorkflow({ ...rt, client: new SabyClient(config(), api.send), createDelivery: neverCreate });
    await rt.store.mutate(source, data => { const record = data.tripSaby!.trips[rt.tripId]; record.lastCheckedAt = '2000-01-01T00:00:00.000Z'; return { result: null, changed: true }; });
    const failing: typeof fetch = async (url, init) => { if (JSON.parse(String(init?.body)).method === 'СБИС.ПрочитатьДокумент') throw new Error('synthetic timeout'); return api.send(url, init); };
    const result = await runTripSabyWorkflow({ ...rt, client: new SabyClient(config(), failing), createDelivery: neverCreate });
    assert.equal(result.lastCheckedAt, '2000-01-01T00:00:00.000Z'); assert.ok(result.lastCheckAttemptAt! > result.lastCheckedAt!);
    assert.equal(result.history.length, 1); assert.equal(api.writes().length, 2);
    const old = await rt.store.read(source); const record = old.tripSaby!.trips[rt.tripId];
    record.phase = 'awaiting_carrier'; delete record.lastCheckedAt; delete record.lastCheckAttemptAt; delete record.history; delete record.order.remoteStateCode; delete record.order.exchangeStage; record.order.remoteStatus = 'Отправлено';
    validateTripSabyData(old.tripSaby);
    const legacy = getTripSabyWorkflow({ ...rt, data: old, config: config() });
    assert.equal(legacy.status, 'not_sent'); assert.equal(legacy.order?.exchangeStage, 'unknown'); assert.equal(legacy.lastCheckedAt, null); assert.deepEqual(legacy.history, []);
  } finally { await rt.close(); }
});

test('operator error, rejection and annulment stop before downstream creation and can be read manually', async () => {
  const rt = await runtime(); const api = fakeApi(); const client = new SabyClient(config(), api.send);
  try {
    await runTripSabyWorkflow({ ...rt, client, createDelivery: neverCreate });
    const doc = [...api.docs.values()][0];
    for (const [code, stage] of [['6', 'operator_error'], ['9', 'rejected'], ['22', 'cancelled']] as const) {
      doc.Состояние = { Код: code, Название: 'Состояние оператора', ...(code === '6' ? { КоличествоОшибок: '1' } : {}) }; delete doc.Код;
      const result = await runTripSabyWorkflow({ ...rt, client, createDelivery: neverCreate });
      assert.equal(result.phase, 'error'); assert.equal(result.order?.exchangeStage, stage); assert.equal(result.carrierConfirmed, false); assert.ok(result.lastError);
    }
    assert.equal(api.writes().length, 2);
  } finally { await rt.close(); }
});
