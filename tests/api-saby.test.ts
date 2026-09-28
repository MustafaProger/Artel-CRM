import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import type { Snapshot, Company } from '../web/src/model';
import { emptyDirectories } from '../server/directory-operations';
import { OperationsStore } from '../server/operations-store';
import { saveShipmentTrip } from '../server/shipment-trips';
import { SabyClient, SabyError, sabyConfigFromEnv, sabyConfigurationBlockers, type SabyConfig, type SabyObject } from '../server/saby-client';
import { serializeSabyTransportOrder, sabyTransportBlockers, encodeWindows1251, type SabyTransportSnapshot, type SabyTransportProfile } from '../server/saby-transport-order';
import { submitSabyTrip, getSabyTrip, validateSabyData, hasSabyDocuments } from '../server/saby-service';
import { ApiError } from '../server/api-error';

const source = 'saby-synthetic-source';
const profile: SabyTransportProfile = { function: 'Заказ', regulatoryInstructions: 'Синтетические требования', foodInstructions: 'Не пищевая продукция', signatory: { surname: 'Тестов', name: 'Тест', patronymic: 'Тестович', position: 'Директор', authorityMethod: '1' }, cargoByProductId: { product: { name: 'Синтетический груз', condition: 'Исправный', packagingCode: '00', packageCount: '1', massMethod: '01', distributable: '1', divisible: '1', heightMetres: '1', lengthMetres: '1', widthMetres: '1', dangerousGoods: null } }, vehicleById: { vehicle: { type: 'Синтетическая цистерна', payloadTonnes: '20', capacityCubicMetres: '25' } } };
const config = (): SabyConfig => ({ sessionId: 'private-synthetic-session', customer: { inn: '7707083893', kpp: '770701001', name: 'Тестовый заказчик', address: 'Тестовый адрес заказчика', phone: '+79990000001', edoId: '2BE-customer-test' }, carrier: { inn: '7736050003', kpp: '773601001', name: 'Тестовый перевозчик', address: 'Тестовый адрес перевозчика', phone: '+79990000002', edoId: '2BE-carrier-test' }, transportProfile: structuredClone(profile) });
const company = (id: string, role: string): Company => ({ id, name: `Тест ${id}`, inn: id === 'supplier' ? '7707083893' : '7736050003', roles: [role], managerLabels: [], shipmentIds: [], paymentIds: [], flags: [] });
const base = (): Snapshot => ({ provenance: { sourceSha256: source, sourceKind: 'synthetic', sourceFile: 'synthetic', exportedAt: '2026-01-01', googleVerified: false, registryVerified: false, formulaPolicy: '', ownershipPolicy: '', valueBasis: '', sourceFilesVerified: false, counts: {}, dateRange: { from: null, to: null } }, companies: [company('supplier', 'supplier'), company('customer', 'customer')], shipments: [], payments: [], stocks: [], managers: [], monthly: [], quality: { status: 'synthetic', issueCounts: {}, issues: [], recordFlagCounts: { shipments: {}, payments: {} }, flaggedShipmentCount: 0, flaggedPaymentCount: 0, duplicateCandidates: [], aliasCandidates: [], multipleManagerCompanyIds: [], limitations: [] }, overview: { shipmentCount: 0, paymentCount: 0, companyCount: 2, liters: { total: '0', numericCount: 0, missingCount: 0 }, revenue: { total: '0', numericCount: 0, missingCount: 0 }, cost: { total: '0', numericCount: 0, missingCount: 0 }, incoming: { total: '0', numericCount: 0, missingCount: 0 }, outgoing: { total: '0', numericCount: 0, missingCount: 0 }, missingShipmentDates: 0, missingPaymentDates: 0 } });
const input = () => ({ fields: { date: '2026-09-28', supplier_id: 'supplier', product_id: 'product', purchase_price_unspecified_unit: '50000', quantity_tonnes: '12', driver_id: 'driver', vehicle_id: 'vehicle', loading_address_id: 'loading', loading_planned_at: '2026-09-28T09:30', additional_costs: '0' }, customers: [0, 1].map(index => ({ fields: { customer_id: 'customer', manager_id: 'manager', payment_form_id: 'payment', quantity_litres: index ? '6000' : '8000', sale_price_per_litre: '60', transport_amount: '1000', unloading_address_id: 'delivery', unloading_planned_at: '2026-09-28T14:00' } })) });
async function runtime() {
  const directory = await mkdtemp(resolve(tmpdir(), 'artel-saby-'));
  const store = new OperationsStore(directory); const snapshot = base();
  await store.mutate(source, data => { data.directories = { ...emptyDirectories(), fleetSeedApplied: true, managers: [{ id: 'manager', name: 'Тест' }], products: [{ id: 'product', name: 'Тест' }], paymentForms: [{ id: 'payment', name: 'б/нал' }], vehicles: [{ id: 'vehicle', plate: 'Т001ЕЕ777' }], drivers: [{ id: 'driver', name: 'Тестов Тест Тестович', vehicleId: 'vehicle', phone: '+79990000003' }], addresses: [{ id: 'loading', companyId: 'supplier', kind: 'loading', name: 'Тестовая погрузка', address: 'Тестовый адрес погрузки' }, { id: 'delivery', companyId: 'customer', kind: 'delivery', name: 'Тестовая доставка', address: 'Тестовый адрес доставки' }] }; return { result: undefined, changed: true }; });
  const created = await store.mutate(source, data => ({ result: saveShipmentTrip(snapshot, data, input()), changed: true }));
  return { directory, store, base: snapshot, tripId: created.trip.id, close: () => rm(directory, { recursive: true, force: true }) };
}
type Rpc = { method: string; params: Record<string, SabyObject>; id: number }; // synthetic protocol fixture only
function fakeApi(options: { write?: (request: Rpc) => Promise<Response> | Response; read?: (request: Rpc) => Promise<Response> | Response; find?: (request: Rpc) => unknown; unauthorizedOnce?: boolean } = {}) {
  const calls: Rpc[] = []; const docs = new Map<string, SabyObject>(); let expired = !!options.unauthorizedOnce;
  const json = (request: Rpc, result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), { status: 200 });
  const send: typeof fetch = async (_url, init) => {
    const request = JSON.parse(String(init!.body)) as Rpc; calls.push(request);
    if (request.method === 'СБИС.Аутентифицировать') return json(request, 'new-private-session');
    if (expired) { expired = false; return new Response('', { status: 401 }); }
    if (request.method === 'СБИС.СписокНашихОрганизаций') return json(request, { НашаОрганизация: [{ СвЮЛ: request.params.Фильтр.НашаОрганизация.СвЮЛ, ДокументооборотПодключен: 'Да' }] });
    if (request.method === 'СБИС.ЗаписатьДокумент') {
      if (options.write) return options.write(request);
      const id = `remote-${docs.size + 1}`; const doc = { ...request.params.Документ, Идентификатор: id, Редакция: [{ Идентификатор: `${id}-revision` }], Состояние: { Название: 'Черновик' }, СсылкаДляНашаОрганизация: `https://online.saby.ru/document/${id}`, Вложение: [{ Тип: 'ЗаказЗаявка', Подтип: '1110361', ВерсияФормата: '5.01' }] }; docs.set(id, doc); return json(request, doc);
    }
    if (request.method === 'СБИС.ПрочитатьДокумент') return options.read ? options.read(request) : json(request, docs.get(request.params.Документ.Идентификатор));
    if (request.method === 'СБИС.СписокДокументов') return json(request, options.find ? options.find(request) : { Документ: [...docs.values()], Навигация: { ЕстьЕще: 'Нет' } });
    throw new Error('Unexpected method');
  };
  return { calls, docs, json, send, count: (method: string) => calls.filter(call => call.method === method).length };
}
const authorize = () => undefined;
const transportSnapshot = (): SabyTransportSnapshot => ({ tripId: 'trip-test', shipmentId: 'shipment-test', version: 1, fields: { date: '2026-09-28', product_id: 'product', vehicle_id: 'vehicle', quantity_litres: '8000', quantity_tonnes: '6.718', loading_address: 'Площадка <погрузки> & склад', unloading_address: 'Площадка доставки', loading_planned_at: '2026-09-28T09:30', unloading_planned_at: '2026-09-28T15:00' }, customer: { inn: '7736050003', kpp: '773601001', name: 'Тестовый клиент', address: 'Юридический адрес клиента' }, supplier: { inn: '7707083893', kpp: '770701001', name: 'Тестовый поставщик', address: 'Юридический адрес поставщика' }, driver: { name: 'Тестов Тест', phone: '+79990000003' }, vehicle: { plate: 'Т001ЕЕ777', type: '' }, customerOrganization: config().customer, carrierOrganization: config().carrier, profile: structuredClone(profile) });

