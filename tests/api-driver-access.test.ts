import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createSnapshotMiddleware } from '../server/local-api';
import { currentSnapshot } from '../server/shipment-operations';
import { saveShipmentTrip } from '../server/shipment-trips';
import { createMissingDriverAccounts } from '../server/driver-access';
import { validateAccounts } from '../server/auth';
import { integrationRuntime, integrationApi } from './helpers/trip-saby-integration';

async function fixture() {
  const rt = await integrationRuntime(), provider = integrationApi();
  const other = await rt.store.mutate(rt.source, data => {
    const driver = data.directories!.drivers[0];
    // Deliberately the same name, telephone and vehicle: identity is exclusively the driver ID.
    data.directories!.drivers.push({ ...driver, id: 'driver-other' }, { ...driver, id: 'driver-unused', name: 'Неиспользуемый водитель', fullName: 'Неиспользуемый синтетический водитель' });
    data.directories!.deletedEntries = { drivers: ['driver-deleted'] };
    const fields = Object.fromEntries(['organization_id', 'date', 'supplier_id', 'carrier_id', 'oil_depot_id', 'product_id', 'purchase_price_unspecified_unit', 'quantity_tonnes', 'driver_id', 'vehicle_id', 'loading_planned_at', 'additional_costs'].map(key => [key, rt.trip.fields[key]]));
    fields.driver_id = 'driver-other';
    const customers = rt.trip.customers.map(row => ({ fields: Object.fromEntries(['customer_id', 'manager_id', 'payment_form_id', 'quantity_litres', 'sale_price_per_litre', 'transport_amount', 'unloading_address_id', 'unloading_planned_at'].map(key => [key, row.fields[key]])) }));
    return { result: saveShipmentTrip(rt.base, data, { fields, customers, idempotencyKey: randomUUID() }), changed: true };
  });
  const middleware = createSnapshotMiddleware(rt.snapshotDirectory, { operationsStore: rt.store, sabyClient: provider.client(), sabyWorkflowMonitoringEnabled: false });
  const server = createServer((request, response) => middleware(request, response, () => { response.writeHead(404); response.end(); }));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = async (path: string, method = 'GET', data?: unknown, cookie?: string) => {
    const response = await fetch(origin + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    const text = await response.text();
    return { status: response.status, body: JSON.parse(text), text, cookie: response.headers.get('set-cookie')?.split(';')[0], headers: response.headers };
  };
  const password = randomUUID();
  const owner = await request('/api/auth/setup', 'POST', { name: 'Синтетический директор', login: 'driver-owner', password });
  assert.equal(owner.status, 200);
  const adminCookie = owner.cookie!;
  const logistics = await request('/api/logistics/auth/login', 'POST', { login: 'driver-owner', password });
  const issue = async (driverId = 'driver') => {
    const response = await request(`/api/drivers/${driverId}/access`, 'POST', { version: 0, action: 'issue' }, adminCookie);
    assert.equal(response.status, 200, response.text);
    const signed = await request('/api/auth/login', 'POST', { login: response.body.access.login, password: response.body.temporaryPassword });
    assert.equal(signed.status, 200, signed.text);
    return { ...response.body, cookie: signed.cookie!, user: signed.body.user };
  };
  return { ...rt, provider, request, issue, adminCookie, owner: owner.body.user, logisticsCookie: logistics.cookie!, otherTrip: other.trip,
    async close() { await new Promise<void>(done => server.close(() => done())); await rt.close(); } };
}

test('driver access is versioned, strong, single-use disclosure and one stable driver binding; employee credentials remain unchanged', async () => {
  const f = await fixture();
  try {
    const before = (await f.store.read(f.source)).accounts!.users[0];
    const initial = await f.request('/api/drivers/driver/access', 'GET', undefined, f.adminCookie);
    assert.equal(initial.status, 200); assert.equal(initial.body.access.status, 'not-issued'); assert.equal(initial.body.access.version, 0);
    const driver = await f.issue();
    assert.equal(driver.user.role, 'driver'); assert.equal(driver.user.driverId, 'driver'); assert.equal(driver.user.managerId, null); assert.deepEqual(driver.user.sections, []);
    assert.equal(driver.temporaryPassword.length, 32); assert.match(driver.temporaryPassword, /^[A-Za-z0-9_-]+$/);
    assert.equal(driver.access.loginUrl, 'https://artel-crm.online/');
    const stored = await f.store.read(f.source);
    assert.deepEqual(stored.accounts!.users[0], before);
    const saved = stored.accounts!.users.find(user => user.driverId === 'driver')!;
    assert.match(saved.passwordHash, /^[a-f0-9]{128}$/); assert.match(saved.salt, /^[a-f0-9]{32}$/);
    assert.ok(!(await readFile(f.store.path, 'utf8')).includes(driver.temporaryPassword));
    for (const [path, cookie] of [['/api/drivers/driver/access', f.adminCookie], ['/api/logistics/drivers/driver/access', f.logisticsCookie], ['/api/directories', f.adminCookie], ['/api/logistics/directories', f.logisticsCookie], ['/api/auth/session', driver.cookie]]) {
      const response = await f.request(path, 'GET', undefined, cookie);
      assert.equal(response.status, 200, path); assert.ok(!response.text.includes(driver.temporaryPassword)); assert.doesNotMatch(response.text, /passwordHash|"salt"/);
    }
    const repeat = await f.request('/api/logistics/drivers/driver/access', 'POST', { version: 1, action: 'issue' }, f.logisticsCookie);
    assert.equal(repeat.status, 200); assert.equal(repeat.body.temporaryPassword, undefined); assert.equal(repeat.body.access.userId, driver.access.userId);
    assert.equal((await f.request('/api/drivers/driver/access', 'POST', { version: 0, action: 'issue' }, f.adminCookie)).status, 409);
    assert.equal((await f.store.read(f.source)).accounts!.users.filter(user => user.driverId === 'driver').length, 1);
    const allUsers = await f.request('/api/auth/users', 'GET', undefined, f.adminCookie);
    assert.equal(allUsers.body.users.length, 2);
    assert.equal(allUsers.body.users.find((user: { id: string }) => user.id === driver.access.userId).driverId, 'driver');
    assert.doesNotMatch(allUsers.text, /passwordHash|salt|temporaryPassword/);
    assert.ok(!allUsers.text.includes(driver.temporaryPassword));
    assert.deepEqual((await f.store.read(f.source)).accounts!.users, stored.accounts!.users);
    assert.equal((await f.request('/api/driver/trips', 'GET', undefined, driver.cookie)).status, 200);
    assert.equal((await f.request(`/api/auth/users/${driver.access.userId}`, 'PATCH', { name: 'forged', login: 'forged', role: 'admin', managerId: 'manager', version: 1 }, f.adminCookie)).status, 403);
    assert.equal((await f.request('/api/auth/users', 'POST', { name: 'forged', login: 'forged', role: 'driver', driverId: 'driver-other', password: randomUUID() }, f.adminCookie)).status, 400);
  } finally { await f.close(); }
});

test('custom driver passwords support issue and reset through both audiences without plaintext storage or stale sessions', async () => {
  const f = await fixture();
  try {
    // Preserve whitespace exactly, as the shared authentication policy does.
    const firstPassword = ` ${randomUUID()} `, nextPassword = randomUUID();
    const endpoint = '/api/drivers/driver/access';
    const issued = await f.request(endpoint, 'POST', { version: 0, action: 'issue', password: firstPassword }, f.adminCookie);
    assert.equal(issued.status, 200); assert.equal(issued.body.temporaryPassword, firstPassword);
    const login = issued.body.access.login;
    const crm = await f.request('/api/auth/login', 'POST', { login, password: firstPassword });
    const logistics = await f.request('/api/logistics/auth/login', 'POST', { login, password: firstPassword });
    assert.equal(crm.status, 200); assert.equal(logistics.status, 200);
    const reset = await f.request('/api/logistics/drivers/driver/access', 'POST', { version: 1, action: 'reset', password: nextPassword }, f.logisticsCookie);
    assert.equal(reset.status, 200); assert.equal(reset.body.temporaryPassword, nextPassword);
    assert.equal(reset.body.access.userId, issued.body.access.userId);
    assert.equal((await f.request('/api/driver/trips', 'GET', undefined, crm.cookie)).status, 401);
    assert.equal((await f.request('/api/logistics/driver/trips', 'GET', undefined, logistics.cookie)).status, 401);
    assert.equal((await f.request('/api/auth/login', 'POST', { login, password: firstPassword })).status, 401);
    assert.equal((await f.request('/api/auth/login', 'POST', { login, password: nextPassword })).status, 200);
    const read = await f.request(endpoint, 'GET', undefined, f.adminCookie);
    const stored = await readFile(f.store.path, 'utf8');
    for (const secret of [firstPassword, nextPassword]) { assert.ok(!stored.includes(secret)); assert.ok(!read.text.includes(secret)); }
    assert.equal(read.body.temporaryPassword, undefined);
    assert.equal((await f.request(endpoint, 'POST', { version: 1, action: 'reset', password: randomUUID() }, f.adminCookie)).status, 409);
  } finally { await f.close(); }
});

test('invalid explicit driver passwords never generate a replacement or mutate accounts and sessions', async () => {
  const f = await fixture();
  try {
    for (const action of ['issue', 'reset']) {
      if (action === 'reset') await f.issue();
      const before = (await f.store.read(f.source)).accounts;
      for (const password of ['', 'x'.repeat(11), 'x'.repeat(257), null, 123, {}, []]) {
        const response = await f.request('/api/drivers/driver/access', 'POST', { version: action === 'issue' ? 0 : 1, action, password }, f.adminCookie);
        assert.equal(response.status, 400); assert.equal(response.body.temporaryPassword, undefined);
        assert.deepEqual((await f.store.read(f.source)).accounts, before);
      }
    }
  } finally { await f.close(); }
});

test('two drivers see only assigned trips and deliveries despite identical names, phone and vehicle; all financial fields omitted', async () => {
  const f = await fixture();
  try {
    const a = await f.issue(), b = await f.issue('driver-other');
    for (const [driver, own, foreign] of [[a, f.trip, f.otherTrip], [b, f.otherTrip, f.trip]]) {
      const listed = await f.request('/api/driver/trips', 'GET', undefined, driver.cookie);
      assert.equal(listed.status, 200); assert.equal(listed.body.total, 1); assert.equal(listed.body.trips[0].id, own.id);
      assert.deepEqual(listed.body.trips[0].deliveries.map((row: {id:string}) => row.id), own.customers.map(row => row.id));
      assert.doesNotMatch(listed.text, /sale_price|purchase_|transport_amount|paidAmount|revenue|cost|manager_id|password|inn|license|bank|Saby/);
      assert.ok(!listed.text.includes(foreign.id)); assert.equal((await f.request(`/api/driver/trips/${own.id}`, 'GET', undefined, driver.cookie)).status, 200);
      assert.equal((await f.request(`/api/driver/trips/${foreign.id}`, 'GET', undefined, driver.cookie)).status, 404);
      const search = await f.request(`/api/driver/trips?q=${encodeURIComponent(foreign.id)}`, 'GET', undefined, driver.cookie);
      assert.deepEqual(search.body, { trips: [], total: 0 });
      for (const path of ['/api/snapshot', '/api/shipments?search=customer', `/api/shipments/${foreign.customers[0].id}`, '/api/shipment-trips', '/api/directories', '/api/context', '/api/settlements', '/api/work', '/api/china', '/api/payroll', '/api/banking', '/api/banking/sber', '/api/auth/users', '/api/drivers/driver/access', '/api/driver/trips/counts']) assert.ok([403, 404].includes((await f.request(path, 'GET', undefined, driver.cookie)).status), path);
    }
    assert.equal((await f.request('/api/shipment-trips', 'GET', undefined, f.adminCookie)).body.trips.length, 2);
  } finally { await f.close(); }
});

test('driver requests fail closed for files, documents, Saby and every mutation before any provider or state changes', async () => {
  const f = await fixture();
  try {
    const a = await f.issue();
    const before = await readFile(f.store.path, 'utf8');
    for (const trip of [f.trip, f.otherTrip]) {
      for (const suffix of ['/saby', '/saby-workflow', '/etrn', `/etrn/xml/${trip.customers[0].id}`, `/etrn/files/${trip.customers[0].id}/guessed-file`]) {
        assert.equal((await f.request(`/api/shipment-trips/${trip.id}${suffix}`, 'GET', undefined, a.cookie)).status, 403);
        assert.equal((await f.request(`/api/shipment-trips/${trip.id}${suffix}`, 'POST', {}, a.cookie)).status, 403);
      }
      for (const path of [`/api/driver/trips/${trip.id}/files/guessed`, `/api/work/tasks/${trip.id}/files/guessed`]) assert.equal((await f.request(path, 'GET', undefined, a.cookie)).status, 403);
    }
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) for (const path of ['/api/driver/trips', `/api/driver/trips/${f.tripId}`, '/api/shipments', '/api/directories', '/api/drivers/driver/access', '/api/auth/users', `/api/auth/users/${f.owner.id}`]) assert.equal((await f.request(path, method, {}, a.cookie)).status, 403, `${method} ${path}`);
    assert.equal(await readFile(f.store.path, 'utf8'), before); assert.equal(f.provider.calls.length, 0);
    assert.equal((await f.request('/api/driver/trips', 'GET', undefined, f.adminCookie)).status, 403);
  } finally { await f.close(); }
});

