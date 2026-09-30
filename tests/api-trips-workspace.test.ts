import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createSnapshotMiddleware, loadSnapshot } from '../server/local-api';
import { OperationsStore, decodeOperations, encodeOperations } from '../server/operations-store';
import { currentSnapshot } from '../server/shipment-operations';
import { getShipmentTrip } from '../server/shipment-trips';
import type { ShipmentTrip, Snapshot } from '../web/src/model';
import { driverTransportDetails } from '../server/driver-transport-details';

test('optional driver transport details normalize date and license identifiers without requesting extra documents', () => {
  assert.deepEqual(driverTransportDetails({}), {});
  assert.deepEqual(driverTransportDetails({ licenseSeries: '11 22', licenseNumber: '123456', licenseIssuedAt: '28.09.2026' }), { licenseSeries: '1122', licenseNumber: '123456', licenseIssuedAt: '2026-09-28' });
  for (const invalid of [{ licenseSeries: '123' }, { licenseNumber: '12345x' }, { inn: '123456789012' }, { licenseIssuedAt: '31.02.2026' }]) assert.throws(() => driverTransportDetails(invalid));
});

async function runtime() {
  const folder = await mkdtemp(resolve(tmpdir(), 'artel-trips-workspace-'));
  const base = await loadSnapshot();
  const store = new OperationsStore(folder);
  await store.mutate(base.provenance.sourceSha256, data => {
    data.sourceOperationsCleared = true;
    for (const [id, role] of [['trip-supplier','supplier'],['trip-client-a','customer'],['trip-client-b','customer']]) data.companies.push({ id, name: id, roles: [role], shipmentIds: [], paymentIds: [], managerLabels: [], flags: [] });
    data.directories!.managers.push({ id: 'trip-manager-a', name: 'Trip manager A' }, { id: 'trip-manager-b', name: 'Trip manager B' });
    data.directories!.customerManagers = [{ companyId: 'trip-client-a', managerId: 'trip-manager-a' }, { companyId: 'trip-client-b', managerId: 'trip-manager-b' }];
    return { result: null, changed: true };
  });
  const middleware = createSnapshotMiddleware(undefined, { operationsDirectory: folder });
  const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end(); }));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (path: string, method = 'GET', data?: unknown, cookie?: string) => fetch(url + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const password = randomUUID();
  const setup = await request('/api/auth/setup', 'POST', { name: 'Trip director', login: 'trips-owner', password });
  assert.equal(setup.status, 200);
  const admin = setup.headers.get('set-cookie')!.split(';')[0];
  const snapshot = await (await request('/api/snapshot', 'GET', undefined, admin)).json() as Snapshot;
  const catalog = snapshot.directories!;
  const sample = (clients = ['a']) => ({ idempotencyKey: randomUUID(), fields: { date: '2026-09-28', supplier_id: 'trip-supplier', product_id: catalog.products[0].id, purchase_price_unspecified_unit: '60000', quantity_tonnes: '16', driver_id: catalog.drivers[0].id, vehicle_id: catalog.vehicles[0].id, trip_notes: 'Actual route note', loading_planned_at: '2026-09-28T08:30' }, customers: clients.map(client => ({ fields: { customer_id: `trip-client-${client}`, manager_id: `trip-manager-${client}`, payment_form_id: catalog.paymentForms[0].id, quantity_litres: '8000', sale_price_per_litre: '65', transport_amount: '8000', invoice_not_required: 'true', delivery_notes: 'Gate 2' } })) });
  return { folder, base, store, request, admin, password, sample, async close() { await new Promise<void>(done => server.close(() => done())); await rm(folder, { recursive: true, force: true }); } };
}
const edit = (trip: ShipmentTrip) => ({ fields: { ...trip.fields }, customers: trip.customers.map(({ id, fields }) => ({ id, fields: { ...fields } })), versions: Object.fromEntries(trip.customers.map(row => [row.id, row.version])) });

