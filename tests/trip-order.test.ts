import assert from 'node:assert/strict';
import test from 'node:test';
import { compareTripsNewestFirst, tripCreatedAt } from '../web/src/trip-order';
import { getShipmentTrip, saveShipmentTrip } from '../server/shipment-trips';
import { readDriverTrips } from '../server/driver-trips';
import { currentSnapshot } from '../server/shipment-operations';
import type { AccountUser } from '../web/src/auth-model';
import { integrationRuntime } from './helpers/trip-saby-integration';

test('newly created trips come first even with an earlier loading date or UUID', () => {
  const trips = [
    { id: 'a-old', createdAt: '2026-10-06T09:00:00Z', fields: { date: '2026-10-10' } },
    { id: 'z-new', createdAt: '2026-10-07T09:00:00Z', fields: { date: '2026-10-01' } },
    { id: 'b-middle', createdAt: '2026-10-06T12:00:00Z', fields: { date: '2026-10-10' } },
  ];
  const expected = ['z-new', 'b-middle', 'a-old'];
  assert.deepEqual([...trips].sort(compareTripsNewestFirst).map(trip => trip.id), expected);
  const driverTrips = trips.map(({ fields, ...trip }) => ({ ...trip, date: fields.date }));
  assert.deepEqual(driverTrips.sort(compareTripsNewestFirst).map(trip => trip.id), expected);
  assert.deepEqual(trips.map(trip => trip.id), ['a-old', 'z-new', 'b-middle']);
});

test('equal timestamps and historical trips keep deterministic date/id order after refresh', () => {
  const trips = [
    { id: 'historical-z', date: '2026-10-07' },
    { id: 'known-z', createdAt: '2026-10-07T10:00:00+03:00', date: '2026-10-01' },
    { id: 'invalid', createdAt: 'invalid', date: '2026-10-02' },
    { id: 'historical-a', createdAt: null, date: '2026-10-07' },
    { id: 'known-a', createdAt: '2026-10-07T07:00:00Z', date: '2026-10-01' },
    { id: 'undated', createdAt: '', date: null },
  ];
  const expected = ['known-a', 'known-z', 'historical-a', 'historical-z', 'invalid', 'undated'];
  assert.deepEqual([...trips].sort(compareTripsNewestFirst).map(trip => trip.id), expected);
  assert.deepEqual([...trips].reverse().sort(compareTripsNewestFirst).map(trip => trip.id), expected);
});

test('adding a delivery uses the earliest retained creation timestamp, ignoring invalid values', () => {
  assert.equal(tripCreatedAt([{ createdAt: '2026-10-07T12:00:00Z' }, { createdAt: 'invalid' }, {}, { createdAt: '2026-10-07T09:00:00+03:00' }]), '2026-10-07T09:00:00+03:00');
  assert.equal(tripCreatedAt([{ createdAt: 'invalid' }, {}]), null);
  assert.equal(tripCreatedAt([]), null);
});

test('CRM and driver projections expose the same creation time, preserved through plan edits', async () => {
  const runtime = await integrationRuntime();
  try {
    const data = await runtime.store.read(runtime.source);
    const originalTime = '2026-10-01T09:00:00Z';
    data.shipments[runtime.trip.customers[0].id].createdAt = '2026-10-02T12:00:00Z';
    data.shipments[runtime.trip.customers[1].id].createdAt = originalTime;
    const actor: AccountUser = { id: 'driver-user', name: 'Синтетический водитель', login: 'driver', role: 'driver', driverId: 'driver', managerId: null, active: true, version: 1 };
    const snapshot = currentSnapshot(runtime.base, data, false);
    const original = getShipmentTrip(snapshot, runtime.tripId);
    const driverOriginal = readDriverTrips(snapshot, actor, runtime.tripId).trip!;
    assert.equal(original.createdAt, originalTime);
    assert.equal(driverOriginal.createdAt, originalTime);
    const updated = saveShipmentTrip(runtime.base, data, {
      versions: Object.fromEntries(original.customers.map(row => [row.id, row.version])),
      fields: { ...original.fields, loading_at: '2026-10-12T09:00', trip_notes: 'Изменён только план' },
      customers: original.customers.map(row => ({ id: row.id, fields: row.fields })),
    }, original.id);
    assert.equal(updated.trip.createdAt, originalTime);
    assert.equal(updated.trip.fields.date, '2026-10-12');
    assert.equal(readDriverTrips(currentSnapshot(runtime.base, data, false), actor, original.id).trip!.createdAt, originalTime);
    assert.equal(compareTripsNewestFirst(updated.trip, { id: 'newer', createdAt: '2026-10-03T09:00:00Z', date: '2026-10-01' }) > 0, true);
  } finally { await runtime.close(); }
});
