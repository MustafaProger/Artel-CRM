import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import Decimal from 'decimal.js';
import { createSnapshotMiddleware, loadSnapshot } from './test-api';
import { OperationsStore } from '../server/operations-store';
import type { Shipment, ShipmentTrip, ShipmentTripResponse, Snapshot } from '../web/src/model';
import { allocateTrip } from '../web/src/trip-calculations';

const source = await loadSnapshot();
const customerIds = source.companies.filter(row => row.roles.includes('customer')).slice(0, 3).map(row => row.id);
const supplierId = source.companies.find(row => row.roles.includes('supplier'))!.id;
const json = (value: unknown) => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
const close = (server: Server) => new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
async function serve(directory: string) {
  const middleware = createSnapshotMiddleware(undefined, { operationsDirectory: directory });
  const server = createServer((request, response) => middleware(request, response, () => { response.writeHead(404); response.end(); }));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = async <T>(path: string) => (await (await fetch(url + path)).json()) as T;
  const snapshot = await get<Snapshot>('/api/snapshot?shipments=omit');
  const catalog = snapshot.directories!;
  const request = (method: string, path: string, data: unknown) => fetch(url + path, { method, ...json(data) });
  const sample = () => ({ fields: { date: '2027-03-01', supplier_id: supplierId, product_id: catalog.products[0].id, purchase_price_unspecified_unit: '60000', quantity_tonnes: '16', driver_id: catalog.drivers[0].id, vehicle_id: catalog.vehicles[1].id, additional_costs: '1600' }, customers: customerIds.slice(0, 2).map((customer_id, index) => ({ fields: { customer_id, manager_id: catalog.managers[0].id, payment_form_id: catalog.paymentForms[index].id, quantity_litres: index ? '6000' : '10000', sale_price_per_litre: '65', transport_amount: index ? '600' : '1000' } })) });
  return { server, url, get, request, sample, catalog };
}
const edit = (trip: ShipmentTrip) => ({ fields: { ...trip.fields }, customers: trip.customers.map(({ id, fields }) => ({ id, fields: { ...fields } })), versions: Object.fromEntries(trip.customers.map(row => [row.id, row.version])) });
const sum = (values: string[]) => values.reduce((value, next) => value.plus(next), new Decimal(0)).toFixed();

test('truck allocation exactly conserves decimal tonnes and expenses including thirds and tiny totals', () => {
  assert.deepEqual(allocateTrip('16', ['10000', '6000'], '1600'), { totalLitres: '16000', tonnes: ['10', '6'], additionalCosts: ['1000', '600'] });
  const thirds = allocateTrip('1', ['1', '1', '1'], '0.01');
  assert.deepEqual(thirds.tonnes, ['0.333334', '0.333333', '0.333333']);
  assert.equal(sum(thirds.tonnes), '1'); assert.equal(sum(thirds.additionalCosts), '0.01');
  const precise = allocateTrip('0.000000019', ['2', '1'], '0.001');
  assert.equal(sum(precise.tonnes), '0.000000019'); assert.equal(sum(precise.additionalCosts), '0.001');
  assert.equal(allocateTrip('16,5', ['10 000', '6 000'], '1 000,12').totalLitres, '16000');
  for (const [tonnes, litres, costs] of [['0', ['1'], '0'], ['-1', ['1'], '0'], ['NaN', ['1'], '0'], ['1e12', ['1'], '0'], ['1', ['0'], '0'], ['1', ['-1'], '0'], ['1', [], '0'], ['1', ['1'], '-1'], ['1', ['0.0000000001', '10000000000'], '0']] as [string, string[], string][]) assert.throws(() => allocateTrip(tonnes, litres, costs));
});

