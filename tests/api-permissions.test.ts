import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSnapshotMiddleware, loadSnapshot } from '../server/local-api';
import { OperationsStore, encodeOperations, decodeOperations } from '../server/operations-store';
import { currentSnapshot } from '../server/shipment-operations';
import { scopeSnapshot } from '../server/auth-scope';
import { shipmentOwnership } from '../server/shipment-ownership';
import { sections, effectiveSections, legacyManagerSections, type AccountUser } from '../web/src/auth-model';
import type { Shipment, ShipmentTrip, Snapshot } from '../web/src/model';
const base = await loadSnapshot();

async function fixture() {
  const directory = await mkdtemp(resolve(tmpdir(), 'artel-permissions-'));
  const store = new OperationsStore(directory);
  await store.mutate(base.provenance.sourceSha256, data => { data.sourceOperationsCleared = true; return { changed: true, result: null }; });
  const middleware = createSnapshotMiddleware(undefined, { operationsStore: store });
  const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end(); }));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = () => {
    let cookie = '';
    return async (path: string, method = 'GET', body?: unknown) => {
      const r = await fetch(url + path, { method, headers: { cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      if (r.headers.has('set-cookie')) cookie = r.headers.get('set-cookie')!.split(';')[0];
      return { status: r.status, body: await r.json() };
    };
  };
  const director = client(), aidar = client(), zufar = client();
  const password = randomUUID();
  await director('/api/auth/setup', 'POST', { name: 'Director QA', login: 'director-qa', password });
  const users: AccountUser[] = [];
  for (const [name, login, api] of [['Айдар QA', 'aidar-qa', aidar], ['Зуфар QA', 'zufar-qa', zufar]] as const) {
    const employee = await director('/api/directories', 'POST', { kind: 'managers', name });
    const created = await director('/api/auth/users', 'POST', { name, login, password, role: 'manager', managerId: employee.body.entry.id, sections: sections.map(s => s.id) });
    assert.equal(created.status, 201, JSON.stringify(created.body)); users.push(created.body.user);
    assert.equal((await api('/api/auth/login', 'POST', { login, password })).status, 200);
  }
  const snapshot = (await director('/api/snapshot')).body as Snapshot;
  const azs = (managerId?: string) => ({ shipment_type: 'azs', date: '2026-09-01', customer_id: snapshot.companies[0].id, supplier_id: snapshot.companies[1].id, ...(managerId ? { manager_id: managerId } : {}), product_id: snapshot.directories!.products[0].id, payment_form_id: snapshot.directories!.paymentForms.find(p => p.name === 'б/нал')!.id, quantity_litres: '1000', customer_amount: '100000', purchase_amount: '80000' });
  return { director, aidar, zufar, client, users, password, store, snapshot, azs, close: async () => { await new Promise<void>(done => server.close(() => done())); await rm(directory, { recursive: true, force: true }); } };
}
const update = (user: AccountUser, changes: object = {}) => ({ name: user.name, login: user.login, role: user.role, managerId: user.managerId, active: user.active, version: user.version, sections: effectiveSections(user), ...changes });

test('administration links existing employees, rejects duplicate links, unknown privileges, missing employees and manager self-service', async () => {
  const f = await fixture(); try {
    const before = (await f.director('/api/directories')).body.directories.managers;
    const existing = await f.director('/api/directories', 'POST', { kind: 'managers', name: 'Айдар QA' });
    assert.equal(existing.body.created, false); assert.equal(existing.body.entry.id, f.users[0].managerId);
    for (const managerId of [null, 'missing-employee']) assert.equal((await f.director('/api/auth/users', 'POST', { name: 'No link', login: 'no-link', password: f.password, role: 'manager', managerId })).status, 400);
    assert.equal((await f.director('/api/auth/users', 'POST', { name: 'Duplicate', login: 'duplicate', password: f.password, role: 'manager', managerId: f.users[0].managerId })).status, 409);
    assert.deepEqual((await f.director('/api/directories')).body.directories.managers, before);
    assert.equal((await f.aidar('/api/auth/users')).status, 403);
    assert.equal((await f.aidar('/api/directories/reconcile-customers')).status, 403);
    assert.equal((await f.aidar('/api/directories/reconcile-customers', 'POST', {})).status, 403);
    assert.equal((await f.aidar('/api/china')).status, 403);
    assert.equal((await f.aidar('/api/banking/export')).status, 403);
    assert.equal((await f.aidar('/api/auth/users/' + f.users[0].id, 'PATCH', update(f.users[0], { role: 'director' }))).status, 403);
    for (const changes of [{ sections: ['unknown'] }, { sections: ['work', 'work'] }, { shipmentScope: 'all' }]) assert.equal((await f.director('/api/auth/users/' + f.users[0].id, 'PATCH', update(f.users[0], changes))).status, 400);
    const linkedAdmin = await f.director('/api/directories', 'POST', { kind: 'managers', name: 'Admin QA' });
    const created = await f.director('/api/auth/users', 'POST', { name: 'Admin', login: 'admin-qa', password: f.password, role: 'admin', managerId: linkedAdmin.body.entry.id, sections: [] });
    assert.equal(created.status, 201); assert.equal(created.body.user.sections.length, sections.length);
    const admin = f.client(); await admin('/api/auth/login', 'POST', { login: 'admin-qa', password: f.password });
    assert.equal((await admin('/api/auth/users')).status, 200);
    const director = (await f.director('/api/auth/users')).body.users.find((u: AccountUser) => u.role === 'director');
    for (const changes of [{ active: false }, { role: 'manager', managerId: null }]) assert.equal((await admin('/api/auth/users/' + director.id, 'PATCH', update(director, changes))).status, 409);
  } finally { await f.close(); }
});

test('two employees: IDs, spoofed owners, shared customers, search, facets, totals, sorting, pages and export pagination stay isolated', async () => {
  const f = await fixture(); try {
    const a = await f.aidar('/api/shipments', 'POST', { fields: f.azs() });
    const b = await f.zufar('/api/shipments', 'POST', { fields: { ...f.azs(), customer_amount: '777777', quantity_litres: '2222' } });
    assert.equal(a.status, 201, JSON.stringify(a.body)); assert.equal(b.status, 201, JSON.stringify(b.body));
    const aid = a.body.shipment.id, bid = b.body.shipment.id;
    assert.equal(a.body.shipment.fields.manager_id, f.users[0].managerId);
    const before = await readFile(f.store.path, 'utf8');
    assert.equal((await f.aidar('/api/shipments/' + bid)).status, 404);
    assert.equal((await f.aidar('/api/shipments/' + bid, 'PATCH', { version: 999, fields: { manager_id: f.users[0].managerId } })).status, 404);
    assert.equal((await f.aidar('/api/shipments/' + aid, 'PATCH', { version: 1, fields: { manager_id: f.users[1].managerId } })).status, 403);
    assert.equal((await f.aidar('/api/shipments', 'POST', { fields: f.azs(f.users[1].managerId!) })).status, 403);
    assert.equal((await f.aidar('/api/shipments/' + bid, 'DELETE', { version: 1 })).status, 403);
    assert.equal(await readFile(f.store.path, 'utf8'), before);
    for (const query of ['', '?manager=all&limit=1&offset=0&sort=customer_amount&direction=desc', '?companyId=' + f.snapshot.companies[0].id, '?managerId=' + f.users[1].managerId]) {
      const r = await f.aidar('/api/shipments' + query); assert.equal(r.status, 200);
      assert.deepEqual(r.body.items.map((row: Shipment) => row.id), [aid]); assert.equal(r.body.total, 1); assert.equal(r.body.summary.revenue.total, '100000');
      assert.ok(!JSON.stringify(r.body).includes(bid));
    }
    assert.equal((await f.aidar('/api/shipments?query=777777')).body.total, 0);
    assert.deepEqual((await f.aidar('/api/shipments?facet=manager_label')).body.facetValues, ['Айдар QA']);
    assert.equal((await f.aidar('/api/shipments')).body.topCustomers[0].revenue, '100000');
    assert.equal((await f.aidar('/api/shipments?manager=' + encodeURIComponent('Зуфар QA'))).body.total, 0);
    assert.equal((await f.aidar('/api/shipments?offset=1&limit=1')).body.items.length, 0);
    const snap = (await f.aidar('/api/snapshot')).body;
    assert.equal(snap.overview.shipmentCount, 1); assert.equal(snap.monthly[0].revenue.total, '100000');
    assert.deepEqual(snap.companies.find((c: { id: string }) => c.id === f.snapshot.companies[0].id).shipmentIds, [aid]);
    assert.equal((await f.director('/api/shipments')).body.total, 2);
    // CSV uses these same paginated rows; no separate unscoped export endpoint exists.
    const exported = []; let offset = 0;
    do { const page = (await f.aidar('/api/shipments?limit=1&offset=' + offset)).body; exported.push(...page.items); if (!page.hasMore) break; offset = page.nextOffset; } while (offset < 10);
    assert.deepEqual(exported.map(row => row.id), [aid]);
  } finally { await f.close(); }
});

test('mixed-owner trips hide shared totals and reject all partial truck changes atomically; own trips remain usable', async () => {
  const f = await fixture(); try {
    const c = f.snapshot.directories!;
    const fields = { date: '2026-09-01', supplier_id: f.snapshot.companies[1].id, product_id: c.products[0].id, purchase_price_unspecified_unit: '60000', quantity_tonnes: '16', driver_id: c.drivers[0].id, additional_costs: '1600' };
    const customer = (index: number) => ({ fields: { customer_id: f.snapshot.companies[0].id, manager_id: f.users[index].managerId, payment_form_id: c.paymentForms[0].id, quantity_litres: '8000', sale_price_per_litre: '65', transport_amount: '1000' } });
    const mixed = await f.director('/api/shipment-trips', 'POST', { fields, customers: [customer(0), customer(1)] }); assert.equal(mixed.status, 201, JSON.stringify(mixed.body));
    const trip = mixed.body.trip as ShipmentTrip;
    const own = (await f.aidar('/api/shipments')).body.items[0];
    assert.equal(own.tripReadOnly, true); assert.equal(own.fields.trip_total_tonnes, null); assert.equal(own.fields.trip_additional_costs, null);
    assert.equal((await f.aidar('/api/shipment-trips/' + trip.id)).status, 403);
    const before = await readFile(f.store.path, 'utf8');
    assert.equal((await f.aidar('/api/shipment-trips/' + trip.id, 'PATCH', { fields, customers: [customer(0)], versions: { [own.id]: own.version } })).status, 403);
    assert.equal((await f.aidar('/api/shipments/' + trip.customers[1].id, 'PATCH', { version: 1, fields: {} })).status, 404);
    assert.equal((await f.aidar('/api/shipment-trips', 'POST', { fields, customers: [customer(0), customer(1)] })).status, 403);
    assert.equal(await readFile(f.store.path, 'utf8'), before);
    const created = await f.aidar('/api/shipment-trips', 'POST', { fields, customers: [customer(0), customer(0)] }); assert.equal(created.status, 201);
    const ownTrip = created.body.trip as ShipmentTrip;
    assert.equal((await f.zufar('/api/shipment-trips/' + ownTrip.id)).status, 404);
    assert.equal((await f.aidar('/api/shipment-trips/' + ownTrip.id)).status, 200);
    const saved = await f.aidar('/api/shipment-trips/' + ownTrip.id, 'PATCH', { fields, customers: ownTrip.customers.map(row => ({ id: row.id, fields: row.fields })), versions: Object.fromEntries(ownTrip.customers.map(row => [row.id, row.version])) });
    assert.equal(saved.status, 200);
  } finally { await f.close(); }
});

test('section changes, account disable and password reset revoke sessions; shared APIs and private work files fail closed', async () => {
  const f = await fixture(); try {
    const task = await f.aidar('/api/work/tasks', 'POST', { title: 'Private QA', addAttachments: [{ name: 'private.txt', data: Buffer.from('private').toString('base64') }] });
    assert.equal(task.status, 201);
    const file = `/api/work/tasks/${task.body.entry.id}/files/${task.body.entry.attachments[0].id}`;
    assert.equal((await f.zufar(file)).status, 404);
    await f.aidar('/api/shipments', 'POST', { fields: f.azs() });
    let user = f.users[0];
    const changed = await f.director('/api/auth/users/' + user.id, 'PATCH', update(user, { sections: ['overview', 'directories'] }));
    assert.equal(changed.status, 200); user = changed.body.user;
    assert.equal((await f.aidar('/api/snapshot')).status, 401);
    await f.aidar('/api/auth/login', 'POST', { login: user.login, password: f.password });
    for (const path of ['/api/shipments', '/api/shipment-trips/guessed', '/api/work', file, '/api/china', '/api/banking/export', '/api/push/config']) assert.equal((await f.aidar(path)).status, 403, path);
    const snapshot = (await f.aidar('/api/snapshot')).body;
    assert.deepEqual(snapshot.shipments, []); assert.equal(snapshot.overview.shipmentCount, 0); assert.deepEqual(snapshot.monthly, []);
    assert.ok(snapshot.companies.every((company: { shipmentIds: string[] }) => company.shipmentIds.length === 0));
    const changedAgain = await f.director('/api/auth/users/' + user.id, 'PATCH', update(user, { sections: ['work'] })); user = changedAgain.body.user;
    await f.aidar('/api/auth/login', 'POST', { login: user.login, password: f.password });
    assert.equal((await f.aidar('/api/directories')).status, 403);
    for (const section of ['overview', 'stock', 'operator', 'payroll']) assert.equal((await f.aidar('/api/' + section)).status, 403);
    const work = (await f.aidar('/api/work')).body; assert.equal(work.work.tasks.length, 1);
    assert.ok(work.companies.every((company: { shipmentIds: string[]; inn?: string }) => company.shipmentIds.length === 0 && !company.inn));
    const password = randomUUID();
    user = (await f.director('/api/auth/users/' + user.id, 'PATCH', update(user, { password }))).body.user;
    assert.equal((await f.aidar('/api/work')).status, 401);
    assert.equal((await f.aidar('/api/auth/login', 'POST', { login: user.login, password: f.password })).status, 401);
    await f.aidar('/api/auth/login', 'POST', { login: user.login, password });
    assert.equal((await f.director('/api/auth/users/' + user.id, 'PATCH', update(user, { active: false }))).status, 200);
    assert.equal((await f.aidar('/api/work')).status, 401);
    assert.equal((await f.aidar('/api/auth/login', 'POST', { login: user.login, password })).status, 401);
  } finally { await f.close(); }
});

test('legacy accounts retain bounded defaults; missing employee associations, unknown IDs and ambiguous labels expose no shipments', async () => {
  const f = await fixture(); try {
    await f.store.mutate(base.provenance.sourceSha256, data => { const user = data.accounts!.users.find(u => u.id === f.users[0].id)!; delete user.sections; user.managerId = null; return { changed: true, result: null }; });
    const saved = await f.store.read(base.provenance.sourceSha256);
    assert.deepEqual(decodeOperations(encodeOperations(saved), base.provenance.sourceSha256).accounts, saved.accounts);
    const signed = await f.aidar('/api/auth/login', 'POST', { login: f.users[0].login, password: f.password });
    assert.deepEqual(signed.body.user.sections, legacyManagerSections);
    assert.equal((await f.aidar('/api/shipments')).body.total, 0);
    assert.equal((await f.director('/api/auth/users/' + f.users[0].id, 'PATCH', update({ ...f.users[0], managerId: null }, { active: false }))).status, 200);
    const snapshot = currentSnapshot(base, saved), employeeId = f.users[1].managerId!;
    const row = { ...base.shipments[0], fields: { ...base.shipments[0].fields, manager_id: null, manager_label: 'Зуфар QA' } };
    assert.equal(shipmentOwnership(snapshot, row).employeeId, employeeId);
    const ambiguous = { ...snapshot, directories: { ...snapshot.directories!, managers: [...snapshot.directories!.managers, { id: 'other-stable-id', name: 'Зуфар QA' }] }, shipments: [row] };
    assert.equal(shipmentOwnership(ambiguous, row).reason, 'ambiguous');
    assert.equal(scopeSnapshot(ambiguous, f.users[1]).shipments.length, 0);
    for (const manager_id of ['unknown-stable-id', null]) {
      const unresolved = { ...row, fields: { ...row.fields, manager_id, manager_label: 'Unknown person' } };
      assert.equal(scopeSnapshot({ ...snapshot, shipments: [unresolved] }, f.users[1]).shipments.length, 0);
    }
    const explicit = { ...row, fields: { ...row.fields, manager_id: employeeId } };
    assert.equal(scopeSnapshot({ ...snapshot, shipments: [explicit] }, { ...f.users[1], managerId: 'missing' }).shipments.length, 0);
  } finally { await f.close(); }
});