test('password reset and revoke invalidate CRM and logistics sessions; audiences cannot be swapped; reissue never duplicates', async () => {
  const f = await fixture();
  try {
    const a = await f.issue();
    const logistics = await f.request('/api/logistics/auth/login', 'POST', { login: a.access.login, password: a.temporaryPassword });
    assert.equal(logistics.status, 200); const cookie = logistics.cookie!;
    assert.equal((await f.request('/api/logistics/driver/trips', 'GET', undefined, cookie)).body.total, 1);
    assert.equal((await f.request('/api/logistics/context', 'GET', undefined, cookie)).status, 403);
    assert.equal((await f.request('/api/driver/trips', 'GET', undefined, cookie.replace('artel_logistics_session=', 'artel_session='))).status, 401);
    assert.equal((await f.request('/api/logistics/driver/trips', 'GET', undefined, a.cookie.replace('artel_session=', 'artel_logistics_session='))).status, 401);
    const reset = await f.request('/api/logistics/drivers/driver/access', 'POST', { version: 1, action: 'reset' }, f.logisticsCookie);
    assert.equal(reset.status, 200); assert.equal(reset.body.access.version, 2); assert.notEqual(reset.body.temporaryPassword, a.temporaryPassword);
    assert.equal((await f.request('/api/driver/trips', 'GET', undefined, a.cookie)).status, 401);
    assert.equal((await f.request('/api/logistics/driver/trips', 'GET', undefined, cookie)).status, 401);
    assert.equal((await f.request('/api/auth/login', 'POST', { login: a.access.login, password: a.temporaryPassword })).status, 401);
    const signed = await f.request('/api/auth/login', 'POST', { login: a.access.login, password: reset.body.temporaryPassword }); assert.equal(signed.status, 200);
    const revoked = await f.request('/api/drivers/driver/access', 'PATCH', { version: 2, active: false }, f.adminCookie);
    assert.equal(revoked.status, 200); assert.equal(revoked.body.access.status, 'revoked');
    assert.equal((await f.request('/api/driver/trips', 'GET', undefined, signed.cookie)).status, 401);
    assert.equal((await f.request('/api/auth/login', 'POST', { login: a.access.login, password: reset.body.temporaryPassword })).status, 401);
    const issue = await f.request('/api/drivers/driver/access', 'POST', { version: 3, action: 'issue' }, f.adminCookie);
    assert.equal(issue.body.access.active, false); assert.equal(issue.body.temporaryPassword, undefined);
    const enabled = await f.request('/api/drivers/driver/access', 'POST', { version: 3, action: 'reset' }, f.adminCookie);
    assert.equal(enabled.body.access.active, true); assert.equal(enabled.body.access.userId, a.access.userId);
    assert.equal((await f.store.read(f.source)).accounts!.users.filter(user => user.driverId === 'driver').length, 1);
    assert.equal((await f.request('/api/auth/session', 'GET', undefined, f.adminCookie)).body.user.id, f.owner.id);
  } finally { await f.close(); }
});

