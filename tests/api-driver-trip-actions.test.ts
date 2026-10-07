import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { createSnapshotMiddleware } from '../server/local-api';
import { currentSnapshot } from '../server/shipment-operations';
import { getShipmentTrip, saveShipmentTrip } from '../server/shipment-trips';
import { prepareTripSaby } from '../server/trip-saby-preparation';
import { readDriverTrips, recordDriverTripAction } from '../server/driver-trips';
import { integrationRuntime, integrationApi, integrationSettings } from './helpers/trip-saby-integration';
import type { AccountUser } from '../web/src/auth-model';

async function fixture(automatic = false) {
  const rt = await integrationRuntime(), provider = integrationApi();
  const created = await rt.store.mutate(rt.source, data => {
    data.directories!.addresses.push({ ...data.directories!.addresses.find(row => row.id === 'delivery')!, id: 'delivery-two', name: 'Вторая точка', address: 'Синтетическая вторая точка' });
    const fields = Object.fromEntries(['organization_id', 'supplier_id', 'carrier_id', 'oil_depot_id', 'product_id', 'purchase_price_unspecified_unit', 'driver_id', 'vehicle_id', 'additional_costs'].map(key => [key, rt.trip.fields[key]]));
    Object.assign(fields, { trip_flow_version: 'driver-v1', loading_at: '2027-02-03T09:15', additional_costs: '100' });
    const customers = rt.trip.customers.map((row, index) => ({ fields: { ...Object.fromEntries(['customer_id', 'manager_id', 'payment_form_id', 'quantity_litres', 'sale_price_per_litre', 'transport_amount'].map(key => [key, row.fields[key]])), unloading_address_id: index ? 'delivery-two' : 'delivery' } }));
    return { result: saveShipmentTrip(rt.base, data, { fields, customers, idempotencyKey: randomUUID() }), changed: true };
  });
  const client = provider.client();
  if (automatic) client.config.automaticSigning = { id: 'synthetic-actions-policy', enabled: true, mode: 'deferred', approvedAt: '2026-01-01T00:00:00.000Z', sender: { ...client.config.customer, thumbprint: 'ab'.repeat(20) }, carrier: { ...client.config.carrier, thumbprint: 'cd'.repeat(20) } };
  const middleware = createSnapshotMiddleware(rt.snapshotDirectory, { operationsStore: rt.store, sabyClient: client, sabyWorkflowMonitoringEnabled: false });
  const server = createServer((request, response) => middleware(request, response, () => { response.writeHead(404); response.end(); }));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = async (path: string, method = 'GET', data?: unknown, cookie?: string) => {
    const response = await fetch(origin + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    const text = await response.text();
    return { status: response.status, body: JSON.parse(text), text, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const owner = await request('/api/auth/setup', 'POST', { name: 'Синтетический директор', login: 'actions-owner', password: randomUUID() });
  const access = await request('/api/drivers/driver/access', 'POST', { version: 0, action: 'issue' }, owner.cookie);
  assert.equal(access.status, 200, access.text);
  const driver = await request('/api/auth/login', 'POST', { login: access.body.access.login, password: access.body.temporaryPassword });
  assert.equal(driver.status, 200, driver.text);
  const path = `/api/driver/trips/${created.trip.id}`;
  return { ...rt, provider, client, created, request, path, actor: driver.body.user as AccountUser, cookie: driver.cookie!, adminCookie: owner.cookie!,
    read: () => request(path, 'GET', undefined, driver.cookie),
    action: (name: 'arrive' | 'depart', body: unknown) => request(`${path}/${name}`, 'POST', body, driver.cookie),
    async close() { await new Promise<void>(done => server.close(() => done())); await rt.close(); } };
}

test('driver-v1 creates immediate accounting without mass, future plan only and isolated driver projection', async () => {
  const f = await fixture();
  try {
    const original = f.created.shipments;
    assert.equal(original.length, 2);
    assert.equal(f.created.trip.fields.quantity_tonnes, null);
    for (const row of original) {
      assert.equal(row.date, '2027-02-03'); assert.equal(row.fields.loading_planned_at, '2027-02-03T09:15');
      for (const key of ['quantity_tonnes', 'quantity_gross_tonnes', 'purchase_amount', 'sale_price_per_tonne', 'profit_source', 'loading_actual_at', 'unloading_planned_at', 'unloading_actual_at']) assert.equal(row.fields[key], null, key);
      assert.ok(Number(row.revenue) > 0); assert.ok(Number(row.liters) > 0);
    }
    const result = await f.read(); assert.equal(result.status, 200);
    assert.equal(result.body.trip.flowVersion, 'driver-v1'); assert.equal(result.body.trip.archived, false);
    assert.equal(result.body.trip.loadingPlannedAt, null); assert.equal(result.body.trip.arrivedAt, null);
    assert.doesNotMatch(result.text, /purchase|sale_price|profit|bank|certificate|password|manager|60000/);
    assert.equal(result.body.trip.deliveries.length, 2);
    assert.notEqual(result.body.trip.deliveries[0].id, result.body.trip.deliveries[1].id);
    assert.notEqual(result.body.trip.deliveries[0].address, result.body.trip.deliveries[1].address);
    assert.equal((await f.request(`${f.path}/arrive`, 'POST', { versions: result.body.trip.versions }, f.adminCookie)).status, 403);
    assert.equal(f.provider.calls.length, 0);
  } finally { await f.close(); }
});

test('editing an existing unlinked trip never enrolls it under a newly enabled automatic policy', async () => {
  const f = await fixture(true);
  const previousProfile = process.env.SABY_AUTOFILL_PROFILE_JSON;
  process.env.SABY_AUTOFILL_PROFILE_JSON = JSON.stringify(integrationSettings);
  try {
    for (const tripId of [f.created.trip.id, f.tripId]) {
      const before = await f.store.read(f.source), snapshot = currentSnapshot(f.base, before);
      const trip = getShipmentTrip(snapshot, tripId);
      assert.deepEqual(prepareTripSaby(snapshot, before, trip, f.client.config).blockers, [], 'the edit would otherwise be eligible for automatic exchange');
      const fields: typeof trip.fields = { ...trip.fields, loading_at: '2028-03-04T10:30', trip_notes: 'Изменение учёта без отправки' };
      for (const key of ['loading_address', 'loading_map_url', 'loading_latitude', 'loading_longitude']) delete fields[key];
      if (fields.trip_flow_version === 'driver-v1') for (const key of ['quantity_tonnes', 'quantity_gross_tonnes', 'loading_actual_at']) delete fields[key];
      const customers = trip.customers.map(row => {
        const fields = { ...row.fields };
        for (const key of ['quantity_tonnes', 'quantity_gross_tonnes', 'unloading_address', 'unloading_map_url', 'unloading_latitude', 'unloading_longitude']) delete fields[key];
        return { id: row.id, fields };
      });
      const result = await f.request(`/api/shipment-trips/${tripId}`, 'PATCH', { fields, customers, versions: Object.fromEntries(trip.customers.map(row => [row.id, row.version])) }, f.adminCookie);
      assert.equal(result.status, 200, result.text);
      assert.equal(result.body.trip.fields.loading_planned_at, '2028-03-04T10:30');
      assert.equal(result.body.trip.fields.loading_actual_at, trip.fields.loading_actual_at, 'changing the plan cannot overwrite historical facts');
      assert.equal((await f.store.read(f.source)).tripSaby?.trips[tripId], undefined);
      assert.equal(f.provider.calls.length, 0);
    }
  } finally {
    if (previousProfile === undefined) delete process.env.SABY_AUTOFILL_PROFILE_JSON; else process.env.SABY_AUTOFILL_PROFILE_JSON = previousProfile;
    await f.close();
  }
});

test('arrival and full departure are atomic, durable and idempotent; decimal masses are never redistributed', async () => {
  const f = await fixture();
  try {
    const initial = (await f.read()).body.trip;
    const masses = initial.deliveries.map((row: { id: string }, index: number) => ({ deliveryId: row.id, netTonnes: index ? '9.654321' : '2,123456' }));
    assert.equal((await f.action('depart', { versions: initial.versions, masses })).status, 409);
    const before = await f.store.read(f.source);
    assert.equal((await f.action('arrive', { versions: initial.versions, arrivedAt: '2000-01-01T00:00:00Z' })).status, 400);
    assert.deepEqual(await f.store.read(f.source), before);
    const arrival = await Promise.all([f.action('arrive', { versions: initial.versions }), f.action('arrive', { versions: initial.versions })]);
    assert.ok(arrival.every(row => row.status === 200));
    assert.equal(arrival[0].body.trip.arrivedAt, arrival[1].body.trip.arrivedAt);
    assert.equal(f.provider.calls.length, 0);
    const arrived = await f.store.read(f.source);
    assert.equal(arrived.etrn?.trips[f.created.trip.id], undefined);
    for (const invalid of [masses.slice(0, 1), [masses[0], masses[0]], [{ ...masses[0], deliveryId: f.trip.customers[0].id }, masses[1]], [{ ...masses[0], netTonnes: '0' }, masses[1]], [{ ...masses[0], netTonnes: '-1' }, masses[1]], [{ ...masses[0], netTonnes: '1.1234567' }, masses[1]], [{ ...masses[0], price: '1' }, masses[1]]]) {
      assert.equal((await f.action('depart', { versions: initial.versions, masses: invalid })).status, 400);
      assert.deepEqual(await f.store.read(f.source), arrived);
    }
    const stale = { ...initial.versions, [initial.deliveries[0].id]: 999 };
    assert.equal((await f.action('depart', { versions: stale, masses })).status, 409);
    assert.deepEqual(await f.store.read(f.source), arrived);
    const departed = await Promise.all([f.action('depart', { versions: initial.versions, masses }), f.action('depart', { versions: initial.versions, masses })]);
    assert.ok(departed.every(row => row.status === 200), JSON.stringify(departed));
    assert.equal(departed[0].body.trip.departedAt, departed[1].body.trip.departedAt);
    assert.deepEqual(departed[0].body.trip.deliveries.map((row: { netTonnes: string }) => row.netTonnes), ['2.123456', '9.654321']);
    const saved = await f.store.read(f.source); const progress = saved.driverTripProgress![f.created.trip.id];
    assert.equal(progress.continuationRequestedAt, progress.departedAt);
    const rows = currentSnapshot(f.base, saved).shipments.filter(row => row.fields.trip_id === f.created.trip.id);
    assert.ok(rows.every(row => row.fields.trip_total_tonnes === '11.777777'));
    assert.deepEqual(rows.map(row => row.fields.purchase_amount), ['106172.8', '482716.05']);
    assert.deepEqual(rows.map(row => row.fields.quantity_gross_tonnes), ['2.123456', '9.654321']);
    assert.ok(rows.every(row => Number(row.fields.sale_price_per_tonne) > 0 && row.fields.profit_source !== null));
    assert.deepEqual(Object.values(saved.etrn!.trips[f.created.trip.id].loadingFacts!.deliveries), [{ grossMassTonnes: '2.123456', massMethod: '03' }, { grossMassTonnes: '9.654321', massMethod: '03' }]);
    assert.equal(saved.etrn!.trips[f.created.trip.id].loadingFacts!.arrivedAt, new Date(Date.parse(progress.arrivedAt) + 10800000).toISOString().slice(0, 19));
    assert.equal((await f.read()).body.trip.departedAt, progress.departedAt);
    assert.equal((await f.action('depart', { versions: departed[0].body.trip.versions, masses: [{ ...masses[0], netTonnes: '3' }, masses[1]] })).status, 409);
    assert.deepEqual(await f.store.read(f.source), saved);
    assert.equal(f.provider.calls.length, 0);
    assert.equal((await f.read()).body.trip.archived, false);
  } finally { await f.close(); }
});

test('driver actions fail closed for stale composition, reassignment, foreign delivery and revoked session', async () => {
  const f = await fixture();
  try {
    const trip = (await f.read()).body.trip;
    const masses = trip.deliveries.map((row: { id: string }) => ({ deliveryId: row.id, netTonnes: '5' }));
    await f.action('arrive', { versions: trip.versions });
    const awaited = await f.store.read(f.source);
    const actor = { ...f.actor, driverId: 'driver-foreign' };
    assert.throws(() => recordDriverTripAction(f.base, structuredClone(awaited), actor, f.created.trip.id, 'depart', { versions: trip.versions, masses }), /только кабинет/);
    await f.store.mutate(f.source, data => {
      data.directories!.drivers.push({ ...data.directories!.drivers[0], id: 'driver-other' });
      for (const id of Object.keys(trip.versions)) { data.shipments[id].fields.driver_id = 'driver-other'; data.shipments[id].version++; }
      return { result: null, changed: true };
    });
    assert.equal((await f.action('depart', { versions: trip.versions, masses })).status, 404);
    assert.equal((await f.read()).status, 404);
    const reassigned = await f.store.read(f.source);
    assert.throws(() => recordDriverTripAction(f.base, reassigned, { ...f.actor, driverId: 'driver-other' }, f.created.trip.id, 'depart', { versions: trip.versions, masses }), /Назначение или состав/);
    assert.equal(reassigned.driverTripProgress![f.created.trip.id].departedAt, undefined);
    assert.equal((await f.request('/api/drivers/driver/access', 'PATCH', { version: 1, active: false }, f.adminCookie)).status, 200);
    assert.equal((await f.action('arrive', { versions: trip.versions })).status, 401);
    assert.equal(f.provider.calls.length, 0);
  } finally { await f.close(); }
});

test('mass and event input cannot bypass driver action; date-only and stale delivery versions never persist', async () => {
  const f = await fixture();
  try {
    const original = await f.store.read(f.source);
    const clean = { fields: { ...f.created.trip.fields, loading_at: '2027-02-03T09:15' }, customers: f.created.trip.customers.map(row => ({ id: row.id, fields: { ...row.fields } })), versions: Object.fromEntries(f.created.trip.customers.map(row => [row.id, row.version])) };
    for (const key of ['quantity_tonnes', 'quantity_gross_tonnes', 'loading_actual_at', 'loading_address', 'loading_map_url', 'loading_latitude', 'loading_longitude']) delete clean.fields[key];
    for (const customer of clean.customers) for (const key of ['quantity_tonnes', 'quantity_gross_tonnes', 'unloading_address', 'unloading_map_url', 'unloading_latitude', 'unloading_longitude']) delete customer.fields[key];
    for (const input of [
      { ...clean, fields: { ...clean.fields, loading_at: '2027-02-03' } },
      { ...clean, fields: { ...clean.fields, quantity_tonnes: '12' } },
      { ...clean, fields: { ...clean.fields, loading_actual_at: '2027-02-03T09:15' } },
      { ...clean, customers: clean.customers.map((row, index) => index ? row : { ...row, fields: { ...row.fields, quantity_tonnes: '12' } }) },
    ]) {
      await assert.rejects(f.store.mutate(f.source, data => ({ result: saveShipmentTrip(f.base, data, input, f.created.trip.id), changed: true })));
      assert.deepEqual(await f.store.read(f.source), original);
    }
    const trip = (await f.read()).body.trip;
    await f.store.mutate(f.source, data => {
      const row = data.shipments[trip.deliveries[0].id]; row.version++; row.fields.delivery_notes = 'Синтетическое изменение';
      return { result: null, changed: true };
    });
    assert.equal((await f.action('arrive', { versions: trip.versions })).status, 409);
    assert.equal((await f.store.read(f.source)).driverTripProgress?.[f.created.trip.id], undefined);
    const fresh = (await f.read()).body.trip;
    assert.equal((await f.action('arrive', { versions: fresh.versions })).status, 200);
    await f.store.mutate(f.source, data => {
      data.shipments[trip.deliveries[0].id].fields.unloading_address = 'Изменённый состав доставки';
      data.shipments[trip.deliveries[0].id].version++;
      return { result: null, changed: true };
    });
    const changed = (await f.read()).body.trip;
    assert.equal((await f.action('depart', { versions: changed.versions, masses: changed.deliveries.map((row: { id: string }) => ({ deliveryId: row.id, netTonnes: '1' })) })).status, 409);
    assert.equal((await f.store.read(f.source)).driverTripProgress?.[f.created.trip.id].departedAt, undefined);
    assert.equal(f.provider.calls.length, 0);
  } finally { await f.close(); }
});

test('legacy trips are read only and draft completion alone never archives', async () => {
  const f = await fixture();
  try {
    const data = await f.store.read(f.source);
    const snapshot = currentSnapshot(f.base, data, false);
    const trip = readDriverTrips(snapshot, f.actor, f.tripId, '', data).trip!;
    assert.equal(trip.flowVersion, null); assert.equal(trip.archived, false);
    assert.throws(() => recordDriverTripAction(f.base, data, f.actor, f.tripId, 'arrive', { versions: trip.versions }), /только новым/);
    data.tripSaby = { trips: { [f.tripId]: { phase: 'completed' } as never } };
    assert.equal(readDriverTrips(snapshot, f.actor, f.tripId, '', data).trip!.archived, false);
  } finally { await f.close(); }
});


test('archive requires terminal evidence for every current delivery, never a stage-six timestamp alone', async () => {
  const f = await fixture();
  try {
    const initial = (await f.read()).body.trip;
    await f.action('arrive', { versions: initial.versions });
    await f.action('depart', { versions: initial.versions, masses: initial.deliveries.map((row: { id: string }) => ({ deliveryId: row.id, netTonnes: '1' })) });
    const data = await f.store.read(f.source), snapshot = currentSnapshot(f.base, data);
    const now = new Date().toISOString();
    const record = { stage6CompletedAt: now, phase: 'completed', driverFlow: { state: 'ready' }, carrierEvidence: {}, signing: { sender: { state: 'confirmed' }, carrier: { state: 'confirmed' } }, deliveries: initial.deliveries.map((row: { id: string }) => ({ shipmentId: row.id, id: `synthetic-doc-${row.id}`, status: 'draft' })) };
    data.tripSaby = { trips: { [f.created.trip.id]: record as never } };
    const projected = () => readDriverTrips(snapshot, f.actor, f.created.trip.id, '', data).trip!.archived;
    assert.equal(projected(), false);
    for (const delivery of record.deliveries) data.etrn!.trips[f.created.trip.id].deliveries[delivery.shipmentId] = { document: { id: delivery.id, dispatch: { completedAt: now, sender: { state: 'confirmed' }, carrier: { state: 'confirmed' } } } } as never;
    assert.equal(projected(), true);
    const second = record.deliveries[1];
    delete data.etrn!.trips[f.created.trip.id].deliveries[second.shipmentId].document!.dispatch!.completedAt;
    assert.equal(projected(), false);
    data.etrn!.trips[f.created.trip.id].deliveries[second.shipmentId].document!.dispatch!.completedAt = now;
    second.id = 'different-synthetic-document'; assert.equal(projected(), false);
  } finally { await f.close(); }
});
