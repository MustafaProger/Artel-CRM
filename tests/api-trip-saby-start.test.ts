import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { saveUser } from '../server/auth';
import { createSnapshotMiddleware } from '../server/local-api';
import { requireLogisticsRoute } from '../server/logistics-api';
import { recordDriverTripAction } from '../server/driver-trips';
import { currentSnapshot } from '../server/shipment-operations';
import { parseXml, type XmlNode } from '../server/saby-order-evidence';
import { serializeXml } from '../server/saby-carrier-details';
import { encodeWindows1251 } from '../server/saby-transport-order';
import { SabyClient, type SabyObject } from '../server/saby-client';
import { dispatchTripSaby } from '../server/trip-saby-scheduler';
import { getTripSabyWorkflow, startAutomaticTripSaby } from '../server/trip-saby-workflow';
import { OperationsStore } from '../server/operations-store';
import type { AccountUser } from '../web/src/auth-model';
import type { ShipmentTrip } from '../web/src/model';
import { workflowView } from '../web/src/trip-workflow-view';
import { integrationRuntime, integrationApi, integrationConfig, integrationPrepare, integrationSettings, type IntegrationRpc } from './helpers/trip-saby-integration';

async function fixture(twoClients = false) {
  const rt = await integrationRuntime(), api = integrationApi(), config = integrationConfig(), kicked: string[] = [];
  config.automaticSigning = { id: 'synthetic-explicit-start', enabled: true, mode: 'deferred', approvedAt: '2026-10-01T00:00:00.000Z', sender: { ...config.customer, thumbprint: 'ab'.repeat(20) }, carrier: { ...config.carrier, thumbprint: 'cd'.repeat(20) } };
  if (twoClients) await rt.store.mutate(rt.source, data => {
    const first = data.companies!.find(company => company.id === 'customer')!;
    data.companies!.push({ ...first, id: 'customer-two', name: 'Второй синтетический клиент', inn: '7736050003', kpp: '773601001' });
    const address = data.directories!.addresses.find(row => row.id === 'delivery')!;
    Object.assign(address, { latitude: '55.705', longitude: '37.705', mapUrl: 'https://yandex.ru/maps/?ll=37.705%2C55.705' });
    data.directories!.addresses.push({ ...address, id: 'delivery-two', companyId: 'customer-two', address: 'Второй полный синтетический адрес', latitude: '55.905', longitude: '37.905' });
    for (const loading of [data.directories!.oilDepots[0], data.directories!.addresses.find(row => row.id === 'loading')!]) Object.assign(loading, { latitude: '55.601', longitude: '37.601', mapUrl: 'https://yandex.ru/maps/?ll=37.601%2C55.601' });
    return { changed: true, result: null };
  });
  const token = randomBytes(32).toString('hex');
  const actor = await rt.store.mutate(rt.source, async data => {
    const user = await saveUser(data, currentSnapshot(rt.base, data), { name: 'Синтетический руководитель', login: 'start-owner', password: randomUUID() }, undefined, true);
    data.accounts!.sessions.push({ userId: user.id, hash: createHash('sha256').update(token).digest('hex'), expiresAt: Date.now() + 600_000 });
    return { result: user, changed: true };
  });
  const previousSettings = process.env.SABY_AUTOFILL_PROFILE_JSON;
  process.env.SABY_AUTOFILL_PROFILE_JSON = JSON.stringify(integrationSettings);
  const middleware = createSnapshotMiddleware(rt.snapshotDirectory, { operationsStore: rt.store, sabyClient: new SabyClient(config, api.send), requestSabyWorkflow: id => { kicked.push(id); }, sabyWorkflowMonitoringEnabled: true });
  const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end(); }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const http = async (path: string, method = 'GET', input?: unknown, authenticated = true) => {
    const response = await fetch(origin + '/api/shipment-trips' + path, { method, headers: { 'Content-Type': 'application/json', ...(authenticated ? { Cookie: `artel_session=${token}` } : {}) }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    return { status: response.status, body: await response.json() };
  };
  const fields = Object.fromEntries(['organization_id', 'supplier_id', 'carrier_id', 'oil_depot_id', 'product_id', 'purchase_price_unspecified_unit', 'driver_id', 'vehicle_id', 'additional_costs'].map(key => [key, rt.trip.fields[key]]));
  Object.assign(fields, { trip_flow_version: 'driver-v1', loading_at: '2027-02-03T09:15' });
  const customer = Object.fromEntries(['customer_id', 'manager_id', 'payment_form_id', 'sale_price_per_litre', 'transport_amount', 'unloading_address_id'].map(key => [key, rt.trip.customers[0].fields[key]]));
  const customerFields = [customer, ...(twoClients ? [{ ...customer, customer_id: 'customer-two', unloading_address_id: 'delivery-two' }] : [])];
  const input = { fields, customers: customerFields.map(row => ({ fields: { ...row, quantity_litres: '1' } })), idempotencyKey: randomUUID() };
  const created = await http('', 'POST', input); if (created.status !== 201) { await new Promise<void>(resolve => server.close(() => resolve())); await rt.close(); } assert.equal(created.status, 201, JSON.stringify(created.body));
  let trip: ShipmentTrip = created.body.trip;
  const tripId = trip.id, path = `/${tripId}/saby-workflow`;
  const patch = async (litres: string | string[] = '10') => {
    const response = await http(`/${tripId}`, 'PATCH', { fields, customers: trip.customers.map((row, index) => ({ id: row.id, fields: { ...customerFields[index], quantity_litres: Array.isArray(litres) ? litres[index] : litres } })), versions: Object.fromEntries(trip.customers.map(row => [row.id, row.version])) });
    assert.equal(response.status, 200, JSON.stringify(response.body)); trip = response.body.trip;
  };
  const preview = async () => { const response = await http(path); assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body; };
  return { ...rt, api, config, actor, kicked, http, patch, preview, path, tripId, input, close: async () => { await new Promise<void>(resolve => server.close(() => resolve())); if (previousSettings === undefined) delete process.env.SABY_AUTOFILL_PROFILE_JSON; else process.env.SABY_AUTOFILL_PROFILE_JSON = previousSettings; await rt.close(); } };
}

test('1 L blocked save and 10 L edit require explicit atomic start; queue survives restart and produces only one unsigned draft', async () => {
  const f = await fixture();
  try {
    const before = await f.store.read(f.source); const blocked = await f.preview();
    assert.equal(blocked.ready, false); assert.equal(blocked.start, undefined); assert.equal(before.tripSaby?.trips[f.tripId], undefined); assert.equal(f.api.calls.length, 0);
    assert.match(blocked.automation.message, /Запустить обмен/); assert.doesNotMatch(blocked.automation.message, /начнётся.*сохранения/);
    await f.patch(); const ready = await f.preview();
    assert.equal(ready.ready, true, JSON.stringify(ready.blockers)); assert.ok(ready.start?.previewToken); assert.equal(ready.automation.enrolled, false);
    assert.match(workflowView(ready).text, /неподписанный черновик/);
    assert.equal((await f.store.read(f.source)).tripSaby?.trips[f.tripId], undefined); assert.deepEqual(f.kicked, []); assert.equal(f.api.calls.length, 0);
    const requests = await Promise.all([f.http(f.path + '/start', 'POST', ready.start), f.http(f.path + '/start', 'POST', ready.start)]);
    assert.deepEqual(requests.map(row => row.status).sort(), [202, 409]); assert.deepEqual(f.kicked, [f.tripId]); assert.equal(f.api.calls.length, 0);
    const queued = (await f.store.read(f.source)).tripSaby!.trips[f.tripId];
    assert.equal(queued.autoAuthorization?.requestedBy, f.actor.id); assert.equal(queued.initiatorId, f.actor.id); assert.equal(queued.order.id, null); assert.equal(queued.signing, undefined);
    const requestId = queued.autoAuthorization!.requestId;
    const replay = await f.http(f.path + '/start', 'POST', ready.start); assert.equal(replay.status, 409);
    assert.deepEqual((await f.store.read(f.source)).tripSaby!.trips[f.tripId], queued); assert.deepEqual(f.kicked, [f.tripId]); assert.equal((await f.preview()).start, undefined);
    const persisted = new OperationsStore(f.directory + '/store');
    const dispatched = await dispatchTripSaby({ base: f.base, store: persisted, config: f.config, enabled: true, prepare: integrationPrepare, send: f.api.send, tripId: f.tripId });
    assert.equal(dispatched.continued, 1);
    const draft = (await f.store.read(f.source)).tripSaby!.trips[f.tripId];
    assert.equal(draft.phase, 'awaiting_driver', draft.lastError ?? ''); assert.ok(draft.order.id); assert.equal(draft.signing, undefined); assert.equal(draft.autoAuthorization!.requestId, requestId);
    assert.equal(f.api.reserves('TransportOrder').length, 1); assert.equal(f.api.calls.some(row => /ПодготовитьДействие|ВыполнитьДействие|СписокПодписей/.test(row.method)), false);
    assert.deepEqual((await f.store.read(f.source)).shipments[f.trip.customers[0].id], before.shipments[f.trip.customers[0].id]);
  } finally { await f.close(); }
});

test('stale trip data, directory snapshot, policy or driver progress cannot start the exchange', async () => {
  for (const change of ['trip', 'directory', 'policy', 'driver'] as const) {
    const f = await fixture();
    try {
      await f.patch(); const ready = await f.preview();
      if (change === 'trip') await f.patch('20');
      if (change === 'policy') f.config.automaticSigning!.approvedAt = '2026-10-02T00:00:00.000Z';
      if (change === 'directory') await f.store.mutate(f.source, data => { data.directories!.products[0].documentName = 'Другой документ'; return { result: null, changed: true }; });
      if (change === 'driver') await f.store.mutate(f.source, data => recordDriverTripAction(f.base, data, { id: 'synthetic-driver', name: 'Тест', login: 'synthetic-driver', role: 'driver', driverId: 'driver', managerId: null, active: true, version: 1 }, f.tripId, 'arrive', { versions: Object.fromEntries(currentSnapshot(f.base, data).shipments.filter(row => row.fields.trip_id === f.tripId).map(row => [row.id, row.version ?? 0])) }));
      const response = await f.http(f.path + '/start', 'POST', ready.start); assert.equal(response.status, 409, `${change}: ${JSON.stringify(response.body)}`);
      assert.equal((await f.store.read(f.source)).tripSaby?.trips[f.tripId], undefined); assert.deepEqual(f.kicked, []); assert.equal(f.api.calls.length, 0);
    } finally { await f.close(); }
  }
});

test('start enforces authentication, methods, strict body and current permission/policy without provider requests', async () => {
  const f = await fixture();
  try {
    await f.patch(); const ready = await f.preview();
    assert.equal((await f.http(f.path + '/start', 'POST', ready.start, false)).status, 401);
    assert.equal((await f.http(f.path + '/start')).status, 405);
    for (const body of [{}, { previewToken: 'bad' }, { ...ready.start, automatic: true }]) assert.equal((await f.http(f.path + '/start', 'POST', body)).status, 400);
    f.config.automaticSigning!.enabled = false;
    assert.equal((await f.preview()).start, undefined); assert.equal((await f.http(f.path + '/start', 'POST', ready.start)).status, 403);
    f.config.automaticSigning!.enabled = true;
    await f.store.mutate(f.source, data => { const actor = data.accounts!.users.find(row => row.id === f.actor.id)!; data.accounts!.users.push({ ...actor, id: 'remaining-director', login: 'remaining-director' }); actor.role = 'employee'; actor.sections = ['shipments']; return { result: null, changed: true }; });
    assert.equal((await f.http(f.path + '/start', 'POST', ready.start)).status, 403);
    assert.equal(f.api.calls.length, 0); assert.deepEqual(f.kicked, []); assert.equal((await f.store.read(f.source)).tripSaby?.trips[f.tripId], undefined);
  } finally { await f.close(); }
});

test('existing unknown or manual workflow cannot be reauthorized; legacy trip never receives a start preview', async () => {
  const f = await fixture();
  try {
    await f.patch(); const ready = await f.preview(); assert.equal((await f.http(f.path + '/start', 'POST', ready.start)).status, 202);
    await f.store.mutate(f.source, data => { const record = data.tripSaby!.trips[f.tripId]; record.phase = 'unknown'; record.order.status = 'unknown'; delete record.autoAuthorization; return { result: null, changed: true }; });
    const before = (await f.store.read(f.source)).tripSaby!.trips[f.tripId];
    assert.equal((await f.http(f.path + '/start', 'POST', ready.start)).status, 409); assert.equal((await f.preview()).start, undefined);
    assert.deepEqual((await f.store.read(f.source)).tripSaby!.trips[f.tripId], before); assert.deepEqual(f.kicked, [f.tripId]); assert.equal(f.api.calls.length, 0);
    const legacy = await f.http(`/${f.trip.id}/saby-workflow`); assert.equal(legacy.status, 200); assert.equal(legacy.body.start, undefined);
    assert.equal((await f.http(`/${f.trip.id}/saby-workflow/start`, 'POST', ready.start)).status, 409);
  } finally { await f.close(); }
});

test('old failed documents and orphan loading facts require reconciliation, even without an external ID', async () => {
  const f = await fixture();
  try {
    await f.patch(); const ready = await f.preview();
    for (const scenario of ['document', 'facts'] as const) {
      const data = await f.store.read(f.source);
      // Unpersisted synthetic history exercises the guard before provider or record creation.
      if (scenario === 'document') data.saby = { trips: { [f.tripId]: { documents: [{ id: null, status: 'error' }] as never[], leaseId: null, leaseUntil: null, updatedAt: new Date().toISOString() } } };
      else data.etrn = { trips: { [f.tripId]: { deliveries: {}, loadingFacts: { arrivedAt: '2027-02-03T09:15', departedAt: '2027-02-03T10:15', deliveries: {} } } } } as typeof data.etrn;
      assert.throws(() => startAutomaticTripSaby({ base: f.base, data, tripId: f.tripId, actorId: f.actor.id, config: f.config, previewToken: ready.start.previewToken, mode: ready.start.mode, prepare: integrationPrepare }), /сверк|прежнего обмена/);
      assert.equal(getTripSabyWorkflow({ base: f.base, data, tripId: f.tripId, actorId: f.actor.id, config: f.config, prepare: integrationPrepare }).start, undefined);
      assert.equal(data.tripSaby?.trips[f.tripId], undefined);
    }
    assert.equal(f.api.calls.length, 0);
  } finally { await f.close(); }
});

test('logistics alias permits only POST for the same guarded start handler', () => {
  assert.doesNotThrow(() => requireLogisticsRoute('/api/shipment-trips/trip/saby-workflow/start', 'POST'));
  assert.throws(() => requireLogisticsRoute('/api/shipment-trips/trip/saby-workflow/start', 'GET'));
});

async function recordDeparture(f: Awaited<ReturnType<typeof fixture>>, mass: string | string[] = '0.00835') {
  const driver: AccountUser = { id: 'synthetic-driver-user', login: 'synthetic-driver', name: 'Синтетический водитель', role: 'driver', driverId: 'driver', managerId: null, active: true, version: 1, sections: [] };
  await f.store.mutate(f.source, data => { data.accounts!.users.push({ ...driver, passwordHash: 'a'.repeat(128), salt: 'a'.repeat(32) }); return { result: null, changed: true }; });
  for (const action of ['arrive', 'depart'] as const) await f.store.mutate(f.source, data => {
    const rows = currentSnapshot(f.base, data, false).shipments.filter(row => row.fields.trip_id === f.tripId);
    return recordDriverTripAction(f.base, data, driver, f.tripId, action, { versions: Object.fromEntries(rows.map(row => [row.id, row.version ?? 0])), ...(action === 'depart' ? { masses: rows.map((row, index) => ({ deliveryId: row.id, netTonnes: Array.isArray(mass) ? mass[index] : mass })) } : {}) });
  });
}

/** Synthetic Saby leaves sender Execute pending, so this test never invents a completed signature. */
function pendingSender(f: Awaited<ReturnType<typeof fixture>>, transform?: (bytes: Uint8Array) => Buffer) {
  let preparedBytes: Buffer | undefined;
  Object.assign(f.config, { login: 'synthetic', password: 'synthetic', accountNumber: 'sender-account', carrierAccountNumber: 'carrier-account' });
  const calls: IntegrationRpc[] = [];
  const senderDoc = () => [...f.api.docs.values()][0];
  const stage = () => ({ Идентификатор: 'sender-stage', Название: 'Отправка', Действие: [{ Название: 'Отправить', ТребуетПодписания: 'Да', Сертификат: { Отпечаток: f.config.automaticSigning!.sender.thumbprint, Ключ: { Тип: 'Отложенный', Активирован: 'Да' } } }] });
  const annotate = () => { for (const doc of f.api.docs.values()) { doc.Направление = 'Исходящий'; doc.Этап = [stage()]; doc.ТекущиеЭтапы = [{ Идентификатор: 'sender-stage', Наименование: 'Отправка' }]; for (const file of doc.Вложение as SabyObject[]) file.Направление = 'Исходящий'; } };
  const send: typeof fetch = async (url, init) => {
    if (init?.method === 'GET') return preparedBytes && String(url).includes('.xml') ? new Response(preparedBytes) : f.api.send(url, init);
    const request = JSON.parse(String(init?.body)) as IntegrationRpc; calls.push(request);
    const side = new Headers(init?.headers).get('X-SBISSessionID') === 'carrier-session' ? 'carrier' : 'sender';
    const organization = side === 'sender' ? f.config.customer : f.config.carrier;
    const json = (result: unknown) => f.api.json(request, result);
    if (request.method === 'СБИС.Аутентифицировать') return json('carrier-session');
    if (request.method === 'sabyCertificate.List' || request.method === 'sabyCertificate.Read') {
      const certificate = { Certificate: { Type: 'Client', CertificateInfo: { Thumbprint: f.config.automaticSigning![side].thumbprint, IsValid: true, IsQualified: true, NotBefore: '2020-01-01T00:00:00Z', NotAfter: '2099-01-01T00:00:00Z', SubjectName: { '1.2.643.100.4': organization.inn, '2.5.4.4': 'Тестовый', '2.5.4.42': 'Подписант' } } }, OurCompany: { Inn: organization.inn, Kpp: organization.kpp } };
      return json(request.method === 'sabyCertificate.List' ? [certificate] : certificate);
    }
    annotate();
    if (request.method === 'СБИС.ПодготовитьДействие') {
      if (transform) {
        const file = ((senderDoc().Вложение as SabyObject[])[0].Файл as SabyObject);
        const response = await f.api.send(String(file.Ссылка), { method: 'GET' });
        preparedBytes = transform(new Uint8Array(await response.arrayBuffer()));
      }
      const prepared = structuredClone(senderDoc());
      (prepared.Этап as SabyObject[])[0].Вложение = (prepared.Вложение as SabyObject[]).map(file => ({ ...file, ТребуемоеДействие: 'Подписать' }));
      return json(prepared);
    }
    if (request.method === 'СБИС.ВыполнитьДействие') { senderDoc().Состояние = { Код: '23' }; delete senderDoc().Код; return json(senderDoc()); }
    const response = await f.api.send(url, init); annotate(); return response;
  };
  return { send, calls };
}

test('consistent saved departure explicitly authorizes signing: massless draft then same-ID mass update before one sender Execute', async () => {
  const f = await fixture();
  try {
    await f.patch(); const preDeparture = await f.preview(); await recordDeparture(f);
    const before = await f.store.read(f.source); const ready = await f.preview();
    assert.equal(ready.ready, true, JSON.stringify(ready.blockers)); assert.equal(ready.start.mode, 'sign_and_send');
    assert.equal(workflowView(ready, true).requiresReconciliation, undefined); assert.match(workflowView(ready, true).text, /подпись АРТЭЛЬ и НК АРТЭЛЬ/);
    assert.equal((await f.http(f.path + '/start', 'POST', preDeparture.start)).status, 409);
    assert.equal((await f.http(f.path + '/start', 'POST', { ...ready.start, mode: 'draft' })).status, 409);
    assert.equal((await f.http(f.path + '/start', 'POST', ready.start)).status, 202);
    const queued = (await f.store.read(f.source)).tripSaby!.trips[f.tripId];
    assert.ok(queued.driverFlow!.authorizedDepartureHash); assert.equal(queued.snapshot.fields.quantity_tonnes, null); assert.equal(queued.deliveries[0].snapshot.profile.deliveryMassTonnes, '');
    const provider = pendingSender(f);
    const dispatched = await dispatchTripSaby({ base: f.base, store: new OperationsStore(f.directory + '/store'), config: f.config, enabled: true, prepare: integrationPrepare, send: provider.send, tripId: f.tripId });
    assert.equal(dispatched.continued, 1);
    const after = await f.store.read(f.source); const record = after.tripSaby!.trips[f.tripId];
    assert.equal(record.driverFlow!.state, 'ready', record.lastError ?? ''); assert.equal(record.signing?.sender.state, 'waiting', JSON.stringify(record.signing ?? record.lastError));
    assert.equal(record.signing!.sender.executeAttempted, true); assert.equal(record.signing!.carrier.state, 'not_started');
    const massWrites = f.api.calls.filter(row => row.method === 'СБИС.ЗаписатьВложение');
    assert.equal(f.api.reserves('TransportOrder').length, 1); assert.equal(f.api.writes('TransportOrder').length, 2); assert.equal(massWrites.length, 1);
    const decode = (request: IntegrationRpc) => new TextDecoder('windows-1251').decode(Buffer.from(String(((request.params.Документ.Вложение as SabyObject[])[0].Файл as SabyObject).ДвоичныеДанные), 'base64'));
    const draftXml = decode(f.api.writes('TransportOrder')[1]), finalXml = decode(massWrites[0]);
    assert.doesNotMatch(draftXml, /МасНетЗнач|МасБрутЗнач/); assert.match(finalXml, /МасНетЗнач="8\.35"/); assert.notEqual(draftXml, finalXml);
    assert.equal(provider.calls.filter(row => row.method === 'СБИС.ВыполнитьДействие').length, 1);
    assert.ok(provider.calls.findIndex(row => row.method === 'СБИС.ЗаписатьВложение') < provider.calls.findIndex(row => row.method === 'СБИС.ПодготовитьДействие'));
    assert.deepEqual(after.shipments, before.shipments); assert.deepEqual(after.driverTripProgress, before.driverTripProgress); assert.deepEqual(after.etrn, before.etrn);
    assert.equal((await f.http(f.path + '/start', 'POST', ready.start)).status, 409);
  } finally { await f.close(); }
});

test('inconsistent saved driver facts cannot expose or execute a post-departure start', async () => {
  const f = await fixture();
  try {
    await f.patch(); await recordDeparture(f); const ready = await f.preview(); const original = await f.store.read(f.source);
    const deliveryId = Object.keys(original.driverTripProgress![f.tripId].masses!)[0];
    const variants = ['missing-facts', 'missing-progress', 'driver', 'composition', 'versions', 'extra-mass', 'missing-delivery', 'mass', 'row-mass', 'row-total', 'mass-method', 'arrival-time', 'departure-time', 'record-time', 'continuation', 'fact-actor', 'driver-actor', 'arrival-actor', 'row-arrival'] as const;
    for (const variant of variants) {
      const data = structuredClone(original), progress = data.driverTripProgress![f.tripId], facts = data.etrn!.trips[f.tripId].loadingFacts!, row = data.shipments[deliveryId];
      if (variant === 'missing-facts') delete data.etrn!.trips[f.tripId].loadingFacts;
      if (variant === 'missing-progress') delete data.driverTripProgress![f.tripId];
      if (variant === 'driver') progress.driverId = 'another-driver';
      if (variant === 'composition') progress.compositionHash = 'f'.repeat(64);
      if (variant === 'versions') progress.departureVersions![deliveryId]++;
      if (variant === 'extra-mass') progress.masses!.extra = '1';
      if (variant === 'missing-delivery') delete facts.deliveries[deliveryId];
      if (variant === 'mass') facts.deliveries[deliveryId].grossMassTonnes = '0.009';
      if (variant === 'row-mass') Object.assign(row.fields, { quantity_gross_tonnes: '0.009', quantity_tonnes: '0.009', trip_total_tonnes: '0.009' });
      if (variant === 'row-total') row.fields.trip_total_tonnes = '0.009';
      if (variant === 'mass-method') facts.deliveries[deliveryId].massMethod = '02';
      if (variant === 'arrival-time') facts.arrivedAt = '2020-01-01T00:00:00';
      if (variant === 'departure-time') facts.departedAt = '2020-01-01T00:00:00';
      if (variant === 'record-time') facts.recordedAt = '2020-01-01T00:00:00.000Z';
      if (variant === 'continuation') delete progress.continuationRequestedAt;
      if (variant === 'fact-actor') facts.actorId = f.actor.id;
      if (variant === 'driver-actor') progress.departedBy = facts.actorId = f.actor.id;
      if (variant === 'arrival-actor') progress.arrivedBy = f.actor.id;
      if (variant === 'row-arrival') row.fields.loading_actual_at = '2020-01-01T00:00:00';
      if (variant === 'row-total') {
        assert.throws(() => getTripSabyWorkflow({ base: f.base, data, tripId: f.tripId, actorId: f.actor.id, config: f.config, prepare: integrationPrepare }));
        assert.throws(() => startAutomaticTripSaby({ base: f.base, data, tripId: f.tripId, actorId: f.actor.id, config: f.config, ...ready.start, prepare: integrationPrepare }));
        continue;
      }
      const preview = getTripSabyWorkflow({ base: f.base, data, tripId: f.tripId, actorId: f.actor.id, config: f.config, prepare: integrationPrepare });
      assert.equal(preview.start, undefined, variant);
      assert.throws(() => startAutomaticTripSaby({ base: f.base, data, tripId: f.tripId, actorId: f.actor.id, config: f.config, ...ready.start, prepare: integrationPrepare }), /сверк/, variant);
      assert.equal(data.tripSaby?.trips[f.tripId], undefined, variant);
    }
    assert.equal(f.api.calls.length, 0); assert.deepEqual(f.kicked, []);
  } finally { await f.close(); }
});

test('post-departure preview and durable authority bind loading facts and stop a changed record before provider calls', async () => {
  const f = await fixture();
  try {
    await f.patch(); await recordDeparture(f); const ready = await f.preview();
    const data = await f.store.read(f.source), facts = data.etrn!.trips[f.tripId].loadingFacts!;
    // An additive metadata change leaves business facts consistent but invalidates the exact reviewed snapshot.
    Object.assign(facts, { syntheticAnnotation: 'changed after preview' });
    assert.throws(() => startAutomaticTripSaby({ base: f.base, data, tripId: f.tripId, actorId: f.actor.id, config: f.config, ...ready.start, prepare: integrationPrepare }), /изменились/);
    assert.equal((await f.http(f.path + '/start', 'POST', ready.start)).status, 202);
    await f.store.mutate(f.source, latest => { latest.etrn!.trips[f.tripId].loadingFacts!.deliveries[Object.keys(facts.deliveries)[0]].massMethod = '02'; return { result: null, changed: true }; });
    const dispatched = await dispatchTripSaby({ base: f.base, store: f.store, config: f.config, enabled: true, prepare: integrationPrepare, send: f.api.send, tripId: f.tripId });
    assert.equal(dispatched.continued, 0); assert.match((await f.preview()).automation.message, /Согласованные.*изменились/); assert.equal(f.api.calls.length, 0); assert.equal((await f.store.read(f.source)).tripSaby!.trips[f.tripId].reservationAttempted, false);
  } finally { await f.close(); }
});

test('new selected two-client driver trip keeps owners and map while draft, exact masses and regenerated Saby source reach one sender Execute', async () => {
  const f = await fixture(true);
  try {
    await f.patch(['8000', '9500']); await recordDeparture(f, ['6.745', '7.985']);
    const before = await f.store.read(f.source), ready = await f.preview();
    assert.equal(ready.ready, true, JSON.stringify(ready)); assert.equal(ready.start.mode, 'sign_and_send');
    assert.equal((await f.http(f.path + '/start', 'POST', ready.start)).status, 202);
    const queued = (await f.store.read(f.source)).tripSaby!.trips[f.tripId];
    assert.equal(queued.senderVerificationPolicy, 'address-multidelivery-v1');
    assert.equal(queued.snapshot.deliveries!.length, 2); assert.notEqual(queued.snapshot.deliveries![0].customer.inn, queued.snapshot.deliveries![1].customer.inn);
    const provider = pendingSender(f, bytes => {
      const xml = parseXml(bytes);
      const transform = (node: XmlNode) => {
        if (node.name === 'ОпГруз') node.children = node.children.filter(child => typeof child === 'string' || child.name !== 'ИнфПол');
        if (node.name === 'Коорд') { node.attributes.Широта = String(Number(node.attributes.Широта) + 0.004); node.attributes.Долгота = String(Number(node.attributes.Долгота) + 0.0001); }
        node.children.forEach(child => { if (typeof child !== 'string') transform(child); });
      };
      transform(xml); return encodeWindows1251('<?xml version="1.0" encoding="windows-1251"?>' + serializeXml(xml));
    });
    const dispatched = await dispatchTripSaby({ base: f.base, store: new OperationsStore(f.directory + '/store'), config: f.config, enabled: true, prepare: integrationPrepare, send: provider.send, tripId: f.tripId });
    assert.equal(dispatched.continued, 1); assert.equal(dispatched.failed, 0);
    const after = await f.store.read(f.source), record = after.tripSaby!.trips[f.tripId];
    assert.equal(record.senderVerificationPolicy, queued.senderVerificationPolicy); assert.equal(record.driverFlow!.state, 'ready');
    assert.equal(record.signing!.sender.executeAttempted, true, JSON.stringify(record.signing)); assert.equal(record.signing!.sender.preparedVerified, true); assert.equal(record.signing!.sender.state, 'waiting');
    assert.deepEqual(record.snapshot.deliveries!.map(row => row.fields.quantity_tonnes), ['6.745', '7.985']);
    assert.deepEqual(record.snapshot.deliveries!.map(row => row.fields.quantity_litres), ['8000', '9500']);
    assert.equal(record.snapshot.fields.quantity_tonnes, '14.73');
    assert.deepEqual(record.snapshot.customerOrganization, queued.snapshot.customerOrganization); assert.deepEqual(record.snapshot.carrierOrganization, queued.snapshot.carrierOrganization);
    assert.deepEqual(record.snapshot.supplier, queued.snapshot.supplier); assert.deepEqual(record.snapshot.loadingInfrastructureOwner, queued.snapshot.loadingInfrastructureOwner);
    for (const key of ['loading_site_owner_name', 'loading_site_owner_inn', 'loading_site_owner_address', 'loading_map_url', 'loading_latitude', 'loading_longitude']) assert.equal(record.snapshot.fields[key], queued.snapshot.fields[key]);
    assert.ok(before.shipments[queued.deliveries[0].shipmentId].fields.loading_map_url); assert.ok(record.snapshot.fields.loading_site_owner_inn);
    const decode = (request: IntegrationRpc) => new TextDecoder('windows-1251').decode(Buffer.from(String(((request.params.Документ.Вложение as SabyObject[])[0].Файл as SabyObject).ДвоичныеДанные), 'base64'));
    const draft = decode(f.api.writes('TransportOrder')[1]), massWrites = f.api.calls.filter(row => row.method === 'СБИС.ЗаписатьВложение');
    assert.doesNotMatch(draft, /МасНетЗнач|МасБрутЗнач/); assert.match(draft, /ИНН получателя доставки 2/);
    assert.equal(massWrites.length, 1); const finalXml = decode(massWrites[0]); assert.match(finalXml, /МасНетЗнач="6745"/); assert.match(finalXml, /МасНетЗнач="7985"/);
    assert.equal(f.api.reserves('TransportOrder').length, 1);
    assert.deepEqual(after.shipments, before.shipments); assert.deepEqual(after.driverTripProgress, before.driverTripProgress); assert.deepEqual(after.etrn, before.etrn);
    await dispatchTripSaby({ base: f.base, store: new OperationsStore(f.directory + '/store'), config: f.config, enabled: true, prepare: integrationPrepare, send: provider.send, tripId: f.tripId });
    assert.equal(provider.calls.filter(row => row.method === 'СБИС.ПодготовитьДействие').length, 1); assert.equal(provider.calls.filter(row => row.method === 'СБИС.ВыполнитьДействие').length, 1);
  } finally { await f.close(); }
});