test('trip create retries are durable and concurrent, changed payload and deleted replay cannot duplicate shipments', async () => {
  const r = await runtime();
  try {
    const body = r.sample(['a','b']);
    const responses = await Promise.all([1,2].map(() => r.request('/api/shipment-trips', 'POST', body, r.admin)));
    assert.deepEqual(responses.map(response => response.status), [201,201]);
    const [one, two] = await Promise.all(responses.map(response => response.json()));
    assert.equal(one.trip.id, two.trip.id);
    assert.equal((await (await r.request('/api/shipment-trips', 'GET', undefined, r.admin)).json()).trips.length, 1);
    const stored = await r.store.read(r.base.provenance.sourceSha256);
    assert.equal(Object.values(stored.shipments).filter(row => !row.deleted).length, 2);
    assert.deepEqual(decodeOperations(encodeOperations(stored), r.base.provenance.sourceSha256).tripCreateRequests, stored.tripCreateRequests);
    const changed = structuredClone(body); changed.fields.quantity_tonnes = '17';
    assert.equal((await r.request('/api/shipment-trips', 'POST', changed, r.admin)).status, 409);
    const deletion = await r.request(`/api/shipment-trips/${one.trip.id}`, 'DELETE', { versions: edit(one.trip).versions }, r.admin);
    assert.equal(deletion.status, 200);
    assert.equal((await r.request('/api/shipment-trips', 'POST', body, r.admin)).status, 409);
  } finally { await r.close(); }
});

test('oil depot places and maps persist as historical snapshots and validate URLs', async () => {
  const r = await runtime();
  try {
    const location = { kind: 'oilDepots', ownerCompanyId: 'trip-supplier', name: 'Terminal', address: 'Physical site, gate 1', mapUrl: 'https://yandex.ru/maps/?ll=37.6%2C55.7', latitude: '55.7', longitude: '37.6' };
    for (const invalid of [{ mapUrl: 'javascript:alert(1)' }, { mapUrl: 'https://evil.example/' }, { latitude: '91' }, { longitude: '' }]) assert.equal((await r.request('/api/directories','POST',{ ...location, ...invalid },r.admin)).status,400);
    const added = await (await r.request('/api/directories','POST',location,r.admin)).json();
    const duplicate = await (await r.request('/api/directories','POST',location,r.admin)).json();
    assert.equal(added.entry.id, duplicate.entry.id);
    const body = { ...r.sample(), fields: { ...r.sample().fields, oil_depot_id: added.entry.id } };
    const created = await (await r.request('/api/shipment-trips','POST',body,r.admin)).json();
    assert.equal(created.trip.fields.loading_address, location.address);
    assert.equal(created.trip.fields.loading_map_url, location.mapUrl);
    assert.equal(created.trip.customers[0].fields.invoice_not_required, 'true');
    const { kind: _kind, ...locationEdit } = location; void _kind;
    assert.equal((await r.request(`/api/directories/oilDepots/${added.entry.id}`, 'PATCH', { ...locationEdit, version: 0, address: 'Changed physical site', mapUrl: 'https://yandex.ru/maps/' }, r.admin)).status, 200);
    const updated = await r.request(`/api/shipment-trips/${created.trip.id}`, 'PATCH', edit(created.trip), r.admin);
    assert.equal(updated.status,200,await updated.clone().text());
    const trip = (await updated.json()).trip;
    assert.equal(trip.fields.loading_address, location.address);
    assert.equal(trip.fields.loading_map_url, location.mapUrl);
    assert.equal((await r.request(`/api/directories/oilDepots/${added.entry.id}`, 'DELETE', { version: 1 }, r.admin)).status,409);
    const bad = edit(trip); bad.fields.loading_address = 'Forged site';
    assert.equal((await r.request(`/api/shipment-trips/${trip.id}`, 'PATCH', bad, r.admin)).status,400);
    for (const fields of [{ loading_actual_at: '2026-02-31T10:00' }, { loading_planned_at: 'tomorrow' }]) assert.equal((await r.request('/api/shipment-trips','POST',{ ...r.sample(), fields: { ...r.sample().fields, ...fields } },r.admin)).status,400);
    const invoice = r.sample(); invoice.customers[0].fields.invoice_not_required = 'yes';
    assert.equal((await r.request('/api/shipment-trips','POST',invoice,r.admin)).status,400);
  } finally { await r.close(); }
});

