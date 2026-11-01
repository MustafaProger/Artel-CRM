import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createSnapshotMiddleware } from '../server/local-api';
import { currentSnapshot } from '../server/shipment-operations';
import { getShipmentTrip } from '../server/shipment-trips';
import { readTripWorkflowIssues } from '../server/trip-workflow-issues';
import { integrationRuntime, integrationApi, integrationConfig, integrationSettings } from './helpers/trip-saby-integration';

test('initial list flags missing input before Saby is opened, matches panel and clears after correction without provider calls', async () => {
  const rt = await integrationRuntime(), api = integrationApi();
  const prior = process.env.SABY_AUTOFILL_PROFILE_JSON;
  process.env.SABY_AUTOFILL_PROFILE_JSON = JSON.stringify(integrationSettings);
  const middleware = createSnapshotMiddleware(rt.snapshotDirectory, { operationsStore: rt.store, sabyClient: api.client() });
  const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end(); }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const setup = await fetch(origin + '/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Synthetic', login: 'synthetic-owner', password: randomUUID() }) });
    assert.equal(setup.status, 200);
    const headers = { Cookie: setup.headers.get('set-cookie')!.split(';')[0] };
    const get = async (path: string) => { const res = await fetch(origin + path, { headers }); assert.equal(res.status, 200); return res.json(); };
    const original = await rt.store.read(rt.source);
    assert.deepEqual((await get('/api/shipment-trips')).trips[0].workflowIssues, []);
    await rt.store.mutate(rt.source, data => {
      for (const row of Object.values(data.shipments)) row.fields.trip_flow_version = 'driver-v1';
      for (const row of Object.values(data.shipments)) { row.fields.quantity_tonnes = null; row.fields.quantity_gross_tonnes = null; row.fields.trip_total_tonnes = null; }
      data.directories!.products[0].documentName = '';
      return { result: null, changed: true };
    });
    const before = await rt.store.read(rt.source);
    currentSnapshot(rt.base, before);
    const list = await get('/api/shipment-trips');
    assert.ok(list.trips[0].workflowIssues.some((issue: { message: string }) => /наименование для документов/.test(issue.message)));
    assert.ok(list.trips[0].workflowIssues.some((issue: { shipmentId?: string; message: string }) => issue.shipmentId === rt.trip.customers[1].id && /масса/.test(issue.message)));
    assert.doesNotMatch(JSON.stringify(list), /private-integration-session|authorization|payloadHash/);
    const panel = await get(`/api/shipment-trips/${rt.tripId}/saby-workflow`);
    assert.deepEqual(panel.workflowIssues, list.trips[0].workflowIssues);
    assert.deepEqual(await rt.store.read(rt.source), before);
    await rt.store.mutate(rt.source, data => { data.shipments = original.shipments; data.directories = original.directories; return { result: null, changed: true }; });
    assert.deepEqual((await get('/api/shipment-trips')).trips[0].workflowIssues, []);
    assert.deepEqual((await get(`/api/shipment-trips/${rt.tripId}/saby-workflow`)).workflowIssues, []);
    assert.equal(api.calls.length, 0);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (prior === undefined) delete process.env.SABY_AUTOFILL_PROFILE_JSON; else process.env.SABY_AUTOFILL_PROFILE_JSON = prior;
    await rt.close();
  }
});

test('excluded deliveries and completed exchanges are not newly blocked by input checks; direct trips are checked read-only', async () => {
  const rt = await integrationRuntime();
  const prior = process.env.SABY_AUTOFILL_PROFILE_JSON; process.env.SABY_AUTOFILL_PROFILE_JSON = JSON.stringify(integrationSettings);
  try {
    const data = await rt.store.read(rt.source);
    for (const row of Object.values(data.shipments)) { row.fields.trip_flow_version = 'driver-v1'; row.fields.quantity_tonnes = null; row.fields.quantity_gross_tonnes = null; row.fields.trip_total_tonnes = null; }
    data.shipments[rt.trip.customers[1].id].fields.etrn_not_required = 'true';
    const read = () => { const snapshot = currentSnapshot(rt.base, data); return readTripWorkflowIssues(data, rt.tripId, { snapshot, trip: getShipmentTrip(snapshot, rt.tripId), config: integrationConfig() }); };
    assert.ok(read().some(issue => issue.shipmentId === rt.trip.customers[0].id));
    assert.ok(!read().some(issue => issue.shipmentId === rt.trip.customers[1].id));
    for (const row of Object.values(data.shipments)) { row.fields.organization_id = 'nk-artel'; row.fields.trip_document_policy = 'nk-direct-autostart-v1'; }
    const before = structuredClone(data);
    assert.ok(read().length); assert.deepEqual(data, before);
    for (const row of Object.values(data.shipments)) row.fields.etrn_not_required = 'true';
    assert.deepEqual(read(), []);
    data.shipments[rt.trip.customers[0].id].fields.etrn_not_required = 'false';
    data.tripSaby = { trips: { [rt.tripId]: { phase: 'completed', deliveries: [] } as unknown as NonNullable<typeof data.tripSaby>['trips'][string] } };
    assert.deepEqual(read(), []);
  } finally { if (prior === undefined) delete process.env.SABY_AUTOFILL_PROFILE_JSON; else process.env.SABY_AUTOFILL_PROFILE_JSON = prior; await rt.close(); }
});