test('Saby formal XML validates against official 1110361 5.01 XSD, converts units exactly and escapes text', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'artel-saby-xml-'));
  try {
    const snapshot = transportSnapshot();
    snapshot.profile!.cargoByProductId.product.packagingCode = 'TY';
    assert.deepEqual(sabyTransportBlockers(snapshot), []);
    const serialized = serializeSabyTransportOrder(snapshot, '11111111-1111-4111-8111-111111111111', '2026-09-28T12:00:00Z');
    const xml = new TextDecoder('windows-1251').decode(serialized.xml);
    assert.match(xml, /Объем="8"/); assert.match(xml, /МасБрутЗнач="6718"/); assert.match(xml, /&lt;погрузки&gt; &amp; склад/);
    assert.match(xml, /ДатВрПод="28.09.2026T09:30:00\+03:00"/); assert.ok(!xml.includes(snapshot.customer.address));
    assert.ok(!xml.includes('Подпись')); assert.ok(!xml.includes('27.9'));
    const path = resolve(directory, 'order.xml'); await writeFile(path, serialized.xml);
    const result = spawnSync('xmllint', ['--noout', '--schema', resolve('tests/fixtures/saby/transport-order-1110361-5.01.xsd'), path], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Saby readiness refuses unknown cargo, mass/capacity assumptions, malformed dates and lossy quantities', () => {
  for (const [key, value] of [['date', '2026-99-99'], ['quantity_litres', '8001'], ['quantity_tonnes', '6.7180001'], ['loading_address', null], ['loading_planned_at', null]] as const) {
    const snapshot = transportSnapshot(); snapshot.fields[key] = value;
    assert.ok(sabyTransportBlockers(snapshot).length, key);
  }
  const snapshot = transportSnapshot(); snapshot.profile = null; assert.ok(sabyTransportBlockers(snapshot).some(message => /профиль|параметры/.test(message)));
  assert.throws(() => encodeWindows1251('Груз 🚚'), SabyError);
  assert.ok(sabyConfigurationBlockers(sabyConfigFromEnv({})).length);
});