test('trips-only permissions preserve manager isolation, exclude mixed groups, and revoke sessions and APIs', async () => {
  const r = await runtime();
  try {
    const userBody = { name: 'Trip employee', login: 'trip-employee', password: r.password, role: 'manager', managerId: 'trip-manager-a', sections: ['trips'], active: true };
    const createdUser = await r.request('/api/auth/users', 'POST', userBody, r.admin);
    assert.equal(createdUser.status,201,await createdUser.clone().text());
    const user = (await createdUser.json()).user;
    const login = await r.request('/api/auth/login', 'POST', { login: userBody.login, password: r.password });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const own = await (await r.request('/api/shipment-trips','POST',r.sample(),cookie)).json();
    assert.ok(own.trip);
    const sabyPath = `/api/shipment-trips/${own.trip.id}/saby`;
    const readiness = await (await r.request(sabyPath, 'GET', undefined, cookie)).json();
    assert.equal(readiness.readiness.ready, false);
    assert.equal(readiness.saby.documents.length, 0);
    assert.equal((await r.request(sabyPath, 'POST', {}, cookie)).status, 422);
    assert.equal((await r.request(sabyPath, 'POST', { password: 'must-not-be-accepted' }, cookie)).status, 400);
    assert.equal((await r.store.read(r.base.provenance.sourceSha256)).saby, undefined);
    const mixed = await (await r.request('/api/shipment-trips','POST',r.sample(['a','b']),r.admin)).json();
    const foreign = await (await r.request('/api/shipment-trips','POST',r.sample(['b']),r.admin)).json();
    const listed = await (await r.request('/api/shipment-trips','GET',undefined,cookie)).json();
    assert.deepEqual(listed.trips.map((trip: ShipmentTrip) => trip.id),[own.trip.id]);
    assert.equal((await r.request(`/api/shipment-trips/${mixed.trip.id}`,'GET',undefined,cookie)).status,403);
    assert.equal((await r.request(`/api/shipment-trips/${foreign.trip.id}`,'GET',undefined,cookie)).status,404);
    assert.equal((await r.request('/api/shipment-trips','POST',r.sample(['b']),cookie)).status,403);
    assert.equal((await r.request('/api/shipments','GET',undefined,cookie)).status,403);
    const snap = await (await r.request('/api/snapshot','GET',undefined,cookie)).json();
    assert.ok(snap.shipments.every((row: { fields: Record<string,string> }) => row.fields.manager_id === 'trip-manager-a'));
    assert.equal((await r.request(`/api/auth/users/${user.id}`,'PATCH',{ ...userBody, version: user.version, password: '', sections: [] },r.admin)).status,200);
    assert.equal((await r.request('/api/shipment-trips','GET',undefined,cookie)).status,401);
    const relogin = await r.request('/api/auth/login','POST',{ login: userBody.login, password: r.password });
    const denied = relogin.headers.get('set-cookie')!.split(';')[0];
    for (const path of ['/api/shipment-trips',`/api/shipment-trips/${own.trip.id}`,`/api/shipment-trips/${own.trip.id}/saby`]) assert.equal((await r.request(path,'GET',undefined,denied)).status,403);
  } finally { await r.close(); }
});

