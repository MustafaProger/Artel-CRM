import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname } from 'node:path';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createSnapshotMiddleware } from '../server/local-api';
import { OperationsStore } from '../server/operations-store';
import { currentSnapshot } from '../server/shipment-operations';
import { saveShipmentTrip } from '../server/shipment-trips';
import { integrationRuntime, integrationApi, integrationSettings } from './helpers/trip-saby-integration';
import type { ShipmentTrip } from '../web/src/model';

const prefix = '/api/logistics';
const editing = (trip: ShipmentTrip) => ({ fields: { ...trip.fields }, customers: trip.customers.map(({ id, fields }) => ({ id, fields: { ...fields } })), versions: Object.fromEntries(trip.customers.map(row => [row.id, row.version])) });

async function fixture() {
  const rt = await integrationRuntime(), provider = integrationApi();
  await rt.store.mutate(rt.source, data => {
    data.companies.find(row => row.id === 'customer')!.bankName = 'PRIVATE-BANK-SENTINEL';
    data.companies.find(row => row.id === 'customer')!.settlementAccount = 'PRIVATE-ACCOUNT-SENTINEL';
    data.companies.push({ id: 'payment-only', name: 'PRIVATE-PAYMENT-ONLY-SENTINEL', roles: ['incoming'], shipmentIds: [], paymentIds: ['payment-hidden'], managerLabels: [], flags: [] });
    data.companies.push({ id: 'depot-participant', name: 'Operational loading participant', roles: ['other'], shipmentIds: [], paymentIds: [], managerLabels: [], flags: [] });
    data.companies.push({ id: 'unused-participant', name: 'New operational participant', roles: ['other'], shipmentIds: [], paymentIds: [], managerLabels: [], flags: [] });
    data.directories!.oilDepots![0].infrastructureOwnerCompanyId = 'depot-participant';
    data.directories!.addresses.push({ id: 'payment-address', companyId: 'payment-only', kind: 'delivery', name: 'PRIVATE-PAYMENT-ADDRESS-SENTINEL' });
    data.directories!.managers.push({ id: 'other-manager', name: 'Другой сотрудник' });
    data.directories!.customerManagers = [{ companyId: 'customer', managerId: 'manager' }];
    return { result: null, changed: true };
  });
  const middleware = createSnapshotMiddleware(rt.snapshotDirectory, { operationsStore: rt.store, sabyClient: provider.client(), sabyWorkflowMonitoringEnabled: false });
  const server = createServer((request, response) => middleware(request, response, () => { response.writeHead(404); response.end(); }));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = async (path: string, method = 'GET', data?: unknown, cookie?: string, extraHeaders: Record<string,string> = {}) => {
    const response = await fetch(origin + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}), ...extraHeaders }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    const text = await response.text();
    return { status: response.status, body: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : null, text, cookie: response.headers.get('set-cookie')?.split(';')[0], headers: response.headers };
  };
  const password = randomUUID();
  const created = await request('/api/auth/setup', 'POST', { name: 'Синтетический директор', login: 'logistics-owner', password });
  assert.equal(created.status, 200, created.text);
  const crmCookie = created.cookie!;
  const signed = await request(prefix + '/auth/login', 'POST', { login: 'logistics-owner', password });
  assert.equal(signed.status, 200, signed.text);
  const cookie = signed.cookie!;
  const user = async (sections: string[] = ['trips'], managerId = 'manager', login = 'logistics-employee') => {
    const input = { name: login, login, password, role: 'manager', managerId, sections };
    const created = await request('/api/auth/users', 'POST', input, crmCookie);
    assert.equal(created.status, 201, created.text);
    const signed = await request(prefix + '/auth/login', 'POST', { login, password });
    return { ...created.body.user, cookie: signed.cookie, loginStatus: signed.status, input };
  };
  const sample = (trip = rt.trip) => ({ idempotencyKey: randomUUID(), fields: Object.fromEntries(['organization_id', 'date', 'supplier_id', 'carrier_id', 'oil_depot_id', 'product_id', 'purchase_price_unspecified_unit', 'quantity_tonnes', 'driver_id', 'vehicle_id', 'loading_planned_at', 'additional_costs'].map(key => [key, trip.fields[key]])), customers: trip.customers.map(({ fields }) => ({ fields: Object.fromEntries(['customer_id', 'manager_id', 'payment_form_id', 'quantity_litres', 'sale_price_per_litre', 'transport_amount', 'unloading_address_id', 'unloading_planned_at'].map(key => [key, fields[key]])) })) });
  return { ...rt, provider, request, cookie, crmCookie, password, user, sample, async close() { await new Promise<void>(done => server.close(() => done())); await rt.close(); } };
}

