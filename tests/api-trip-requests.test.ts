import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname } from 'node:path';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createSnapshotMiddleware, type LocalApiOptions } from '../server/local-api';
import { OperationsStore } from '../server/operations-store';
import { integrationRuntime } from './helpers/trip-saby-integration';
import type { TripRequest } from '../web/src/trip-request-model';
import type { ShipmentTrip } from '../web/src/model';
import { mapLink } from '../web/src/map-link';

async function fixture(options: Pick<LocalApiOptions, 'tripRequestGeocoder'> = {}) {
  const rt = await integrationRuntime();
  await rt.store.mutate(rt.source, data => {
    data.companies.find(row => row.id === 'customer')!.bankName = 'PRIVATE-OTHER-CUSTOMER-BANK';
    data.directories!.managers.push({ id: 'other-manager', name: 'Другой менеджер' }, { id: 'no-trips-manager', name: 'Без рейсов' });
    data.directories!.customerManagers = [{ companyId: 'customer', managerId: 'manager' }];
    data.directories!.addresses.push({ id: 'delivery-2', companyId: 'customer', kind: 'delivery', name: 'Другой синтетический адрес' });
    data.directories!.addresses.find(row => row.id === 'delivery')!.latitude = '55.7';
    data.directories!.addresses.find(row => row.id === 'delivery')!.longitude = '37.6';
    return { result: null, changed: true };
  });
  const middleware = createSnapshotMiddleware(rt.snapshotDirectory, { operationsStore: rt.store, sabyWorkflowMonitoringEnabled: false, ...options });
  const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end(); }));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = async (path: string, method = 'GET', body?: unknown, cookie?: string) => {
    const response = await fetch(origin + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const password = randomUUID();
  const setup = await request('/api/auth/setup', 'POST', { name: 'Синтетический директор', login: 'requests-owner', password });
  assert.equal(setup.status, 200); const admin = setup.cookie!;
  const employee = async (login: string, managerId: string, sections = ['trips']) => {
    const added = await request('/api/auth/users', 'POST', { name: login, login, password, role: 'employee', managerId, sections }, admin);
    assert.equal(added.status, 201);
    const signed = await request('/api/auth/login', 'POST', { login, password });
    return { cookie: signed.cookie!, user: added.body.user };
  };
  const one = await employee('requests-one', 'manager'), two = await employee('requests-two', 'other-manager');
  const create = async (index = 0, cookie = one.cookie) => {
    const response = await request('/api/trip-requests', 'POST', { companyId: 'customer', addressId: index % 2 ? 'delivery-2' : 'delivery', quantityLitres: String(1000 + index), comment: `Комментарий ${index}`, idempotencyKey: randomUUID() }, cookie);
    assert.equal(response.status, 201, JSON.stringify(response.body)); return response.body.request as TripRequest;
  };
  const tripBody = (requests: TripRequest[]) => ({ idempotencyKey: randomUUID(), fields: { trip_flow_version: 'driver-v1', loading_at: '2027-04-01T10:00', organization_id: 'artel', supplier_id: 'supplier', oil_depot_id: 'depot', product_id: 'product', purchase_price_unspecified_unit: '50000', driver_id: 'driver', vehicle_id: 'vehicle', additional_costs: '0' }, customers: requests.map(source => ({ sourceRequestId: source.id, sourceRequestVersion: source.version, fields: { customer_id: source.companyId, unloading_address_id: source.addressId, quantity_litres: source.quantityLitres, delivery_notes: source.comment, payment_form_id: 'payment', sale_price_per_litre: '60', transport_amount: '0' } })) });
  return { ...rt, request, admin, one, two, employee, create, tripBody, async close() { await new Promise<void>(done => server.close(() => done())); await rt.close(); } };
}
const editing = (trip: ShipmentTrip) => ({ fields: trip.fields, versions: Object.fromEntries(trip.customers.map(row => [row.id, row.version])), customers: trip.customers.map(row => ({ id: row.id, fields: Object.fromEntries(Object.entries(row.fields).filter(([key]) => !['quantity_tonnes', 'quantity_gross_tonnes'].includes(key))) })) });

test('oil depot geocoding uses authorized directory address, respects saved points and never changes business data', async () => {
  const lookedUp: string[] = [];
  const point = { status: 'found' as const, latitude: 55.4, longitude: 37.5, source: 'geocoder' as const, accuracy: 'building' as const };
  const f = await fixture({ tripRequestGeocoder: async address => { lookedUp.push(address); return point; } });
  try {
    await f.store.mutate(f.source, data => {
      data.directories!.oilDepots = [
        { id: 'depot', name: 'Синтетическая нефтебаза', address: 'Сохранённый адрес нефтебазы', version: 2 },
        { id: 'manual-depot', name: 'Ручная точка', address: 'Не запрашивать', latitude: '55.1', longitude: '37.1' },
        { id: 'linked-depot', name: 'Ссылка с точкой', mapUrl: 'https://yandex.ru/maps/?pt=38,56' },
        { id: 'empty-depot', name: 'Название не использовать как адрес' },
      ];
      return { result: null, changed: true };
    });
    const before = await readFile(f.store.path, 'utf8');
    const response = await f.request('/api/trip-requests/geocode', 'POST', { oilDepotId: 'depot', version: 2 }, f.one.cookie);
    assert.equal(response.status, 200); assert.deepEqual(response.body, point);
    assert.deepEqual((await f.request('/api/trip-requests/geocode', 'POST', { oilDepotId: 'manual-depot' }, f.two.cookie)).body, { status: 'found', latitude: 55.1, longitude: 37.1, source: 'directory' });
    assert.deepEqual((await f.request('/api/trip-requests/geocode', 'POST', { oilDepotId: 'linked-depot' }, f.one.cookie)).body, { status: 'found', latitude: 56, longitude: 38, source: 'map_url' });
    assert.equal((await f.request('/api/trip-requests/geocode', 'POST', { oilDepotId: 'empty-depot' }, f.one.cookie)).body.status, 'not_found');
    assert.deepEqual(lookedUp, ['Сохранённый адрес нефтебазы']);
    assert.equal(await readFile(f.store.path, 'utf8'), before);
    assert.equal((await f.request('/api/trip-requests/geocode', 'POST', { oilDepotId: 'depot', version: 1 }, f.one.cookie)).status, 409);
    for (const body of [{ oilDepotId: 'depot', address: 'ARBITRARY' }, { oilDepotId: 'depot', requestId: 'unknown' }, { oilDepotId: 1 }]) assert.equal((await f.request('/api/trip-requests/geocode', 'POST', body, f.one.cookie)).status, 400);
    assert.equal((await f.request('/api/trip-requests/geocode', 'POST', { oilDepotId: 'missing' }, f.one.cookie)).status, 404);
    assert.equal((await f.request('/api/trip-requests/geocode', 'POST', { oilDepotId: 'depot' })).status, 401);
    const denied = await f.employee('depots-denied', 'no-trips-manager', []);
    assert.equal((await f.request('/api/trip-requests/geocode', 'POST', { oilDepotId: 'depot' }, denied.cookie)).status, 403);
    assert.deepEqual(lookedUp, ['Сохранённый адрес нефтебазы']);
  } finally { await f.close(); }
});

test('oil depot geocoding rejects stale directory results after address changes or deletion', async () => {
  for (const change of ['address', 'delete'] as const) {
    let start!: () => void, release!: () => void;
    const started = new Promise<void>(done => { start = done; }), blocked = new Promise<void>(done => { release = done; });
    const f = await fixture({ tripRequestGeocoder: async () => { start(); await blocked; return { status: 'found', latitude: 55, longitude: 37, source: 'geocoder', label: 'MUST-NOT-RETURN-STALE-DEPOT' }; } });
    try {
      await f.store.mutate(f.source, data => { data.directories!.oilDepots!.push({ id: 'pending-depot', name: 'Нефтебаза', address: 'Исходный адрес' }); return { changed: true, result: null }; });
      const pending = f.request('/api/trip-requests/geocode', 'POST', { oilDepotId: 'pending-depot' }, f.one.cookie);
      await started;
      await f.store.mutate(f.source, data => { if (change === 'address') data.directories!.oilDepots!.find(row => row.id === 'pending-depot')!.address = 'Другой адрес'; else data.directories!.oilDepots = data.directories!.oilDepots!.filter(row => row.id !== 'pending-depot'); return { changed: true, result: null }; });
      release(); const result = await pending;
      assert.equal(result.status, change === 'address' ? 409 : 404);
      assert.doesNotMatch(JSON.stringify(result.body), /MUST-NOT-RETURN-STALE-DEPOT/);
    } finally { release(); await f.close(); }
  }
});

test('geocoding reads only authorized authoritative address snapshots and never mutates requests or directory data', async () => {
  const lookedUp: string[] = [];
  const location = { status: 'found' as const, latitude: 55.61, longitude: 37.35, source: 'geocoder' as const, label: 'Синтетический дом', accuracy: 'building' as const };
  const f = await fixture({ tripRequestGeocoder: async address => { lookedUp.push(address); return location; } });
  try {
    const source = await f.create(1);
    await f.store.mutate(f.source, data => { const place = data.directories!.addresses.find(row => row.id === source.addressId)!; place.address = 'ДРУГОЙ АДРЕС В СПРАВОЧНИКЕ'; return { result: null, changed: true }; });
    const before = await readFile(f.store.path, 'utf8');
    const response = await f.request('/api/trip-requests/geocode', 'POST', { requestId: source.id }, f.one.cookie);
    assert.equal(response.status, 200); assert.deepEqual(response.body, location); assert.deepEqual(lookedUp, [source.address]);
    assert.equal((await f.request('/api/trip-requests/geocode', 'POST', { companyId: source.companyId, addressId: source.addressId }, f.two.cookie)).status, 200);
    assert.deepEqual(lookedUp, [source.address, 'ДРУГОЙ АДРЕС В СПРАВОЧНИКЕ']);
    assert.equal(await readFile(f.store.path, 'utf8'), before);
    for (const body of [{}, { address: 'ARBITRARY ADDRESS' }, { requestId: source.id, address: 'ARBITRARY ADDRESS' }, { requestId: source.id, companyId: source.companyId, addressId: source.addressId }, { companyId: source.companyId }, { requestId: 123 }]) assert.equal((await f.request('/api/trip-requests/geocode', 'POST', body, f.one.cookie)).status, 400);
    for (const body of [{ requestId: 'missing' }, { companyId: 'missing', addressId: source.addressId }, { companyId: source.companyId, addressId: 'loading' }]) assert.equal((await f.request('/api/trip-requests/geocode', 'POST', body, f.one.cookie)).status, 404);
    assert.equal((await f.request('/api/trip-requests/geocode', 'GET', undefined, f.one.cookie)).status, 405);
    assert.equal((await f.request('/api/trip-requests/geocode', 'POST', { requestId: source.id })).status, 401);
    const none = await f.employee('geocode-denied', 'no-trips-manager', []);
    assert.equal((await f.request('/api/trip-requests/geocode', 'POST', { requestId: source.id }, none.cookie)).status, 403);
    assert.equal(lookedUp.length, 2);
    await f.request(`/api/trip-requests/${source.id}`, 'DELETE', { version: source.version }, f.one.cookie);
    assert.equal((await f.request('/api/trip-requests/geocode', 'POST', { requestId: source.id }, f.one.cookie)).status, 409);
    assert.equal(lookedUp.length, 2);
  } finally { await f.close(); }
});

test('geocoding never replaces explicit pins or incomplete saved coordinates', async () => {
  let calls = 0;
  const f = await fixture({ tripRequestGeocoder: async () => { calls++; return { status: 'not_found', message: 'Synthetic' }; } });
  try {
    const source = await f.create();
    const before = await readFile(f.store.path, 'utf8');
    const explicit = await f.request('/api/trip-requests/geocode', 'POST', { requestId: source.id }, f.one.cookie);
    assert.deepEqual(explicit.body, { status: 'found', latitude: 55.7, longitude: 37.6, source: 'directory' });
    assert.equal(await readFile(f.store.path, 'utf8'), before);
    await f.store.mutate(f.source, data => { const request = data.tripRequests![source.id]; request.latitude = null; request.longitude = null; request.mapUrl = 'https://yandex.ru/maps/?pt=37.9,55.9'; return { result: null, changed: true }; });
    assert.equal((await f.request('/api/trip-requests/geocode', 'POST', { requestId: source.id }, f.one.cookie)).body.source, 'map_url');
    await f.store.mutate(f.source, data => { const request = data.tripRequests![source.id]; request.latitude = '55.5'; request.longitude = null; return { result: null, changed: true }; });
    assert.equal((await f.request('/api/trip-requests/geocode', 'POST', { requestId: source.id }, f.one.cookie)).body.status, 'unavailable');
    assert.equal(calls, 0);
  } finally { await f.close(); }
});

test('queued geocoding rechecks permissions and current snapshot before returning provider data', async () => {
  for (const change of ['permission', 'point', 'cancel', 'directory'] as const) {
    let ready!: () => void, release!: () => void;
    const started = new Promise<void>(done => { ready = done; }), blocked = new Promise<void>(done => { release = done; });
    const f = await fixture({ tripRequestGeocoder: async () => { ready(); await blocked; return { status: 'found', latitude: 55, longitude: 37, source: 'geocoder', label: 'MUST-NOT-RETURN-STALE', accuracy: 'building' }; } });
    try {
      const source = await f.create(1);
      const body = change === 'directory' ? { companyId: source.companyId, addressId: source.addressId } : { requestId: source.id };
      const pending = f.request('/api/trip-requests/geocode', 'POST', body, f.one.cookie);
      await started;
      await f.store.mutate(f.source, data => {
        if (change === 'permission') data.accounts!.users.find(row => row.id === f.one.user.id)!.sections = [];
        if (change === 'point') Object.assign(data.tripRequests![source.id], { latitude: '56', longitude: '38', version: source.version + 1 });
        if (change === 'cancel') Object.assign(data.tripRequests![source.id], { status: 'cancelled', version: source.version + 1 });
        if (change === 'directory') data.directories!.addresses.find(row => row.id === source.addressId)!.address = 'Изменённый адрес';
        return { result: null, changed: true };
      });
      release(); const result = await pending;
      assert.equal(result.status, change === 'permission' ? 403 : 409); assert.doesNotMatch(JSON.stringify(result.body), /MUST-NOT-RETURN-STALE/);
    } finally { release(); await f.close(); }
  }
});

test('request point requires a bounded string pair and rejects invalid or unauthorized writes atomically', async () => {
  const f = await fixture();
  try {
    const source = await f.create();
    const noTrips = await f.employee('requests-point-denied', 'no-trips-manager', []);
    const create = { companyId: source.companyId, addressId: source.addressId, quantityLitres: '1500', comment: 'Точка', idempotencyKey: randomUUID() };
    const patch = { version: source.version, quantityLitres: source.quantityLitres, comment: source.comment };
    const before = await readFile(f.store.path, 'utf8');
    for (const point of [{ latitude: '55' }, { longitude: '37' }, { latitude: '', longitude: '' }, { latitude: null, longitude: null }, { latitude: 55, longitude: 37 }, { latitude: ['55'], longitude: '37' }, { latitude: '91', longitude: '37' }, { latitude: '55', longitude: '-181' }, { latitude: '1e1', longitude: '37' }, { latitude: '0x10', longitude: '37' }, { latitude: '5'.repeat(65), longitude: '37' }]) {
      assert.equal((await f.request('/api/trip-requests', 'POST', { ...create, ...point }, f.one.cookie)).status, 400);
      assert.equal((await f.request(`/api/trip-requests/${source.id}`, 'PATCH', { ...patch, ...point }, f.two.cookie)).status, 400);
      assert.equal(await readFile(f.store.path, 'utf8'), before);
    }
    const valid = { latitude: '0', longitude: '-180' };
    assert.equal((await f.request('/api/trip-requests', 'POST', { ...create, ...valid }, noTrips.cookie)).status, 403);
    assert.equal((await f.request(`/api/trip-requests/${source.id}`, 'PATCH', { ...patch, ...valid }, noTrips.cookie)).status, 403);
    assert.equal((await f.request(`/api/trip-requests/${source.id}`, 'PATCH', { ...patch, ...valid })).status, 401);
    assert.equal(await readFile(f.store.path, 'utf8'), before);
    const updated = await f.request(`/api/trip-requests/${source.id}`, 'PATCH', { ...patch, latitude: ' +00.000 ', longitude: '-0' }, f.two.cookie);
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.request.latitude, '0'); assert.equal(updated.body.request.longitude, '0');
    assert.equal(new URL(updated.body.request.mapUrl).searchParams.get('pt'), '0,0');
    assert.equal(updated.body.request.address, source.address);
    assert.equal(updated.body.request.addressId, source.addressId);
  } finally { await f.close(); }
});