test('driver ownership follows current stable assignment and fails closed for malformed mixed trips', async () => {
  const f = await fixture();
  try {
    const a = await f.issue(), b = await f.issue('driver-other');
    await f.store.mutate(f.source, data => { for (const row of f.trip.customers) data.shipments[row.id].fields.driver_id = 'driver-other'; return { result: null, changed: true }; });
    assert.equal((await f.request(`/api/driver/trips/${f.tripId}`, 'GET', undefined, a.cookie)).status, 404);
    assert.equal((await f.request('/api/driver/trips', 'GET', undefined, a.cookie)).body.total, 0);
    assert.equal((await f.request('/api/driver/trips', 'GET', undefined, b.cookie)).body.total, 2);
    await f.store.mutate(f.source, data => { data.shipments[f.trip.customers[0].id].fields.driver_id = 'driver'; return { result: null, changed: true }; });
    // Snapshot integrity rejects inconsistent shared trip fields before any projection is returned.
    for (const driver of [a, b]) {
      const rejected = await f.request(`/api/driver/trips/${f.tripId}`, 'GET', undefined, driver.cookie);
      assert.equal(rejected.status, 500); assert.equal(rejected.body.trip, undefined); assert.ok(!rejected.text.includes(f.trip.customers[0].id));
    }
  } finally { await f.close(); }
});