test('logistics sessions are audience-bound, independent of CRM, persist, and never reveal bank/accounting data', async () => {
  const f = await fixture();
  try {
    const context = await f.request(prefix + '/context', 'GET', undefined, f.cookie);
    assert.equal(context.status, 200, context.text);
    assert.deepEqual(Object.keys(context.body).sort(), ['companies', 'directories']);
    assert.doesNotMatch(context.text, /PRIVATE-BANK|PRIVATE-ACCOUNT|PRIVATE-PAYMENT|bankName|settlementAccount|deletedEntries|provenance|passwordHash/);
    assert.ok(context.body.companies.some((company: { id: string }) => company.id === 'depot-participant'));
    assert.ok(context.body.companies.some((company: { id: string }) => company.id === 'unused-participant'));
    assert.ok(context.body.companies.every((row: { shipmentIds: string[]; paymentIds: string[] }) => !row.shipmentIds.length && !row.paymentIds.length));
    assert.equal(context.body.directories.vehicles[0].payloadTonnes, '20');
    assert.match((await f.request('/api/snapshot', 'GET', undefined, f.crmCookie)).text, /PRIVATE-BANK-SENTINEL/);
    assert.equal((await f.request(prefix + '/context')).status, 401);
    assert.equal((await f.request(prefix + '/context', 'GET', undefined, f.crmCookie)).status, 401);
    assert.equal((await f.request('/api/snapshot', 'GET', undefined, f.cookie)).status, 401);
    assert.equal((await f.request('/api/snapshot', 'GET', undefined, f.cookie.replace('artel_logistics_session=', 'artel_session='))).status, 401);
    assert.equal((await f.request(prefix + '/context', 'GET', undefined, f.crmCookie.replace('artel_session=', 'artel_logistics_session='))).status, 401);
    const stored = await new OperationsStore(dirname(f.store.path)).read(f.source);
    assert.ok(stored.accounts!.sessions.some(row => row.audience === 'logistics'));
    assert.ok(stored.accounts!.sessions.some(row => row.audience === undefined));
    const logout = await f.request(prefix + '/auth/logout', 'POST', {}, `${f.crmCookie}; ${f.cookie}`);
    assert.equal(logout.status, 200); assert.match(logout.headers.get('set-cookie')!, /Path=\/api\/logistics;/);
    assert.equal((await f.request(prefix + '/context', 'GET', undefined, f.cookie)).status, 401);
    assert.equal((await f.request('/api/snapshot', 'GET', undefined, f.crmCookie)).status, 200);
    const another = await f.request(prefix + '/auth/login', 'POST', { login: 'logistics-owner', password: f.password });
    assert.equal((await f.request('/api/auth/logout', 'POST', {}, `${f.crmCookie}; ${another.cookie}`)).status, 200);
    assert.equal((await f.request(prefix + '/context', 'GET', undefined, another.cookie)).status, 200);
    assert.equal((await f.request('/api/snapshot', 'GET', undefined, f.crmCookie)).status, 401);
  } finally { await f.close(); }
});

