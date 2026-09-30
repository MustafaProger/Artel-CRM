import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSnapshotMiddleware } from './test-api';
import type { Snapshot, ShipmentTrip, ShipmentTripResponse } from '../web/src/model';

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'artel-trip-input-'));
  const middleware = createSnapshotMiddleware(undefined, { operationsDirectory: directory });
  const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end(); }));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(url + path, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const snapshot = (await request('GET', '/api/snapshot')).body as Snapshot;
  const directories = snapshot.directories!;
  const sample = (productId: string) => ({ fields: { date: '2026-09-30', loading_at: '2026-09-30T10:15', supplier_id: snapshot.companies.find(c => c.roles.includes('supplier'))!.id, product_id: productId, quantity_tonnes: '8.125', driver_id: directories.drivers[0].id, vehicle_id: directories.vehicles[0].id, purchase_price_unspecified_unit: '60000' } as Record<string, string | null>, customers: [{ fields: { customer_id: snapshot.companies.find(c => c.roles.includes('customer'))!.id, manager_id: directories.managers[0].id, payment_form_id: directories.paymentForms[0].id, quantity_litres: '10000', sale_price_per_litre: '70' } as Record<string, string | null> }] });
  return { request, snapshot, sample, close: async () => { await new Promise<void>(done => server.close(() => done())); await rm(directory, { recursive: true, force: true }); } };
}
const edit = (trip: ShipmentTrip) => ({ fields: { ...trip.fields }, versions: Object.fromEntries(trip.customers.map(row => [row.id, row.version])), customers: trip.customers.map(row => ({ id: row.id, fields: { ...row.fields } })) });

test('bulk diesel uses one positive cargo mass; other and packaged products preserve distinct gross mass', async () => {
  const r = await setup();
  try {
    for (const cargoPackaging of ['bulk', 'packaged', undefined]) {
      const product = await r.request('POST', '/api/directories', { kind: 'products', name: `QA дизель ${cargoPackaging}`, transportProductKind: 'diesel', cargoPackaging });
      assert.equal(product.status, 201);
      const body = r.sample(product.body.entry.id);
      if (cargoPackaging !== 'bulk') body.fields.quantity_gross_tonnes = '9';
      const result = await r.request('POST', '/api/shipment-trips', body);
      assert.equal(result.status, 201, JSON.stringify(result.body));
      assert.equal(result.body.trip.fields.quantity_gross_tonnes, cargoPackaging === 'bulk' ? '8.125' : '9');
      if (cargoPackaging === 'bulk') {
        const contradictory = edit(result.body.trip); contradictory.fields.quantity_gross_tonnes = '9';
        const normalized = await r.request('PATCH', `/api/shipment-trips/${result.body.trip.id}`, contradictory);
        assert.equal(normalized.status, 200, JSON.stringify(normalized.body));
        assert.equal(normalized.body.trip.fields.quantity_gross_tonnes, '8.125');
      }
      const invalid = r.sample(product.body.entry.id); invalid.fields.quantity_tonnes = '0';
      assert.equal((await r.request('POST', '/api/shipment-trips', invalid)).status, 400);
    }
  } finally { await r.close(); }
});