test('truck creation is atomic, derives proportional rows, keeps vehicle override and survives restart', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'artel-trip-create-'));
  let runtime = await serve(directory);
  try {
    const invalid = runtime.sample(); invalid.customers[1].fields.customer_id = 'missing-customer';
    assert.equal((await runtime.request('POST', '/api/shipment-trips', invalid)).status, 400);
    assert.equal((await runtime.get<Snapshot>('/api/snapshot?shipments=omit')).overview.shipmentCount, source.shipments.length);
    await assert.rejects(readFile(resolve(directory, 'operations.json')), { code: 'ENOENT' });
    const response = await runtime.request('POST', '/api/shipment-trips', runtime.sample());
    assert.equal(response.status, 201, await response.clone().text());
    const created = await response.json() as ShipmentTripResponse;
    assert.equal(created.shipments.length, 2); assert.equal(created.shipment.id, created.shipments[0].id);
    assert.deepEqual(created.shipments.map(row => row.fields.quantity_tonnes), ['10', '6']);
    assert.deepEqual(created.shipments.map(row => row.fields.purchase_amount), ['600000', '360000']);
    assert.deepEqual(created.shipments.map(row => row.fields.additional_costs), ['1000', '600']);
    assert.deepEqual(created.shipments.map(row => row.fields.customer_amount), ['650000', '390000']);
    assert.ok(created.shipments.every(row => row.fields.trip_id === created.trip.id && row.fields.trip_total_tonnes === '16' && row.fields.purchase_unit === 'tonnes' && row.fields.vehicle_id === runtime.catalog.vehicles[1].id));
    assert.ok(created.shipments.every(row => row.fields.document_number === null));
    assert.equal(created.trip.fields.quantity_tonnes, '16'); assert.equal(created.trip.fields.additional_costs, '1600');
    for (const row of created.shipments) {
      assert.equal((await runtime.request('PATCH', `/api/shipments/${row.id}`, { version: 1, fields: { quantity_tonnes: '2' } })).status, 409);
      assert.equal((await runtime.request('DELETE', `/api/shipments/${row.id}`, { version: 1 })).status, 409);
    }
    assert.equal((await runtime.request('POST', '/api/shipments', { fields: { trip_id: created.trip.id } })).status, 400);
    const beforeRestart = await runtime.get<{ trip: ShipmentTrip }>(`/api/shipment-trips/${created.trip.id}`);
    await close(runtime.server); runtime = await serve(directory);
    assert.deepEqual(await runtime.get(`/api/shipment-trips/${created.trip.id}`), beforeRestart);
    for (const row of created.shipments) assert.deepEqual((await runtime.get<{ shipment: Shipment }>(`/api/shipments/${row.id}`)).shipment, row);
  } finally { await close(runtime.server); await rm(directory, { recursive: true, force: true }); }
});

