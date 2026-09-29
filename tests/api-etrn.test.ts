import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { Company, Snapshot } from '../web/src/model';
import { ApiError } from '../server/api-error';
import { emptyDirectories } from '../server/directory-operations';
import { OperationsStore } from '../server/operations-store';
import { saveShipmentTrip } from '../server/shipment-trips';
import { SabyClient, type SabyConfig, type SabyObject } from '../server/saby-client';
import { downloadEtrnFile, exchangeEtrn, getEtrnTrip, hasEtrnDocuments, preparedEtrnXml, saveEtrnProfile, validateEtrnData } from '../server/etrn-service';
import { syntheticEtrnFixture, sender, carrier } from './helpers/etrn-fixture';

const source = 'etrn-isolated-synthetic-source';
const config = (): SabyConfig => ({ sessionId: 'private-synthetic-etrn-session', customer: { ...sender }, carrier: { ...carrier } });
const company = (id: string, role: string): Company => ({ id, name: `Синтетическая компания ${id}`, roles: [role], managerLabels: [], shipmentIds: [], paymentIds: [], flags: [] });
function base(): Snapshot {
  const zero = { total: '0', numericCount: 0, missingCount: 0 };
  return { provenance: { sourceSha256: source, sourceKind: 'synthetic', sourceFile: 'synthetic', exportedAt: '2025-04-01', googleVerified: false, registryVerified: false, formulaPolicy: '', ownershipPolicy: '', valueBasis: '', sourceFilesVerified: false, counts: {}, dateRange: { from: null, to: null } }, companies: [company('supplier', 'supplier'), company('customer', 'customer')], shipments: [], payments: [], stocks: [], managers: [], monthly: [], quality: { status: 'synthetic', issueCounts: {}, issues: [], recordFlagCounts: { shipments: {}, payments: {} }, flaggedShipmentCount: 0, flaggedPaymentCount: 0, duplicateCandidates: [], aliasCandidates: [], multipleManagerCompanyIds: [], limitations: [] }, overview: { shipmentCount: 0, paymentCount: 0, companyCount: 2, liters: zero, revenue: zero, cost: zero, incoming: zero, outgoing: zero, missingShipmentDates: 0, missingPaymentDates: 0 } };
}
async function runtime() {
  const directory = await mkdtemp(resolve(tmpdir(), 'artel-etrn-service-')); const store = new OperationsStore(directory); const snapshot = base();
  await store.mutate(source, data => {
    data.directories = { ...emptyDirectories(), fleetSeedApplied: true, managers: [{ id: 'manager', name: 'Тест' }], products: [{ id: 'product', name: 'Синтетический груз' }], paymentForms: [{ id: 'payment', name: 'б/нал' }], vehicles: [{ id: 'vehicle', plate: 'Т000ТТ00', vehicleType: 'Синтетический тип', capacityLitres: '12340' }], drivers: [{ id: 'driver', name: 'ВодительТестовый Тест', fullName: 'ВодительТестовый Тест', vehicleId: 'vehicle', phone: '+70000000005', inn: '048172639504' }], addresses: [{ id: 'loading', companyId: 'supplier', kind: 'loading', name: 'Погрузка', address: 'Синтетический адрес погрузки' }, { id: 'delivery', companyId: 'customer', kind: 'delivery', name: 'Доставка', address: 'Синтетический адрес доставки' }] };
    return { result: undefined, changed: true };
  });
  const created = await store.mutate(source, data => ({ result: saveShipmentTrip(snapshot, data, { fields: { organization_id: 'artel', date: '2025-04-01', supplier_id: 'supplier', product_id: 'product', purchase_price_unspecified_unit: '50000', quantity_tonnes: '5.123125', driver_id: 'driver', vehicle_id: 'vehicle', loading_address_id: 'loading', loading_planned_at: '2025-04-01T08:15', additional_costs: '0' }, customers: [{ fields: { customer_id: 'customer', manager_id: 'manager', payment_form_id: 'payment', quantity_litres: '7125', sale_price_per_litre: '60', transport_amount: '1000', unloading_address_id: 'delivery', unloading_planned_at: '2025-04-01T14:00' } }] }), changed: true }));
  return { directory, store, base: snapshot, tripId: created.trip.id, shipmentId: created.trip.customers[0].id, profile: syntheticEtrnFixture().profile, authorize: () => undefined, close: () => rm(directory, { recursive: true, force: true }) };
}
type Rpc = { method: string; params: Record<string, SabyObject>; id: number };
function fakeApi() {
  const calls: Rpc[] = []; const docs = new Map<string, SabyObject>(); const bytes = Buffer.from('<synthetic-file>exact original bytes</synthetic-file>'); let downloads = 0;
  const json = (request: Rpc, result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), { status: 200 });
  const send: typeof fetch = async (_url, init) => {
    if (init?.method === 'GET') { downloads++; return new Response(bytes); }
    const req = JSON.parse(String(init?.body)) as Rpc; calls.push(req);
    if (req.method === 'СБИС.СписокНашихОрганизаций') return json(req, { НашаОрганизация: [{ СвЮЛ: req.params.Фильтр.НашаОрганизация.СвЮЛ, ДокументооборотПодключен: 'Да' }] });
    if (req.method === 'СБИС.ЗаписатьДокумент') {
      const id = `synthetic-remote-${docs.size + 1}`; const input = req.params.Документ;
      const doc = { ...input, Идентификатор: id, Стороны: { Отправитель: input.Грузоотправитель, Перевозчик: input.ТранспортнаяКомпания, Получатель: input.Грузополучатель }, Редакция: [{ Идентификатор: `${id}-revision`, Актуален: 'Да' }], Состояние: { Название: 'Черновик' }, СсылкаДляНашаОрганизация: `https://online.saby.ru/document/${id}`, Вложение: [{ Идентификатор: 'synthetic-title-one', Тип: 'ЭТрН', Подтип: '1110339', ВерсияФормата: '5.01', Файл: { Имя: 'synthetic-title.xml', Ссылка: 'https://disk.saby.ru/synthetic-file' } }], ТекущиеЭтапы: [{ Действие: [{ Название: 'Погружен' }] }] };
      docs.set(id, doc); return json(req, doc);
    }
    if (req.method === 'СБИС.ПрочитатьДокумент') return json(req, docs.get(req.params.Документ.Идентификатор));
    if (req.method === 'СБИС.СписокДокументов') return json(req, { Документ: [...docs.values()], Навигация: { ЕстьЕще: 'Нет' } });
    throw new Error('Unexpected synthetic RPC');
  };
  return { send, calls, docs, bytes, json, count: (method: string) => calls.filter(row => row.method === method).length, downloads: () => downloads };
}
const status = (result: ReturnType<typeof getEtrnTrip>) => result.deliveries[0].document?.status;
const conflict = (error: unknown) => error instanceof ApiError && error.status === 409;