test('logistics default-denies banking, administration, raw snapshot, shipments and unsupported methods without changes', async () => {
  const f = await fixture();
  try {
    const before = await readFile(f.store.path, 'utf8');
    for (const [path, method] of [['/snapshot', 'GET'], ['/shipments', 'GET'], ['/auth/users', 'GET'], ['/auth/setup', 'POST'], ['/work', 'GET'], ['/china', 'GET'], ['/settlements', 'GET'], ['/banking', 'GET'], ['/banking/sber/statements', 'GET'], ['/banking/dispatch', 'GET'], ['/push/dispatch', 'GET'], ['/directories/cleanup', 'POST'], ['/companies/from-inn', 'POST'], ['/directories/managers/manager', 'PATCH'], ['/directories/customerManagers/customer', 'DELETE']]) {
      assert.equal((await f.request(prefix + path, method, method === 'GET' ? undefined : {}, f.cookie)).status, 403, path);
    }
    for (const kind of ['managers', 'customerManagers', 'paymentForms']) assert.equal((await f.request(prefix + '/directories', 'POST', { kind, name: 'Denied' }, f.cookie)).status, 403);
    for (const path of ['/directories/companies/payment-only', '/directories/addresses/payment-address']) for (const method of ['PATCH', 'DELETE']) assert.equal((await f.request(prefix + path, method, { version: 0 }, f.cookie)).status, 404);
    for (const body of [
      { kind: 'addresses', companyId: 'payment-only', name: 'Hidden party', addressKind: 'delivery' },
      { kind: 'oilDepots', ownerCompanyId: 'payment-only', name: 'Hidden owner', address: 'Synthetic address' },
      { kind: 'companies', name: 'New supplier', roles: ['supplier'], addresses: [{ name: 'Loading', kind: 'loading', loadingActorCompanyId: 'payment-only' }] },
    ]) assert.equal((await f.request(prefix + '/directories', 'POST', body, f.cookie)).status, 404);
    for (const [path, method] of [['/context', 'POST'], ['/auth/login', 'GET'], ['/shipment-trips', 'PUT'], [`/shipment-trips/${f.tripId}/saby`, 'DELETE'], ['/directories', 'PUT']]) assert.equal((await f.request(prefix + path, method, method === 'GET' ? undefined : {}, f.cookie)).status, 405, path);
    assert.equal((await f.request(prefix + '/context', 'GET', undefined, f.cookie, { origin: 'https://evil.example' })).status, 403);
    assert.equal(await readFile(f.store.path, 'utf8'), before);
    assert.equal(f.provider.calls.length, 0);
  } finally { await f.close(); }
});

test('logistics trip CRUD retains multiple deliveries, durable create repeats, version conflicts and shared accounting', async () => {
  const f = await fixture();
  try {
    const input = f.sample();
    const [a, b] = await Promise.all([1, 2].map(() => f.request(prefix + '/shipment-trips', 'POST', input, f.cookie)));
    assert.equal(a.status, 201, a.text); assert.equal(b.status, 201, b.text); assert.equal(a.body.trip.id, b.body.trip.id);
    const trip = a.body.trip as ShipmentTrip; assert.equal(trip.customers.length, 2);
    const crm = await f.request(`/api/shipment-trips/${trip.id}`, 'GET', undefined, f.crmCookie);
    assert.deepEqual(crm.body.trip, trip);
    const changed = structuredClone(input); changed.fields.trip_notes = 'Different retry';
    assert.equal((await f.request(prefix + '/shipment-trips', 'POST', changed, f.cookie)).status, 409);
    const edit = editing(trip); edit.fields.trip_notes = 'Updated through logistics';
    const updated = await f.request(`${prefix}/shipment-trips/${trip.id}`, 'PATCH', edit, f.cookie);
    assert.equal(updated.status, 200, updated.text);
    assert.equal((await f.request(`${prefix}/shipment-trips/${trip.id}`, 'PATCH', edit, f.cookie)).status, 409);
    assert.equal((await f.request(`${prefix}/shipment-trips/${trip.id}`, 'DELETE', { versions: editing(trip).versions }, f.cookie)).status, 409);
    const removed = await f.request(`${prefix}/shipment-trips/${trip.id}`, 'DELETE', { versions: editing(updated.body.trip).versions }, f.cookie);
    assert.equal(removed.status, 200, removed.text);
    assert.equal((await f.request(`/api/shipment-trips/${trip.id}`, 'GET', undefined, f.crmCookie)).status, 404);
    assert.equal((await f.request(prefix + '/shipment-trips', 'POST', input, f.cookie)).status, 409);
    assert.equal(f.provider.calls.length, 0);
  } finally { await f.close(); }
});