test('request point preserves old replay fingerprints and distinguishes new point retries and stale versions', async () => {
  const f = await fixture();
  try {
    const oldBody = { companyId: 'customer', addressId: 'delivery', quantityLitres: '1000', comment: 'Исходный контракт', idempotencyKey: randomUUID() };
    const old = await f.request('/api/trip-requests', 'POST', oldBody, f.one.cookie);
    const stored = await f.store.read(f.source);
    assert.equal(stored.tripRequestCreates![oldBody.idempotencyKey].fingerprint, createHash('sha256').update(JSON.stringify(['customer', 'delivery', '1000', 'Исходный контракт'])).digest('hex'));
    assert.equal((await f.request('/api/trip-requests', 'POST', oldBody, f.one.cookie)).body.request.id, old.body.request.id);
    assert.equal((await f.request('/api/trip-requests', 'POST', { ...oldBody, latitude: '55.7', longitude: '37.6' }, f.one.cookie)).status, 409);
    const body = { ...oldBody, idempotencyKey: randomUUID(), latitude: '55.710000', longitude: '37.620000' };
    const results = await Promise.all([1, 2].map(() => f.request('/api/trip-requests', 'POST', body, f.one.cookie)));
    assert.deepEqual(results.map(row => row.status), [201, 201]);
    assert.equal(results[0].body.request.id, results[1].body.request.id);
    const source = results[0].body.request as TripRequest;
    assert.equal((await f.request('/api/trip-requests', 'POST', { ...body, latitude: '55.71', longitude: '37.62' }, f.one.cookie)).body.request.id, source.id);
    assert.equal((await f.request('/api/trip-requests', 'POST', { ...body, longitude: '37.63' }, f.one.cookie)).status, 409);
    assert.equal((await f.request('/api/trip-requests', 'POST', body, f.two.cookie)).status, 409);
    const changed = await f.request(`/api/trip-requests/${source.id}`, 'PATCH', { version: 1, quantityLitres: source.quantityLitres, latitude: '-90', longitude: '180' }, f.two.cookie);
    assert.equal(changed.status, 200); assert.equal(changed.body.request.version, 2);
    assert.equal((await f.request(`/api/trip-requests/${source.id}`, 'PATCH', { version: 1, quantityLitres: source.quantityLitres, latitude: '55', longitude: '37' }, f.one.cookie)).status, 409);
    const unchanged = await f.request(`/api/trip-requests/${source.id}`, 'PATCH', { version: 2, quantityLitres: '1250', comment: 'Точка прежняя' }, f.one.cookie);
    assert.equal(unchanged.status, 200);
    for (const key of ['latitude', 'longitude', 'mapUrl']) assert.equal(unchanged.body.request[key], changed.body.request[key]);
    assert.equal(unchanged.body.request.comment, 'Точка прежняя');
  } finally { await f.close(); }
});