test('intermediate stops and repeated recipients remain separate deliveries, retaining their route order across restart and legacy edits', async () => {
  const r = await runtime();
  try {
    const addressResponse = await r.request('/api/directories', 'POST', { kind: 'addresses', companyId: 'trip-client-a', addressKind: 'delivery', name: 'Repeated synthetic recipient site', address: 'Synthetic road, 1' }, r.admin);
    assert.equal(addressResponse.status, 201);
    const addressId = (await addressResponse.json()).entry.id;
    const sample = r.sample(['a', 'a']);
    const stops = [{ id: 'synthetic-stop-1', name: ' Tank service ', address: ' Synthetic service road, 2 ' }];
    const body = { ...sample, fields: { ...sample.fields, organization_id: 'artel', intermediate_stops_in_order: 'false' }, customers: sample.customers.map((row, index) => ({ fields: { ...row.fields, unloading_address_id: addressId, delivery_notes: `Delivery ${index + 1}`, intermediate_stops_after: index === 0 ? JSON.stringify(stops) : '' } })) };
    const response = await r.request('/api/shipment-trips', 'POST', body, r.admin);
    assert.equal(response.status, 201, await response.clone().text());
    const result = await response.json();
    const trip = result.trip as ShipmentTrip;
    assert.equal(trip.customers.length, 2);
    assert.notEqual(trip.customers[0].id, trip.customers[1].id);
    assert.equal(trip.customers[0].fields.unloading_address_id, trip.customers[1].fields.unloading_address_id);
    assert.deepEqual(JSON.parse(trip.customers[0].fields.intermediate_stops_after!), [{ id: 'synthetic-stop-1', name: 'Tank service', address: 'Synthetic service road, 2' }]);
    assert.equal(trip.customers[1].fields.intermediate_stops_after, null);
    assert.equal(trip.fields.intermediate_stops_in_order, 'false');
    const stored = await new OperationsStore(r.folder).read(r.base.provenance.sourceSha256);
    assert.deepEqual(getShipmentTrip(currentSnapshot(r.base, decodeOperations(encodeOperations(stored), r.base.provenance.sourceSha256)), trip.id), trip);
    assert.deepEqual(result.shipments.map((row: { fields: Record<string, string> }) => row.fields.trip_delivery_order), ['1', '2']);
    assert.equal(stored.saby, undefined);
    assert.equal(stored.etrn, undefined);
    assert.equal(stored.tripSaby, undefined);
    const replay = await (await r.request('/api/shipment-trips', 'POST', body, r.admin)).json();
    assert.deepEqual(replay.trip.customers.map((row: { id: string }) => row.id), trip.customers.map(row => row.id));
    const reordered = edit(trip);
    reordered.customers.reverse();
    delete reordered.fields.intermediate_stops_in_order;
    for (const row of reordered.customers) delete row.fields.intermediate_stops_after;
    const patched = await r.request(`/api/shipment-trips/${trip.id}`, 'PATCH', reordered, r.admin);
    assert.equal(patched.status, 200, await patched.clone().text());
    const updated = (await patched.json()).trip as ShipmentTrip;
    assert.deepEqual(updated.customers.map(row => row.id), [...trip.customers].reverse().map(row => row.id));
    assert.equal(updated.customers[0].fields.intermediate_stops_after, null);
    assert.equal(updated.customers[1].fields.intermediate_stops_after, trip.customers[0].fields.intermediate_stops_after);
    assert.equal(updated.fields.intermediate_stops_in_order, 'false');
    assert.deepEqual(updated.customers.map(row => row.fields.delivery_notes), ['Delivery 2', 'Delivery 1']);
    assert.ok(updated.customers.every(row => row.fields.invoice_not_required === 'true' && row.fields.transport_amount === '8000'));
    const loaded = await new OperationsStore(r.folder).read(r.base.provenance.sourceSha256);
    assert.deepEqual(getShipmentTrip(currentSnapshot(r.base, loaded), trip.id).customers.map(row => row.id), updated.customers.map(row => row.id));
    assert.equal(Object.values(loaded.shipments).filter(row => !row.deleted).length, 2);
    const beforeRead = encodeOperations(loaded);
    const workflow = await r.request(`/api/shipment-trips/${trip.id}/saby-workflow`, 'GET', undefined, r.admin);
    assert.equal(workflow.status, 200);
    assert.equal((await workflow.json()).ready, false);
    assert.equal(encodeOperations(await r.store.read(r.base.provenance.sourceSha256)), beforeRead);
  } finally { await r.close(); }
});

test('intermediate route rejects malformed stops atomically and permits an unsent trip with undecided order inclusion', async () => {
  const r = await runtime();
  try {
    const sample = r.sample();
    const validStop = { id: 'stop-1', name: 'Synthetic service stop', address: 'Synthetic address' };
    const before = encodeOperations(await r.store.read(r.base.provenance.sourceSha256));
    const invalidStops = ['{', '{}', 'null', JSON.stringify([{ ...validStop, name: '' }]), JSON.stringify([{ ...validStop, address: 'bad\nline' }]), JSON.stringify([validStop, validStop]), JSON.stringify([{ ...validStop, lat: '55' }]), JSON.stringify([{ ...validStop, id: '../bad' }]), JSON.stringify(Array.from({ length: 11 }, (_, index) => ({ ...validStop, id: `stop-${index}` })))];
    for (const intermediate_stops_after of invalidStops) {
      const request = { ...sample, idempotencyKey: randomUUID(), customers: [{ fields: { ...sample.customers[0].fields, intermediate_stops_after } }] };
      assert.equal((await r.request('/api/shipment-trips', 'POST', request, r.admin)).status, 400);
    }
    assert.equal((await r.request('/api/shipment-trips', 'POST', { ...sample, fields: { ...sample.fields, intermediate_stops_in_order: 'yes' } }, r.admin)).status, 400);
    assert.equal(encodeOperations(await r.store.read(r.base.provenance.sourceSha256)), before);
    const valid = { ...sample, customers: [{ fields: { ...sample.customers[0].fields, intermediate_stops_after: JSON.stringify([validStop]) } }] };
    const response = await r.request('/api/shipment-trips', 'POST', valid, r.admin);
    assert.equal(response.status, 201);
    const created = (await response.json()).trip as ShipmentTrip;
    assert.equal(created.fields.intermediate_stops_in_order, null);
    const clearing = edit(created);
    clearing.customers[0].fields.intermediate_stops_after = '';
    const cleared = await r.request(`/api/shipment-trips/${created.id}`, 'PATCH', clearing, r.admin);
    assert.equal(cleared.status, 200);
    assert.equal((await cleared.json()).trip.customers[0].fields.intermediate_stops_after, null);
  } finally { await r.close(); }
});

