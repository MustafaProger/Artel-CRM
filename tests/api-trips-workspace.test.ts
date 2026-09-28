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

test('actual places and maps persist as historical snapshots, validate URLs and preserve company-card edits', async () => {
  const r = await runtime();
  try {
    const location = { kind: 'addresses', companyId: 'trip-supplier', addressKind: 'loading', name: 'Terminal', address: 'Physical site, gate 1', mapUrl: 'https://yandex.ru/maps/?ll=37.6%2C55.7', latitude: '55.7', longitude: '37.6' };
    for (const invalid of [{ mapUrl: 'javascript:alert(1)' }, { mapUrl: 'https://evil.example/' }, { latitude: '91' }, { longitude: '' }]) assert.equal((await r.request('/api/directories','POST',{ ...location, ...invalid },r.admin)).status,400);
    const added = await (await r.request('/api/directories','POST',location,r.admin)).json();
    const duplicate = await (await r.request('/api/directories','POST',location,r.admin)).json();
    assert.equal(added.entry.id, duplicate.entry.id);
    const body = { ...r.sample(), fields: { ...r.sample().fields, loading_address_id: added.entry.id } };
    const created = await (await r.request('/api/shipment-trips','POST',body,r.admin)).json();
    assert.equal(created.trip.fields.loading_address, location.address);
    assert.equal(created.trip.fields.loading_map_url, location.mapUrl);
    assert.equal(created.trip.customers[0].fields.invoice_not_required, 'true');
    const { kind: _kind, ...locationEdit } = location; void _kind;
    assert.equal((await r.request(`/api/directories/addresses/${added.entry.id}`, 'PATCH', { ...locationEdit, version: 0, address: 'Changed physical site', mapUrl: 'https://yandex.ru/maps/' }, r.admin)).status, 200);
    const updated = await r.request(`/api/shipment-trips/${created.trip.id}`, 'PATCH', edit(created.trip), r.admin);
    assert.equal(updated.status,200,await updated.clone().text());
    const trip = (await updated.json()).trip;
    assert.equal(trip.fields.loading_address, location.address);
    assert.equal(trip.fields.loading_map_url, location.mapUrl);
    assert.equal((await r.request(`/api/directories/addresses/${added.entry.id}`, 'DELETE', { version: 1 }, r.admin)).status,409);
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
