import assert from 'node:assert/strict';
import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createSnapshotMiddleware } from '../../server/local-api';
import type { PushSender, PushConfig } from '../../server/push';
import type { ShipmentTrip } from '../../web/src/model';
import { integrationRuntime } from './trip-saby-integration';

export const config: PushConfig = { publicKey: 'test-public', privateKey: 'test-private', subject: 'https://example.test', schedule: true };
export const subscription = () => {
  const key = createECDH('prime256v1'); key.generateKeys();
  return { endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`, keys: { p256dh: key.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
};
export function tripBody(trip: ShipmentTrip, driverId = 'driver', edit = false) {
  return { ...(edit ? { versions: Object.fromEntries(trip.customers.map(row => [row.id, row.version])) } : { idempotencyKey: randomUUID() }),
    fields: { ...Object.fromEntries(['organization_id', 'date', 'supplier_id', 'oil_depot_id', 'product_id', 'purchase_price_unspecified_unit', 'quantity_tonnes', 'vehicle_id', 'loading_planned_at', 'additional_costs', 'trip_notes'].map(key => [key, trip.fields[key]])), driver_id: driverId }, customers: trip.customers.map(row => ({ ...(edit ? { id: row.id } : {}), fields: Object.fromEntries(['customer_id', 'manager_id', 'payment_form_id', 'quantity_litres', 'sale_price_per_litre', 'transport_amount', 'unloading_address_id', 'unloading_planned_at'].map(key => [key, row.fields[key]])) })) };
}
export async function driverNotificationFixture(sender: PushSender, pushConfig = config) {
  const rt = await integrationRuntime();
  const deny = async () => { throw new Error('External provider forbidden in notification QA'); };
  await rt.store.mutate(rt.source, data => {
    data.directories!.drivers.push({ ...data.directories!.drivers[0], id: 'driver-other' });
    // Existing trips must not produce a historical notification at feature activation.
    delete data.push;
    return { changed: true, result: null };
  });
  const middleware = createSnapshotMiddleware(rt.snapshotDirectory, { operationsStore: rt.store, pushConfig, pushSender: sender, sabyWorkflowMonitoringEnabled: false,
    bankEnvironment: { ARTEL_BANK_SYNC_ENABLED: 'false', ARTEL_BANK_REQUESTS_ENABLED: 'false' }, bankRequest: deny, sberRequest: deny, fetcher: deny, checkoApiKey: '' });
  const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end(); }));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = async (path: string, method = 'GET', body?: unknown, cookie = '') => {
    const response = await fetch(origin + path, { method, headers: { cookie, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] ?? '' };
  };
  const password = randomUUID();
  const owner = await request('/api/auth/setup', 'POST', { login: 'notification-admin', name: 'QA Директор', password });
  assert.equal(owner.status, 200);
  const admin = (path: string, method = 'GET', body?: unknown) => request(path, method, body, owner.cookie);
  const drivers = [];
  for (const driverId of ['driver', 'driver-other']) {
    const access = await admin(`/api/drivers/${driverId}/access`, 'POST', { action: 'issue', version: 0 });
    assert.equal(access.status, 200);
    const login = access.body.access.login, password = access.body.temporaryPassword;
    const signed = await request('/api/auth/login', 'POST', { login, password });
    assert.equal(signed.status, 200);
    const call = (path: string, method = 'GET', body?: unknown) => request(path, method, body, signed.cookie);
    drivers.push({ driverId, userId: signed.body.user.id as string, call, cookie: signed.cookie, login, password });
  }
  return { ...rt, origin, middleware, request, admin, drivers,
    close: async () => { await new Promise<void>(done => server.close(() => done())); await rt.close(); } };
}