test('chosen request point reaches trip and driver map link while directory and historical trips stay unchanged', async () => {
  const f = await fixture();
  try {
    await f.store.mutate(f.source, data => { data.directories!.addresses.find(row => row.id === 'delivery')!.mapUrl = 'https://yandex.ru/maps/?pt=37.6,55.7'; return { result: null, changed: true }; });
    const historicRequest = await f.create();
    const historical = await f.request('/api/shipment-trips', 'POST', f.tripBody([historicRequest]), f.two.cookie);
    assert.equal(historical.status, 201);
    const historicalTrip = historical.body.trip;
    const previousStore = await f.store.read(f.source);
    const source = await f.create(2);
    const updated = await f.request(`/api/trip-requests/${source.id}`, 'PATCH', { version: source.version, quantityLitres: source.quantityLitres, comment: source.comment, latitude: '55.812345', longitude: '37.723456' }, f.one.cookie);
    assert.equal(updated.status, 200);
    assert.notEqual(updated.body.request.mapUrl, source.mapUrl);
    const created = await f.request('/api/shipment-trips', 'POST', f.tripBody([updated.body.request]), f.two.cookie);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const delivery = created.body.trip.customers[0].fields;
    assert.equal(delivery.unloading_address, source.address);
    assert.equal(delivery.unloading_latitude, '55.812345'); assert.equal(delivery.unloading_longitude, '37.723456');
    const issued = await f.request('/api/drivers/driver/access', 'POST', { version: 0, action: 'issue' }, f.admin);
    assert.equal(issued.status, 200, JSON.stringify(issued.body));
    const login = await f.request('/api/auth/login', 'POST', { login: issued.body.access.login, password: issued.body.temporaryPassword });
    const driver = await f.request(`/api/driver/trips/${created.body.trip.id}`, 'GET', undefined, login.cookie);
    assert.equal(driver.status, 200, JSON.stringify(driver.body));
    const navigation = mapLink({ mapUrl: driver.body.trip.deliveries[0].mapUrl, address: driver.body.trip.deliveries[0].address })!;
    assert.equal(new URL(navigation.href).searchParams.get('pt'), '37.723456,55.812345');
    const after = await f.store.read(f.source);
    assert.deepEqual(after.directories, previousStore.directories);
    for (const row of historicalTrip.customers) assert.deepEqual(after.shipments[row.id], previousStore.shipments[row.id]);
    assert.equal((await f.request(`/api/trip-requests/${source.id}`, 'PATCH', { version: updated.body.request.version + 1, quantityLitres: '1000', latitude: '0', longitude: '0' }, f.one.cookie)).status, 409);
    assert.deepEqual((await f.store.read(f.source)).shipments, after.shipments);
  } finally { await f.close(); }
});

test('shared request queue exposes only operational catalog and persists four requests, two consumed with source history', async () => {
  const f = await fixture();
  try {
    const sources = await Promise.all([0, 1, 2, 3].map(index => f.create(index)));
    const listed = await f.request('/api/trip-requests', 'GET', undefined, f.two.cookie);
    assert.equal(listed.status, 200); assert.equal(listed.body.requests.length, 4);
    assert.equal(listed.body.addresses.filter((row: { companyId: string }) => row.companyId === 'customer').length, 2);
    assert.equal(listed.body.addresses.find((row: { id: string }) => row.id === 'delivery-2').address, 'Другой синтетический адрес');
    assert.doesNotMatch(JSON.stringify(listed.body), /PRIVATE-OTHER-CUSTOMER-BANK|bankName|receiverPhone/);
    const input = f.tripBody(sources.slice(0, 2)); input.customers[0].fields.quantity_litres = '900';
    const created = await f.request('/api/shipment-trips', 'POST', input, f.two.cookie);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const trip = created.body.trip as ShipmentTrip;
    assert.equal(trip.customers[0].fields.quantity_litres, '900');
    assert.equal(trip.customers[0].fields.unloading_latitude, '55.7');
    assert.ok(trip.customers.every(row => row.fields.manager_id === 'other-manager'));
    assert.equal((await f.request('/api/trip-requests', 'GET', undefined, f.one.cookie)).body.requests.length, 2);
    const persisted = await new OperationsStore(dirname(f.store.path)).read(f.source);
    assert.equal(persisted.tripRequests![sources[0].id].quantityLitres, '1000');
    assert.equal(persisted.tripRequests![sources[0].id].tripId, trip.id);
    assert.equal(persisted.shipments[trip.customers[0].id].fields.source_request_id, sources[0].id);
    assert.equal((await f.request(`/api/shipment-trips/${trip.id}`, 'GET', undefined, f.two.cookie)).status, 200);
    assert.equal((await f.request(`/api/shipment-trips/${trip.id}`, 'GET', undefined, f.one.cookie)).status, 404);
    const snapshot = await f.request('/api/snapshot', 'GET', undefined, f.two.cookie);
    assert.doesNotMatch(JSON.stringify(snapshot.body), /PRIVATE-OTHER-CUSTOMER-BANK/);
    assert.equal(snapshot.body.shipments.length, 2);
    const retry = await f.request('/api/shipment-trips', 'POST', input, f.two.cookie);
    assert.equal(retry.status, 201, JSON.stringify(retry.body)); assert.equal(retry.body.trip.id, trip.id);
    const forged = editing(trip); forged.customers[0].fields.unloading_address_id = 'delivery-2';
    assert.equal((await f.request(`/api/shipment-trips/${trip.id}`, 'PATCH', forged, f.two.cookie)).status, 400);
    assert.equal((await f.request(`/api/shipment-trips/${trip.id}`, 'PATCH', editing(trip), f.two.cookie)).status, 200);
  } finally { await f.close(); }
});