test('unified loading defaults unloading without changing manual dates, historical differences or workflow state', async () => {
  const r = await setup();
  try {
    const body = r.sample(r.snapshot.directories!.products[0].id);
    let saved = await r.request('POST', '/api/shipment-trips', body);
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
    let result = saved.body as ShipmentTripResponse;
    for (const field of ['loading_planned_at', 'loading_actual_at']) assert.equal(result.trip.fields[field], '2026-09-30T10:15');
    for (const field of ['unloading_planned_at', 'unloading_actual_at']) assert.equal(result.trip.customers[0].fields[field], '2026-09-30T10:15');
    assert.equal(result.shipment.fields.status, undefined);
    const changed = edit(result.trip);
    changed.fields.loading_at = '2026-10-01T11:00';
    changed.customers[0].fields.unloading_planned_at = '2026-10-02T12:30';
    changed.customers[0].fields.unloading_actual_at = '2026-10-02T13:15';
    saved = await r.request('PATCH', `/api/shipment-trips/${result.trip.id}`, changed);
    assert.equal(saved.status, 200, JSON.stringify(saved.body)); result = saved.body;
    assert.equal(result.trip.fields.date, '2026-10-01');
    assert.equal(result.trip.customers[0].fields.unloading_planned_at, '2026-10-02T12:30');
    assert.equal(result.trip.customers[0].fields.unloading_actual_at, '2026-10-02T13:15');
    const historical = edit(result.trip);
    historical.fields.loading_planned_at = '2026-10-01T11:00'; historical.fields.loading_actual_at = '2026-10-01T14:00';
    result = (await r.request('PATCH', `/api/shipment-trips/${result.trip.id}`, historical)).body;
    const unchanged = edit(result.trip); unchanged.fields.trip_notes = 'Поменяли только заметку';
    result = (await r.request('PATCH', `/api/shipment-trips/${result.trip.id}`, unchanged)).body;
    assert.equal(result.trip.fields.loading_planned_at, '2026-10-01T11:00');
    assert.equal(result.trip.fields.loading_actual_at, '2026-10-01T14:00');
    const dateOnly = r.sample(r.snapshot.directories!.products[0].id); dateOnly.fields.loading_at = '2026-10-05';
    const day = await r.request('POST', '/api/shipment-trips', dateOnly);
    assert.equal(day.status, 201, JSON.stringify(day.body)); assert.equal(day.body.trip.fields.loading_actual_at, '2026-10-05');
    const manuallyCleared = r.sample(r.snapshot.directories!.products[0].id);
    manuallyCleared.customers[0].fields.unloading_actual_at = null;
    const cleared = await r.request('POST', '/api/shipment-trips', manuallyCleared);
    assert.equal(cleared.status, 201, JSON.stringify(cleared.body));
    assert.equal(cleared.body.trip.customers[0].fields.unloading_actual_at, null);
    const invalid = r.sample(r.snapshot.directories!.products[0].id); invalid.fields.loading_at = '2026-02-30T09:00';
    assert.equal((await r.request('POST', '/api/shipment-trips', invalid)).status, 400);
  } finally { await r.close(); }
});