test('Saby uploads one formal document per delivery, reads confirmation and persists restart without duplicate writes', async () => {
  const runtimeData = await runtime(); const api = fakeApi(); const client = new SabyClient(config(), api.send);
  try {
    const result = await submitSabyTrip({ ...runtimeData, authorize, client });
    assert.equal(result.saby.status, 'draft'); assert.equal(result.saby.documents.length, 2);
    assert.equal(api.count('СБИС.ЗаписатьДокумент'), 2); assert.equal(api.count('СБИС.ПрочитатьДокумент'), 2);
    assert.equal(new Set(result.saby.documents.map(doc => doc.id)).size, 2);
    const raw = await readFile(resolve(runtimeData.directory, 'operations.json'), 'utf8');
    assert.ok(!raw.includes('private-synthetic-session'));
    const restarted = new OperationsStore(runtimeData.directory);
    const data = await restarted.read(source); validateSabyData(data.saby); assert.ok(hasSabyDocuments(data, runtimeData.tripId));
    assert.deepEqual(getSabyTrip(runtimeData.base, data, runtimeData.tripId, config()), result);
    const repeat = await submitSabyTrip({ ...runtimeData, store: restarted, authorize, client });
    assert.equal(repeat.saby.status, 'draft'); assert.equal(api.count('СБИС.ЗаписатьДокумент'), 2);
    assert.ok(!JSON.stringify(repeat).includes('snapshot')); assert.ok(!JSON.stringify(repeat).includes('Тестов Тест'));
  } finally { await runtimeData.close(); }
});

