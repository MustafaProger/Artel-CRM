import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolve } from 'node:path';
import test from 'node:test';
import { createSnapshotMiddleware } from '../server/local-api';
import { currentSnapshot } from '../server/shipment-operations';
import { getShipmentTrip, saveShipmentTrip } from '../server/shipment-trips';
import { OperationsStore, decodeOperations, encodeOperations } from '../server/operations-store';
import { readDriverTrips } from '../server/driver-trips';
import { dispatchTripSaby } from '../server/trip-saby-scheduler';
import { enqueueAutomaticTripSaby, getTripSabyWorkflow, runTripSabyWorkflow } from '../server/trip-saby-workflow';
import { assertTripTransportDocumentsAllowed, hasTripTransportHistory, isNkSupplyDelivery, TRIP_DOCUMENT_POLICY_VERSION } from '../server/trip-document-mode';
import { integrationApi, integrationRuntime } from './helpers/trip-saby-integration';
import type { AccountUser } from '../web/src/auth-model';
import type { ShipmentTrip } from '../web/src/model';

async function fixture(organization = 'nk-artel', excluded = [false, false]) {
  const rt = await integrationRuntime(), provider = integrationApi(), client = provider.client();
  client.config.automaticSigning = { id: 'synthetic-supply-policy', enabled: true, mode: 'deferred', approvedAt: '2026-01-01T00:00:00.000Z', sender: { ...client.config.customer, thumbprint: 'ab'.repeat(20) }, carrier: { ...client.config.carrier, thumbprint: 'cd'.repeat(20) } };
  const input = {
    fields: { organization_id: organization, trip_flow_version: 'driver-v1', loading_at: '2027-02-03T09:15', supplier_id: 'supplier', carrier_id: 'carrier', oil_depot_id: 'depot', product_id: 'product', purchase_price_unspecified_unit: '50000', driver_id: 'driver', vehicle_id: 'vehicle', additional_costs: '100' },
    customers: [0, 1].map(index => ({ fields: { customer_id: index ? 'customer-two' : 'customer', manager_id: 'manager', payment_form_id: 'payment', quantity_litres: index ? '9500' : '8000', sale_price_per_litre: '60', transport_amount: '1000', unloading_address_id: index ? 'delivery-two' : 'delivery', etrn_not_required: String(excluded[index]), invoice_not_required: String(index === 0) } })),
  };
  const created = await rt.store.mutate(rt.source, data => {
    data.companies.push({ ...data.companies.find(row => row.id === 'customer')!, id: 'customer-two', name: 'Второй синтетический клиент', inn: '7702070139', kpp: '770201001' });
    data.directories!.addresses.push({ ...data.directories!.addresses.find(row => row.id === 'delivery')!, id: 'delivery-two', companyId: 'customer-two', name: 'Вторая точка', address: 'Синтетическая вторая точка' });
    return { result: saveShipmentTrip(rt.base, data, { ...input, idempotencyKey: randomUUID() }), changed: true };
  });
  const middleware = createSnapshotMiddleware(rt.snapshotDirectory, { operationsStore: rt.store, sabyClient: client, sabyWorkflowMonitoringEnabled: true });
  const server = createServer((request, response) => middleware(request, response, () => { response.writeHead(404); response.end(); }));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = async (path: string, method = 'GET', data?: unknown, cookie?: string) => {
    const response = await fetch(origin + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    const text = await response.text();
    return { status: response.status, body: JSON.parse(text), text, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const owner = await request('/api/auth/setup', 'POST', { name: 'Синтетический директор', login: 'supply-owner', password: randomUUID() });
  const access = await request('/api/drivers/driver/access', 'POST', { version: 0, action: 'issue' }, owner.cookie);
  assert.equal(access.status, 200, access.text);
  const driver = await request('/api/auth/login', 'POST', { login: access.body.access.login, password: access.body.temporaryPassword });
  assert.equal(driver.status, 200, driver.text);
  return { ...rt, input, created, provider, client, request, actor: driver.body.user as AccountUser, cookie: driver.cookie!, adminCookie: owner.cookie!,
    async close() { await new Promise<void>(done => server.close(() => done())); await rt.close(); } };
}

function editBody(trip: ShipmentTrip, organization = trip.fields.organization_id) {
  const fields = { ...trip.fields, organization_id: organization };
  for (const key of ['quantity_tonnes', 'quantity_gross_tonnes', 'loading_actual_at']) delete fields[key];
  const customers = trip.customers.map(row => {
    const fields = { ...row.fields };
    delete fields.quantity_tonnes; delete fields.quantity_gross_tonnes;
    return { id: row.id, fields };
  });
  return { fields, customers, versions: Object.fromEntries(trip.customers.map(row => [row.id, row.version])) };
}

test('new NK direct ETRN keeps two clients and exact driver masses, stays active pending explicit direct authorization across restart', async () => {
  const f = await fixture();
  try {
    const tripId = f.created.trip.id, path = `/api/shipment-trips/${tripId}`, driverPath = `/api/driver/trips/${tripId}`;
    assert.equal(f.created.trip.fields.trip_document_policy, TRIP_DOCUMENT_POLICY_VERSION);
    assert.deepEqual(f.created.shipments.map(row => row.fields.customer_id), ['customer', 'customer-two']);
    const originalFlags = f.created.shipments.map(row => row.fields.etrn_not_required);
    const workflow = await f.request(`${path}/saby-workflow`, 'GET', undefined, f.adminCookie);
    assert.equal(workflow.status, 200, workflow.text);
    assert.equal(workflow.body.documentMode, 'nk_direct_etrn'); assert.notEqual(workflow.body.notRequired, true);
    assert.deepEqual(workflow.body.parties, { sender: f.client.config.carrier.name, carrier: f.client.config.carrier.name });
    assert.equal(workflow.body.order, null); assert.equal(workflow.body.start, undefined); assert.equal(workflow.body.signing, undefined);
    assert.ok(['preparation', 'awaiting_driver'].includes(workflow.body.phase)); assert.equal(workflow.body.status, 'error');
    assert.equal(workflow.body.ready, false);
    assert.ok(workflow.body.blockers.some((message: string) => /подписанта НК/.test(message)), 'Missing direct NK signer must remain an explicit blocker');
    assert.ok(workflow.body.deliveries.every((delivery: { status: string }) => delivery.status === 'not_sent'), 'Preparation error does not imply a provider submission');
    assert.equal(workflow.body.monitoring.enabled, false); assert.equal(workflow.body.automation.enrolled, false);
    for (const [suffix, method, payload] of [
      ['/saby-workflow', 'POST', {}], ['/saby-workflow/carrier-details', 'POST', {}],
      ['/saby-workflow/signing', 'GET', undefined],
      ['/saby', 'GET', undefined], ['/saby', 'POST', {}], ['/etrn', 'PUT', { shipmentId: f.created.trip.customers[0].id, profile: {} }],
      ['/etrn/submit', 'POST', { shipmentId: f.created.trip.customers[0].id }],
    ] as const) {
      const result = await f.request(path + suffix, method, payload, f.adminCookie);
      assert.equal(result.status, 409, `${suffix}: ${result.text}`);
    }
    await f.store.mutate(f.source, data => {
      const queued = enqueueAutomaticTripSaby({ base: f.base, data, tripId, actorId: 'unused', config: f.client.config, prepare: () => { throw new Error('Own supply must not prepare transport documents'); } });
      assert.deepEqual(queued, { enqueued: false, blockers: [] });
      return { result: null, changed: false };
    });
    const trip = (await f.request(driverPath, 'GET', undefined, f.cookie)).body.trip;
    assert.equal(trip.deliveries.length, 2); assert.equal(trip.etrnRequired, true); assert.equal(trip.archived, false);
    const arrival = await f.request(`${driverPath}/arrive`, 'POST', { versions: trip.versions }, f.cookie);
    assert.equal(arrival.status, 200, arrival.text); assert.equal(arrival.body.trip.archived, false);
    const masses = trip.deliveries.map((row: { id: string }, index: number) => ({ deliveryId: row.id, netTonnes: index ? '7,985' : '6,745' }));
    const departure = await f.request(`${driverPath}/depart`, 'POST', { versions: trip.versions, masses }, f.cookie);
    assert.equal(departure.status, 200, departure.text); assert.equal(departure.body.trip.archived, false);
    assert.deepEqual(departure.body.trip.deliveries.map((row: { netTonnes: string }) => row.netTonnes), ['6.745', '7.985']);
    const saved = await f.store.read(f.source);
    assert.equal(saved.tripSaby?.trips[tripId], undefined); assert.equal(saved.saby?.trips[tripId], undefined);
    assert.deepEqual(saved.etrn!.trips[tripId].deliveries, {});
    assert.equal(Object.keys(saved.etrn!.trips[tripId].loadingFacts!.deliveries).length, 2);
    assert.deepEqual(f.created.shipments.map(row => saved.shipments[row.id].fields.etrn_not_required), originalFlags);
    assert.ok(f.created.shipments.every(row => saved.shipments[row.id].fields.trip_total_tonnes === '14.73'));
    assert.equal(hasTripTransportHistory(saved, tripId), false, 'local driver facts are not external attempts');
    const restarted = new OperationsStore(resolve(f.directory, 'store')), restored = await restarted.read(f.source);
    assert.equal(encodeOperations(restored), encodeOperations(saved));
    const restoredTrip = getShipmentTrip(currentSnapshot(f.base, restored), tripId);
    assert.equal(isNkSupplyDelivery(restoredTrip, restored), true);
    assert.equal(readDriverTrips(currentSnapshot(f.base, restored), f.actor, tripId, '', restored).trip?.archived, false);
    assert.equal(getTripSabyWorkflow({ base: f.base, data: restored, tripId, config: f.client.config, prepare: f.prepare }).documentMode, 'nk_direct_etrn');
    await dispatchTripSaby({ base: f.base, store: restarted, config: f.client.config, client: f.client, enabled: true });
    const replay = await f.request(`${driverPath}/depart`, 'POST', { versions: trip.versions, masses }, f.cookie);
    assert.equal(replay.status, 200, replay.text);
    assert.equal(encodeOperations(await f.store.read(f.source)), encodeOperations(saved), 'repeated departure is read-only');
    assert.equal(f.provider.calls.length, 0, 'no auth, Prepare, Execute, Write or other provider request');
  } finally { await f.close(); }
});

test('document policy is server assigned, immutable and retained when a new trip switches organization; old rows never gain it', async () => {
  const f = await fixture('artel');
  try {
    const saved = await f.store.read(f.source);
    assert.equal(isNkSupplyDelivery(f.created.trip, saved), false);
    assert.equal(f.created.trip.fields.trip_document_policy, TRIP_DOCUMENT_POLICY_VERSION);
    await assert.rejects(f.store.mutate(f.source, data => ({ result: saveShipmentTrip(f.base, data, { ...f.input, fields: { ...f.input.fields, trip_document_policy: TRIP_DOCUMENT_POLICY_VERSION } }), changed: true })), /назначается сервером/);
    const changed = await f.store.mutate(f.source, data => ({ result: saveShipmentTrip(f.base, data, editBody(f.created.trip, 'nk-artel'), f.created.trip.id), changed: true }));
    assert.equal(isNkSupplyDelivery(changed.trip, await f.store.read(f.source)), true);
    const bad = editBody(changed.trip); bad.fields.trip_document_policy = 'future';
    await assert.rejects(f.store.mutate(f.source, data => ({ result: saveShipmentTrip(f.base, data, bad, changed.trip.id), changed: true })), /назначается сервером/);
    await f.store.mutate(f.source, data => {
      for (const row of changed.shipments) delete data.shipments[row.id].fields.trip_document_policy;
      return { result: null, changed: true };
    });
    const old = await f.store.read(f.source), historical = getShipmentTrip(currentSnapshot(f.base, old), changed.trip.id);
    assert.equal(historical.fields.trip_document_policy, undefined); assert.equal(isNkSupplyDelivery(historical, old), false);
    const edited = await f.store.mutate(f.source, data => ({ result: saveShipmentTrip(f.base, data, editBody(historical), historical.id), changed: true }));
    assert.ok(edited.shipments.every(row => row.fields.trip_document_policy === undefined));
    assert.equal(getTripSabyWorkflow({ base: f.base, data: await f.store.read(f.source), tripId: historical.id, prepare: f.prepare, config: f.client.config }).documentMode, undefined);
    const invalid = structuredClone(saved);
    for (const row of f.created.shipments) invalid.shipments[row.id].fields.trip_document_policy = 'future';
    assert.throws(() => currentSnapshot(f.base, invalid), /Invalid trip document policy/);
    assert.throws(() => encodeOperations(invalid), /Invalid trip document policy/);
    assert.throws(() => decodeOperations(JSON.stringify({ data: invalid, sha256: createHash('sha256').update(JSON.stringify(invalid)).digest('hex') }), f.source), /damaged/);
    const persisted = decodeOperations(encodeOperations(await f.store.read(f.source)), f.source);
    assert.ok(edited.shipments.every(row => persisted.shipments[row.id].fields.trip_document_policy === undefined));
    assert.equal(f.provider.calls.length, 0);
  } finally { await f.close(); }
});

test('a historical started NK workflow retains exact old state and is never treated as a new direct ETRN', async () => {
  const f = await fixture();
  try {
    const tripId = f.created.trip.id;
    await f.store.mutate(f.source, data => {
      for (const row of f.created.shipments) delete data.shipments[row.id].fields.trip_document_policy;
      return { result: null, changed: true };
    });
    const result = await runTripSabyWorkflow({ base: f.base, store: f.store, tripId, authorize: f.authorize, client: f.client, prepare: f.prepare, createDelivery: async () => { throw new Error('No driver facts'); } });
    assert.equal(result.phase, 'awaiting_driver');
    const saved = await f.store.read(f.source), raw = encodeOperations(saved), historical = getShipmentTrip(currentSnapshot(f.base, saved), tripId);
    assert.equal(isNkSupplyDelivery(historical, saved), false); assert.equal(hasTripTransportHistory(saved, tripId), true);
    assert.doesNotThrow(() => assertTripTransportDocumentsAllowed(historical, saved));
    assert.equal(getTripSabyWorkflow({ base: f.base, data: saved, tripId, config: f.client.config, prepare: f.prepare }).documentMode, undefined);
    assert.equal(encodeOperations(saved), raw, 'read projection preserves historical snapshot, attempts and masses');
    // Even a policy-marked trip cannot override previously started external work.
    const marked = { ...historical, fields: { ...historical.fields, trip_document_policy: TRIP_DOCUMENT_POLICY_VERSION } };
    assert.equal(isNkSupplyDelivery(marked, saved), false);
    await assert.rejects(f.store.mutate(f.source, data => ({ result: saveShipmentTrip(f.base, data, editBody(historical, 'artel'), tripId), changed: true })), /сохранён в Saby/);
  } finally { await f.close(); }
});

test('failed idless legacy Saby and ETRN attempts take precedence over supply policy while local profiles and facts do not', async () => {
  const f = await fixture();
  try {
    const data = await f.store.read(f.source), tripId = f.created.trip.id, trip = f.created.trip;
    const prepared = f.prepare(currentSnapshot(f.base, data), data, trip, f.client.config);
    const stamp = '2027-02-03T10:00:00.000Z', delivery = prepared.deliveries[0];
    const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const local = structuredClone(data);
    local.etrn = { trips: { [tripId]: {
      updatedAt: stamp,
      loadingFacts: { arrivedAt: '2027-02-03T09:00', departedAt: '2027-02-03T10:00', recordedAt: stamp, actorId: f.actor.id, deliveries: Object.fromEntries(trip.customers.map((row, i) => [row.id, { grossMassTonnes: i ? '7.985' : '6.745', massMethod: '03' }])) },
      deliveries: { [delivery.shipmentId]: { profile: delivery.snapshot.profile, snapshot: delivery.snapshot, preparedHash: digest(delivery.snapshot), document: null, updatedAt: stamp } },
    } } };
    assert.equal(hasTripTransportHistory(local, tripId), false);
    assert.equal(isNkSupplyDelivery(trip, local), true);
    const localBytes = encodeOperations(local);
    assert.throws(() => assertTripTransportDocumentsAllowed(trip, local), /напрям/);
    assert.equal(encodeOperations(local), localBytes);
    const sabyFailed = structuredClone(local);
    sabyFailed.saby = { trips: { [tripId]: { leaseId: null, leaseUntil: null, updatedAt: stamp, documents: [{
      shipmentId: tripId, id: null, revision: null, status: 'error', url: null, remoteStatus: null, lastError: 'Synthetic failed attempt', updatedAt: stamp,
      marker: 'ARTEL-CRM:SYNTHETIC-FAILED', payloadHash: digest(prepared.order), snapshot: prepared.order, createdAt: stamp, attemptId: randomUUID(),
    }] } } };
    const etrnFailed = structuredClone(local);
    etrnFailed.etrn!.trips[tripId].deliveries[delivery.shipmentId].document = {
      id: null, revision: null, status: 'error', url: null, remoteStatus: null, lastError: 'Synthetic failed attempt', updatedAt: stamp,
      gisStatus: null, signatureStatus: 'unknown', availableActions: [], marker: 'ARTEL-CRM:ETRN:SYNTHETIC-FAILED', attemptId: randomUUID(),
      createdAt: stamp, payloadHash: digest(delivery.snapshot), snapshot: delivery.snapshot, artifacts: [], leaseId: null, leaseUntil: null,
    };
    for (const previous of [sabyFailed, etrnFailed]) {
      const bytes = encodeOperations(previous);
      const restarted = decodeOperations(bytes, f.source);
      assert.equal(hasTripTransportHistory(restarted, tripId), true);
      assert.equal(isNkSupplyDelivery(trip, restarted), false);
      assert.doesNotThrow(() => assertTripTransportDocumentsAllowed(trip, restarted));
      assert.throws(() => saveShipmentTrip(f.base, restarted, editBody(trip, 'artel'), tripId), /сохранён в Saby/);
      assert.equal(encodeOperations(previous), bytes, 'history classification never mutates failed attempts or masses');
    }
    assert.equal(f.provider.calls.length, 0);
  } finally { await f.close(); }
});

for (const excluded of [[false, true], [true, false], [true, true]]) test(`direct NK filters ETRN per delivery (${excluded.join(',')}) and preserves every mass and independent invoice flag`, async () => {
  const f = await fixture('nk-artel', excluded);
  try {
    const id = f.created.trip.id, driverPath = `/api/driver/trips/${id}`;
    const initial = (await f.request(driverPath, 'GET', undefined, f.cookie)).body.trip;
    const arrival = await f.request(`${driverPath}/arrive`, 'POST', { versions: initial.versions }, f.cookie);
    assert.equal(arrival.status, 200, arrival.text);
    const departure = await f.request(`${driverPath}/depart`, 'POST', { versions: initial.versions, masses: f.created.trip.customers.map((row, index) => ({ deliveryId: row.id, netTonnes: index ? '7.985' : '6.745' })) }, f.cookie);
    assert.equal(departure.status, 200, departure.text);
    const required = f.created.trip.customers.filter((_, index) => !excluded[index]);
    assert.equal(departure.body.trip.etrnRequired, required.length > 0);
    assert.equal(departure.body.trip.archived, false, 'departure never completes physical deliveries, including trips without ETRN');
    assert.deepEqual(departure.body.trip.deliveries.map((row: { netTonnes: string }) => row.netTonnes), ['6.745', '7.985']);
    const saved = await f.store.read(f.source);
    const before = encodeOperations(saved);
    const response = getTripSabyWorkflow({ base: f.base, data: saved, tripId: id, prepare: f.prepare, config: f.client.config });
    assert.equal(response.documentMode, 'nk_direct_etrn');
    assert.equal(response.notRequired === true, required.length === 0);
    assert.deepEqual(response.deliveries.map(row => row.shipmentId), required.map(row => row.id));
    assert.deepEqual(f.created.trip.customers.map(row => saved.shipments[row.id].fields.invoice_not_required), ['true', 'false']);
    assert.deepEqual(Object.keys(saved.etrn!.trips[id].loadingFacts!.deliveries), f.created.trip.customers.map(row => row.id));
    assert.equal(encodeOperations(saved), before, 'projection is read only');
    let current = departure.body.trip;
    for (const [index, delivery] of f.created.trip.customers.entries()) {
      const delivered = await f.request(`${driverPath}/deliver`, 'POST', { versions: current.versions, executionVersion: current.execution.version, deliveryId: delivery.id }, f.cookie);
      assert.equal(delivered.status, 200, delivered.text);
      current = delivered.body.trip;
      assert.equal(current.archived, index === f.created.trip.customers.length - 1, 'only the last physical delivery archives the trip');
      assert.equal(current.execution.deliveries[delivery.id].role, 'driver');
    }
    const completed = await f.store.read(f.source);
    assert.deepEqual(completed.etrn, saved.etrn, 'physical completion does not create or change electronic documents or loading facts');
    assert.deepEqual(completed.shipments, saved.shipments, 'physical completion preserves masses, invoice flags and ETRN exclusions');
    assert.equal(f.provider.calls.length, 0, 'save, departure, projection and physical completion never authorize direct signing');
  } finally { await f.close(); }
});

test('existing supply-delivery-v1 trip with driver departure adopts direct projection without changing the saved facts or policy', async () => {
  const f = await fixture();
  try {
    const id = f.created.trip.id, driverPath = `/api/driver/trips/${id}`;
    await f.store.mutate(f.source, data => {
      for (const row of f.created.trip.customers) data.shipments[row.id].fields.trip_document_policy = 'supply-delivery-v1';
      return { changed: true, result: null };
    });
    const initial = (await f.request(driverPath, 'GET', undefined, f.cookie)).body.trip;
    await f.request(`${driverPath}/arrive`, 'POST', { versions: initial.versions }, f.cookie);
    const departure = await f.request(`${driverPath}/depart`, 'POST', { versions: initial.versions, masses: f.created.trip.customers.map((row, index) => ({ deliveryId: row.id, netTonnes: index ? '7.985' : '6.745' })) }, f.cookie);
    assert.equal(departure.status, 200, departure.text);
    const before = await f.store.read(f.source), bytes = encodeOperations(before);
    const restarted = decodeOperations(bytes, f.source);
    const trip = getShipmentTrip(currentSnapshot(f.base, restarted), id);
    assert.equal(trip.fields.trip_document_policy, 'supply-delivery-v1');
    assert.equal(isNkSupplyDelivery(trip, restarted), true);
    assert.equal(getTripSabyWorkflow({ base: f.base, data: restarted, tripId: id, prepare: f.prepare, config: f.client.config }).documentMode, 'nk_direct_etrn');
    assert.equal(readDriverTrips(currentSnapshot(f.base, restarted), f.actor, id, '', restarted).trip?.archived, false);
    assert.equal(encodeOperations(restarted), bytes, 'no migration or reset of confirmed driver facts');
    assert.equal(f.provider.calls.length, 0);
  } finally { await f.close(); }
});