test('loading defaults to selected date without inventing time and old trips retain organization and financial inputs', async () => {
  const r = await runtime();
  try {
    const sample = r.sample(['a', 'a']);
    const fields: Record<string, string> = { ...sample.fields, organization_id: 'nk-artel', date: '2027-01-15' };
    delete fields.loading_planned_at;
    const response = await r.request('/api/shipment-trips', 'POST', { ...sample, fields }, r.admin);
    assert.equal(response.status, 201);
    const trip = (await response.json()).trip as ShipmentTrip;
    assert.equal(trip.fields.loading_planned_at, '2027-01-15');
    assert.equal(trip.fields.loading_actual_at, '2027-01-15');
    await r.store.mutate(r.base.provenance.sourceSha256, data => {
      for (const row of Object.values(data.shipments)) { delete row.fields.trip_delivery_order; delete row.fields.intermediate_stops_after; delete row.fields.intermediate_stops_in_order; }
      return { changed: true, result: null };
    });
    const previous = (await (await r.request(`/api/shipment-trips/${trip.id}`, 'GET', undefined, r.admin)).json()).trip as ShipmentTrip;
    assert.deepEqual(previous.customers.map(row => row.id), trip.customers.map(row => row.id));
    const legacy = edit(previous);
    delete legacy.fields.organization_id;
    delete legacy.fields.loading_planned_at;
    delete legacy.fields.intermediate_stops_in_order;
    const updated = await r.request(`/api/shipment-trips/${trip.id}`, 'PATCH', legacy, r.admin);
    assert.equal(updated.status, 200, await updated.clone().text());
    const result = (await updated.json()).trip as ShipmentTrip;
    assert.equal(result.fields.organization_id, 'nk-artel');
    assert.equal(result.fields.loading_planned_at, '2027-01-15');
    assert.equal(result.fields.purchase_price_unspecified_unit, sample.fields.purchase_price_unspecified_unit);
    assert.equal(result.fields.quantity_tonnes, sample.fields.quantity_tonnes);
    assert.deepEqual(result.customers.map(row => row.fields), previous.customers.map(row => row.fields));
  } finally { await r.close(); }
});

test('new supplier loading selections are rejected while untouched historical supplier snapshots survive', async () => {
  const r = await runtime();
  try {
    const location = await (await r.request('/api/directories', 'POST', { kind: 'addresses', companyId: 'trip-supplier', addressKind: 'loading', name: 'Legacy terminal', address: 'Legacy physical loading site' }, r.admin)).json();
    const sample = r.sample();
    const rejected = await r.request('/api/shipment-trips', 'POST', { ...sample, fields: { ...sample.fields, loading_address_id: location.entry.id } }, r.admin);
    assert.equal(rejected.status, 400);
    assert.match((await rejected.json()).error, /нефтебаз/);
    const created = await (await r.request('/api/shipment-trips', 'POST', r.sample(), r.admin)).json();
    await r.store.mutate(r.base.provenance.sourceSha256, data => {
      for (const row of Object.values(data.shipments).filter(row => row.fields.trip_id === created.trip.id)) {
        row.fields.loading_address_id = location.entry.id;
        row.fields.loading_address = 'Historical saved loading site';
      }
      return { result: null, changed: true };
    });
    const oldTrip = getShipmentTrip(currentSnapshot(r.base, await r.store.read(r.base.provenance.sourceSha256)), created.trip.id);
    const input = edit(oldTrip); input.fields.trip_notes = 'Only a historical note changed';
    const saved = await r.request(`/api/shipment-trips/${oldTrip.id}`, 'PATCH', input, r.admin);
    assert.equal(saved.status, 200, await saved.clone().text());
    assert.equal((await saved.json()).trip.fields.loading_address, 'Historical saved loading site');
    const second = await (await r.request('/api/directories', 'POST', { kind: 'addresses', companyId: 'trip-supplier', addressKind: 'loading', name: 'Another legacy terminal' }, r.admin)).json();
    const latest = getShipmentTrip(currentSnapshot(r.base, await r.store.read(r.base.provenance.sourceSha256)), oldTrip.id);
    const changed = edit(latest); changed.fields.loading_address_id = second.entry.id;
    assert.equal((await r.request(`/api/shipment-trips/${oldTrip.id}`, 'PATCH', changed, r.admin)).status, 400);
  } finally { await r.close(); }
});
