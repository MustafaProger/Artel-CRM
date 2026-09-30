import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ApiError } from '../server/api-error';
import { OperationsStore } from '../server/operations-store';
import { currentSnapshot } from '../server/shipment-operations';
import { createSnapshotMiddleware } from '../server/local-api';
import { runTripSabyWorkflow } from '../server/trip-saby-workflow';
import { exchangeEtrn, exchangePreparedEtrn, saveEtrnProfile, saveTripLoadingFacts } from '../server/etrn-service';
import { SabyClient, type SabyObject } from '../server/saby-client';
import { integrationRuntime, integrationApi, integrationConfig, integrationSettings } from './helpers/trip-saby-integration';

async function preparedRuntime() {
  const rt = await integrationRuntime(); const api = integrationApi(); const client = api.client(); const context = { ...rt, client };
  const run = (options: Partial<typeof context> = {}) => runTripSabyWorkflow({ ...context, ...options, createDelivery: input => exchangePreparedEtrn({ ...context, ...options }, input) });
  return { ...rt, api, client, context, run };
}
async function awaitingLoading(rt: Awaited<ReturnType<typeof preparedRuntime>>) {
  const initial = await rt.run(); assert.equal(initial.phase, 'awaiting_carrier', initial.lastError ?? initial.blockers.join(' '));
  rt.api.accept(); const waiting = await rt.run(); assert.equal(waiting.phase, 'awaiting_loading', waiting.lastError ?? '');
}
const decodeUpload = (request: SabyObject) => new TextDecoder('windows-1251').decode(Buffer.from(String(((request.Вложение as SabyObject[])[0].Файл as SabyObject).ДвоичныеДанные), 'base64'));

test('full preparation reserves one order, waits for employee facts, and creates numbered IP consignment notes per repeated delivery', async () => {
  const rt = await preparedRuntime();
  try {
    const data = await rt.store.read(rt.source); const preflight = rt.prepare(currentSnapshot(rt.base, data), data, rt.trip, integrationConfig()); assert.deepEqual(preflight.blockers, []);
    assert.equal(preflight.deliveries[0].snapshot.profile.massSource, 'calculated'); assert.equal(preflight.deliveries[0].snapshot.profile.loading.arrivedAt, '');
    await awaitingLoading(rt); assert.equal(rt.api.writes('ConsignmentNote').length, 0);
    await assert.rejects(exchangeEtrn(rt.context, rt.trip.customers[0].id), error => error instanceof ApiError && error.status === 409);
    await assert.rejects(saveEtrnProfile(rt.context, rt.trip.customers[0].id, {}), error => error instanceof ApiError && error.status === 409);
    await saveTripLoadingFacts(rt.context, rt.facts(), 'synthetic-employee');
    const complete = await rt.run(); assert.equal(complete.phase, 'completed', complete.lastError ?? '');
    const orderUpload = rt.api.writes('TransportOrder').find(row => row.params.Документ.Вложение)!.params.Документ;
    assert.match(decodeUpload(orderUpload), /МасБрутЗнач="12000" МасНетЗнач="12000"/);
    assert.equal(rt.api.reserves('TransportOrder').length, 1); assert.equal(rt.api.reserves('ConsignmentNote').length, 2); assert.equal(rt.api.writes('ConsignmentNote').length, 4);
    const uploads = rt.api.writes('ConsignmentNote').filter(row => row.params.Документ.Вложение).map(row => row.params.Документ);
    assert.deepEqual(uploads.map(row => row.Номер), ['100', '101']); assert.equal(new Set(uploads.map(row => row.Идентификатор)).size, 2);
    for (const [index, request] of uploads.entries()) {
      const recipient = request.Грузополучатель as SabyObject; assert.equal((recipient.СвФЛ as SabyObject).ИНН, '010000000102'); assert.equal(recipient.СвЮЛ, undefined);
      const xml = decodeUpload(request); assert.match(xml, /<СвИП ИННФЛ="010000000102"/); assert.match(xml, /НомЗак="41"/); assert.doesNotMatch(xml, /Точка только общей заявки|Собственная остановка/); assert.match(xml, new RegExp(`Объем="${index ? '6' : '8'}"`)); assert.match(xml, new RegExp(`МасБрутОтгр="${index ? '5200' : '7000'}"`));
      assert.match(xml, new RegExp(`МасНетЗнач="${index ? '5142.857' : '6857.143'}"`));
      assert.match(xml, new RegExp(`МасБрутЗнач="${index ? '5142.857' : '6857.143'}"`));
      const file = (request.Вложение as SabyObject[])[0].Файл as SabyObject;
      const path = resolve(rt.directory, `cn-${index}.xml`); await writeFile(path, Buffer.from(String(file.ДвоичныеДанные), 'base64'));
      const validation = spawnSync('xmllint', ['--noout', '--schema', resolve('tests/fixtures/saby/consignment-note-1110339-5.01.xsd'), path], { encoding: 'utf8' }); assert.equal(validation.status, 0, validation.stderr);
    }
    const saved = await rt.store.read(rt.source); assert.equal(saved.etrn!.trips[rt.tripId].loadingFacts!.actorId, 'synthetic-employee'); assert.ok(Object.values(saved.etrn!.trips[rt.tripId].deliveries).every(row => row.sourceOrderId === complete.order?.id));
    const { carrierHandoff, ...summary } = complete;
    assert.deepEqual(Object.keys(carrierHandoff!).sort(), ['driverName', 'driverPhone', 'vehiclePlate', 'vehicleType']);
    assert.equal(carrierHandoff!.driverPhone, '+70000000003');
    assert.doesNotMatch(JSON.stringify(summary), /700000000|private-integration-session|payloadHash|snapshot/);
    assert.doesNotMatch(await readFile(resolve(rt.directory, 'store', 'operations.json'), 'utf8'), /private-integration-session/);
    const restarted = new OperationsStore(resolve(rt.directory, 'store')); await rt.run({ store: restarted }); assert.equal(rt.api.reserves().length, 3);
  } finally { await rt.close(); }
});