test('request creation retries, updates and cancellation preserve versions and immutable directory snapshots', async () => {
  const f = await fixture();
  try {
    const body = { companyId: 'customer', addressId: 'delivery', quantityLitres: '1 250,5', comment: 'Ворота 2', idempotencyKey: randomUUID() };
    const results = await Promise.all([1, 2].map(() => f.request('/api/trip-requests', 'POST', body, f.two.cookie)));
    assert.deepEqual(results.map(row => row.status), [201, 201]);
    const original = results[0].body.request as TripRequest; assert.equal(original.id, results[1].body.request.id); assert.equal(original.quantityLitres, '1250.5');
    assert.equal((await f.request('/api/trip-requests', 'POST', { ...body, quantityLitres: '1' }, f.two.cookie)).status, 409);
    assert.equal((await f.request(`/api/trip-requests/${original.id}`, 'PATCH', { version: 1, quantityLitres: '1500', addressId: 'delivery-2' }, f.one.cookie)).status, 400);
    const edited = await f.request(`/api/trip-requests/${original.id}`, 'PATCH', { version: 1, quantityLitres: '1500', comment: 'Изменён' }, f.one.cookie);
    assert.equal(edited.status, 200); assert.equal(edited.body.request.version, 2); assert.equal(edited.body.request.ownerUserId, f.two.user.id);
    assert.equal((await f.request(`/api/trip-requests/${original.id}`, 'DELETE', { version: 1 }, f.two.cookie)).status, 409);
    assert.equal((await f.request(`/api/trip-requests/${original.id}`, 'DELETE', { version: 2 }, f.two.cookie)).status, 200);
    assert.equal((await f.request('/api/trip-requests', 'GET', undefined, f.one.cookie)).body.requests.length, 0);
    assert.equal((await f.store.read(f.source)).tripRequests![original.id].status, 'cancelled');
    const retry = await f.request('/api/trip-requests', 'POST', body, f.two.cookie);
    assert.equal(retry.body.request.status, 'cancelled');
    assert.equal((await f.request('/api/trip-requests', 'POST', { ...body, idempotencyKey: randomUUID(), addressId: 'loading' }, f.two.cookie)).status, 400);
  } finally { await f.close(); }
});

test('competing consumers have one winner; stale or invalid selections roll back the entire trip and request set', async () => {
  const f = await fixture();
  try {
    const first = await f.create(), second = await f.create(1);
    const before = await readFile(f.store.path, 'utf8');
    const mismatch = f.tripBody([first, second]); mismatch.customers[1].fields.unloading_address_id = 'delivery';
    assert.equal((await f.request('/api/shipment-trips', 'POST', mismatch, f.two.cookie)).status, 400);
    assert.equal(await readFile(f.store.path, 'utf8'), before);
    const duplicated = f.tripBody([first, first]);
    assert.equal((await f.request('/api/shipment-trips', 'POST', duplicated, f.two.cookie)).status, 400);
    const noRequests = f.tripBody([first]);
    for (const row of noRequests.customers) { delete (row as Partial<typeof row>).sourceRequestId; delete (row as Partial<typeof row>).sourceRequestVersion; }
    const direct = await f.request('/api/shipment-trips', 'POST', noRequests, f.admin);
    assert.equal(direct.status, 201, JSON.stringify(direct.body));
    assert.ok(!direct.body.trip.customers[0].fields.source_request_id);
    assert.equal((await f.store.read(f.source)).tripRequests![first.id].status, 'active');
    const directEdit = editing(direct.body.trip);
    const extended = await f.request(`/api/shipment-trips/${direct.body.trip.id}`, 'PATCH', { ...directEdit, customers: [...directEdit.customers, noRequests.customers[0]] }, f.admin);
    assert.equal(extended.status, 200, JSON.stringify(extended.body));
    assert.equal(extended.body.trip.customers.length, 2);
    const races = await Promise.all([f.one.cookie, f.two.cookie].map(cookie => f.request('/api/shipment-trips', 'POST', f.tripBody([first]), cookie)));
    assert.deepEqual(races.map(row => row.status).sort(), [201, 409]);
    const beforeRejected = await readFile(f.store.path, 'utf8');
    assert.equal((await f.request('/api/shipment-trips', 'POST', f.tripBody([second, first]), f.two.cookie)).status, 409);
    assert.equal(await readFile(f.store.path, 'utf8'), beforeRejected);
    assert.equal((await f.store.read(f.source)).tripRequests![second.id].status, 'active');
  } finally { await f.close(); }
});

test('trip permission is required for shared queue and refreshed for consumption; cross-assigned deliveries require a source grant', async () => {
  const f = await fixture();
  try {
    const none = await f.employee('requests-none', 'no-trips-manager', ['shipments']);
    assert.equal((await f.request('/api/trip-requests', 'GET', undefined, none.cookie)).status, 403);
    assert.equal((await f.request('/api/trip-requests/map-config', 'GET', undefined, none.cookie)).status, 403);
    assert.equal((await f.request('/api/trip-requests/map-config', 'GET', undefined, f.one.cookie)).status, 200);
    const source = await f.create();
    assert.equal((await f.request('/api/directories/addresses/delivery', 'DELETE', { version: 0 }, f.admin)).status, 409);
    assert.equal((await f.request('/api/shipment-trips', 'POST', f.tripBody([source]), none.cookie)).status, 404);
    const saved = await f.request('/api/shipment-trips', 'POST', f.tripBody([source]), f.two.cookie);
    assert.equal(saved.status, 201);
    const change = editing(saved.body.trip);
    const extra = { fields: { ...change.customers[0].fields } };
    const add = await f.request(`/api/shipment-trips/${saved.body.trip.id}`, 'PATCH', { ...change, customers: [...change.customers, extra] }, f.two.cookie);
    assert.equal(add.status, 403); // No source grant for a company assigned to another employee.
    const allowed = await f.create(2);
    const added = await f.request(`/api/shipment-trips/${saved.body.trip.id}`, 'PATCH', { ...change, customers: [...change.customers, f.tripBody([allowed]).customers[0]] }, f.two.cookie);
    assert.equal(added.status, 200, JSON.stringify(added.body));
    assert.equal((await f.store.read(f.source)).tripRequests![allowed.id].status, 'consumed');
    const next = await f.create(3);
    await f.store.mutate(f.source, data => { data.accounts!.users.find(row => row.id === f.two.user.id)!.sections = []; return { result: null, changed: true }; });
    assert.equal((await f.request('/api/shipment-trips', 'POST', f.tripBody([next]), f.two.cookie)).status, 403);
    assert.equal((await f.store.read(f.source)).tripRequests![next.id].status, 'active');
  } finally { await f.close(); }
});

test('changed directory coordinates and stale request versions never silently replace chosen request details', async () => {
  const f = await fixture();
  try {
    const source = await f.create();
    await f.store.mutate(f.source, data => {
      const place = data.directories!.addresses.find(row => row.id === source.addressId)!;
      place.address = 'Изменённый адрес'; place.latitude = '60'; place.longitude = '30';
      return { result: null, changed: true };
    });
    const edited = await f.request(`/api/trip-requests/${source.id}`, 'PATCH', { version: source.version, quantityLitres: '2222', comment: source.comment }, f.two.cookie);
    assert.equal(edited.status, 200);
    const stale = await f.request('/api/shipment-trips', 'POST', f.tripBody([source]), f.two.cookie);
    assert.equal(stale.status, 409);
    const saved = await f.request('/api/shipment-trips', 'POST', f.tripBody([edited.body.request]), f.two.cookie);
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
    assert.equal(saved.body.trip.customers[0].fields.unloading_address, source.address);
    assert.equal(saved.body.trip.customers[0].fields.unloading_latitude, source.latitude);
    assert.equal(saved.body.trip.customers[0].fields.quantity_litres, '2222');
    const before = await readFile(f.store.path, 'utf8');
    const forged = { ...f.tripBody([source]).customers[0].fields, source_request_id: source.id };
    assert.equal((await f.request('/api/shipments', 'POST', { fields: forged }, f.admin)).status, 400);
    assert.equal(await readFile(f.store.path, 'utf8'), before);
  } finally { await f.close(); }
});