test('truck edit/add/remove validates the complete version set and concurrent edits have one winner', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'artel-trip-edit-'));
  const runtime = await serve(directory);
  const second = await serve(directory);
  try {
    const created = await (await runtime.request('POST', '/api/shipment-trips', runtime.sample())).json() as ShipmentTripResponse;
    const path = `/api/shipment-trips/${created.trip.id}`;
    const stale = edit(created.trip);
    const before = await readFile(resolve(directory, 'operations.json'), 'utf8');
    const invalid = edit(created.trip); invalid.customers[1].fields.quantity_litres = '0';
    assert.equal((await runtime.request('PATCH', path, invalid)).status, 400);
    assert.equal(await readFile(resolve(directory, 'operations.json'), 'utf8'), before);
    const duplicate = edit(created.trip); duplicate.customers[1].id = duplicate.customers[0].id;
    assert.equal((await runtime.request('PATCH', path, duplicate)).status, 400);
    const omitted = edit(created.trip); delete omitted.versions[created.trip.customers[1].id];
    assert.equal((await runtime.request('PATCH', path, omitted)).status, 409);
    const additions = { ...edit(created.trip), customers: [...edit(created.trip).customers, { fields: { ...created.trip.customers[0].fields, customer_id: customerIds[2], quantity_litres: '4000' } }] };
    const addedResponse = await runtime.request('PATCH', path, additions);
    assert.equal(addedResponse.status, 200, await addedResponse.clone().text());
    const added = await addedResponse.json() as ShipmentTripResponse;
    assert.deepEqual(added.shipments.map(row => row.fields.quantity_tonnes), ['8', '4.8', '3.2']);
    assert.deepEqual(added.shipments.map(row => row.version), [2, 2, 1]);
    assert.equal((await runtime.request('PATCH', path, stale)).status, 409);
    const versionsMissingNew = edit(added.trip); delete versionsMissingNew.versions[added.trip.customers[2].id];
    assert.equal((await runtime.request('PATCH', path, versionsMissingNew)).status, 409);
    const removal = edit(added.trip); removal.customers = removal.customers.slice(0, 2);
    const removed = await (await runtime.request('PATCH', path, removal)).json() as ShipmentTripResponse;
    assert.deepEqual(removed.shipments.map(row => row.fields.quantity_tonnes), ['10', '6']);
    assert.equal((await fetch(runtime.url + `/api/shipments/${added.trip.customers[2].id}`)).status, 404);
    const attempts = await Promise.all([runtime, second].map((server, index) => server.request('PATCH', path, { ...edit(removed.trip), fields: { ...removed.trip.fields, quantity_tonnes: `${17 + index}` } })));
    assert.deepEqual(attempts.map(response => response.status).sort(), [200, 409]);
    const current = await runtime.get<{ trip: ShipmentTrip }>(path);
    assert.deepEqual(await second.get(path), current);
  } finally { await close(runtime.server); await close(second.server); await rm(directory, { recursive: true, force: true }); }
});

test('trip updates retain payment allocations and reject removing a linked customer atomically', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'artel-trip-payments-'));
  const runtime = await serve(directory);
  try {
    const created = await (await runtime.request('POST', '/api/shipment-trips', runtime.sample())).json() as ShipmentTripResponse;
    const store = new OperationsStore(directory);
    const allocation = { id: 'allocation-trip-test', shipmentId: created.shipments[0].id, paymentId: source.payments[0].id, amount: '100', date: '2027-03-01' };
    await store.mutate(source.provenance.sourceSha256, data => { data.paymentAllocations!.push(allocation); return { result: null, changed: true }; });
    const body = edit(created.trip); body.customers[0].fields.sale_price_per_litre = '66';
    const response = await runtime.request('PATCH', `/api/shipment-trips/${created.trip.id}`, body);
    assert.equal(response.status, 200);
    const updated = await response.json() as ShipmentTripResponse;
    assert.equal(updated.shipments[0].fields.paid_amount_source, '100');
    assert.equal(updated.trip.customers[0].paidAmount, '100');
    assert.equal((await runtime.get<{ trip: ShipmentTrip }>(`/api/shipment-trips/${created.trip.id}`)).trip.customers[0].paidAmount, '100');
    assert.deepEqual((await store.read(source.provenance.sourceSha256)).paymentAllocations, [allocation]);
    const reassignment = edit(updated.trip); reassignment.customers[0].fields.customer_id = customerIds[2];
    const beforeReassignment = await readFile(store.path, 'utf8');
    assert.equal((await runtime.request('PATCH', `/api/shipment-trips/${created.trip.id}`, reassignment)).status, 409);
    assert.equal(await readFile(store.path, 'utf8'), beforeReassignment);
    const remove = edit(updated.trip); remove.customers = remove.customers.slice(1);
    const before = await readFile(store.path, 'utf8');
    assert.equal((await runtime.request('PATCH', `/api/shipment-trips/${created.trip.id}`, remove)).status, 409);
    assert.equal(await readFile(store.path, 'utf8'), before);
  } finally { await close(runtime.server); await rm(directory, { recursive: true, force: true }); }
});