test('facts require carrier confirmation, all delivery rows, real past times, positive masses, and are immutable once stored', async () => {
  const rt = await preparedRuntime();
  try {
    await assert.rejects(saveTripLoadingFacts(rt.context, rt.facts(), 'synthetic-employee'), error => error instanceof ApiError && error.status === 409);
    await awaitingLoading(rt);
    for (const invalid of [ { ...rt.facts(), deliveries: { [rt.trip.customers[0].id]: rt.facts().deliveries[rt.trip.customers[0].id] } }, { ...rt.facts(), departedAt: '2099-01-01T10:00' }, { ...rt.facts(), departedAt: '2025-04-01T08:00' }, { ...rt.facts(), deliveries: Object.fromEntries(rt.trip.customers.map(row => [row.id, { grossMassTonnes: '0', massMethod: '02' }])) } ]) await assert.rejects(saveTripLoadingFacts(rt.context, invalid, 'synthetic-employee'), error => error instanceof ApiError && error.status === 400);
    assert.equal(rt.api.writes('ConsignmentNote').length, 0);
    await saveTripLoadingFacts(rt.context, rt.facts(), 'synthetic-employee'); await assert.rejects(saveTripLoadingFacts(rt.context, rt.facts(), 'synthetic-employee'), error => error instanceof ApiError && error.status === 409);
  } finally { await rt.close(); }
});

test('lost first CN reservation response recovers by marker and retained order without second reservation', async () => {
  const rt = await preparedRuntime(); let lost = false;
  const send: typeof fetch = async (url, init) => { const result = await rt.api.send(url, init); if (init?.method !== 'GET') { const req = JSON.parse(String(init?.body)); if (!lost && req.method === 'СБИС.ЗаписатьДокумент' && req.params.Документ.Тип === 'ConsignmentNote' && !req.params.Документ.Идентификатор) { lost = true; throw new Error('private-lost-response'); } } return result; };
  try {
    await awaitingLoading(rt); await saveTripLoadingFacts(rt.context, rt.facts(), 'synthetic-employee');
    const first = await rt.run({ client: new SabyClient(integrationConfig(), send) }); assert.equal(first.phase, 'unknown'); assert.equal(rt.api.reserves('ConsignmentNote').length, 1);
    const result = await rt.run({ store: new OperationsStore(resolve(rt.directory, 'store')) }); assert.equal(result.phase, 'completed', result.lastError ?? ''); assert.equal(rt.api.reserves('ConsignmentNote').length, 2); assert.equal(rt.api.reserves('TransportOrder').length, 1);
    assert.doesNotMatch(JSON.stringify(await rt.store.read(rt.source)), /private-lost-response/);
  } finally { await rt.close(); }
});