test('Saby double-click obtains a single persisted lease and no duplicate write', async () => {
  const rt = await runtime(); const api = fakeApi(); let release!: () => void; let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }); const barrier = new Promise<void>(resolve => { release = resolve; });
  const send: typeof fetch = async (url, init) => { const req = JSON.parse(String(init!.body)); if (req.method === 'СБИС.ЗаписатьДокумент') { entered(); await barrier; } return api.send(url, init); };
  const client = new SabyClient(config(), send);
  try {
    const first = submitSabyTrip({ ...rt, authorize, client }); await started;
    await assert.rejects(submitSabyTrip({ ...rt, authorize, client }), error => error instanceof ApiError && error.status === 409);
    release(); assert.equal((await first).saby.status, 'draft'); assert.equal(api.count('СБИС.ЗаписатьДокумент'), 2);
  } finally { release(); await rt.close(); }
});

test('Saby lost write response reconciles existing document before any repeat and never treats no-match as safe recreation', async () => {
  const rt = await runtime(); const api = fakeApi(); let loseFirst = true;
  const send: typeof fetch = async (url, init) => { const req = JSON.parse(String(init!.body)); const result = await api.send(url, init); if (req.method === 'СБИС.ЗаписатьДокумент' && loseFirst) { loseFirst = false; throw new Error('lost-response-secret'); } return result; };
  try {
    const client = new SabyClient(config(), send); const first = await submitSabyTrip({ ...rt, authorize, client });
    assert.equal(first.saby.status, 'unknown'); assert.equal(api.count('СБИС.ЗаписатьДокумент'), 2);
    const second = await submitSabyTrip({ ...rt, authorize, client }); assert.equal(second.saby.status, 'draft'); assert.equal(api.count('СБИС.ЗаписатьДокумент'), 2);
    assert.equal(api.count('СБИС.СписокДокументов'), 1);
    const filter = api.calls.find(call => call.method === 'СБИС.СписокДокументов')!.params.Фильтр;
    assert.match(filter.Маска, /^CRM-/);
    await rt.store.mutate(source, data => { const doc = data.saby!.trips[rt.tripId].documents[0]; doc.id = null; doc.status = 'unknown'; return { result: null, changed: true }; }); api.docs.clear();
    assert.equal((await submitSabyTrip({ ...rt, authorize, client })).saby.status, 'unknown'); assert.equal(api.count('СБИС.ЗаписатьДокумент'), 2);
  } finally { await rt.close(); }
});

test('Saby read failure after a returned ID remains unknown and retries read, not write', async () => {
  const rt = await runtime(); const api = fakeApi({ read: () => new Response('', { status: 401 }) });
  try {
    const result = await submitSabyTrip({ ...rt, authorize, client: new SabyClient(config(), api.send) });
    assert.equal(result.saby.status, 'unknown'); assert.ok(result.saby.documents.every(doc => doc.id));
    await submitSabyTrip({ ...rt, authorize, client: new SabyClient(config(), api.send) });
    assert.equal(api.count('СБИС.ЗаписатьДокумент'), 2); assert.equal(api.count('СБИС.СписокДокументов'), 0);
  } finally { await rt.close(); }
});

test('Saby 200 RPC error is never success and private vendor text never reaches stored or UI errors', async () => {
  const rt = await runtime(); const api = fakeApi({ write: request => new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -1, message: 'secret=private-synthetic-session', data: 'private-synthetic-password' } })) });
  try {
    const result = await submitSabyTrip({ ...rt, authorize, client: new SabyClient(config(), api.send) }); assert.equal(result.saby.status, 'unknown');
    assert.ok(result.saby.documents.every(doc => !doc.id)); assert.ok(!JSON.stringify(result).includes('private-synthetic'));
    assert.ok(!(await readFile(resolve(rt.directory, 'operations.json'), 'utf8')).includes('private-synthetic'));
  } finally { await rt.close(); }
});