test('all directory mutation paths preserve active request company and location dependencies atomically', async () => {
  const f = await fixture();
  try {
    const created = await f.request('/api/directories', 'POST', { kind: 'companies', name: 'Компания только активной заявки', roles: ['customer'], addresses: [{ name: 'База только заявки', kind: 'delivery' }] }, f.admin);
    assert.equal(created.status, 201);
    const company = created.body.entry;
    const catalog = (await f.request('/api/trip-requests', 'GET', undefined, f.one.cookie)).body;
    const address = catalog.addresses.find((row: { companyId: string }) => row.companyId === company.id);
    const saved = await f.request('/api/trip-requests', 'POST', { companyId: company.id, addressId: address.id, quantityLitres: '1250', comment: '' }, f.one.cookie);
    assert.equal(saved.status, 201);
    const source = saved.body.request as TripRequest;
    const companyInput = { version: company.version, name: company.name, roles: ['customer'], addresses: [{ id: address.id, name: address.name, kind: 'delivery' }] };
    const addressInput = { version: 0, name: address.name, companyId: company.id, addressKind: 'delivery' };
    const before = await readFile(f.store.path, 'utf8');
    const revision = (await f.store.read(f.source)).revision;
    const denied: [string, string, unknown][] = [
      [`/api/directories/addresses/${address.id}`, 'DELETE', { version: 0 }],
      [`/api/directories/addresses/${address.id}`, 'PATCH', { ...addressInput, companyId: 'customer' }],
      [`/api/directories/addresses/${address.id}`, 'PATCH', { ...addressInput, addressKind: 'loading' }],
      [`/api/directories/companies/${company.id}`, 'PATCH', { ...companyInput, addresses: [] }],
      [`/api/directories/companies/${company.id}`, 'PATCH', { ...companyInput, roles: ['supplier'] }],
      ['/api/directories/cleanup', 'POST', { confirm: 'clear-directories', scope: 'companies', revision }],
    ];
    for (const [path, method, body] of denied) {
      const result = await f.request(path, method, body, f.admin);
      assert.equal(result.status, 409, `${path}: ${JSON.stringify(result.body)}`);
      assert.match(result.body.error, /активн/);
      assert.equal(await readFile(f.store.path, 'utf8'), before);
    }
    const preview = await f.request('/api/directories/cleanup?scope=companies', 'GET', undefined, f.admin);
    assert.equal(preview.status, 200); assert.equal(preview.body.available, false); assert.match(preview.body.blocked, /активн/);
    assert.equal(await readFile(f.store.path, 'utf8'), before);
    assert.equal((await f.request(`/api/trip-requests/${source.id}`, 'DELETE', { version: source.version }, f.one.cookie)).status, 200);
    // Cancelled request snapshots remain history, and do not prevent ordinary directory edits.
    const released = await f.request(`/api/directories/companies/${company.id}`, 'PATCH', { ...companyInput, roles: ['supplier'], addresses: [] }, f.admin);
    assert.equal(released.status, 200, JSON.stringify(released.body));
    const history = (await f.store.read(f.source)).tripRequests![source.id];
    assert.equal(history.status, 'cancelled'); assert.equal(history.addressId, address.id); assert.equal(history.address, source.address);
  } finally { await f.close(); }
});

test('consumed requests retain historical shipment protections while normal company archival stays supported', async () => {
  const f = await fixture();
  try {
    const source = await f.create();
    const saved = await f.request('/api/shipment-trips', 'POST', f.tripBody([source]), f.two.cookie);
    assert.equal(saved.status, 201);
    const before = await f.store.read(f.source);
    const history = structuredClone(before.tripRequests![source.id]);
    const reassigned = await f.request(`/api/directories/addresses/${source.addressId}`, 'PATCH', { version: 0, name: source.addressName, companyId: source.companyId, addressKind: 'loading' }, f.admin);
    assert.equal(reassigned.status, 409); assert.match(reassigned.body.error, /отгрузк/);
    const preview = await f.request('/api/directories/cleanup?scope=companies', 'GET', undefined, f.admin);
    assert.equal(preview.status, 200); assert.equal(preview.body.available, true);
    const archived = await f.request('/api/directories/cleanup', 'POST', { confirm: 'clear-directories', scope: 'companies', revision: preview.body.revision }, f.admin);
    assert.equal(archived.status, 200, JSON.stringify(archived.body));
    const after = await f.store.read(f.source);
    assert.deepEqual(after.tripRequests![source.id], history);
    assert.equal(after.companies.find(row => row.id === source.companyId)!.directoryArchived, true);
    assert.equal((await f.request(`/api/shipment-trips/${saved.body.trip.id}`, 'GET', undefined, f.two.cookie)).status, 200);
  } finally { await f.close(); }
});

test('save triggers one address lookup; initial list immediately includes durable known points without another provider call', async () => {
  let calls = 0, entered!: () => void, finish!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { finish = resolve; });
  const point = { status: 'found' as const, latitude: 55.61, longitude: 37.35, source: 'geocoder' as const, accuracy: 'building' as const, label: 'Синтетический дом' };
  const f = await fixture({ tripRequestGeocoder: async () => { calls++; entered(); await blocked; return point; } });
  try {
    const source = await f.create(1);
    await started;
    const before = await readFile(f.store.path, 'utf8');
    const first = await Promise.race([f.request('/api/trip-requests', 'GET', undefined, f.one.cookie), new Promise<never>((_, reject) => { const timer = setTimeout(() => reject(new Error('GET waited for provider')), 1000); timer.unref(); })]);
    assert.equal(first.status, 200); assert.equal(first.body.requests[0].location.status, 'pending');
    finish();
    assert.deepEqual((await f.request('/api/trip-requests/geocode', 'POST', { requestId: source.id }, f.one.cookie)).body, point);
    for (let index = 0; index < 3; index++) {
      const loaded = await f.request('/api/trip-requests', 'GET', undefined, f.two.cookie);
      assert.deepEqual(loaded.body.requests[0].location, point);
      assert.deepEqual(loaded.body.addresses.find((row: { id: string }) => row.id === source.addressId).location, point);
    }
    assert.equal(calls, 1); assert.equal(await readFile(f.store.path, 'utf8'), before);
    const another = await f.create(3);
    assert.equal(another.latitude, String(point.latitude)); assert.equal(another.longitude, String(point.longitude)); assert.deepEqual(another.locationSnapshot, point); assert.equal(calls, 1);
    await f.store.mutate(f.source, data => { Object.assign(data.directories!.addresses.find(row => row.id === source.addressId)!, { latitude: '50', longitude: '40' }); return { result: null, changed: true }; });
    const loaded = await f.request('/api/trip-requests', 'GET', undefined, f.one.cookie);
    assert.deepEqual(loaded.body.requests.find((row: TripRequest) => row.id === source.id).location, point);
    const trip = await f.request('/api/shipment-trips', 'POST', f.tripBody([source]), f.one.cookie);
    assert.equal(trip.status, 201, JSON.stringify(trip.body));
    assert.equal(trip.body.shipments[0].fields.unloading_latitude, String(point.latitude));
    assert.equal(trip.body.shipments[0].fields.unloading_longitude, String(point.longitude));
  } finally { finish(); await f.close(); }
});

