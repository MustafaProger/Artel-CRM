import assert from 'node:assert/strict';
import test from 'node:test';
import { dirname } from 'node:path';
import { OperationsStore } from '../server/operations-store';
import { dispatchReminders, dispatchTripAssignments, validatePush, type PushSender } from '../server/push';
import { config, driverNotificationFixture, subscription, tripBody } from './helpers/driver-notifications';

type Notice = { userId: string; body: string; tag: string; url: string };
const capture = (sent: Notice[]): PushSender => async (device, payload) => { sent.push({ ...JSON.parse(payload), userId: device.userId }); };
async function fixture(sender: PushSender) {
  const f = await driverNotificationFixture(sender);
  for (const driver of f.drivers) assert.equal((await driver.call('/api/push/subscription', 'POST', { subscription: subscription() })).status, 200);
  return f;
}

test('driver subscribes and verifies receipt on own device, with no work/other-driver/dispatch access', async () => {
  const payloads: Record<string, unknown>[] = [];
  const f = await driverNotificationFixture(async (_device, payload) => { payloads.push(JSON.parse(payload)); });
  try {
    const [a, b] = f.drivers;
    const sub = subscription();
    assert.equal((await a.call('/api/push/config')).status, 200);
    assert.equal((await a.call('/api/push/subscription', 'POST', { subscription: sub })).status, 200);
    assert.equal((await b.call('/api/push/test', 'POST', { endpoint: sub.endpoint })).status, 404);
    const probe = await a.call('/api/push/test', 'POST', { endpoint: sub.endpoint });
    assert.equal(probe.status, 200); assert.equal(payloads[0].url, '/#driver-trips');
    assert.equal((await b.call(`/api/push/test-status?probeId=${probe.body.probeId}`)).status, 404);
    assert.equal((await a.call(`/api/push/test-status?probeId=${probe.body.probeId}`)).body.status, 'pending');
    const receipt = payloads[0].probe as { id: string; token: string };
    assert.equal((await f.request('/api/push/test-receipt', 'POST', { probeId: receipt.id, token: receipt.token })).status, 200);
    assert.equal((await a.call(`/api/push/test-status?probeId=${probe.body.probeId}`)).body.status, 'confirmed');
    for (const path of ['/api/work', '/api/snapshot', '/api/push/unknown']) assert.equal((await a.call(path)).status, 403);
    assert.equal((await a.call('/api/push/dispatch', 'POST', {})).status, 403);
    for (const method of ['PATCH', 'PUT', 'GET']) assert.equal((await a.call('/api/push/subscription', method)).status, 403);
    assert.equal((await a.call('/api/push/subscription', 'POST', { subscription: { ...sub, endpoint: 'https://127.0.0.1/private' } })).status, 400);
    await b.call('/api/push/subscription', 'DELETE', { endpoint: sub.endpoint });
    assert.equal((await f.store.read(f.source)).push!.devices.length, 1);
    await a.call('/api/auth/logout', 'POST', { pushEndpoint: sub.endpoint });
    assert.equal((await f.store.read(f.source)).push!.devices.length, 0);
  } finally { await f.close(); }
});

test('new trip notifies only its driver once; replay, edits and historical trips remain quiet, with restart deduplication', async () => {
  const sent: Notice[] = [], f = await fixture(capture(sent));
  try {
    await dispatchReminders(f.store, f.source, config, capture(sent)); assert.equal(sent.length, 0);
    const body = tripBody(f.trip);
    const created = await f.admin('/api/shipment-trips', 'POST', body); assert.equal(created.status, 201);
    assert.equal(sent.length, 1); assert.equal(sent[0].userId, f.drivers[0].userId);
    assert.equal(sent[0].url, `/#driver-trip/${created.body.trip.id}`);
    assert.match(sent[0].body, /новый рейс/); assert.doesNotMatch(JSON.stringify(sent), /customer|supplier|7000|50000/);
    const repeat = await f.admin('/api/shipment-trips', 'POST', body); assert.equal(repeat.status, 201); assert.equal(repeat.body.trip.id, created.body.trip.id);
    const edit = tripBody(created.body.trip, 'driver', true); edit.fields.trip_notes = 'Изменён маршрут';
    assert.equal((await f.admin(`/api/shipment-trips/${created.body.trip.id}`, 'PATCH', edit)).status, 200);
    await dispatchReminders(new OperationsStore(dirname(f.store.path)), f.source, config, capture(sent));
    assert.equal(sent.length, 1);
    assert.equal((await f.drivers[1].call(`/api/driver/trips/${created.body.trip.id}`)).status, 404);
  } finally { await f.close(); }
});