test('Saby authorization and wrong organization block all writes; HTTP401 renews once with server credentials', async () => {
  const rt = await runtime(); const api = fakeApi({ unauthorizedOnce: true }); const configured = config(); configured.login = 'private-login'; configured.password = 'private-password'; configured.accountNumber = 'private-account';
  try {
    assert.equal((await submitSabyTrip({ ...rt, authorize, client: new SabyClient(configured, api.send) })).saby.status, 'draft');
    assert.equal(api.count('СБИС.Аутентифицировать'), 1); assert.deepEqual(api.calls.find(call => call.method === 'СБИС.Аутентифицировать')!.params.Параметр, { Логин: 'private-login', Пароль: 'private-password', НомерАккаунта: 'private-account' });
    assert.ok(!(await readFile(resolve(rt.directory, 'operations.json'), 'utf8')).includes('private-password'));
  } finally { await rt.close(); }
  const blocked = await runtime(); const deny: typeof fetch = async () => new Response('', { status: 403 });
  try { const result = await submitSabyTrip({ ...blocked, authorize, client: new SabyClient(config(), deny) }); assert.equal(result.saby.status, 'error'); assert.ok(!hasSabyDocuments(await blocked.store.read(source), blocked.tripId)); }
  finally { await blocked.close(); }
});

test('Saby expired persisted lease recovers pending as unknown and config profile removal does not prevent reconciliation', async () => {
  const rt = await runtime(); const api = fakeApi(); const client = new SabyClient(config(), api.send);
  try {
    await submitSabyTrip({ ...rt, authorize, client });
    await rt.store.mutate(source, data => { const entry = data.saby!.trips[rt.tripId]; entry.leaseId = 'interrupted'; entry.leaseUntil = '2026-01-01T00:00:00Z'; entry.documents[0].status = 'pending'; entry.documents[0].id = null; return { result: null, changed: true }; });
    const noProfile = config(); delete noProfile.transportProfile;
    const state = getSabyTrip(rt.base, await rt.store.read(source), rt.tripId, noProfile);
    assert.equal(state.saby.status, 'unknown'); assert.equal(state.readiness.ready, true);
    assert.equal((await submitSabyTrip({ ...rt, authorize, client: new SabyClient(noProfile, api.send) })).saby.status, 'draft'); assert.equal(api.count('СБИС.ЗаписатьДокумент'), 2);
  } finally { await rt.close(); }
});

test('Saby revocation during submission prevents the next customer write and never exposes another customer snapshot', async () => {
  const rt = await runtime(); const api = fakeApi(); let reads = 0;
  const authorize = () => { if (++reads > 2) throw new ApiError(403, 'Доступ отозван'); };
  try {
    await assert.rejects(submitSabyTrip({ ...rt, authorize, client: new SabyClient(config(), api.send) }), /Доступ отозван/);
    assert.equal(api.count('СБИС.ЗаписатьДокумент'), 1);
    const state = await rt.store.read(source); assert.equal(state.saby!.trips[rt.tripId].documents[1].status, 'error');
  } finally { await rt.close(); }
});

test('Saby readiness gates whole-truck volume and weight; drafts have zero network traffic when incomplete', async () => {
  const rt = await runtime(); const api = fakeApi(); const small = config(); small.transportProfile!.vehicleById.vehicle.capacityCubicMetres = '10'; small.transportProfile!.vehicleById.vehicle.payloadTonnes = '8';
  try {
    const state = getSabyTrip(rt.base, await rt.store.read(source), rt.tripId, small);
    assert.equal(state.readiness.ready, false); assert.ok(state.readiness.blockers.some(message => /Суммарный объём/.test(message))); assert.ok(state.readiness.blockers.some(message => /Суммарная масса/.test(message)));
    await assert.rejects(submitSabyTrip({ ...rt, authorize, client: new SabyClient(small, api.send) }), error => error instanceof ApiError && error.status === 422); assert.equal(api.calls.length, 0);
  } finally { await rt.close(); }
});