test('text address correction clears the old pin, isolates stale in-flight results, and retains prior snapshots', async () => {
  const oldPoint = { status: 'found' as const, latitude: 55.1, longitude: 37.1, source: 'geocoder' as const, accuracy: 'building' as const };
  const newPoint = { ...oldPoint, latitude: 55.2, longitude: 37.2 };
  let entered!: () => void, finish!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { finish = resolve; });
  const queried: string[] = [];
  const correctedAddress = 'улица Новый пример, строение 9, Москва';
  const f = await fixture({ tripRequestGeocoder: async address => { queried.push(address); if (address === correctedAddress) return newPoint; entered(); await blocked; return oldPoint; } });
  try {
    const original = await f.create(1); await started;
    const pending = f.request('/api/trip-requests/geocode', 'POST', { requestId: original.id }, f.one.cookie);
    // Ensure the protected endpoint has entered its authoritative read before the correction.
    await new Promise(resolve => setTimeout(resolve, 20));
    const directoryBefore = structuredClone((await f.store.read(f.source)).directories);
    const patched = await f.request(`/api/trip-requests/${original.id}`, 'PATCH', { version: original.version, quantityLitres: original.quantityLitres, comment: original.comment, address: correctedAddress }, f.one.cookie);
    assert.equal(patched.status, 200); assert.equal(patched.body.request.address, correctedAddress);
    assert.equal(patched.body.request.latitude, null); assert.equal(patched.body.request.longitude, null); assert.equal(patched.body.request.mapUrl, null);
    finish(); assert.equal((await pending).status, 409);
    assert.deepEqual((await f.request('/api/trip-requests/geocode', 'POST', { requestId: original.id }, f.one.cookie)).body, newPoint);
    const loaded = await f.request('/api/trip-requests', 'GET', undefined, f.one.cookie);
    assert.deepEqual(loaded.body.requests[0].location, newPoint);
    assert.deepEqual(queried, [original.address, correctedAddress]);
    assert.deepEqual((await f.store.read(f.source)).directories, directoryBefore);
    const corrected = patched.body.request as TripRequest;
    const trip = await f.request('/api/shipment-trips', 'POST', f.tripBody([corrected]), f.one.cookie);
    assert.equal(trip.status, 201, JSON.stringify(trip.body));
    const oldShipment = structuredClone(trip.body.shipments[0]);
    assert.equal(oldShipment.fields.unloading_address, correctedAddress);
    assert.equal(oldShipment.fields.unloading_latitude, String(newPoint.latitude));
    await f.store.mutate(f.source, data => { Object.assign(data.directories!.addresses.find(row => row.id === original.addressId)!, { address: 'Ещё один адрес', latitude: '56', longitude: '38' }); return { result: null, changed: true }; });
    const historical = await f.request(`/api/shipment-trips/${trip.body.trip.id}`, 'GET', undefined, f.one.cookie);
    assert.equal(historical.body.shipment.fields.unloading_address, correctedAddress);
    assert.equal(historical.body.shipment.fields.unloading_latitude, String(newPoint.latitude));
  } finally { finish(); await f.close(); }
});

test('new request address override does not inherit a pin from a different directory address', async () => {
  let calls = 0;
  const f = await fixture({ tripRequestGeocoder: async () => { calls++; return { status: 'not_found', message: 'Уточните адрес доставки' }; } });
  try {
    const body = { companyId: 'customer', addressId: 'delivery', address: '  другой  адрес  ', quantityLitres: '1000', idempotencyKey: randomUUID() };
    const created = await f.request('/api/trip-requests', 'POST', body, f.one.cookie);
    assert.equal(created.status, 201); assert.equal(created.body.request.address, 'другой адрес');
    assert.equal(created.body.request.latitude, null); assert.equal(created.body.request.longitude, null); assert.equal(created.body.request.mapUrl, null);
    assert.equal((await f.request('/api/trip-requests/geocode', 'POST', { requestId: created.body.request.id }, f.one.cookie)).body.status, 'not_found');
    for (let index = 0; index < 3; index++) await f.request('/api/trip-requests', 'GET', undefined, f.one.cookie);
    assert.equal(calls, 1);
    const replay = await f.request('/api/trip-requests', 'POST', body, f.one.cookie); assert.equal(replay.body.request.id, created.body.request.id);
    assert.equal((await f.request('/api/trip-requests', 'POST', { ...body, address: 'совсем другой адрес' }, f.one.cookie)).status, 409);
    for (const address of ['', '   ', 4, 'x'.repeat(2001)]) assert.equal((await f.request(`/api/trip-requests/${created.body.request.id}`, 'PATCH', { version: 1, quantityLitres: '1000', address }, f.one.cookie)).status, 400);
  } finally { await f.close(); }
});

test('saving delivery directory addresses starts search once and unchanged edits reuse their result', async () => {
  const queried: string[] = [];
  const f = await fixture({ tripRequestGeocoder: async address => { queried.push(address); return { status: 'not_found', message: 'Уточните адрес' }; } });
  try {
    const created = await f.request('/api/directories', 'POST', { kind: 'addresses', companyId: 'customer', addressKind: 'delivery', name: 'Синтетическая новая площадка', address: 'улица Пример, 1, Москва' }, f.admin);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.entry.id;
    await f.request('/api/trip-requests/geocode', 'POST', { companyId: 'customer', addressId: id }, f.one.cookie);
    assert.deepEqual(queried, ['улица Пример, 1, Москва']);
    const unchanged = await f.request(`/api/directories/addresses/${id}`, 'PATCH', { version: created.body.entry.version ?? 0, companyId: 'customer', addressKind: 'delivery', name: 'Переименованная площадка', address: 'улица Пример, 1, Москва' }, f.admin);
    assert.equal(unchanged.status, 200, JSON.stringify(unchanged.body));
    await f.request('/api/trip-requests/geocode', 'POST', { companyId: 'customer', addressId: id }, f.one.cookie);
    assert.equal(queried.length, 1);
  } finally { await f.close(); }
});


test('directory address changes drop resubmitted old pins, queue the new text, and preserve request snapshots', async () => {
  const queried: string[] = [];
  const f = await fixture({ tripRequestGeocoder: async address => { queried.push(address); return { status: 'not_found', message: 'Уточните адрес' }; } });
  try {
    const source = await f.create();
    const directory = (await f.store.read(f.source)).directories!.addresses.find(row => row.id === source.addressId)!;
    const changed = await f.request(`/api/directories/addresses/${source.addressId}`, 'PATCH', { ...directory, version: directory.version ?? 0, id: undefined, kind: undefined, companyId: 'customer', addressKind: 'delivery', name: directory.name, address: 'Новый адрес площадки', latitude: directory.latitude, longitude: directory.longitude }, f.admin);
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
    assert.equal(changed.body.entry.latitude, undefined); assert.equal(changed.body.entry.longitude, undefined); assert.equal(changed.body.entry.mapUrl, undefined);
    await f.request('/api/trip-requests/geocode', 'POST', { companyId: 'customer', addressId: source.addressId }, f.one.cookie);
    assert.deepEqual(queried, ['Новый адрес площадки']);
    const saved = (await f.store.read(f.source)).tripRequests![source.id];
    assert.equal(saved.address, source.address); assert.equal(saved.latitude, source.latitude); assert.equal(saved.longitude, source.longitude); assert.equal(saved.version, source.version);
    const selected = await f.request(`/api/directories/addresses/${source.addressId}`, 'PATCH', { version: changed.body.entry.version, companyId: 'customer', addressKind: 'delivery', name: directory.name, address: 'Ещё один адрес площадки', latitude: '55.7', longitude: '37.6', pointAddress: 'Ещё один адрес площадки' }, f.admin);
    assert.equal(selected.status, 200, JSON.stringify(selected.body)); assert.equal(selected.body.entry.latitude, '55.7');
    assert.equal(selected.body.entry.pointAddress, undefined);
  } finally { await f.close(); }
});

test('request address override cannot inherit the cached automatic point of its selected directory address', async () => {
  const point = { status: 'found' as const, latitude: 55.6, longitude: 37.4, source: 'geocoder' as const, accuracy: 'building' as const };
  const override = 'другой точный адрес доставки';
  const f = await fixture({ tripRequestGeocoder: async address => address === override ? { status: 'not_found', message: 'Уточните адрес' } : point });
  try {
    const source = await f.create(1);
    assert.deepEqual((await f.request('/api/trip-requests/geocode', 'POST', { requestId: source.id }, f.one.cookie)).body, point);
    const created = await f.request('/api/trip-requests', 'POST', { companyId: source.companyId, addressId: source.addressId, address: override, quantityLitres: '1000', idempotencyKey: randomUUID() }, f.one.cookie);
    assert.equal(created.status, 201); assert.equal(created.body.request.address, override);
    assert.equal(created.body.request.latitude, null); assert.equal(created.body.request.longitude, null); assert.equal(created.body.request.locationSnapshot, undefined);
    assert.equal((await f.request('/api/trip-requests/geocode', 'POST', { requestId: created.body.request.id }, f.one.cookie)).body.status, 'not_found');
  } finally { await f.close(); }
});

test('pending geocode replies bind later polls to the same request version', async () => {
  let entered!: () => void, finish!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { finish = resolve; });
  let calls = 0;
  const f = await fixture({ tripRequestGeocoder: async () => { calls++; entered(); await blocked; return { status: 'found', latitude: 55, longitude: 37, source: 'geocoder', accuracy: 'building' }; } });
  try {
    const source = await f.create(1); await started;
    const first = await f.request('/api/trip-requests/geocode', 'POST', { requestId: source.id }, f.one.cookie);
    assert.equal(first.status, 200); assert.equal(first.body.status, 'pending'); assert.match(first.body.fingerprint, /^[a-f0-9]{64}$/);
    const changed = await f.request(`/api/trip-requests/${source.id}`, 'PATCH', { version: source.version, quantityLitres: source.quantityLitres, comment: 'Изменённая заявка' }, f.one.cookie);
    assert.equal(changed.status, 200);
    const stale = await f.request('/api/trip-requests/geocode', 'POST', { requestId: source.id, fingerprint: first.body.fingerprint }, f.one.cookie);
    assert.equal(stale.status, 409); assert.equal(calls, 1);
    finish(); await f.request('/api/trip-requests/geocode', 'POST', { requestId: source.id }, f.one.cookie);
  } finally { finish(); await f.close(); }
});


