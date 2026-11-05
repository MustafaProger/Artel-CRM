import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createSnapshotMiddleware } from '../server/local-api';
import { SabyClient } from '../server/saby-client';
import { currentSnapshot } from '../server/shipment-operations';
import { getShipmentTrip, deleteShipmentTrip, tripDeletionBlocker } from '../server/shipment-trips';
import { readTripWorkflowIssues } from '../server/trip-workflow-issues';
import { runTripSabyWorkflow } from '../server/trip-saby-workflow';
import { dispatchTripSaby, createTripSabyScheduler } from '../server/trip-saby-scheduler';
import { controlledTripClient, exchangeControl, setTripExchangeControl, TripExchangePausedError } from '../server/trip-exchange-control';
import { integrationApi, integrationConfig, integrationRuntime, integrationSettings } from './helpers/trip-saby-integration';

test('control API uses fresh authorization and version, persists across reads and never contacts Saby', async () => {
  const rt = await integrationRuntime(), api = integrationApi();
  const middleware = createSnapshotMiddleware(rt.snapshotDirectory, { operationsStore: rt.store, sabyClient: api.client() });
  const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end(); }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const endpoint = `/api/shipment-trips/${rt.tripId}/saby-workflow`;
  try {
    const setup = await fetch(origin + '/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Synthetic', login: 'synthetic', password: randomUUID() }) });
    assert.equal(setup.status, 200);
    const headers = { Cookie: setup.headers.get('set-cookie')!.split(';')[0], 'Content-Type': 'application/json' };
    const request = (path: string, body?: unknown) => fetch(origin + path, { headers, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
    const original = await rt.store.read(rt.source);
    const stop = await request(endpoint + '/control', { paused: true, version: 0 });
    assert.equal(stop.status, 200); assert.equal((await stop.json()).exchangeControl.paused, true);
    const stopped = await rt.store.read(rt.source);
    assert.deepEqual({ ...stopped, revision: original.revision, tripExchangeControls: undefined }, { ...original, tripExchangeControls: undefined });
    assert.equal((await (await request(endpoint)).json()).exchangeControl.paused, true);
    assert.equal((await request(endpoint + '/control', { paused: false, version: 0 })).status, 409);
    assert.equal((await request(endpoint, {})).status, 409);
    assert.equal((await request(endpoint + '/control', { paused: false, version: 1, extra: 1 })).status, 400);
    assert.equal((await fetch(origin + endpoint + '/control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"paused":false,"version":1}' })).status, 401);
    assert.equal((await request(endpoint + '/control', { paused: false, version: 1 })).status, 200);
    const resumed = await rt.store.read(rt.source);
    assert.equal(exchangeControl(resumed, rt.tripId).version, 2);
    await rt.store.mutate(rt.source, data => { data.accounts!.sessions = []; return { result: null, changed: true }; });
    assert.equal((await request(endpoint + '/control', { paused: true, version: 2 })).status, 401);
    assert.equal(api.calls.length, 0);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rt.close(); }
});

test('normal driver waiting is neutral; actual missing fields and post-confirmation missing mass remain errors', async () => {
  const rt = await integrationRuntime(), previous = process.env.SABY_AUTOFILL_PROFILE_JSON;
  process.env.SABY_AUTOFILL_PROFILE_JSON = JSON.stringify(integrationSettings);
  try {
    const data = await rt.store.read(rt.source);
    for (const row of Object.values(data.shipments)) Object.assign(row.fields, { trip_flow_version: 'driver-v1', quantity_tonnes: null, quantity_gross_tonnes: null, trip_total_tonnes: null });
    const issues = () => { const snapshot = currentSnapshot(rt.base, data); return readTripWorkflowIssues(data, rt.tripId, { snapshot, trip: getShipmentTrip(snapshot, rt.tripId), config: integrationConfig() }); };
    assert.deepEqual(issues(), []);
    data.directories!.products[0].documentName = '';
    assert.ok(issues().some(row => /наименование для документов/.test(row.message)));
    data.directories!.products[0].documentName = 'Синтетическое дизельное топливо';
    data.driverTripProgress = { [rt.tripId]: { departedAt: '2026-11-01T10:00:00Z' } as never };
    assert.equal(issues().filter(row => /не указана масса/.test(row.message)).length, 2);
  } finally { if (previous === undefined) delete process.env.SABY_AUTOFILL_PROFILE_JSON; else process.env.SABY_AUTOFILL_PROFILE_JSON = previous; await rt.close(); }
});