test('single row vehicle overrides survive reads and driver changes choose a new default', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'artel-trip-vehicle-'));
  const runtime = await serve(directory);
  try {
    const payload = runtime.sample();
    const fields = { ...payload.fields, ...payload.customers[0].fields, quantity_tonnes: '16', purchase_unit: 'tonnes' };
    const createdResponse = await runtime.request('POST', '/api/shipments', { fields });
    assert.equal(createdResponse.status, 201);
    const created = (await createdResponse.json() as { shipment: Shipment }).shipment;
    assert.equal(created.fields.vehicle_id, runtime.catalog.vehicles[1].id);
    const driver = runtime.catalog.drivers.find(row => row.id !== fields.driver_id)!;
    const changed = await runtime.request('PATCH', `/api/shipments/${created.id}`, { version: 1, fields: { driver_id: driver.id } });
    assert.equal(changed.status, 200);
    const row = (await changed.json() as { shipment: Shipment }).shipment;
    assert.equal(row.fields.vehicle_id, driver.vehicleId);
    assert.equal((await runtime.request('PATCH', `/api/shipments/${created.id}`, { version: 2, fields: { vehicle_id: 'missing-vehicle' } })).status, 400);
    assert.equal((await runtime.get<{ shipment: Shipment }>(`/api/shipments/${created.id}`)).shipment.fields.vehicle_id, driver.vehicleId);
    const store = new OperationsStore(directory);
    await store.mutate(source.provenance.sourceSha256, data => { data.shipments[created.id].fields.vehicle_id = 'missing-stored-vehicle'; return { result: null, changed: true }; });
    assert.equal((await fetch(runtime.url + `/api/shipments/${created.id}`)).status, 500);
  } finally { await close(runtime.server); await rm(directory, { recursive: true, force: true }); }
});


test('whole truck deletion is atomic, requires all current versions and protects every linked client', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'artel-trip-delete-'));
  let runtime = await serve(directory);
  try {
    const created = await (await runtime.request('POST', '/api/shipment-trips', runtime.sample())).json() as ShipmentTripResponse;
    const path = `/api/shipment-trips/${created.trip.id}`;
    const versions = edit(created.trip).versions;
    const store = new OperationsStore(directory);
    const before = await readFile(store.path, 'utf8');
    assert.equal((await runtime.request('DELETE', path, { versions: { [created.trip.customers[0].id]: 1 } })).status, 409);
    assert.equal((await runtime.request('DELETE', path, { versions: { ...versions, [created.trip.customers[0].id]: 0 } })).status, 409);
    assert.equal(await readFile(store.path, 'utf8'), before);
    await store.mutate(source.provenance.sourceSha256, data => { data.paymentAllocations!.push({ id: 'trip-delete-linked', shipmentId: created.shipments[1].id, paymentId: source.payments[0].id, amount: '100', date: '2027-03-01' }); return { result: null, changed: true }; });
    const linked = await readFile(store.path, 'utf8');
    assert.equal((await runtime.request('DELETE', path, { versions })).status, 409);
    assert.equal(await readFile(store.path, 'utf8'), linked);
    await store.mutate(source.provenance.sourceSha256, data => { data.paymentAllocations = []; return { result: null, changed: true }; });
    const response = await runtime.request('DELETE', path, { versions });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { deleted: true, id: created.trip.id, deletedCount: 2 });
    assert.equal((await fetch(runtime.url + path)).status, 404);
    for (const row of created.shipments) assert.equal((await fetch(runtime.url + `/api/shipments/${row.id}`)).status, 404);
    assert.equal((await runtime.get<Snapshot>('/api/snapshot?shipments=omit')).overview.shipmentCount, source.shipments.length);
    await close(runtime.server); runtime = await serve(directory);
    assert.equal((await fetch(runtime.url + path)).status, 404);
  } finally { await close(runtime.server); await rm(directory, { recursive: true, force: true }); }
});
