import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AccountUser } from '../web/src/auth-model';
import type { Snapshot } from '../web/src/model';
import { requireWholeTrip, ownsShipment } from '../server/auth-scope';
import { directoryEntryId } from '../server/directory-operations';
import { StoreError, type OperationsData } from '../server/operations-store';
import { currentShipmentAccess, currentSnapshot, type ShipmentAccessContext } from '../server/shipment-operations';
import { getShipmentTrip } from '../server/shipment-trips';
import { assertTripTransportDocumentsAllowed } from '../server/trip-document-mode';
import { requiresEtrn } from '../server/trip-etrn-scope';
import { integrationRuntime } from './helpers/trip-saby-integration';

const actor = (managerId: string | null, role: AccountUser['role'] = 'manager'): AccountUser => ({ id: 'synthetic-actor', name: 'Тест', login: 'test', role, managerId, active: true, version: 1, sections: ['trips'] });
const outcome = (action: () => unknown) => {
  try { return { ok: true, result: action() }; }
  catch (error) { return { ok: false, name: (error as Error).name, message: (error as Error).message, status: (error as { status?: number }).status }; }
};
function authorityProjection(snapshot: ShipmentAccessContext, tripId: string, actors: AccountUser[], data: OperationsData) {
  return {
    membership: snapshot.shipments.map(row => [row.id, row.customerId, row.version, actors.map(user => ownsShipment(user, row, snapshot))]),
    wholeTrip: actors.map(user => outcome(() => requireWholeTrip(user, snapshot, tripId))),
    eligible: snapshot.shipments.filter(row => row.fields.trip_id === tripId && requiresEtrn(row)).map(row => row.id),
    policy: outcome(() => assertTripTransportDocumentsAllowed(getShipmentTrip(snapshot, tripId), data)),
    trip: (() => { const trip = getShipmentTrip(snapshot, tripId); return { ...trip, customers: trip.customers.map(row => ({ id: row.id, version: row.version, fields: row.fields })) }; })(),
  };
}

test('operational access has identical ownership, trip fields and ETRN scope without financial aggregates', async t => {
  const f = await integrationRuntime(); t.after(f.close);
  const original = await f.store.read(f.source);
  const actors = [actor('manager'), actor('other'), actor(null, 'admin'), actor(null, 'driver')];
  const scenarios: Array<(data: OperationsData) => void> = [
    () => undefined,
    data => { data.sourceOperationsCleared = true; },
    data => { Object.values(data.shipments)[0].fields.etrn_not_required = 'true'; },
    data => { data.directories!.customerManagers = [{ companyId: 'customer', managerId: 'manager' }]; },
    data => { data.directories!.managers.push({ id: 'other', name: 'Другой' }); data.directories!.customerManagers = [{ companyId: 'customer', managerId: 'other' }]; },
    data => { data.directories!.managers.push({ id: 'other', name: 'Другой' }); Object.values(data.shipments)[0].fields.manager_id = 'other'; },
    data => { Object.values(data.shipments)[0].fields.source_request_id = 'request-shared'; data.directories!.managers.push({ id: 'other', name: 'Другой' }); data.directories!.customerManagers = [{ companyId: 'customer', managerId: 'other' }]; },
    data => { for (const row of Object.values(data.shipments)) row.fields.manager_id = 'missing-employee'; },
    data => { for (const row of Object.values(data.shipments)) { row.fields.manager_id = null; row.fields.manager_label = ' ТЕСТ '; } },
    data => { data.directories!.managers.push({ id: 'duplicate-manager', name: 'Тест' }); for (const row of Object.values(data.shipments)) row.fields.manager_id = null; },
    data => { data.directories!.managers = [{ id: directoryEntryId('managers', 'Тест'), name: 'Переименован' }]; for (const row of Object.values(data.shipments)) row.fields.manager_id = null; },
    data => { for (const row of Object.values(data.shipments)) { row.fields.vehicle_id = null; } },
  ];
  for (const mutate of scenarios) {
    const data = structuredClone(original); mutate(data);
    const input = structuredClone(data), base = structuredClone(f.base);
    const access = currentShipmentAccess(base, data), full = currentSnapshot(base, data);
    assert.deepEqual(authorityProjection(access, f.tripId, actors, data), authorityProjection(full, f.tripId, actors, data));
    assert.deepEqual(Object.keys(access).sort(), ['directories', 'shipments']);
    assert.deepEqual(data, input); assert.deepEqual(base, f.base);
  }
});