test('reassignment cancels the old pending event and notifies the new driver; assigning back creates a fresh event', async () => {
  const sent: Notice[] = []; let fail = true;
  const f = await fixture(async (device, payload, config) => { if (fail) throw new Error('offline'); await capture(sent)(device, payload, config); });
  try {
    const created = await f.admin('/api/shipment-trips', 'POST', tripBody(f.trip)); assert.equal(created.status, 201);
    fail = false;
    const moved = await f.admin(`/api/shipment-trips/${created.body.trip.id}`, 'PATCH', tripBody(created.body.trip, 'driver-other', true)); assert.equal(moved.status, 200);
    await dispatchReminders(f.store, f.source, config, capture(sent), Date.now() + 130000);
    assert.deepEqual(sent.map(row => row.userId), [f.drivers[1].userId]);
    const back = await f.admin(`/api/shipment-trips/${created.body.trip.id}`, 'PATCH', tripBody(moved.body.trip, 'driver', true)); assert.equal(back.status, 200);
    assert.deepEqual(sent.map(row => row.userId), [f.drivers[1].userId, f.drivers[0].userId]);
    assert.notEqual(sent[0].tag, sent[1].tag);
  } finally { await f.close(); }
});

test('failed delivery survives reload and retries once across concurrent dispatchers; expired endpoints are removed', async () => {
  const sent: Notice[] = [];
  const f = await fixture(async () => { throw new Error('network unavailable'); });
  try {
    const created = await f.admin('/api/shipment-trips', 'POST', tripBody(f.trip)); assert.equal(created.status, 201);
    const now = Date.now() + 130000;
    await Promise.all([dispatchReminders(f.store, f.source, config, capture(sent), now), dispatchTripAssignments(new OperationsStore(dirname(f.store.path)), f.source, config, capture(sent), now)]);
    assert.equal(sent.length, 1);
    await dispatchReminders(f.store, f.source, config, capture(sent), now + 130000); assert.equal(sent.length, 1);
    const other = await f.admin('/api/shipment-trips', 'POST', tripBody(f.trip, 'driver-other')); assert.equal(other.status, 201);
    const result = await dispatchReminders(f.store, f.source, config, async () => { throw Object.assign(new Error('gone'), { statusCode: 410 }); }, now + 130000);
    assert.equal(result.expired, 1);
    assert.ok(!(await f.store.read(f.source)).push!.devices.some(row => row.userId === f.drivers[1].userId));
  } finally { await f.close(); }
});

test('deleted or mixed-driver trips, revoked users and expired assignments never dispatch', async () => {
  const sent: Notice[] = [], f = await fixture(async () => { throw new Error('offline'); });
  try {
    const create = async () => { const r = await f.admin('/api/shipment-trips', 'POST', tripBody(f.trip)); assert.equal(r.status, 201); return r.body.trip; };
    const deleted = await create();
    assert.equal((await f.admin(`/api/shipment-trips/${deleted.id}`, 'DELETE', { versions: tripBody(deleted, 'driver', true).versions })).status, 200);
    await dispatchReminders(f.store, f.source, config, capture(sent), Date.now() + 130000); assert.equal(sent.length, 0);
    const mixed = await create();
    await f.store.mutate(f.source, data => { data.shipments[mixed.customers[0].id].fields.driver_id = 'driver-other'; return { changed: true, result: null }; });
    await dispatchReminders(f.store, f.source, config, capture(sent), Date.now() + 130000); assert.equal(sent.length, 0);
    await f.store.mutate(f.source, data => { data.shipments[mixed.customers[0].id].fields.driver_id = 'driver'; return { changed: true, result: null }; });
    await create();
    await f.admin('/api/drivers/driver/access', 'PATCH', { active: false, version: 1 });
    await dispatchReminders(f.store, f.source, config, capture(sent), Date.now() + 130000); assert.equal(sent.length, 0);
    await dispatchReminders(f.store, f.source, config, capture(sent), Date.now() + 86400001);
    assert.deepEqual((await f.store.read(f.source)).push!.tripAssignments, {});
  } finally { await f.close(); }
});

test('failed saves cannot queue notifications and malformed stored events are rejected', async () => {
  const sent: Notice[] = [], f = await fixture(capture(sent));
  try {
    const body = tripBody(f.trip); body.fields.driver_id = 'missing';
    assert.equal((await f.admin('/api/shipment-trips', 'POST', body)).status, 400);
    assert.equal(sent.length, 0); assert.equal((await f.store.read(f.source)).push!.tripAssignments, undefined);
    assert.throws(() => validatePush({ devices: [], deliveries: {}, tripAssignments: { bad: { token: 'bad', driverId: 'driver', at: 0 } } }));
  } finally { await f.close(); }
});