test('paused fresh workflows cannot create intents or provider calls; scheduler also skips direct records', async () => {
  const rt = await integrationRuntime(), api = integrationApi();
  try {
    await rt.store.mutate(rt.source, data => ({ result: setTripExchangeControl(data, rt.tripId, 'synthetic', { paused: true, version: 0 }), changed: true }));
    const before = await rt.store.read(rt.source);
    await assert.rejects(runTripSabyWorkflow({ ...rt, client: api.client(), createDelivery: async () => { throw new Error('Unexpected delivery'); } }), TripExchangePausedError);
    assert.deepEqual(await rt.store.read(rt.source), before);
    // Selection must ignore a paused direct attempt even before its authorization is evaluated.
    const fake = { ...before, etrn: { trips: { [rt.tripId]: { direct: { phase: 'creating_etrn' } } } } };
    const store = { ...rt.store, read: async () => fake, mutate: async () => { throw new Error('Paused direct job mutated data'); } } as unknown as typeof rt.store;
    assert.deepEqual(await dispatchTripSaby({ ...rt, store, enabled: true, config: integrationConfig(), client: api.client() }), { continued: 0, refreshed: 0, denied: 0, failed: 0 });
    const scheduler = createTripSabyScheduler({ ...rt, store, enabled: true, config: integrationConfig(), client: api.client() });
    await scheduler.tick(); await scheduler.drain(); await scheduler.stop();
    assert.equal(api.calls.length, 0);
  } finally { await rt.close(); }
});

test('pause during an in-flight request preserves the received document and stops the next request; resume reuses it', async () => {
  const rt = await integrationRuntime(), api = integrationApi();
  let arrived!: () => void, release!: () => void;
  const arrival = new Promise<void>(resolve => { arrived = resolve; }), held = new Promise<void>(resolve => { release = resolve; });
  let hold = false;
  const send: typeof fetch = async (input, init) => {
    const response = await api.send(input, init);
    if (hold) { hold = false; arrived(); await held; }
    return response;
  };
  const run = () => runTripSabyWorkflow({ ...rt, client: new SabyClient(integrationConfig(), send), createDelivery: async () => { throw new Error('Unexpected delivery'); } });
  try {
    await run();
    const before = (await rt.store.read(rt.source)).tripSaby!.trips[rt.tripId];
    hold = true; const running = run(); const settled = assert.rejects(running, TripExchangePausedError);
    await arrival;
    await rt.store.mutate(rt.source, data => ({ result: setTripExchangeControl(data, rt.tripId, 'synthetic', { paused: true, version: 0 }), changed: true }));
    const count = api.calls.length; release(); await settled;
    const stopped = (await rt.store.read(rt.source)).tripSaby!.trips[rt.tripId];
    assert.equal(api.calls.length, count); assert.equal(stopped.order.id, before.order.id); assert.equal(stopped.lastError, before.lastError); assert.equal(stopped.leaseId, null);
    await rt.store.mutate(rt.source, data => ({ result: setTripExchangeControl(data, rt.tripId, 'synthetic', { paused: false, version: 1 }), changed: true }));
    await run(); assert.equal(api.reserves('TransportOrder').length, 1);
  } finally { release(); await rt.close(); }
});

test('provider requests waiting for network capacity check pause after admission', async () => {
  const rt = await integrationRuntime(), api = integrationApi();
  let admit!: () => void, queued!: () => void;
  const gate = new Promise<void>(resolve => { admit = resolve; }), waiting = new Promise<void>(resolve => { queued = resolve; });
  const client = controlledTripClient(api.client().withRequestBudget(async action => { queued(); await gate; return action(); }), rt.store, rt.source, rt.tripId);
  try {
    const request = assert.rejects(client.readTransportOrder('synthetic'), TripExchangePausedError);
    await waiting;
    await rt.store.mutate(rt.source, data => ({ result: setTripExchangeControl(data, rt.tripId, 'synthetic', { paused: true, version: 0 }), changed: true }));
    admit(); await request; assert.equal(api.calls.length, 0);
  } finally { admit(); await rt.close(); }
});

test('delete is version guarded and blocks documents, payments and driver facts without changing them', async () => {
  const rt = await integrationRuntime(), api = integrationApi();
  try {
    const data = await rt.store.read(rt.source), versions = Object.fromEntries(rt.trip.customers.map(row => [row.id, row.version]));
    const stale = structuredClone(data);
    assert.throws(() => deleteShipmentTrip(rt.base, stale, { versions: {} }, rt.tripId), /изменены/); assert.deepEqual(stale, data);
    for (const protectedData of [
      { ...data, paymentAllocations: [{ shipmentId: rt.trip.customers[0].id } as never] },
      { ...data, driverTripProgress: { [rt.tripId]: { departedAt: '2026-11-01T00:00:00.000Z' } as never } },
      { ...data, tripExecutions: { [rt.tripId]: {} as never } },
    ]) {
      const before = structuredClone(protectedData);
      assert.ok(tripDeletionBlocker(protectedData, rt.tripId));
      assert.throws(() => deleteShipmentTrip(rt.base, protectedData, { versions }, rt.tripId)); assert.deepEqual(protectedData, before);
    }
    await runTripSabyWorkflow({ ...rt, client: api.client(), createDelivery: async () => { throw new Error('Unexpected delivery'); } });
    const linked = await rt.store.read(rt.source), before = structuredClone(linked);
    assert.throws(() => deleteShipmentTrip(rt.base, linked, { versions }, rt.tripId), /Saby/); assert.deepEqual(linked, before);
    const removed = deleteShipmentTrip(rt.base, data, { versions }, rt.tripId);
    assert.equal(removed.deletedCount, 2); assert.ok(Object.values(data.shipments).every(row => row.deleted));
  } finally { await rt.close(); }
});