test('explicit legacy company defaults validate new selection while ordinary edits preserve the historical legal link', async () => {
  const r = await setup();
  try {
    const c = await r.request('POST', '/api/directories', { kind: 'companies', name: 'QA перевозчик связей', roles: ['carrier'], addresses: [] });
    assert.equal(c.status, 201, JSON.stringify(c.body)); const carrierId = c.body.entry.id;
    const v = await r.request('POST', '/api/directories', { kind: 'vehicles', plate: 'QA CARRIER 123', carrierId });
    assert.equal(v.status, 201, JSON.stringify(v.body));
    const d = await r.request('POST', '/api/directories', { kind: 'drivers', name: 'QA водитель связей', vehicleId: v.body.entry.id, carrierId });
    assert.equal(d.status, 201, JSON.stringify(d.body));
    const other = await r.request('POST', '/api/directories', { kind: 'companies', name: 'QA другой перевозчик', roles: ['carrier'], addresses: [] });
    const incompatible = await r.request('PATCH', `/api/directories/vehicles/${v.body.entry.id}`, { version: 0, plate: v.body.entry.plate, carrierId: other.body.entry.id });
    assert.equal(incompatible.status, 409);
    const body = r.sample(r.snapshot.directories!.products[0].id); body.fields.carrier_id = carrierId; delete body.fields.driver_id; delete body.fields.vehicle_id;
    const saved = await r.request('POST', '/api/shipment-trips', body);
    assert.equal(saved.status, 201, JSON.stringify(saved.body)); assert.equal(saved.body.trip.fields.driver_id, d.body.entry.id); assert.equal(saved.body.trip.fields.vehicle_id, v.body.entry.id);
    const wrong = edit(saved.body.trip); wrong.fields.vehicle_id = r.snapshot.directories!.vehicles[0].id;
    const ordinaryEdit = await r.request('PATCH', `/api/shipment-trips/${saved.body.trip.id}`, wrong);
    assert.equal(ordinaryEdit.status, 200, JSON.stringify(ordinaryEdit.body));
    assert.equal(ordinaryEdit.body.trip.fields.carrier_id, carrierId);
    assert.equal(ordinaryEdit.body.trip.fields.vehicle_id, wrong.fields.vehicle_id);
    const edited = edit(ordinaryEdit.body.trip);
    const expanded = { ...edited, customers: [...edited.customers, { fields: { ...edited.customers[0].fields } }] };
    const addedDelivery = await r.request('PATCH', `/api/shipment-trips/${saved.body.trip.id}`, expanded);
    assert.equal(addedDelivery.status, 200, JSON.stringify(addedDelivery.body));
    assert.equal(addedDelivery.body.trip.fields.carrier_id, carrierId);
    const changedLegal = edit(addedDelivery.body.trip); changedLegal.fields.carrier_id = other.body.entry.id;
    assert.equal((await r.request('PATCH', `/api/shipment-trips/${saved.body.trip.id}`, changedLegal)).status, 400);
    await r.request('POST', '/api/directories', { kind: 'vehicles', plate: 'QA CARRIER 456', carrierId });
    assert.equal((await r.request('POST', '/api/shipment-trips', body)).status, 400);
    const defaults = await r.request('PATCH', `/api/directories/companies/${carrierId}`, { version: c.body.entry.version, name: c.body.entry.name, roles: ['carrier'], addresses: [], defaultVehicleId: v.body.entry.id, defaultDriverId: d.body.entry.id });
    assert.equal(defaults.status, 200, JSON.stringify(defaults.body));
    assert.equal((await r.request('POST', '/api/shipment-trips', body)).status, 201);
  } finally { await r.close(); }
});

test('ordinary trip selects driver and vehicle without requiring or inferring a carrier company', async () => {
  const r = await setup();
  try {
    const vehicle = await r.request('POST', '/api/directories', { kind: 'vehicles', plate: 'QA DRIVER ONLY 991' });
    assert.equal(vehicle.status, 201);
    const driver = await r.request('POST', '/api/directories', { kind: 'drivers', name: 'QA водитель без компании', vehicleId: vehicle.body.entry.id });
    assert.equal(driver.status, 201);
    const body = r.sample(r.snapshot.directories!.products[0].id);
    body.fields.driver_id = driver.body.entry.id; body.fields.vehicle_id = vehicle.body.entry.id;
    const explicit = await r.request('POST', '/api/shipment-trips', body);
    assert.equal(explicit.status, 201, JSON.stringify(explicit.body));
    assert.equal(explicit.body.trip.fields.carrier_id, null);
    assert.equal(explicit.body.trip.fields.driver_id, driver.body.entry.id);
    assert.equal(explicit.body.trip.fields.vehicle_id, vehicle.body.entry.id);
    delete body.fields.vehicle_id;
    const linked = await r.request('POST', '/api/shipment-trips', body);
    assert.equal(linked.status, 201, JSON.stringify(linked.body));
    assert.equal(linked.body.trip.fields.vehicle_id, vehicle.body.entry.id);
    assert.notEqual(linked.body.trip.fields.vehicle_id, r.snapshot.directories!.vehicles[0].id);
    const chosen = { ...body, fields: { ...body.fields, vehicle_id: r.snapshot.directories!.vehicles[0].id } };
    const selected = await r.request('POST', '/api/shipment-trips', chosen);
    assert.equal(selected.status, 201, JSON.stringify(selected.body));
    assert.equal(selected.body.trip.fields.vehicle_id, chosen.fields.vehicle_id);
    const invalid = { ...body, fields: { ...body.fields, driver_id: 'missing-driver' } };
    assert.equal((await r.request('POST', '/api/shipment-trips', invalid)).status, 400);
    delete body.fields.driver_id;
    assert.equal((await r.request('POST', '/api/shipment-trips', body)).status, 400);
  } finally { await r.close(); }
});