test('the first geocode POST rejects a version changed after the displayed request or directory snapshot', async () => {
  let calls = 0;
  const f = await fixture({ tripRequestGeocoder: async () => { calls++; return { status: 'not_found', message: 'Уточните адрес' }; } });
  try {
    const source = await f.create();
    const initial = await f.request('/api/trip-requests', 'GET', undefined, f.one.cookie);
    const shown = initial.body.requests.find((row: TripRequest) => row.id === source.id);
    const shownAddress = initial.body.addresses.find((row: { id: string }) => row.id === source.addressId);
    assert.equal(shown.version, 1); assert.equal(shownAddress.version, 0);
    const patched = await f.request(`/api/trip-requests/${source.id}`, 'PATCH', { version: source.version, quantityLitres: source.quantityLitres, latitude: '56', longitude: '38' }, f.one.cookie);
    assert.equal(patched.status, 200);
    const stale = await f.request('/api/trip-requests/geocode', 'POST', { requestId: source.id, version: shown.version }, f.one.cookie);
    assert.equal(stale.status, 409); assert.equal(calls, 0);
    const current = await f.request('/api/trip-requests/geocode', 'POST', { requestId: source.id, version: patched.body.request.version }, f.one.cookie);
    assert.equal(current.body.latitude, 56); assert.equal(current.body.longitude, 38);
    const directory = await f.request(`/api/directories/addresses/${source.addressId}`, 'PATCH', { companyId: source.companyId, addressKind: 'delivery', name: shownAddress.name, address: shownAddress.address, version: shownAddress.version, latitude: '57', longitude: '39' }, f.admin);
    assert.equal(directory.status, 200, JSON.stringify(directory.body));
    const staleAddress = await f.request('/api/trip-requests/geocode', 'POST', { companyId: source.companyId, addressId: source.addressId, version: shownAddress.version }, f.one.cookie);
    assert.equal(staleAddress.status, 409); assert.equal(calls, 0);
    const currentAddress = await f.request('/api/trip-requests/geocode', 'POST', { companyId: source.companyId, addressId: source.addressId, version: directory.body.entry.version }, f.one.cookie);
    assert.equal(currentAddress.body.latitude, 57); assert.equal(currentAddress.body.longitude, 39);
    for (const version of [-1, '1', null, 1.5]) assert.equal((await f.request('/api/trip-requests/geocode', 'POST', { requestId: source.id, version }, f.one.cookie)).status, 400);
  } finally { await f.close(); }
});

test('request price is optional, normalized, persisted, versioned, clearable and part of creation replay identity', async () => {
  const f = await fixture();
  try {
    const legacy = await f.create();
    assert.equal(legacy.salePricePerLitre, undefined);
    const body = { companyId: 'customer', addressId: 'delivery', quantityLitres: '15000', salePricePerLitre: '65,50', idempotencyKey: randomUUID() };
    const created = await f.request('/api/trip-requests', 'POST', body, f.one.cookie);
    assert.equal(created.status, 201); const source = created.body.request as TripRequest;
    assert.equal(source.salePricePerLitre, '65.5');
    assert.equal((await f.request('/api/trip-requests', 'POST', body, f.one.cookie)).body.request.id, source.id);
    assert.equal((await f.request('/api/trip-requests', 'POST', { ...body, salePricePerLitre: '66' }, f.one.cookie)).status, 409);
    assert.equal((await f.request('/api/trip-requests', 'GET', undefined, f.two.cookie)).body.requests.find((row: TripRequest) => row.id === source.id).salePricePerLitre, '65.5');
    const updated = await f.request(`/api/trip-requests/${source.id}`, 'PATCH', { version: source.version, quantityLitres: '15000', salePricePerLitre: '65' }, f.one.cookie);
    assert.equal(updated.status, 200); assert.equal(updated.body.request.salePricePerLitre, '65');
    assert.equal((await f.request(`/api/trip-requests/${source.id}`, 'PATCH', { version: source.version, quantityLitres: '15000', salePricePerLitre: '70' }, f.one.cookie)).status, 409);
    const preserved = await f.request(`/api/trip-requests/${source.id}`, 'PATCH', { version: updated.body.request.version, quantityLitres: '15001' }, f.one.cookie);
    assert.equal(preserved.status, 200); assert.equal(preserved.body.request.salePricePerLitre, '65');
    const cleared = await f.request(`/api/trip-requests/${source.id}`, 'PATCH', { version: preserved.body.request.version, quantityLitres: '15000', salePricePerLitre: null }, f.one.cookie);
    assert.equal(cleared.status, 200); assert.equal(cleared.body.request.salePricePerLitre, null);
    const blank = await f.request('/api/trip-requests', 'POST', { ...body, idempotencyKey: randomUUID(), salePricePerLitre: '' }, f.one.cookie);
    assert.equal(blank.status, 201); assert.equal(blank.body.request.salePricePerLitre, undefined);
    for (const price of ['0', '-1', 'NaN', 'Infinity', '1e2', '65.0000001', 'x', '1'.repeat(41), 65, {}, []]) {
      assert.equal((await f.request('/api/trip-requests', 'POST', { ...body, idempotencyKey: randomUUID(), salePricePerLitre: price }, f.one.cookie)).status, 400, JSON.stringify(price));
    }
    const saved = await f.store.read(f.source);
    assert.equal(saved.tripRequests![source.id].salePricePerLitre, null);
    assert.equal(saved.tripRequests![legacy.id].salePricePerLitre, undefined);
  } finally { await f.close(); }
});

test('trip inherits request price and permits independent litre/price overrides without rewriting request price', async () => {
  const f = await fixture();
  try {
    for (const override of [false, true]) {
      const made = await f.request('/api/trip-requests', 'POST', { companyId: 'customer', addressId: 'delivery', quantityLitres: '15000', salePricePerLitre: '65' }, f.one.cookie);
      assert.equal(made.status, 201); const source = made.body.request as TripRequest;
      const body = f.tripBody([source]);
      if (override) { body.customers[0].fields.quantity_litres = '14500'; body.customers[0].fields.sale_price_per_litre = '67.5'; }
      else { delete (body.customers[0].fields as Record<string, string>).sale_price_per_litre; }
      const result = await f.request('/api/shipment-trips', 'POST', body, f.one.cookie);
      assert.equal(result.status, 201, JSON.stringify(result.body));
      const trip = result.body.trip as ShipmentTrip;
      assert.equal(trip.customers[0].fields.sale_price_per_litre, override ? '67.5' : '65');
      assert.equal(trip.customers[0].fields.quantity_litres, override ? '14500' : '15000');
      const edit = editing(trip); edit.customers[0].fields.sale_price_per_litre = '68';
      const changed = await f.request(`/api/shipment-trips/${trip.id}`, 'PATCH', edit, f.one.cookie);
      assert.equal(changed.status, 200, JSON.stringify(changed.body));
      assert.equal(changed.body.trip.customers[0].fields.sale_price_per_litre, '68');
      const saved = (await f.store.read(f.source)).tripRequests![source.id];
      assert.equal(saved.salePricePerLitre, '65'); assert.equal(saved.quantityLitres, '15000');
    }
    const legacy = await f.create(); const body = f.tripBody([legacy]);
    delete (body.customers[0].fields as Record<string, string>).sale_price_per_litre;
    assert.equal((await f.request('/api/shipment-trips', 'POST', body, f.one.cookie)).status, 400);
    body.customers[0].fields.sale_price_per_litre = '69';
    assert.equal((await f.request('/api/shipment-trips', 'POST', body, f.one.cookie)).status, 201);
  } finally { await f.close(); }
});