test('logistics managers retain own-client isolation, hidden mixed trips, denied directory writes and immediate revocation', async () => {
  const f = await fixture();
  try {
    const user = await f.user(); assert.equal(user.loginStatus, 200);
    const context = await f.request(prefix + '/context', 'GET', undefined, user.cookie);
    assert.equal(context.status, 200);
    assert.equal(context.body.directories.drivers[0].phone, undefined);
    assert.equal(context.body.directories.vehicles[0].payloadTonnes, undefined);
    assert.equal(context.body.directories.currentEmployeeId, 'manager');
    assert.deepEqual(context.body.directories.managers.map((row: { id: string }) => row.id), ['manager']);
    assert.equal((await f.request(prefix + '/directories', 'GET', undefined, user.cookie)).status, 200);
    assert.equal((await f.request(prefix + '/shipment-trips', 'POST', f.sample(), user.cookie)).status, 201);
    const foreign = f.sample(); foreign.customers.forEach(row => { row.fields.manager_id = 'other-manager'; });
    const mixed = f.sample(); mixed.customers[1].fields.manager_id = 'other-manager';
    const foreignTrip = await f.request(prefix + '/shipment-trips', 'POST', foreign, f.cookie), mixedTrip = await f.request(prefix + '/shipment-trips', 'POST', mixed, f.cookie);
    assert.equal(foreignTrip.status, 201, foreignTrip.text); assert.equal(mixedTrip.status, 201, mixedTrip.text);
    const listed = await f.request(prefix + '/shipment-trips', 'GET', undefined, user.cookie);
    assert.ok(!listed.text.includes(foreignTrip.body.trip.id)); assert.ok(!listed.text.includes(mixedTrip.body.trip.id));
    for (const suffix of ['', '/saby', '/saby-workflow', '/etrn', `/etrn/xml/${foreignTrip.body.trip.customers[0].id}`, `/etrn/files/${foreignTrip.body.trip.customers[0].id}/file`]) assert.equal((await f.request(`${prefix}/shipment-trips/${foreignTrip.body.trip.id}${suffix}`, 'GET', undefined, user.cookie)).status, 404, suffix);
    assert.equal((await f.request(`${prefix}/shipment-trips/${mixedTrip.body.trip.id}`, 'GET', undefined, user.cookie)).status, 403);
    assert.equal((await f.request(prefix + '/shipment-trips', 'POST', foreign, user.cookie)).status, 403);
    assert.equal((await f.request(`${prefix}/shipment-trips/${f.tripId}`, 'DELETE', { versions: editing(f.trip).versions }, user.cookie)).status, 403);
    assert.equal((await f.request(prefix + '/directories', 'POST', { kind: 'products', name: 'Denied' }, user.cookie)).status, 403);
    const revocation = await f.request(`/api/auth/users/${user.id}`, 'PATCH', { ...user.input, sections: [], version: user.version }, f.crmCookie);
    assert.equal(revocation.status, 200, revocation.text);
    assert.equal((await f.request(prefix + '/context', 'GET', undefined, user.cookie)).status, 401);
    assert.equal((await f.request(prefix + '/auth/session', 'GET', undefined, user.cookie)).body.user, null);
    assert.equal((await f.request(prefix + '/auth/login', 'POST', { login: user.login, password: f.password })).status, 403);
    const limited = await f.user(['shipments', 'directories'], 'other-manager', 'no-trips');
    assert.equal(limited.loginStatus, 403); assert.equal(limited.cookie, undefined);
  } finally { await f.close(); }
});

test('logistics directory edits preserve hidden bank fields and original directory permissions', async () => {
  const f = await fixture();
  try {
    const user = await f.user(['trips', 'directories']);
    const context = await f.request(prefix + '/context', 'GET', undefined, user.cookie);
    assert.equal(context.body.directories.drivers[0].phone, '+70000000003');
    assert.doesNotMatch(context.text, /PRIVATE-BANK|PRIVATE-ACCOUNT/);
    assert.equal((await f.request(prefix + '/companies/lookup', 'POST', { inn: '7707083893' }, user.cookie)).status, 403);
    const input = { version: 0, name: 'Обновлённый тестовый клиент', inn: '010000000102', roles: ['customer'], managerId: 'manager', addresses: [{ id: 'delivery', name: 'Доставка', kind: 'delivery', address: 'Синтетическая доставка' }] };
    assert.equal((await f.request(prefix + '/directories/companies/customer', 'PATCH', { ...input, settlementAccount: '' }, f.cookie)).status, 403);
    const saved = await f.request(prefix + '/directories/companies/customer', 'PATCH', input, f.cookie);
    assert.equal(saved.status, 200, saved.text); assert.doesNotMatch(saved.text, /PRIVATE-BANK|PRIVATE-ACCOUNT|bankName/);
    const after = await f.store.read(f.source);
    assert.equal(after.companies.find(row => row.id === 'customer')!.bankName, 'PRIVATE-BANK-SENTINEL');
    assert.equal(after.companies.find(row => row.id === 'customer')!.settlementAccount, 'PRIVATE-ACCOUNT-SENTINEL');
    assert.equal((await f.request(prefix + '/directories/companies/customer', 'PATCH', input, f.cookie)).status, 409);
    const newVehicle = await f.request(prefix + '/directories', 'POST', { kind: 'vehicles', plate: 'Т999ТТ777', capacityLitres: '10000' }, f.cookie);
    assert.equal(newVehicle.status, 201, newVehicle.text);
    assert.equal((await f.request(prefix + `/directories/vehicles/${newVehicle.body.entry.id}`, 'DELETE', { version: 0 }, f.cookie)).status, 200);
  } finally { await f.close(); }
});