test('ETRN partial profile saves privately but cannot initiate any external call', async () => {
  const rt = await runtime(); const api = fakeApi(); const options = { ...rt, client: new SabyClient(config(), api.send) };
  try {
    const response = await saveEtrnProfile(options, rt.shipmentId, { confirmed: false }); assert.ok(response.deliveries[0].blockers.length);
    await assert.rejects(exchangeEtrn(options, rt.shipmentId), error => error instanceof ApiError && error.status === 422); assert.equal(api.calls.length, 0);
    assert.equal(hasEtrnDocuments(await rt.store.read(source), rt.tripId), false);
  } finally { await rt.close(); }
});
test('ETRN writes one ConsignmentNote, reads separately, survives restart and repeat without duplicates', async () => {
  const rt = await runtime(); const api = fakeApi(); const options = { ...rt, client: new SabyClient(config(), api.send) };
  try {
    await saveEtrnProfile(options, rt.shipmentId, rt.profile); const response = await exchangeEtrn(options, rt.shipmentId);
    assert.equal(status(response), 'draft'); assert.equal(api.count('СБИС.ЗаписатьДокумент'), 1); assert.equal(api.count('СБИС.ПрочитатьДокумент'), 1);
    assert.equal(response.deliveries[0].document?.signatureStatus, 'not_signed'); assert.equal(response.deliveries[0].document?.gisStatus, null);
    const restarted = new OperationsStore(rt.directory); const data = await restarted.read(source); validateEtrnData(data.etrn); assert.equal(hasEtrnDocuments(data, rt.tripId), true);
    await exchangeEtrn({ ...options, store: restarted }, rt.shipmentId); assert.equal(api.count('СБИС.ЗаписатьДокумент'), 1);
    const raw = await readFile(resolve(rt.directory, 'operations.json'), 'utf8'); assert.doesNotMatch(raw, /private-synthetic-etrn-session/); assert.doesNotMatch(JSON.stringify(response), /payloadHash|preparedHash|ДвоичныеДанные|disk\.saby/);
    const request = api.calls.find(call => call.method === 'СБИС.ЗаписатьДокумент')!.params.Документ; assert.equal(request.Тип, 'ConsignmentNote');
  } finally { await rt.close(); }
});
test('ETRN lost write response reconciles by stored marker before repeat, including empty search', async () => {
  const rt = await runtime(); const api = fakeApi(); let lose = true;
  const send: typeof fetch = async (url, init) => { const response = await api.send(url, init); if (JSON.parse(String(init?.body)).method === 'СБИС.ЗаписатьДокумент' && lose) { lose = false; throw new Error('private-wire-detail'); } return response; };
  const options = { ...rt, client: new SabyClient(config(), send) };
  try {
    await saveEtrnProfile(options, rt.shipmentId, rt.profile); assert.equal(status(await exchangeEtrn(options, rt.shipmentId)), 'unknown');
    const original = [...api.docs.values()][0]; api.docs.clear(); assert.equal(status(await exchangeEtrn(options, rt.shipmentId)), 'unknown'); assert.equal(api.count('СБИС.ЗаписатьДокумент'), 1);
    api.docs.set(String(original.Идентификатор), original); assert.equal(status(await exchangeEtrn(options, rt.shipmentId)), 'draft'); assert.equal(api.count('СБИС.ЗаписатьДокумент'), 1);
    assert.equal(api.calls.find(call => call.method === 'СБИС.СписокДокументов')?.params.Фильтр.Тип, 'ConsignmentNote');
    assert.doesNotMatch(JSON.stringify(await rt.store.read(source)), /private-wire-detail/);
  } finally { await rt.close(); }
});
test('ETRN simultaneous double click shares a persisted lease and only one write', async () => {
  const rt = await runtime(); const api = fakeApi(); let release!: () => void; let entered!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; }); const started = new Promise<void>(resolve => { entered = resolve; });
  const send: typeof fetch = async (url, init) => { if (JSON.parse(String(init?.body)).method === 'СБИС.ЗаписатьДокумент') { entered(); await barrier; } return api.send(url, init); }; const options = { ...rt, client: new SabyClient(config(), send) };
  try {
    await saveEtrnProfile(options, rt.shipmentId, rt.profile); const first = exchangeEtrn(options, rt.shipmentId); await started;
    await assert.rejects(exchangeEtrn(options, rt.shipmentId), conflict); release(); assert.equal(status(await first), 'draft'); assert.equal(api.count('СБИС.ЗаписатьДокумент'), 1);
  } finally { release(); await rt.close(); }
});
test('ETRN expired pending lease recovers through read/search without a second create', async () => {
  const rt = await runtime(); const api = fakeApi(); const options = { ...rt, client: new SabyClient(config(), api.send) };
  try {
    await saveEtrnProfile(options, rt.shipmentId, rt.profile); await exchangeEtrn(options, rt.shipmentId);
    await rt.store.mutate(source, data => { const doc = data.etrn!.trips[rt.tripId].deliveries[rt.shipmentId].document!; doc.status = 'pending'; doc.id = null; doc.leaseId = 'previous-process'; doc.leaseUntil = '2020-01-01T00:00:00.000Z'; return { result: undefined, changed: true }; });
    assert.equal(status(getEtrnTrip(rt.base, await rt.store.read(source), rt.tripId, config())), 'unknown'); assert.equal(status(await exchangeEtrn(options, rt.shipmentId)), 'draft'); assert.equal(api.count('СБИС.ЗаписатьДокумент'), 1);
  } finally { await rt.close(); }
});
test('ETRN rejects a read-back with any mismatched sender, carrier or recipient', async () => {
  for (const role of ['Отправитель', 'Перевозчик', 'Получатель']) {
    const rt = await runtime(); const api = fakeApi();
    const send: typeof fetch = async (url, init) => { const req = JSON.parse(String(init?.body)) as Rpc; if (req.method === 'СБИС.ПрочитатьДокумент') { const doc = structuredClone(api.docs.get(req.params.Документ.Идентификатор)!); (doc.Стороны as SabyObject)[role] = { СвЮЛ: { ИНН: '9999999999', КПП: '999999999' } }; return api.json(req, doc); } return api.send(url, init); }; const options = { ...rt, client: new SabyClient(config(), send) };
    try { await saveEtrnProfile(options, rt.shipmentId, rt.profile); const response = await exchangeEtrn(options, rt.shipmentId); assert.equal(status(response), 'unknown'); assert.ok(response.deliveries[0].document?.id); await exchangeEtrn(options, rt.shipmentId); assert.equal(api.count('СБИС.ЗаписатьДокумент'), 1); }
    finally { await rt.close(); }
  }
});
test('ETRN stores a returned ID before read-back failure and then refreshes that same ID', async () => {
  const rt = await runtime(); const api = fakeApi(); let fail = true;
  const send: typeof fetch = async (url, init) => { if (JSON.parse(String(init?.body)).method === 'СБИС.ПрочитатьДокумент' && fail) throw new Error('private-transport-detail'); return api.send(url, init); }; const options = { ...rt, client: new SabyClient(config(), send) };
  try { await saveEtrnProfile(options, rt.shipmentId, rt.profile); const first = await exchangeEtrn(options, rt.shipmentId); assert.equal(status(first), 'unknown'); assert.equal(first.deliveries[0].document?.id, 'synthetic-remote-1'); fail = false; assert.equal(status(await exchangeEtrn(options, rt.shipmentId, true)), 'draft'); assert.equal(api.count('СБИС.ЗаписатьДокумент'), 1); }
  finally { await rt.close(); }
});
test('ETRN submitted/unknown preparations are immutable and block trip mutations', async () => {
  const rt = await runtime(); const api = fakeApi(); const options = { ...rt, client: new SabyClient(config(), api.send) };
  try { await saveEtrnProfile(options, rt.shipmentId, rt.profile); await exchangeEtrn(options, rt.shipmentId); await assert.rejects(saveEtrnProfile(options, rt.shipmentId, { ...rt.profile, deliveryMassTonnes: '6' }), conflict); assert.equal(hasEtrnDocuments(await rt.store.read(source), rt.tripId), true); }
  finally { await rt.close(); }
});
test('ETRN draft detects directory drift and requires a fresh review before creating', async () => {
  const rt = await runtime(); const api = fakeApi(); const options = { ...rt, client: new SabyClient(config(), api.send) };
  try {
    await saveEtrnProfile(options, rt.shipmentId, rt.profile); await rt.store.mutate(source, data => { data.directories!.drivers[0].phone = '+70000000006'; return { result: undefined, changed: true }; });
    const response = getEtrnTrip(rt.base, await rt.store.read(source), rt.tripId, config()); assert.ok(response.deliveries[0].blockers.some(value => value.includes('изменились')));
    await assert.rejects(exchangeEtrn(options, rt.shipmentId), conflict); assert.equal(api.calls.length, 0);
    await saveEtrnProfile(options, rt.shipmentId, rt.profile); assert.equal(status(await exchangeEtrn(options, rt.shipmentId)), 'draft');
  } finally { await rt.close(); }
});
test('ETRN checks revoked authorization again after organization verification before write', async () => {
  const rt = await runtime(); const api = fakeApi(); let allowed = true; let verifications = 0;
  const send: typeof fetch = async (url, init) => { const response = await api.send(url, init); if (JSON.parse(String(init?.body)).method === 'СБИС.СписокНашихОрганизаций' && ++verifications === 2) allowed = false; return response; };
  const options = { ...rt, authorize: () => { if (!allowed) throw new ApiError(403, 'Синтетическое право отозвано'); }, client: new SabyClient(config(), send) };
  try { await saveEtrnProfile(options, rt.shipmentId, rt.profile); await assert.rejects(exchangeEtrn(options, rt.shipmentId), error => error instanceof ApiError && error.status === 403); assert.equal(api.count('СБИС.ЗаписатьДокумент'), 0); assert.equal(hasEtrnDocuments(await rt.store.read(source), rt.tripId), false); }
  finally { await rt.close(); }
});
test('ETRN XML after submission is byte-identical to the uploaded snapshot despite later directory drift', async () => {
  const rt = await runtime(); const api = fakeApi(); const options = { ...rt, client: new SabyClient(config(), api.send) };
  try {
    await saveEtrnProfile(options, rt.shipmentId, rt.profile); await exchangeEtrn(options, rt.shipmentId);
    await rt.store.mutate(source, data => { data.directories!.drivers[0].phone = '+70000000006'; return { result: undefined, changed: true }; });
    const xml = preparedEtrnXml(rt.base, await rt.store.read(source), rt.tripId, rt.shipmentId, config());
    const files = api.calls.find(call => call.method === 'СБИС.ЗаписатьДокумент')!.params.Документ.Вложение as { Файл: { ДвоичныеДанные: string } }[];
    assert.equal(xml.xml.equals(Buffer.from(files[0].Файл.ДвоичныеДанные, 'base64')), true);
  } finally { await rt.close(); }
});
test('ETRN private downloads cache original bytes and checksum, conceal vendor/session URLs and enforce access', async () => {
  const rt = await runtime(); const api = fakeApi(); const options = { ...rt, client: new SabyClient(config(), api.send) };
  try {
    await saveEtrnProfile(options, rt.shipmentId, rt.profile); const response = await exchangeEtrn(options, rt.shipmentId); const file = response.deliveries[0].document!.files[0];
    assert.match(file.url, /^\/api\/shipment-trips\//); const first = await downloadEtrnFile(options, rt.shipmentId, file.id); assert.deepEqual(Buffer.from(first.bytes), api.bytes);
    const second = await downloadEtrnFile(options, rt.shipmentId, file.id); assert.deepEqual(Buffer.from(second.bytes), api.bytes); assert.equal(api.downloads(), 1);
    const stored = await rt.store.read(source); validateEtrnData(stored.etrn); const cached = stored.etrn!.trips[rt.tripId].deliveries[rt.shipmentId].document!.artifacts[0]; assert.equal(cached.size, api.bytes.length); assert.match(cached.sha256!, /^[0-9a-f]{64}$/);
    await assert.rejects(downloadEtrnFile({ ...options, authorize: () => { throw new ApiError(403, 'Нет доступа'); } }, rt.shipmentId, file.id), error => error instanceof ApiError && error.status === 403);
    const broken = structuredClone(stored.etrn!); broken.trips[rt.tripId].deliveries[rt.shipmentId].document!.artifacts[0].content = Buffer.from('changed').toString('base64'); assert.throws(() => validateEtrnData(broken));
  } finally { await rt.close(); }
});
test('ETRN refuses uncached files after remote revision changes', async () => {
  const rt = await runtime(); const api = fakeApi(); const options = { ...rt, client: new SabyClient(config(), api.send) };
  try {
    await saveEtrnProfile(options, rt.shipmentId, rt.profile); const response = await exchangeEtrn(options, rt.shipmentId); const file = response.deliveries[0].document!.files[0];
    api.docs.get('synthetic-remote-1')!.Редакция = [{ Идентификатор: 'new-revision', Актуален: 'Да' }]; await assert.rejects(downloadEtrnFile(options, rt.shipmentId, file.id), conflict); assert.equal(api.downloads(), 0);
  } finally { await rt.close(); }
});
test('ETRN refuses bytes if the saved revision changes during download', async () => {
  const rt = await runtime(); const api = fakeApi();
  const send: typeof fetch = async (url, init) => { const response = await api.send(url, init); if (init?.method === 'GET') await rt.store.mutate(source, data => { data.etrn!.trips[rt.tripId].deliveries[rt.shipmentId].document!.revision = 'concurrent-revision'; return { result: undefined, changed: true }; }); return response; }; const options = { ...rt, client: new SabyClient(config(), send) };
  try { await saveEtrnProfile(options, rt.shipmentId, rt.profile); const response = await exchangeEtrn(options, rt.shipmentId); await assert.rejects(downloadEtrnFile(options, rt.shipmentId, response.deliveries[0].document!.files[0].id), conflict); const data = await rt.store.read(source); assert.equal(data.etrn!.trips[rt.tripId].deliveries[rt.shipmentId].document!.artifacts[0].content, undefined); }
  finally { await rt.close(); }
});
test('ETRN cannot send a different organization or a delivery outside the selected trip', async () => {
  const rt = await runtime(); const api = fakeApi(); const options = { ...rt, client: new SabyClient(config(), api.send) };
  try {
    await assert.rejects(saveEtrnProfile(options, 'unrelated-shipment', rt.profile), error => error instanceof ApiError && error.status === 404);
    await rt.store.mutate(source, data => { data.shipments[rt.shipmentId].fields.organization_id = 'nk-artel'; return { result: undefined, changed: true }; });
    const response = await saveEtrnProfile(options, rt.shipmentId, rt.profile); assert.ok(response.deliveries[0].blockers.some(value => value.includes('Первый сценарий'))); await assert.rejects(exchangeEtrn(options, rt.shipmentId), error => error instanceof ApiError && error.status === 422); assert.equal(api.calls.length, 0);
  } finally { await rt.close(); }
});