test('execution dates persist, sort earliest first, validate and protect retries and versions', async () => {
  const f = await fixture();
  try {
    const legacy = await f.create();
    const body = { companyId: 'customer', addressId: 'delivery', quantityLitres: '1000', executionDate: '2026-10-29', idempotencyKey: randomUUID() };
    const created = await f.request('/api/trip-requests', 'POST', body, f.one.cookie);
    assert.equal(created.status, 201); const dated = created.body.request;
    assert.equal(dated.executionDate, body.executionDate);
    const repeated = await f.request('/api/trip-requests', 'POST', body, f.one.cookie);
    assert.equal(repeated.body.request.id, dated.id);
    assert.equal((await f.request('/api/trip-requests', 'POST', { ...body, executionDate: '2026-10-30' }, f.one.cookie)).status, 409);
    for (const date of ['2026-02-30', '2026-13-01', '2026-1-01', '0000-01-01', 1, {}, '2026-10-29T12:00:00Z']) {
      assert.equal((await f.request('/api/trip-requests', 'POST', { ...body, executionDate: date, idempotencyKey: randomUUID() }, f.one.cookie)).status, 400);
    }
    const updated = await f.request(`/api/trip-requests/${legacy.id}`, 'PATCH', { version: legacy.version, quantityLitres: legacy.quantityLitres, executionDate: '2026-10-28' }, f.two.cookie);
    assert.equal(updated.status, 200); assert.equal(updated.body.request.executionDate, '2026-10-28');
    assert.equal((await f.request(`/api/trip-requests/${legacy.id}`, 'PATCH', { version: legacy.version, quantityLitres: legacy.quantityLitres, executionDate: '2026-10-27' }, f.one.cookie)).status, 409);
    const undated = await f.create(2);
    assert.deepEqual((await f.request('/api/trip-requests', 'GET', undefined, f.one.cookie)).body.requests.map((r: TripRequest) => r.id), [legacy.id, dated.id, undated.id]);
    const preserved = await f.request(`/api/trip-requests/${dated.id}`, 'PATCH', { version: dated.version, quantityLitres: '2000' }, f.one.cookie);
    assert.equal(preserved.body.request.executionDate, body.executionDate);
    const cleared = await f.request(`/api/trip-requests/${dated.id}`, 'PATCH', { version: preserved.body.request.version, quantityLitres: '2000', executionDate: null }, f.one.cookie);
    assert.equal(cleared.body.request.executionDate, null);
    const disk = await f.store.read(f.source);
    assert.equal(disk.tripRequests?.[legacy.id].executionDate, '2026-10-28');
    assert.equal(disk.tripRequests?.[dated.id].executionDate, null);
  } finally { await f.close(); }
});

test('request projection and trips context preserve the existing catalog and permission scopes', async () => {
  const { currentSnapshot, currentTripRequestSnapshot } = await import('../server/shipment-operations');
  const { tripRequestCatalog } = await import('../server/trip-requests');
  const { scopeSnapshot } = await import('../server/auth-scope');
  const f = await fixture(); try {
    // Historical shipment roles must still make a company available in the shared queue.
    await f.store.mutate(f.source, data => { data.companies.find(row => row.id === 'customer')!.roles = []; return { changed: true, result: null }; });
    const data = await f.store.read(f.source), full = currentSnapshot(f.base, data, false), lean = currentTripRequestSnapshot(f.base, data);
    assert.deepEqual(tripRequestCatalog(lean), tripRequestCatalog(full));
    for (const credential of [f.admin, f.one.cookie, f.two.cookie]) {
      const session = await f.request('/api/auth/session', 'GET', undefined, credential);
      const actor = data.accounts!.users.find(user => user.id === session.body.user.id)!;
      const expected = scopeSnapshot(full, actor);
      const context = await f.request('/api/trip-requests/context', 'GET', undefined, credential);
      assert.equal(context.status, 200); assert.deepEqual(context.body, JSON.parse(JSON.stringify({ companies: expected.companies, directories: expected.directories })));
      assert.equal(Object.hasOwn(context.body, 'payments'), false);
    }
    const denied = await f.employee('context-denied', 'no-trips-manager', []);
    assert.equal((await f.request('/api/trip-requests/context', 'GET', undefined, denied.cookie)).status, 403);
    assert.equal((await f.request('/api/trip-requests/context')).status, 401);
    assert.equal((await f.request('/api/trip-requests/context', 'POST', {}, f.admin)).status, 405);
  } finally { await f.close(); }
});

test('partitioned requests preserve Work, history, idempotency, trip consumption and restart/export', async () => {
  const { migrateWorkStorage, mergeWorkStorage, WorkPartition } = await import('../server/work-partition');
  const f = await fixture(); try {
    await migrateWorkStorage(dirname(f.store.path), f.source);
    const part = new WorkPartition(f.store.path), before = await f.store.read(f.source), work = await readFile(part.workPath, 'utf8');
    const input = { companyId: 'customer', addressId: 'delivery', quantityLitres: '1000', salePricePerLitre: '61.25', executionDate: '2026-10-30', idempotencyKey: randomUUID() };
    const created = await f.request('/api/trip-requests', 'POST', input, f.one.cookie);
    assert.equal(created.status, 201); const request = created.body.request;
    assert.equal((await f.request('/api/trip-requests', 'POST', input, f.one.cookie)).body.request.id, request.id);
    assert.equal((await f.request('/api/trip-requests/' + request.id, 'DELETE', { version: 99 }, f.one.cookie)).status, 409);
    const consumed = await f.request('/api/shipment-trips', 'POST', f.tripBody([request]), f.one.cookie);
    assert.equal(consumed.status, 201, JSON.stringify(consumed.body));
    assert.equal((await f.request('/api/trip-requests/' + request.id, 'DELETE', { version: request.version }, f.one.cookie)).status, 409);
    const cancelled = await f.create(2); assert.equal((await f.request('/api/trip-requests/' + cancelled.id, 'DELETE', { version: cancelled.version }, f.two.cookie)).status, 200);
    const after = await new OperationsStore(dirname(f.store.path)).read(f.source);
    assert.equal(after.tripRequests![request.id].status, 'consumed'); assert.equal(after.tripRequests![cancelled.id].status, 'cancelled');
    assert.equal(after.tripRequests![request.id].executionDate, input.executionDate);
    assert.deepEqual(after.directories, before.directories); assert.deepEqual(after.accounts, before.accounts);
    for (const [id, row] of Object.entries(before.shipments)) assert.deepEqual(after.shipments[id], row);
    assert.equal(await readFile(part.workPath, 'utf8'), work);
    await mergeWorkStorage(dirname(f.store.path), f.source); assert.deepEqual(await f.store.read(f.source), after);
  } finally { await f.close(); }
});

test('separate request admission reauthorizes revoked accounts inside the transaction', async () => {
  const { migrateWorkStorage } = await import('../server/work-partition');
  const f = await fixture(); try {
    await migrateWorkStorage(dirname(f.store.path), f.source);
    const original = f.store.mutateTripRequests.bind(f.store);
    f.store.mutateTripRequests = async (source, update) => {
      await f.store.mutate(source, data => { const user = data.accounts!.users.find(row => row.id === f.one.user.id)!; user.active = false; user.version++; return { changed: true, result: null }; });
      return original(source, update);
    };
    const before = (await f.store.read(f.source)).tripRequests;
    const response = await f.request('/api/trip-requests', 'POST', { companyId: 'customer', addressId: 'delivery', quantityLitres: '1000', idempotencyKey: randomUUID() }, f.one.cookie);
    assert.equal(response.status, 401); assert.deepEqual((await f.store.read(f.source)).tripRequests, before);
  } finally { await f.close(); }
});

test('request cancellation racing trip consumption has a single atomic winner on the split store', async () => {
  const { migrateWorkStorage } = await import('../server/work-partition');
  const f = await fixture(); try {
    await migrateWorkStorage(dirname(f.store.path), f.source); const row = await f.create();
    const [trip, cancelled] = await Promise.all([f.request('/api/shipment-trips', 'POST', f.tripBody([row]), f.one.cookie), f.request('/api/trip-requests/' + row.id, 'DELETE', { version: row.version }, f.two.cookie)]);
    assert.ok(trip.status === 201 && cancelled.status === 409 || trip.status === 409 && cancelled.status === 200, JSON.stringify([trip, cancelled]));
    const stored = await f.store.read(f.source), saved = stored.tripRequests![row.id];
    assert.equal(saved.version, row.version + 1);
    assert.equal(saved.status, trip.status === 201 ? 'consumed' : 'cancelled');
    if (saved.status === 'consumed') assert.equal(stored.shipments[saved.shipmentId!].fields.source_request_id, row.id);
    else assert.equal(Object.values(stored.shipments).filter(shipment => shipment.fields.source_request_id === row.id).length, 0);
  } finally { await f.close(); }
});
