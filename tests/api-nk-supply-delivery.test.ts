import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { ApiError } from '../server/api-error';
import { saveUser } from '../server/auth';
import { createSnapshotMiddleware } from '../server/local-api';
import { OperationsStore } from '../server/operations-store';
import { currentSnapshot } from '../server/shipment-operations';
import { SabyClient } from '../server/saby-client';
import { getEtrnTrip, saveEtrnProfile, exchangeEtrn, exchangePreparedEtrn, preparedEtrnXml, downloadEtrnFile } from '../server/etrn-service';
import { continueEtrnDispatch } from '../server/etrn-dispatch';
import { getTripSigningPreview } from '../server/trip-saby-signing';
import { getSabyTrip, submitSabyTrip } from '../server/saby-service';
import { dispatchTripSaby } from '../server/trip-saby-scheduler';
import type { CreateTripSabyDelivery } from '../server/trip-saby-workflow';
import type { ShipmentTrip } from '../web/src/model';
import { integrationRuntime, integrationApi, integrationConfig, integrationPrepare, integrationSettings } from './helpers/trip-saby-integration';
import { syntheticLoadingDetails } from './helpers/loading-details-fixture';

async function fixture(organization = 'nk-artel', skips = [false, false]) {
  const rt = await integrationRuntime(), api = integrationApi(), config = integrationConfig();
  config.nkConsignmentSigner = { surname: 'НКПодписант', name: 'Тест', patronymic: '', position: 'Директор' };
  config.nkRegulatoryInstructions = 'Синтетические указания НК';
  config.login = 'synthetic-login'; config.password = 'synthetic-password'; config.accountNumber = 'artel-account'; config.carrierAccountNumber = 'nk-account';
  config.automaticSigning = { id: 'synthetic-supply-policy', enabled: true, mode: 'deferred', approvedAt: '2026-10-01T00:00:00.000Z', sender: { ...config.customer, thumbprint: 'ab'.repeat(20) }, carrier: { ...config.carrier, thumbprint: 'cd'.repeat(20) } };
  const tokens = { admin: randomBytes(32).toString('hex'), driver: randomBytes(32).toString('hex') };
  await rt.store.mutate(rt.source, async data => {
    const admin = await saveUser(data, currentSnapshot(rt.base, data), { name: 'Синтетический руководитель', login: 'supply-owner', password: randomUUID() }, undefined, true);
    const driverId = 'synthetic-supply-driver';
    data.accounts!.users.push({ id: driverId, login: 'supply-driver', name: 'Синтетический водитель', role: 'driver', driverId: 'driver', managerId: null, active: true, version: 1, sections: [], passwordHash: 'a'.repeat(128), salt: 'a'.repeat(32) });
    for (const [userId, token] of [[admin.id, tokens.admin], [driverId, tokens.driver]]) data.accounts!.sessions.push({ userId, hash: createHash('sha256').update(token).digest('hex'), expiresAt: Date.now() + 600_000 });
    const first = data.companies!.find(company => company.id === 'customer')!;
    data.companies!.push({ ...first, id: 'customer-two', name: 'Второй синтетический клиент', inn: '7736050003', kpp: '773601001' });
    const address = data.directories!.addresses.find(row => row.id === 'delivery')!;
    data.directories!.addresses.push({ ...address, id: 'delivery-two', companyId: 'customer-two', address: 'Второй полный синтетический адрес' });
    Object.assign(data.directories!.oilDepots[0], { latitude: '55.601', longitude: '37.601', mapUrl: 'https://yandex.ru/maps/?ll=37.601%2C55.601' });
    return { changed: true, result: null };
  });
  const kicked: string[] = [], network: string[] = [];
  const send: typeof fetch = async (url, init) => { network.push(String(url)); return api.send(url, init); };
  const previousSettings = process.env.SABY_AUTOFILL_PROFILE_JSON;
  process.env.SABY_AUTOFILL_PROFILE_JSON = JSON.stringify(integrationSettings);
  let server: Server, origin = '';
  const launch = async (store: OperationsStore) => {
    const middleware = createSnapshotMiddleware(rt.snapshotDirectory, { operationsStore: store, sabyClient: new SabyClient(config, send), requestSabyWorkflow: id => { kicked.push(id); }, sabyWorkflowMonitoringEnabled: true });
    server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end(); }));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };
  await launch(rt.store);
  const http = async (path: string, method = 'GET', input?: unknown, role: 'admin' | 'driver' | 'anonymous' = 'admin') => {
    const response = await fetch(origin + path, { method, headers: { 'Content-Type': 'application/json', ...(role === 'anonymous' ? {} : { Cookie: `artel_session=${tokens[role]}` }) }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    return { status: response.status, body: await response.json() };
  };
  const fields = Object.fromEntries(['supplier_id', 'carrier_id', 'oil_depot_id', 'product_id', 'purchase_price_unspecified_unit', 'driver_id', 'vehicle_id', 'additional_costs'].map(key => [key, rt.trip.fields[key]]));
  Object.assign(fields, { organization_id: organization, trip_flow_version: 'driver-v1', loading_at: '2027-02-03T09:15' });
  const customer = Object.fromEntries(['customer_id', 'manager_id', 'payment_form_id', 'sale_price_per_litre', 'transport_amount', 'unloading_address_id'].map(key => [key, rt.trip.customers[0].fields[key]]));
  const input = { fields, customers: [
    { fields: { ...customer, quantity_litres: '8000', etrn_not_required: String(skips[0]) } },
    { fields: { ...customer, customer_id: 'customer-two', unloading_address_id: 'delivery-two', quantity_litres: '9500', etrn_not_required: String(skips[1]) } },
  ], idempotencyKey: randomUUID() };
  const created = await http('/api/shipment-trips', 'POST', input);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const trip: ShipmentTrip = created.body.trip;
  if (organization === 'nk-artel') {
    const path = `/api/shipment-trips/${trip.id}/etrn/loading-details`;
    const current = await http(path);
    assert.equal(current.status, 200, JSON.stringify(current.body));
    assert.equal(current.body.required, false);
    assert.equal(current.body.mode, 'sender');
    assert.equal(current.body.loadingActor.inn, config.carrier.inn);
    assert.ok(current.body.infrastructureOwner.inn);
    assert.equal(current.body.details, null);
    assert.equal((await http(path, 'GET', undefined, 'anonymous')).status, 401);
    assert.equal((await http(path, 'GET', undefined, 'driver')).status, 403);
    const input = { version: current.body.version, details: syntheticLoadingDetails() };
    assert.equal((await http(path, 'PUT', input, 'driver')).status, 403);
    assert.deepEqual(network, []);
  }
  return {
    ...rt, trip, tripId: trip.id, config, api, send, network, kicked, http,
    restart: async () => { await new Promise<void>(resolve => server.close(() => resolve())); await launch(new OperationsStore(rt.directory + '/store')); },
    close: async () => {
      await new Promise<void>(resolve => server.close(() => resolve()));
      if (previousSettings === undefined) delete process.env.SABY_AUTOFILL_PROFILE_JSON; else process.env.SABY_AUTOFILL_PROFILE_JSON = previousSettings;
      await rt.close();
    },
  };
}
const isSupplyConflict = (error: unknown) => error instanceof ApiError && error.status === 409 && /прям|напрям/i.test(error.message);

test('new NK trip atomically queues direct ETRN after authenticated departure and survives restart without a TransportOrder', async () => {
  const f = await fixture();
  try {
    assert.notEqual(f.trip.customers[0].fields.customer_id, f.trip.customers[1].fields.customer_id);
    assert.deepEqual(f.trip.customers.map(row => row.fields.quantity_litres), ['8000', '9500']);
    assert.equal(f.trip.fields.organization_id, 'nk-artel');
    assert.equal(f.trip.fields.trip_document_policy, 'nk-direct-autostart-v1');
    assert.ok(f.trip.fields.loading_map_url);
    const savedDirectories = (await f.store.read(f.source)).directories;
    const depot = savedDirectories?.oilDepots.find(row => row.id === f.trip.fields.oil_depot_id);
    assert.equal(depot?.ownerCompanyId, 'supplier'); assert.equal(depot?.loadingActorCompanyId, 'supplier');
    const path = `/api/shipment-trips/${f.tripId}/saby-workflow`;
    const initial = await f.http(path); assert.equal(initial.status, 200);
    assert.equal(initial.body.documentMode, 'nk_direct_etrn'); assert.notEqual(initial.body.notRequired, true);
    assert.equal(initial.body.start, undefined); assert.equal(initial.body.signing, undefined);
    const driverPath = `/api/driver/trips/${f.tripId}`;
    const assigned = await f.http(driverPath, 'GET', undefined, 'driver'); assert.equal(assigned.status, 200);
    const arrived = await f.http(driverPath + '/arrive', 'POST', { versions: assigned.body.trip.versions }, 'driver');
    assert.equal(arrived.status, 200, JSON.stringify(arrived.body));
    const departed = await f.http(driverPath + '/depart', 'POST', { versions: arrived.body.trip.versions, masses: f.trip.customers.map((row, index) => ({ deliveryId: row.id, netTonnes: index ? '7,985' : '6,745' })) }, 'driver');
    assert.equal(departed.status, 200, JSON.stringify(departed.body));
    assert.deepEqual(departed.body.trip.deliveries.map((row: { netTonnes: string }) => row.netTonnes), ['6.745', '7.985']);
    assert.equal(departed.body.trip.etrnRequired, true);
    const beforeRestart = await f.store.read(f.source);
    assert.equal(beforeRestart.tripSaby?.trips[f.tripId], undefined); assert.equal(beforeRestart.saby?.trips[f.tripId], undefined);
    assert.equal(Object.values(beforeRestart.etrn?.trips[f.tripId]?.deliveries ?? {}).some(row => row.document), false);
    assert.equal(beforeRestart.etrn!.trips[f.tripId].directAutostart!.state, 'queued');
    assert.ok(beforeRestart.etrn!.trips[f.tripId].direct!.authorization.automatic);
    assert.deepEqual(f.kicked, [f.tripId]); assert.deepEqual(f.network, []);
    await f.restart();
    const after = await f.http(path); assert.equal(after.status, 200);
    assert.equal(after.body.documentMode, 'nk_direct_etrn'); assert.notEqual(after.body.notRequired, true);
    assert.ok(after.body.driverConfirmation.confirmedAt); assert.equal(after.body.signing, undefined);
    const readDriver = await f.http(driverPath, 'GET', undefined, 'driver'); assert.equal(readDriver.status, 200);
    assert.deepEqual(readDriver.body.trip.deliveries.map((row: { netTonnes: string }) => row.netTonnes), ['6.745', '7.985']);
    const result = await dispatchTripSaby({ base: f.base, store: new OperationsStore(f.directory + '/store'), config: f.config, enabled: false, send: f.send, prepare: integrationPrepare, tripId: f.tripId });
    assert.deepEqual(result, { continued: 0, refreshed: 0, denied: 0, failed: 0 });
    assert.deepEqual(f.network, []);
    const persisted = await f.store.read(f.source);
    assert.deepEqual(persisted.shipments, beforeRestart.shipments); assert.deepEqual(persisted.driverTripProgress, beforeRestart.driverTripProgress);
    assert.deepEqual(persisted.etrn, beforeRestart.etrn); assert.deepEqual(persisted.tripSaby, beforeRestart.tripSaby);
  } finally { await f.close(); }
});

test('legacy transport-document HTTP routes reject NK direct mode after normal access checks and before provider calls', async () => {
  const f = await fixture();
  try {
    const prefix = `/api/shipment-trips/${f.tripId}`, shipmentId = f.trip.customers[0].id;
    const signing = { requestId: randomUUID(), previewToken: 'a'.repeat(64), senderSignatureId: 'ab'.repeat(20), carrierSignatureId: 'cd'.repeat(20), confirmed: true };
    const routes: Array<[string, string, unknown?]> = [
      ['/saby', 'GET'], ['/saby', 'POST', {}], ['/etrn', 'PUT', { shipmentId, profile: {} }],
      ['/etrn/submit', 'POST', { shipmentId }], ['/etrn/refresh', 'POST', { shipmentId }],
      ['/saby-workflow', 'POST', {}],
      ['/saby-workflow/signing', 'GET'], ['/saby-workflow/signing/start', 'POST', signing], ['/saby-workflow/carrier-details', 'POST', {}],
    ];
    const before = await f.store.read(f.source);
    for (const [path, method, input] of routes) {
      const response = await f.http(prefix + path, method, input);
      assert.equal(response.status, 409, `${path}: ${JSON.stringify(response.body)}`);
      assert.match(response.body.error, /прям|напрям/i, path);
      const anonymous = await f.http(prefix + path, method, input, 'anonymous');
      assert.equal(anonymous.status, 401, path); assert.doesNotMatch(anonymous.body.error, /прям|напрям/i);
    }
    assert.equal((await f.http(prefix + '/saby', 'POST', {}, 'driver')).status, 403);
    for (const [path, expected] of [[`/etrn/xml/${shipmentId}`, 422], [`/etrn/files/${shipmentId}/${'a'.repeat(64)}`, 404]] as const) {
      assert.equal((await f.http(prefix + path)).status, expected, 'read route is allowed but missing artifact is not invented');
      assert.equal((await f.http(prefix + path, 'GET', undefined, 'anonymous')).status, 401);
    }
    const rejectedStart = await f.http(prefix + '/saby-workflow/start', 'POST', { mode: 'draft', previewToken: 'a'.repeat(64) });
    assert.ok([409, 422].includes(rejectedStart.status), 'direct route cannot start a draft or reuse a made-up preview');
    assert.deepEqual(f.network, []); assert.deepEqual(f.kicked, []);
    const after = await f.store.read(f.source);
    assert.deepEqual(after.tripSaby, before.tripSaby); assert.deepEqual(after.saby, before.saby); assert.deepEqual(after.etrn, before.etrn);
  } finally { await f.close(); }
});

test('direct Saby, ETRN and signing services apply the same supply guard without depending on credentials or existing preparation', async () => {
  const f = await fixture();
  try {
    let authorized = 0;
    const context = { base: f.base, store: f.store, tripId: f.tripId, authorize: () => { authorized++; }, client: new SabyClient({ ...f.config, sessionId: undefined }, f.send) };
    const shipmentId = f.trip.customers[0].id;
    const source = await f.store.read(f.source);
    assert.throws(() => getSabyTrip(f.base, source, f.tripId, context.client.config), isSupplyConflict);
    assert.ok(getEtrnTrip(f.base, source, f.tripId, context.client.config).deliveries.every(row => row.document === null));
    assert.throws(() => preparedEtrnXml(f.base, source, f.tripId, shipmentId, context.client.config), error => error instanceof ApiError && error.status === 422);
    // The mode guard must run before even requiring a prepared document.
    const delivery = { shipmentId } as CreateTripSabyDelivery;
    for (const action of [
      () => submitSabyTrip(context), () => saveEtrnProfile(context, shipmentId, {}), () => exchangeEtrn(context, shipmentId),
      () => exchangeEtrn(context, shipmentId, true), () => exchangePreparedEtrn(context, delivery),
      () => getTripSigningPreview(context),
    ]) {
      const before = authorized; await assert.rejects(action(), isSupplyConflict); assert.ok(authorized > before);
    }
    await assert.rejects(continueEtrnDispatch(context, shipmentId), error => error instanceof ApiError && error.status === 403);
    await assert.rejects(downloadEtrnFile(context, shipmentId, 'a'.repeat(64)), error => error instanceof ApiError && error.status === 404);
    const denied = { ...context, authorize: () => { throw new ApiError(403, 'Synthetic permission denied'); } };
    await assert.rejects(exchangeEtrn(denied, shipmentId), error => error instanceof ApiError && error.status === 403);
    assert.deepEqual(f.network, []);
  } finally { await f.close(); }
});

test('ARTEL and historical NK trips keep their existing transport flow instead of adopting direct mode', async () => {
  const artel = await fixture('artel');
  try {
    const state = await artel.store.read(artel.source), record = state.tripSaby?.trips[artel.tripId];
    assert.ok(record, 'New ARTEL trip keeps its automatic transport intent');
    assert.equal(record.scenario, 'artel_customer'); assert.deepEqual(artel.kicked, [artel.tripId]);
    const response = await artel.http(`/api/shipment-trips/${artel.tripId}/saby-workflow`);
    assert.equal(response.status, 200); assert.notEqual(response.body.documentMode, 'nk_direct_etrn'); assert.notEqual(response.body.notRequired, true);
    assert.equal(record.snapshot.customerOrganization.inn, artel.config.customer.inn);
  } finally { await artel.close(); }
  const historical = await fixture();
  try {
    await historical.store.mutate(historical.source, data => {
      for (const row of historical.trip.customers) delete data.shipments[row.id].fields.trip_document_policy;
      return { changed: true, result: null };
    });
    await historical.restart();
    const prefix = `/api/shipment-trips/${historical.tripId}`;
    const workflow = await historical.http(prefix + '/saby-workflow');
    assert.equal(workflow.status, 200); assert.notEqual(workflow.body.documentMode, 'nk_direct_etrn'); assert.notEqual(workflow.body.notRequired, true);
    assert.equal((await historical.http(prefix + '/saby')).status, 200);
    assert.equal((await historical.http(prefix + '/etrn')).status, 200);
    assert.deepEqual(historical.network, []);
  } finally { await historical.close(); }
});

for (const skips of [[false, false], [false, true], [true, false], [true, true]]) test(`concurrent authenticated departure persists one automatic grant and scheduling hint ${skips}`, async () => {
  const f = await fixture('nk-artel', skips);
  try {
    const before = await f.store.read(f.source), driverPath = `/api/driver/trips/${f.tripId}`, workflowPath = `/api/shipment-trips/${f.tripId}/saby-workflow`;
    assert.equal(before.etrn!.trips[f.tripId].directAutostart!.state, 'waiting_departure');
    assert.equal(before.etrn!.trips[f.tripId].direct, undefined);
    for (let count = 0; count < 2; count++) await f.http(workflowPath);
    await dispatchTripSaby({ ...f, enabled: true });
    assert.deepEqual((await f.store.read(f.source)).etrn, before.etrn);
    assert.deepEqual(f.kicked, []); assert.deepEqual(f.network, []);
    const assigned = await f.http(driverPath, 'GET', undefined, 'driver');
    assert.equal(assigned.body.trip.documentAutomation, 'after_driver_departure');
    const early = await f.http(driverPath + '/depart', 'POST', { versions: assigned.body.trip.versions, masses: f.trip.customers.map((row, index) => ({ deliveryId: row.id, netTonnes: index ? '7.985' : '6.745' })) }, 'driver');
    assert.equal(early.status, 409); assert.equal((await f.store.read(f.source)).etrn!.trips[f.tripId].direct, undefined);
    const arrived = await f.http(driverPath + '/arrive', 'POST', { versions: assigned.body.trip.versions }, 'driver');
    const payload = { versions: arrived.body.trip.versions, masses: f.trip.customers.map((row, index) => ({ deliveryId: row.id, netTonnes: index ? '7.985' : '6.745' })) };
    const responses = await Promise.all([f.http(driverPath + '/depart', 'POST', payload, 'driver'), f.http(driverPath + '/depart', 'POST', payload, 'driver')]);
    assert.ok(responses.every(result => result.status === 200), JSON.stringify(responses));
    const after = await f.store.read(f.source), saved = after.etrn!.trips[f.tripId];
    assert.equal(saved.directAutostart!.state, skips.every(Boolean) ? 'not_required' : 'queued');
    assert.equal(saved.direct?.deliveries.length ?? 0, skips.filter(value => !value).length);
    assert.deepEqual(f.kicked, skips.every(Boolean) ? [] : [f.tripId]);
    assert.deepEqual(f.network, []);
    const attempts = saved.direct?.attemptId;
    await f.restart();
    const replay = await f.http(driverPath + '/depart', 'POST', payload, 'driver');
    assert.equal(replay.status, 200); assert.equal((await f.store.read(f.source)).etrn!.trips[f.tripId].direct?.attemptId, attempts);
    assert.deepEqual(f.kicked, skips.every(Boolean) ? [] : [f.tripId]);
    assert.deepEqual((await f.store.read(f.source)).driverTripProgress, after.driverTripProgress);
  } finally { await f.close(); }
});

for (const change of ['policy', 'creator', 'source'] as const) test(`blocked ${change} preserves driver facts and never grants on replay, GET or scheduler scan`, async () => {
  const f = await fixture();
  try {
    const driverPath = `/api/driver/trips/${f.tripId}`, workflowPath = `/api/shipment-trips/${f.tripId}/saby-workflow`;
    const assigned = await f.http(driverPath, 'GET', undefined, 'driver');
    const arrived = await f.http(driverPath + '/arrive', 'POST', { versions: assigned.body.trip.versions }, 'driver');
    if (change === 'policy') f.config.automaticSigning!.approvedAt = '2026-10-19T00:00:00Z';
    else await f.store.mutate(f.source, data => {
      if (change === 'source') data.etrn!.trips[f.tripId].directAutostart!.sourceHash = 'f'.repeat(64);
      else {
        const creator = data.accounts!.users.find(row => row.id === data.etrn!.trips[f.tripId].directAutostart!.actorId)!;
        data.accounts!.users.push({ ...creator, id: 'backup-director', login: 'backup-director' }); creator.active = false;
      }
      return { changed: true, result: undefined };
    });
    const payload = { versions: arrived.body.trip.versions, masses: f.trip.customers.map((row, index) => ({ deliveryId: row.id, netTonnes: index ? '7.985' : '6.745' })) };
    const departed = await f.http(driverPath + '/depart', 'POST', payload, 'driver');
    assert.equal(departed.status, 200, JSON.stringify(departed.body));
    const saved = await f.store.read(f.source);
    assert.equal(saved.etrn!.trips[f.tripId].directAutostart!.state, 'blocked'); assert.ok(saved.etrn!.trips[f.tripId].directAutostart!.lastError);
    assert.ok(saved.driverTripProgress![f.tripId].departedAt); assert.equal(saved.etrn!.trips[f.tripId].direct, undefined);
    if (change === 'policy') f.config.automaticSigning!.approvedAt = '2026-10-01T00:00:00.000Z';
    await f.restart(); await f.http(workflowPath); await f.http(driverPath + '/depart', 'POST', payload, 'driver');
    await dispatchTripSaby({ ...f, enabled: true });
    const after = await f.store.read(f.source);
    assert.deepEqual(after.etrn, saved.etrn); assert.deepEqual(after.driverTripProgress, saved.driverTripProgress);
    assert.deepEqual(f.kicked, []); assert.deepEqual(f.network, []);
  } finally { await f.close(); }
});

test('legacy direct departure and read paths do not enroll historical trips', async () => {
  const f = await fixture();
  try {
    await f.store.mutate(f.source, data => {
      delete data.etrn!.trips[f.tripId].directAutostart;
      for (const row of f.trip.customers) data.shipments[row.id].fields.trip_document_policy = 'nk-direct-etrn-v1';
      return { changed: true, result: undefined };
    });
    const driverPath = `/api/driver/trips/${f.tripId}`;
    const assigned = await f.http(driverPath, 'GET', undefined, 'driver');
    const arrived = await f.http(driverPath + '/arrive', 'POST', { versions: assigned.body.trip.versions }, 'driver');
    const departed = await f.http(driverPath + '/depart', 'POST', { versions: arrived.body.trip.versions, masses: f.trip.customers.map((row, index) => ({ deliveryId: row.id, netTonnes: index ? '7.985' : '6.745' })) }, 'driver');
    assert.equal(departed.status, 200);
    await f.http(`/api/shipment-trips/${f.tripId}/saby-workflow`); await dispatchTripSaby({ ...f, enabled: true });
    const saved = await f.store.read(f.source);
    assert.equal(saved.etrn!.trips[f.tripId].directAutostart, undefined); assert.equal(saved.etrn!.trips[f.tripId].direct, undefined);
    assert.equal(departed.body.trip.documentAutomation, undefined); assert.deepEqual(f.kicked, []); assert.deepEqual(f.network, []);
  } finally { await f.close(); }
});