test('both paths reject structural corruption, including unrelated rows and directory/payment references', async t => {
  const f = await integrationRuntime(); t.after(f.close);
  const original = await f.store.read(f.source);
  const scenarios: Array<(data: OperationsData) => void> = [
    data => { Object.values(data.shipments)[0].fields.etrn_not_required = 'invalid'; },
    data => { Object.values(data.shipments)[0].fields.trip_total_tonnes = '1'; },
    data => { Object.values(data.shipments)[0].fields.trip_delivery_order = '1'; Object.values(data.shipments)[1].fields.trip_delivery_order = '1'; },
    data => { Object.values(data.shipments)[0].fields.product_id = 'missing-product'; },
    data => { Object.values(data.shipments)[0].fields.unloading_address_id = 'loading'; },
    data => { data.directories!.addresses[0].companyId = 'missing-company'; },
    data => { data.directories!.customerManagers = [{ companyId: 'customer', managerId: 'missing-manager' }]; },
    data => { data.paymentAllocations = [{ id: 'allocation', shipmentId: Object.keys(data.shipments)[0], paymentId: 'missing-payment', amount: '1', date: '2025-01-01' }]; },
    data => { data.shipments['unknown-original'] = structuredClone(Object.values(data.shipments)[0]); },
    data => { data.shipments['shipment-local-unrelated'] = { fields: { ...Object.values(data.shipments)[0].fields, trip_id: null }, version: 1, createdAt: '', updatedAt: '' }; },
    data => { Object.values(data.shipments)[0].fields.organization_id = 'unknown-organization'; },
    data => { Object.values(data.shipments)[0].fields.unrecognized_field = 'corrupt'; },
  ];
  for (const mutate of scenarios) {
    const data = structuredClone(original); mutate(data);
    assert.throws(() => currentShipmentAccess(f.base, data), StoreError);
    assert.deepEqual(outcome(() => currentShipmentAccess(f.base, data)), outcome(() => currentSnapshot(f.base, data)));
  }
});

test('legacy source ownership and cleared source use the same rules as full snapshot', async t => {
  const f = await integrationRuntime(); t.after(f.close);
  const data = await f.store.read(f.source);
  const populated = currentSnapshot(f.base, data);
  const base: Snapshot = { ...f.base, companies: populated.companies, shipments: populated.shipments, managers: populated.managers };
  data.shipments = {}; data.companies = [];
  for (const cleared of [false, true]) {
    data.sourceOperationsCleared = cleared;
    const full = currentSnapshot(base, data), access = currentShipmentAccess(base, data);
    assert.deepEqual(access.shipments.map(row => [row.id, ownsShipment(actor('manager'), row, access)]), full.shipments.map(row => [row.id, ownsShipment(actor('manager'), row, full)]));
    assert.deepEqual(outcome(() => requireWholeTrip(actor('manager'), access, f.tripId)), outcome(() => requireWholeTrip(actor('manager'), full, f.tripId)));
    assert.equal(access.shipments.length, cleared ? 0 : 2);
  }
});

test('independent fresh reads reflect ownership revocation without caching a previous decision', async t => {
  const f = await integrationRuntime(); t.after(f.close);
  const initial = currentShipmentAccess(f.base, await f.store.read(f.source));
  requireWholeTrip(actor('manager'), initial, f.tripId);
  await f.store.mutate(f.source, data => {
    data.directories!.managers.push({ id: 'other', name: 'Другой' });
    data.directories!.customerManagers = [{ companyId: 'customer', managerId: 'other' }];
    return { changed: true, result: null };
  });
  const next = currentShipmentAccess(f.base, await f.store.read(f.source));
  assert.throws(() => requireWholeTrip(actor('manager'), next, f.tripId));
  requireWholeTrip(actor('manager'), initial, f.tripId);
});