test('logistics Saby workflow uses the shared synthetic provider, protects transmitted trips and exposes authorized files only', async () => {
  const f = await fixture(), previous = process.env.SABY_AUTOFILL_PROFILE_JSON;
  process.env.SABY_AUTOFILL_PROFILE_JSON = JSON.stringify(integrationSettings);
  try {
    await f.store.mutate(f.source, data => { data.directories!.oilDepots![0].infrastructureOwnerCompanyId = 'supplier'; return { result: null, changed: true }; });
    const path = `${prefix}/shipment-trips/${f.tripId}`, workflow = path + '/saby-workflow';
    const preflight = await f.request(workflow, 'GET', undefined, f.cookie);
    assert.equal(preflight.status, 200, preflight.text); assert.equal(preflight.body.ready, true, preflight.text); assert.equal(f.provider.calls.length, 0);
    assert.equal((await f.request(path + '/saby', 'GET', undefined, f.cookie)).status, 200);
    assert.equal((await f.request(workflow, 'POST', { ignored: true }, f.cookie)).status, 400);
    const started = await f.request(workflow, 'POST', {}, f.cookie);
    assert.equal(started.status, 200, started.text); assert.equal(started.body.phase, 'awaiting_carrier', started.text);
    assert.equal((await f.request(path, 'PATCH', editing(f.trip), f.cookie)).status, 409);
    assert.equal((await f.request(path, 'DELETE', { versions: editing(f.trip).versions }, f.cookie)).status, 409);
    f.provider.accept();
    const waiting = await f.request(workflow, 'POST', {}, f.cookie);
    assert.equal(waiting.body.phase, 'awaiting_loading', waiting.text);
    assert.equal((await f.request(workflow + '/loading-facts', 'POST', { ...f.facts(), departedAt: '2099-01-01T10:00' }, f.cookie)).status, 400);
    const complete = await f.request(workflow + '/loading-facts', 'POST', f.facts(), f.cookie);
    assert.equal(complete.body.phase, 'completed', complete.text);
    const writes = f.provider.writes().length;
    assert.equal((await f.request(workflow, 'POST', {}, f.cookie)).status, 200);
    assert.equal(f.provider.writes().length, writes);
    const etrn = await f.request(path + '/etrn', 'GET', undefined, f.cookie);
    assert.equal(etrn.status, 200, etrn.text); assert.equal(etrn.body.deliveries.length, 2);
    assert.doesNotMatch(etrn.text, /private-integration-session|disk\.saby|ДвоичныеДанные/);
    const delivery = etrn.body.deliveries[0], shipmentId = delivery.shipmentId, fileId = delivery.document.files[0].id;
    assert.equal(delivery.document.signatureStatus, 'not_signed');
    const file = await f.request(`${path}/etrn/files/${shipmentId}/${encodeURIComponent(fileId)}`, 'GET', undefined, f.cookie);
    assert.equal(file.status, 200, file.text); assert.match(file.headers.get('content-disposition')!, /attachment/);
    assert.equal((await f.request(`${path}/etrn/files/${shipmentId}/${encodeURIComponent(fileId)}`, 'GET', undefined, f.crmCookie)).status, 401);
    assert.equal((await f.request(path + '/etrn/refresh', 'POST', { shipmentId }, f.cookie)).status, 200);
    const stored = await f.store.read(f.source);
    assert.equal(currentSnapshot(f.base, stored).shipments.length, 2);
    // Creating through the same domain handler still observes the protected persistent state.
    assert.throws(() => saveShipmentTrip(f.base, structuredClone(stored), editing(f.trip), f.tripId));
  } finally { if (previous === undefined) delete process.env.SABY_AUTOFILL_PROFILE_JSON; else process.env.SABY_AUTOFILL_PROFILE_JSON = previous; await f.close(); }
});