test('lost second CN upload retains the first success and recovers exactly the second ID after restart', async () => {
  const rt = await preparedRuntime(); let uploads = 0; let lost = false;
  const send: typeof fetch = async (url, init) => { const result = await rt.api.send(url, init); if (init?.method !== 'GET') { const req = JSON.parse(String(init?.body)); if (req.method === 'СБИС.ЗаписатьДокумент' && req.params.Документ.Тип === 'ConsignmentNote' && req.params.Документ.Вложение && ++uploads === 2 && !lost) { lost = true; throw new Error('private-lost-upload'); } } return result; };
  try {
    await awaitingLoading(rt); await saveTripLoadingFacts(rt.context, rt.facts(), 'synthetic-employee');
    const first = await rt.run({ client: new SabyClient(integrationConfig(), send) }); assert.equal(first.phase, 'unknown'); assert.equal(first.deliveries[0].status, 'draft'); assert.equal(first.deliveries[1].status, 'unknown'); assert.ok(first.deliveries[1].id);
    await rt.store.mutate(rt.source, data => { data.directories!.products[0].documentName = 'Изменённая карточка'; data.directories!.addresses.find(row => row.id === 'delivery')!.receiverPhone = '+70000000088'; return { result: null, changed: true }; });
    const result = await rt.run({ store: new OperationsStore(resolve(rt.directory, 'store')) }); assert.equal(result.phase, 'completed'); assert.equal(rt.api.writes('ConsignmentNote').length, 4); assert.equal(rt.api.reserves('ConsignmentNote').length, 2);
    const saved = await rt.store.read(rt.source); assert.ok(Object.values(saved.etrn!.trips[rt.tripId].deliveries).every(row => row.snapshot.profile.cargo.name === 'Синтетическое дизельное топливо' && row.snapshot.profile.recipient.phone === '+70000000009'));
  } finally { await rt.close(); }
});

test('revocation after CN reservation read preserves its ID and prevents its XML upload', async () => {
  const rt = await preparedRuntime(); let revoked = false;
  const send: typeof fetch = async (url, init) => { const result = await rt.api.send(url, init); if (init?.method !== 'GET') { const req = JSON.parse(String(init?.body)); if (req.method === 'СБИС.ПрочитатьДокумент' && rt.api.docs.get(req.params.Документ.Идентификатор)?.Тип === 'ConsignmentNote') revoked = true; } return result; };
  try {
    await awaitingLoading(rt); await saveTripLoadingFacts(rt.context, rt.facts(), 'synthetic-employee');
    await assert.rejects(rt.run({ client: new SabyClient(integrationConfig(), send), authorize: () => { if (revoked) throw new ApiError(403, 'Нет доступа'); } }), error => error instanceof ApiError && error.status === 403);
    assert.equal(rt.api.writes('ConsignmentNote').length, 1); assert.ok(Object.values((await rt.store.read(rt.source)).etrn!.trips[rt.tripId].deliveries)[0].document?.id);
  } finally { await rt.close(); }
});

