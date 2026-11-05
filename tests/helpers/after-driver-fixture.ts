import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { saveUser } from '../../server/auth';
import { createSnapshotMiddleware } from '../../server/local-api';
import { currentSnapshot } from '../../server/shipment-operations';
import { SabyClient } from '../../server/saby-client';
import type { ShipmentTrip } from '../../web/src/model';
import { integrationRuntime, integrationApi, integrationConfig, integrationSettings } from './trip-saby-integration';
export async function afterDriverFixture(twoClients = false) {
  const rt = await integrationRuntime(), api = integrationApi(), config = integrationConfig(), kicked: string[] = [];
  config.automaticSigning = { id: 'synthetic-explicit-start', enabled: true, mode: 'deferred', approvedAt: '2026-10-01T00:00:00.000Z', sender: { ...config.customer, thumbprint: 'ab'.repeat(20) }, carrier: { ...config.carrier, thumbprint: 'cd'.repeat(20) } };
  if (twoClients) await rt.store.mutate(rt.source, data => {
    const first = data.companies!.find(company => company.id === 'customer')!;
    data.companies!.push({ ...first, id: 'customer-two', name: 'Второй синтетический клиент', inn: '7736050003', kpp: '773601001' });
    const address = data.directories!.addresses.find(row => row.id === 'delivery')!;
    Object.assign(address, { latitude: '55.705', longitude: '37.705', mapUrl: 'https://yandex.ru/maps/?ll=37.705%2C55.705' });
    data.directories!.addresses.push({ ...address, id: 'delivery-two', companyId: 'customer-two', address: 'Второй полный синтетический адрес', latitude: '55.905', longitude: '37.905' });
    for (const loading of [data.directories!.oilDepots[0], data.directories!.addresses.find(row => row.id === 'loading')!]) Object.assign(loading, { latitude: '55.601', longitude: '37.601', mapUrl: 'https://yandex.ru/maps/?ll=37.601%2C55.601' });
    return { changed: true, result: null };
  });
  const token = randomBytes(32).toString('hex');
  const actor = await rt.store.mutate(rt.source, async data => {
    const user = await saveUser(data, currentSnapshot(rt.base, data), { name: 'Синтетический руководитель', login: 'start-owner', password: randomUUID() }, undefined, true);
    data.accounts!.sessions.push({ userId: user.id, hash: createHash('sha256').update(token).digest('hex'), expiresAt: Date.now() + 600_000 });
    return { result: user, changed: true };
  });
  const previousSettings = process.env.SABY_AUTOFILL_PROFILE_JSON;
  process.env.SABY_AUTOFILL_PROFILE_JSON = JSON.stringify(integrationSettings);
  const middleware = createSnapshotMiddleware(rt.snapshotDirectory, { operationsStore: rt.store, sabyClient: new SabyClient(config, api.send), requestSabyWorkflow: id => { kicked.push(id); }, sabyWorkflowMonitoringEnabled: true });
  const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end(); }));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const http = async (path: string, method = 'GET', input?: unknown, authenticated = true) => {
    const response = await fetch(origin + '/api/shipment-trips' + path, { method, headers: { 'Content-Type': 'application/json', ...(authenticated ? { Cookie: `artel_session=${token}` } : {}) }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    return { status: response.status, body: await response.json() };
  };
  const raw = async (path: string, method = 'GET', input?: unknown, cookie = `artel_session=${token}`) => {
    const response = await fetch(origin + path, { method, headers: { 'Content-Type': 'application/json', Cookie: cookie }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const fields = Object.fromEntries(['organization_id', 'supplier_id', 'carrier_id', 'oil_depot_id', 'product_id', 'purchase_price_unspecified_unit', 'driver_id', 'vehicle_id', 'additional_costs'].map(key => [key, rt.trip.fields[key]]));
  Object.assign(fields, { trip_flow_version: 'driver-v1', loading_at: '2027-02-03T09:15' });
  const customer = Object.fromEntries(['customer_id', 'manager_id', 'payment_form_id', 'sale_price_per_litre', 'transport_amount', 'unloading_address_id'].map(key => [key, rt.trip.customers[0].fields[key]]));
  const customerFields = [customer, ...(twoClients ? [{ ...customer, customer_id: 'customer-two', unloading_address_id: 'delivery-two' }] : [])];
  const input = { fields, customers: customerFields.map(row => ({ fields: { ...row, quantity_litres: '1' } })), idempotencyKey: randomUUID() };
  const created = await http('', 'POST', input); if (created.status !== 201) { await new Promise<void>(resolve => server.close(() => resolve())); await rt.close(); } assert.equal(created.status, 201, JSON.stringify(created.body));
  let trip: ShipmentTrip = created.body.trip;
  const tripId = trip.id, path = `/${tripId}/saby-workflow`;
  const patch = async (litres: string | string[] = '10') => {
    const response = await http(`/${tripId}`, 'PATCH', { fields, customers: trip.customers.map((row, index) => ({ id: row.id, fields: { ...customerFields[index], quantity_litres: Array.isArray(litres) ? litres[index] : litres } })), versions: Object.fromEntries(trip.customers.map(row => [row.id, row.version])) });
    assert.equal(response.status, 200, JSON.stringify(response.body)); trip = response.body.trip;
  };
  const preview = async () => { const response = await http(path); assert.equal(response.status, 200, JSON.stringify(response.body)); return response.body; };
  return { ...rt, raw, origin, ownerCookie: `artel_session=${token}`, api, config, actor, kicked, http, patch, preview, path, tripId, input, close: async () => { await new Promise<void>(resolve => server.close(() => resolve())); if (previousSettings === undefined) delete process.env.SABY_AUTOFILL_PROFILE_JSON; else process.env.SABY_AUTOFILL_PROFILE_JSON = previousSettings; await rt.close(); } };
}