test('Saby accepted write followed by storage failure preserves unknown and reconciles without resending', async () => {
  const rt = await runtime(); const api = fakeApi(); let failOnce = true;
  const wrapped = { read: rt.store.read.bind(rt.store), mutate: async <T>(sha: string, update: Parameters<OperationsStore['mutate']>[1]): Promise<T> => {
    if (failOnce && api.count('СБИС.ЗаписатьДокумент') > 0) { failOnce = false; throw new Error('synthetic-disk-failure'); }
    return rt.store.mutate(sha, update) as Promise<T>;
  } };
  try {
    const client = new SabyClient(config(), api.send);
    const first = await submitSabyTrip({ ...rt, store: wrapped, authorize, client });
    assert.equal(first.saby.status, 'unknown'); assert.equal(api.count('СБИС.ЗаписатьДокумент'), 2);
    const again = await submitSabyTrip({ ...rt, authorize, client }); assert.equal(again.saby.status, 'draft'); assert.equal(api.count('СБИС.ЗаписатьДокумент'), 2);
  } finally { await rt.close(); }
});

test('Saby mismatched read-back and missing formal attachment remain unknown; untrusted URLs never enter summary', async () => {
  const rt = await runtime(); const api = fakeApi();
  const send: typeof fetch = async (url, init) => {
    const request = JSON.parse(String(init!.body)) as Rpc; const response = await api.send(url, init);
    if (request.method === 'СБИС.ПрочитатьДокумент') { const body = await response.json(); body.result.Вложение = []; body.result.СсылкаДляНашаОрганизация = 'https://malicious.example/leak'; return new Response(JSON.stringify(body)); }
    return response;
  };
  try {
    const result = await submitSabyTrip({ ...rt, authorize, client: new SabyClient(config(), send) }); assert.equal(result.saby.status, 'unknown'); assert.ok(result.saby.documents.every(doc => doc.url === null));
    const data = await rt.store.read(source); data.saby!.trips[rt.tripId].documents[0].snapshot.fields.date = '2030-01-01'; assert.throws(() => validateSabyData(data.saby), /Invalid Saby document/);
  } finally { await rt.close(); }
});

test('Saby environment profile parsing strips unrelated secret keys before persistence and rejects malformed configuration', () => {
  const parsed = sabyConfigFromEnv({ SABY_TRANSPORT_PROFILE_JSON: JSON.stringify({ ...profile, token: 'secret-not-document', signatory: { ...profile.signatory, password: 'secret-not-document' } }) });
  assert.ok(!JSON.stringify(parsed.transportProfile).includes('secret-not-document'));
  assert.equal(sabyConfigFromEnv({ SABY_TRANSPORT_PROFILE_JSON: '{invalid' }).transportProfile, undefined);
});

test('Saby application requires confirmed contract and serializes ДогОргПрвз without uploading contract files', async () => {
  const snapshot = transportSnapshot(); snapshot.profile!.function = 'Заявка';
  assert.ok(sabyTransportBlockers(snapshot).some(message => message.includes('договора')));
  snapshot.profile!.contract = { name: 'Синтетический договор перевозки', number: 'ТЕСТ-1', date: '2026-01-01', issuerInns: ['7707083893', '7736050003'] };
  assert.deepEqual(sabyTransportBlockers(snapshot), []);
  const serialized = serializeSabyTransportOrder(snapshot, '22222222-2222-4222-8222-222222222222', '2026-09-28T12:00:00Z');
  const xml = new TextDecoder('windows-1251').decode(serialized.xml);
  assert.match(xml, /Функция="Заявка"/); assert.match(xml, /<ДогОргПрвз НаимДок="Синтетический договор перевозки" НомерДок="ТЕСТ-1" ДатаДок="01.01.2026">/);
  const directory = await mkdtemp(resolve(tmpdir(), 'artel-saby-application-'));
  try {
    const path = resolve(directory, 'application.xml'); await writeFile(path, serialized.xml);
    const result = spawnSync('xmllint', ['--noout', '--schema', resolve('tests/fixtures/saby/transport-order-1110361-5.01.xsd'), path], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