test('HTTP workflow endpoints enforce auth, return safe state, run order, and accept employee loading facts', async () => {
  const rt = await preparedRuntime(); const savedEnv = process.env.SABY_AUTOFILL_PROFILE_JSON; process.env.SABY_AUTOFILL_PROFILE_JSON = JSON.stringify(integrationSettings);
  const middleware = createSnapshotMiddleware(rt.snapshotDirectory, { operationsStore: rt.store, sabyClient: rt.client });
  const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end(); })); await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (path: string, method = 'GET', body?: unknown, cookie?: string) => fetch(origin + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  try {
    const path = `/api/shipment-trips/${rt.tripId}/saby-workflow`;
    assert.equal((await request(path)).status, 401);
    const setup = await request('/api/auth/setup', 'POST', { name: 'Синтетический сотрудник', login: 'synthetic-owner', password: randomUUID() }); assert.equal(setup.status, 200); const cookie = setup.headers.get('set-cookie')!.split(';')[0];
    const ready = await request(path, 'GET', undefined, cookie); assert.equal(ready.status, 200); const readyBody = await ready.json(); assert.equal(readyBody.ready, true, readyBody.blockers.join(' ')); assert.equal(rt.api.calls.length, 0);
    assert.equal((await request(path, 'POST', { arbitrary: 'forbidden' }, cookie)).status, 400);
    const sent = await request(path, 'POST', {}, cookie); assert.equal(sent.status, 200); assert.equal((await sent.json()).phase, 'awaiting_carrier');
    rt.api.accept(); const accepted = await request(path, 'POST', {}, cookie); assert.equal((await accepted.json()).phase, 'awaiting_loading');
    const completed = await request(`${path}/loading-facts`, 'POST', rt.facts(), cookie); assert.equal(completed.status, 200); const result = await completed.json(); assert.equal(result.phase, 'completed');
    assert.deepEqual(Object.keys(result.carrierHandoff).sort(), ['driverName', 'driverPhone', 'vehiclePlate', 'vehicleType']);
    assert.equal(result.carrierHandoff.driverPhone, '+70000000003'); delete result.carrierHandoff;
    assert.doesNotMatch(JSON.stringify(result), /700000000|private-integration-session|snapshot|payloadHash/);
    const hidden = await request(path); assert.equal(hidden.status, 401); assert.doesNotMatch(await hidden.text(), /driverPhone|700000000|ВодительТестовый/);
    assert.equal((await request(`/api/shipment-trips/${rt.tripId}/etrn/submit`, 'POST', { shipmentId: rt.trip.customers[0].id }, cookie)).status, 409);
  } finally { if (savedEnv === undefined) delete process.env.SABY_AUTOFILL_PROFILE_JSON; else process.env.SABY_AUTOFILL_PROFILE_JSON = savedEnv; await new Promise<void>(done => server.close(() => done())); await rt.close(); }
});

test('the complete actual loading package must not exceed vehicle payload across separate delivery rows', async () => {
  const rt = await preparedRuntime();
  try {
    await awaitingLoading(rt);
    const excessive = { ...rt.facts(), deliveries: Object.fromEntries(rt.trip.customers.map(row => [row.id, { grossMassTonnes: '11', massMethod: '02' }])) };
    await assert.rejects(saveTripLoadingFacts(rt.context, excessive, 'synthetic-employee'), error => error instanceof ApiError && [400, 422].includes(error.status));
    assert.equal((await rt.store.read(rt.source)).etrn?.trips[rt.tripId]?.loadingFacts, undefined); assert.equal(rt.api.writes('ConsignmentNote').length, 0);
  } finally { await rt.close(); }
});

test('definitely rejected CN reservation can retry safely, while a vendor RPC error cannot', async () => {
  for (const mode of ['denied', 'rpc'] as const) {
    const rt = await preparedRuntime(); let failed = false;
    const send: typeof fetch = async (url, init) => {
      if (init?.method !== 'GET') {
        const req = JSON.parse(String(init?.body));
        if (!failed && req.method === 'СБИС.ЗаписатьДокумент' && req.params.Документ.Тип === 'ConsignmentNote') {
          failed = true;
          return mode === 'denied' ? new Response('', { status: 403 }) : new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -1, message: 'private-vendor-message' } }));
        }
      }
      return rt.api.send(url, init);
    };
    try {
      await awaitingLoading(rt); await saveTripLoadingFacts(rt.context, rt.facts(), 'synthetic-employee');
      const first = await rt.run({ client: new SabyClient(integrationConfig(), send) });
      assert.equal(first.phase, mode === 'denied' ? 'error' : 'unknown'); assert.equal(rt.api.reserves('ConsignmentNote').length, 0);
      const second = await rt.run(); assert.equal(second.phase, mode === 'denied' ? 'completed' : 'unknown'); assert.equal(rt.api.reserves('ConsignmentNote').length, mode === 'denied' ? 2 : 0);
      assert.doesNotMatch(JSON.stringify(await rt.store.read(rt.source)), /private-vendor-message/);
    } finally { await rt.close(); }
  }
});