test('deleted directory identity loses login immediately and cannot be issued access or revived by provisioning', async () => {
  const f = await fixture();
  try {
    const a = await f.issue('driver-unused');
    const removed = await f.request('/api/directories/drivers/driver-unused', 'DELETE', { version: 0 }, f.adminCookie);
    assert.equal(removed.status, 200, removed.text);
    assert.equal((await f.request('/api/auth/session', 'GET', undefined, a.cookie)).body.user, null);
    assert.equal((await f.request('/api/driver/trips', 'GET', undefined, a.cookie)).status, 401);
    assert.equal((await f.request('/api/auth/login', 'POST', { login: a.access.login, password: a.temporaryPassword })).status, 401);
    for (const id of ['driver-unused', 'driver-deleted', 'unknown']) {
      assert.equal((await f.request(`/api/drivers/${id}/access`, 'GET', undefined, f.adminCookie)).status, 404);
      assert.equal((await f.request(`/api/drivers/${id}/access`, 'POST', { version: 0, action: 'issue' }, f.adminCookie)).status, 404);
    }
  } finally { await f.close(); }
});

test('batch provisioning creates only missing current drivers, keeps employee state, skips revoked, returns no passwords on repeat', async () => {
  const f = await fixture();
  try {
    const a = await f.issue();
    await f.request('/api/drivers/driver/access', 'PATCH', { version: 1, active: false }, f.adminCookie);
    const before = await f.store.read(f.source);
    const run = () => f.store.mutate(f.source, async data => { const result = await createMissingDriverAccounts(data, currentSnapshot(f.base, data, false)); return { result, changed: result.changed }; });
    const issued = await run(); assert.equal(issued.created.length, 2); assert.equal(issued.skipped, 1);
    assert.equal(new Set(issued.created.map(row => row.login)).size, 2); assert.equal(new Set(issued.created.map(row => row.temporaryPassword)).size, 2);
    const stored = await f.store.read(f.source);
    assert.deepEqual(stored.accounts!.users.find(user => user.id === f.owner.id), before.accounts!.users.find(user => user.id === f.owner.id));
    assert.deepEqual(stored.accounts!.users.find(user => user.id === a.access.userId), before.accounts!.users.find(user => user.id === a.access.userId));
    for (const issuedDriver of issued.created) assert.ok(!(await readFile(f.store.path, 'utf8')).includes(issuedDriver.temporaryPassword));
    const bytes = await readFile(f.store.path, 'utf8'); assert.deepEqual(await run(), { created: [], skipped: 3, changed: false }); assert.equal(await readFile(f.store.path, 'utf8'), bytes);
    const malformed = structuredClone(stored.accounts!); malformed.users.find(user => user.role === 'driver')!.sections = ['trips']; assert.throws(() => validateAccounts(malformed));
    const forged = structuredClone(stored.accounts!); forged.users.find(user => user.role === 'driver')!.managerId = 'manager'; assert.throws(() => validateAccounts(forged));
    const duplicated = structuredClone(stored.accounts!); duplicated.users.find(user => user.driverId === 'driver-other')!.driverId = 'driver'; assert.throws(() => validateAccounts(duplicated));
  } finally { await f.close(); }
});

test('manager rights remain employee-scoped and cannot manage or impersonate driver access', async () => {
  const f = await fixture();
  try {
    const password = randomUUID();
    const employee = await f.request('/api/auth/users', 'POST', { name: 'Сотрудник', login: 'trip-employee', password, role: 'manager', managerId: 'manager', sections: ['trips', 'directories'] }, f.adminCookie);
    assert.equal(employee.status, 201);
    const logged = await f.request('/api/auth/login', 'POST', { login: 'trip-employee', password });
    assert.equal(logged.status, 200);
    assert.equal((await f.request('/api/shipment-trips', 'GET', undefined, logged.cookie)).body.trips.length, 2);
    for (const method of ['GET', 'POST', 'PATCH']) assert.equal((await f.request('/api/drivers/driver/access', method, method === 'GET' ? undefined : {version:0,action:'issue'}, logged.cookie)).status, 403);
    assert.equal((await f.request('/api/driver/trips', 'GET', undefined, logged.cookie)).status, 403);
  } finally { await f.close(); }
});