test('an unknown CN upload with no returned title is read again without re-upload or a new number', async () => {
  const rt = await preparedRuntime(); let uploadAttempts = 0;
  const send: typeof fetch = async (url, init) => {
    if (init?.method !== 'GET') { const req = JSON.parse(String(init?.body)); if (req.method === 'СБИС.ЗаписатьДокумент' && req.params.Документ.Тип === 'ConsignmentNote' && req.params.Документ.Вложение) { uploadAttempts++; throw new Error('lost-before-server-result'); } }
    return rt.api.send(url, init);
  };
  try {
    await awaitingLoading(rt); await saveTripLoadingFacts(rt.context, rt.facts(), 'synthetic-employee');
    assert.equal((await rt.run({ client: new SabyClient(integrationConfig(), send) })).phase, 'unknown'); assert.equal(uploadAttempts, 1);
    assert.equal((await rt.run()).phase, 'unknown'); assert.equal(rt.api.writes('ConsignmentNote').length, 1); assert.equal(rt.api.reserves('ConsignmentNote').length, 1);
  } finally { await rt.close(); }
});

test('bulk diesel uses one planned mass while other packaging retains separate gross validation', async () => {
  const rt = await preparedRuntime();
  try {
    const data = await rt.store.read(rt.source); const source = currentSnapshot(rt.base, data);
    for (const quantity_gross_tonnes of [null, '11', '21']) {
      const prepared = rt.prepare(source, data, { ...rt.trip, fields: { ...rt.trip.fields, quantity_gross_tonnes } }, integrationConfig());
      assert.deepEqual(prepared.blockers, []);
      assert.equal(prepared.order.fields.quantity_gross_tonnes, rt.trip.fields.quantity_tonnes);
      assert.equal(prepared.deliveries[0].snapshot.profile.plannedGrossMassTonnes, prepared.deliveries[0].snapshot.profile.deliveryMassTonnes);
    }
    delete source.directories!.products[0].cargoPackaging;
    const unknown = rt.prepare(source, data, { ...rt.trip, fields: { ...rt.trip.fields, quantity_gross_tonnes: null } }, integrationConfig());
    assert.ok(unknown.blockers.some(message => /массу брутто/.test(message)));
    source.directories!.products[0].cargoPackaging = 'packaged';
    assert.ok(rt.prepare(source, data, rt.trip, integrationConfig()).blockers.some(message => /в упаковке/.test(message)));
    assert.equal(rt.api.calls.length, 0); assert.equal((await rt.store.read(rt.source)).tripSaby, undefined);
  } finally { await rt.close(); }
});

test('permission revoked between durable CN intent and HTTP does not prohibit later safe creation', async () => {
  const rt = await preparedRuntime(); let revokeOnce = true;
  try {
    await awaitingLoading(rt); await saveTripLoadingFacts(rt.context, rt.facts(), 'synthetic-employee');
    await assert.rejects(rt.run({ authorize: (_snapshot, data) => { const documents = Object.values(data.etrn?.trips[rt.tripId]?.deliveries ?? {}).map(row => row.document); if (revokeOnce && documents.some(doc => doc?.reservationAttempted && !doc.id)) { revokeOnce = false; throw new ApiError(403, 'Нет доступа'); } } }), error => error instanceof ApiError && error.status === 403);
    assert.equal(rt.api.reserves('ConsignmentNote').length, 0);
    assert.equal((await rt.run()).phase, 'completed'); assert.equal(rt.api.reserves('ConsignmentNote').length, 2);
  } finally { await rt.close(); }
});

test('late missing configuration never replaces frozen data and missing credentials cannot trigger a retry', async () => {
  const rt = await preparedRuntime();
  try {
    await awaitingLoading(rt); await saveTripLoadingFacts(rt.context, rt.facts(), 'synthetic-employee');
    const before = rt.api.calls.length;
    await assert.rejects(rt.run({ client: new SabyClient({ ...integrationConfig(), sessionId: undefined }, rt.api.send) }), error => error instanceof ApiError && error.status === 422);
    assert.equal(rt.api.calls.length, before);
    const result = await rt.run({ client: new SabyClient({ ...integrationConfig(), transportProfile: undefined, consignmentSigner: undefined }, rt.api.send), prepare: () => { throw new Error('Frozen data must not be rebuilt'); } });
    assert.equal(result.phase, 'completed'); assert.equal(rt.api.reserves('ConsignmentNote').length, 2);
  } finally { await rt.close(); }
});

test('Saby preparation may change sender file identifiers and signing headers without breaking the linked carrier acceptance', async () => {
  const rt = await preparedRuntime();
  try {
    assert.equal((await rt.run()).phase, 'awaiting_carrier');
    rt.api.prepareSender(); rt.api.accept();
    assert.equal((await rt.run()).phase, 'awaiting_loading');
    await saveTripLoadingFacts(rt.context, rt.facts(), 'synthetic-employee'); assert.equal((await rt.run()).phase, 'completed');
    assert.equal(rt.api.reserves('TransportOrder').length, 1); assert.equal(rt.api.reserves('ConsignmentNote').length, 2);
  } finally { await rt.close(); }
});

test('a signed and correctly linked carrier response cannot authorize changed sender cargo facts', async () => {
  const rt = await preparedRuntime();
  try {
    assert.equal((await rt.run()).phase, 'awaiting_carrier'); rt.api.prepareSender(true); rt.api.accept();
    const result = await rt.run(); assert.equal(result.phase, 'unknown'); assert.equal(result.carrierConfirmed, false); assert.match(result.lastError!, /сохранённые сведения/);
    assert.equal(rt.api.writes('ConsignmentNote').length, 0);
  } finally { await rt.close(); }
});

test('NK transport-only accounting scenario still creates the confirmed Artel-to-NK order and per-delivery notes', async () => {
  const rt = await preparedRuntime();
  try {
    await rt.store.mutate(rt.source, data => { for (const row of Object.values(data.shipments)) row.fields.organization_id = 'nk-artel'; return { result: null, changed: true }; });
    await awaitingLoading(rt);
    const request = rt.api.reserves('TransportOrder')[0].params.Документ;
    assert.equal(((request.НашаОрганизация as SabyObject).СвЮЛ as SabyObject).ИНН, integrationConfig().customer.inn);
    assert.equal(((request.Контрагент as SabyObject).СвЮЛ as SabyObject).ИНН, integrationConfig().carrier.inn);
    await saveTripLoadingFacts(rt.context, rt.facts(), 'synthetic-employee'); assert.equal((await rt.run()).phase, 'completed');
    assert.equal(rt.api.reserves('TransportOrder').length, 1); assert.equal(rt.api.reserves('ConsignmentNote').length, 2);
  } finally { await rt.close(); }
});

test('unexpected write response IDs are retained privately without replacing intended order or consignment links', async () => {
  for (const type of ['TransportOrder', 'ConsignmentNote'] as const) {
    const rt = await preparedRuntime(); let mismatched = false;
    const send: typeof fetch = async (url, init) => {
      const response = await rt.api.send(url, init);
      if (init?.method !== 'GET') {
        const req = JSON.parse(String(init?.body));
        if (!mismatched && req.method === 'СБИС.ЗаписатьДокумент' && req.params.Документ.Тип === type && req.params.Документ.Вложение) {
          mismatched = true; const body = await response.json(); body.result.Идентификатор = 'unexpected-synthetic-document-id'; return new Response(JSON.stringify(body));
        }
      }
      return response;
    };
    try {
      if (type === 'ConsignmentNote') { await awaitingLoading(rt); await saveTripLoadingFacts(rt.context, rt.facts(), 'synthetic-employee'); }
      const response = await rt.run({ client: new SabyClient(integrationConfig(), send) }); assert.equal(response.phase, 'unknown');
      const data = await rt.store.read(rt.source);
      const record = type === 'TransportOrder' ? data.tripSaby!.trips[rt.tripId] : Object.values(data.etrn!.trips[rt.tripId].deliveries)[0].document!;
      assert.deepEqual(record.unexpectedDocumentIds, ['unexpected-synthetic-document-id']);
      assert.notEqual(type === 'TransportOrder' ? data.tripSaby!.trips[rt.tripId].order.id : Object.values(data.etrn!.trips[rt.tripId].deliveries)[0].document!.id, 'unexpected-synthetic-document-id');
      assert.doesNotMatch(JSON.stringify(response), /unexpectedDocumentIds|unexpected-synthetic-document-id/);
    } finally { await rt.close(); }
  }
});
