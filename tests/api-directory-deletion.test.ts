import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { createSnapshotMiddleware, loadSnapshot } from '../server/local-api';
import { OperationsStore, type OperationsData } from '../server/operations-store';
import { currentSnapshot } from '../server/shipment-operations';
import { clearOperations } from '../server/reset-operations';
import { deleteDirectoryEntry } from '../server/directory-deletion';
import { addDirectoryEntry } from '../server/directory-operations';
import { saveCompany, updateDirectoryEntry } from '../server/directory-editing';
import type { Snapshot } from '../web/src/model';

const base = await loadSnapshot(resolve('data/local-xlsx-final'));
async function setup(clear = true) {
  const directory = await mkdtemp(resolve(tmpdir(), 'artel-directory-delete-'));
  const store = new OperationsStore(directory);
  const mutate = <T>(fn: (snapshot: Snapshot, data: OperationsData) => T) => store.mutate(base.provenance.sourceSha256, data => {
    const result = fn(currentSnapshot(base, data), data);
    currentSnapshot(base, data);
    return { result, changed: true };
  });
  if (clear) await mutate((_, data) => clearOperations(base, data));
  const snapshot = async () => currentSnapshot(base, await new OperationsStore(directory).read(base.provenance.sourceSha256));
  const remove = (kind: string, id: string, version = 0) => mutate((snapshot, data) => deleteDirectoryEntry(kind, id, { version }, snapshot, data));
  return { store, snapshot, mutate, remove, close: () => rm(directory, { recursive: true, force: true }) };
}

test('deletion persists for source names and default forms; deleted fleet cannot return after storage reload', async () => {
  const runtime = await setup();
  try {
    const before = await runtime.snapshot();
    for (const kind of ['managers', 'products', 'paymentForms'] as const) {
      const entry = before.directories![kind][0];
      await runtime.remove(kind, entry.id);
      assert.ok(!(await runtime.snapshot()).directories![kind].some(row => row.id === entry.id));
    }
    const vehicle = before.directories!.vehicles[0];
    await assert.rejects(runtime.remove('vehicles', vehicle.id), /карточке водителя/);
    for (const driver of before.directories!.drivers.filter(row => row.vehicleId === vehicle.id)) {
      await runtime.remove('drivers', driver.id);
      assert.ok(!(await runtime.snapshot()).directories!.drivers.some(row => row.id === driver.id));
    }
    await runtime.remove('vehicles', vehicle.id);
    const after = await runtime.snapshot();
    assert.ok(!after.directories!.vehicles.some(row => row.id === vehicle.id));
    assert.equal(after.directories!.fleetSeedApplied, true);
    for (const kind of ['managers', 'products', 'paymentForms'] as const) assert.equal(after.directories![kind].length, before.directories![kind].length - 1);
    const other = await runtime.mutate((snapshot, data) => addDirectoryEntry({ kind: 'products', name: 'После удаления можно добавлять' }, snapshot, data));
    assert.ok((await runtime.snapshot()).directories!.products.some(row => row.id === other.entry.id));
  } finally { await runtime.close(); }
});

test('shared company is stored once, deleting customer role retains supplier and historical carrier role', async () => {
  const runtime = await setup();
  try {
    const result = await runtime.mutate((snapshot, data) => saveCompany({ name: 'Общий клиент поставщик', roles: ['customer', 'supplier'], addresses: [], managerId: null }, snapshot, data));
    const company = result.entry;
    await runtime.mutate((_, data) => { data.companies.find(row => row.id === company.id)!.roles.push('carrier'); });
    await runtime.remove('customers', company.id, company.version);
    let saved = (await runtime.snapshot()).companies.filter(row => row.id === company.id);
    assert.equal(saved.length, 1); assert.deepEqual(saved[0].roles, ['supplier', 'carrier']);
    await runtime.mutate((snapshot, data) => saveCompany({ version: saved[0].version, name: saved[0].name, roles: ['supplier'], addresses: [], managerId: null }, snapshot, data, company.id));
    saved = (await runtime.snapshot()).companies.filter(row => row.id === company.id);
    assert.ok(saved[0].roles.includes('carrier'));
    await runtime.remove('suppliers', company.id, saved[0].version);
    assert.deepEqual((await runtime.snapshot()).companies.find(row => row.id === company.id)!.roles, ['carrier']);
    await assert.rejects(runtime.mutate((snapshot, data) => saveCompany({ name: 'Новый перевозчик', roles: ['carrier'], addresses: [], managerId: null }, snapshot, data)), /клиент или поставщик/);
  } finally { await runtime.close(); }
});

test('a fleet seed matched to an older custom vehicle ID is not recreated after deletion', async () => {
  const runtime = await setup();
  try {
    const before = await runtime.snapshot(), seeded = before.directories!.vehicles[0], customId = 'vehicle-imported-before-seed';
    await runtime.mutate((_, data) => {
      data.directories!.vehicles.find(row => row.id === seeded.id)!.id = customId;
      for (const driver of data.directories!.drivers) if (driver.vehicleId === seeded.id) driver.vehicleId = customId;
      delete data.directories!.fleetSeedApplied;
    });
    const imported = await runtime.snapshot();
    assert.ok(!imported.directories!.vehicles.some(row => row.id === seeded.id));
    for (const driver of imported.directories!.drivers.filter(row => row.vehicleId === customId)) await runtime.remove('drivers', driver.id);
    await runtime.remove('vehicles', customId);
    const reloaded = await runtime.snapshot();
    assert.ok(!reloaded.directories!.vehicles.some(row => row.id === customId || row.id === seeded.id));
  } finally { await runtime.close(); }
});

test('unused local and imported companies are deleted permanently; owned addresses and manager links block company removal', async () => {
  const runtime = await setup();
  try {
    const initial = await runtime.snapshot(), manager = initial.directories!.managers[0];
    const created = await runtime.mutate((snapshot, data) => saveCompany({ name: 'Удаляемая компания', roles: ['customer'], addresses: [{ name: 'Адрес удаления', kind: 'delivery' }], managerId: manager.id }, snapshot, data));
    const company = created.entry;
    await assert.rejects(runtime.remove('customers', company.id, company.version), /справочнике адресов/);
    const address = (await runtime.snapshot()).directories!.addresses.find(row => row.companyId === company.id)!;
    await runtime.remove('addresses', address.id);
    await assert.rejects(runtime.remove('customers', company.id, company.version), /назначении менеджера/);
    await assert.rejects(runtime.remove('managers', manager.id), /назначении менеджера/);
    await runtime.mutate((snapshot, data) => deleteDirectoryEntry('customerManagers', company.id, { managerId: manager.id }, snapshot, data));
    await runtime.remove('customers', company.id, company.version);
    assert.ok(!(await runtime.snapshot()).companies.some(row => row.id === company.id));
    const imported = initial.companies.find(row => !initial.directories!.addresses.some(address => address.companyId === row.id))!;
    await runtime.remove('companies', imported.id, imported.version);
    assert.ok(!(await runtime.snapshot()).companies.some(row => row.id === imported.id));
  } finally { await runtime.close(); }
});

test('source operation dependencies block deletion including source records renamed in their directory', async () => {
  const runtime = await setup(false);
  try {
    const snapshot = await runtime.snapshot(), shipment = snapshot.shipments.find(row => row.customerId && row.supplierId && row.fields.manager_label && row.fields.product && row.fields.payment_form)!;
    for (const role of ['customer', 'supplier'] as const) {
      const company = snapshot.companies.find(row => row.id === shipment[`${role}Id`])!;
      await assert.rejects(runtime.remove(role === 'customer' ? 'customers' : 'suppliers', company.id), /в отгрузках/);
    }
    for (const [kind, field] of [['managers', 'manager_label'], ['products', 'product'], ['paymentForms', 'payment_form']] as const) {
      const entry = snapshot.directories![kind].find(row => row.name.toLocaleLowerCase('ru') === shipment.fields[field]!.trim().toLocaleLowerCase('ru'));
      assert.ok(entry, `source directory match for ${kind}`);
      await runtime.mutate((snapshot, data) => updateDirectoryEntry(kind, entry.id, { version: 0, name: `Новое имя ${kind}` }, snapshot, data));
      await assert.rejects(runtime.remove(kind, entry.id, 1), /в отгрузках/);
    }
  } finally { await runtime.close(); }
});

test('HTTP deletion requires a real session and director/admin role; dependencies and versions are checked on the server', async () => {
  const runtime = await setup();
  const middleware = createSnapshotMiddleware(resolve('data/local-xlsx-final'), { operationsStore: runtime.store });
  const server = createServer((request, response) => middleware(request, response, () => { response.writeHead(404); response.end(); }));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = async (path: string, method: string, body: unknown, cookie = '', origin?: string) => {
    const response = await fetch(url + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(origin ? { Origin: origin } : {}) }, ...(method !== 'GET' ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] ?? '' };
  };
  try {
    const password = randomBytes(24).toString('hex');
    const director = await request('/api/auth/setup', 'POST', { name: 'Тестовый директор удаления', login: 'delete-director', password });
    assert.equal(director.status, 200); assert.ok(director.cookie);
    const managerId = (await runtime.snapshot()).directories!.managers[0].id;
    assert.equal((await request('/api/auth/users', 'POST', { name: 'Тестовый менеджер удаления', login: 'delete-manager', password, role: 'manager', managerId }, director.cookie)).status, 201);
    const manager = await request('/api/auth/login', 'POST', { login: 'delete-manager', password });
    assert.equal(manager.status, 200);
    const created = await request('/api/directories', 'POST', { kind: 'products', name: 'HTTP удаляемый товар' }, director.cookie);
    assert.equal(created.status, 201);
    const path = `/api/directories/products/${created.body.entry.id}`;
    assert.equal((await request(path, 'DELETE', { version: 0 })).status, 401);
    assert.equal((await request(path, 'DELETE', { version: 0 }, manager.cookie)).status, 403);
    assert.equal((await request(path, 'DELETE', { version: 0 }, director.cookie, 'https://untrusted.invalid')).status, 403);
    assert.equal((await request(path, 'DELETE', { version: 1 }, director.cookie)).status, 409);
    assert.equal((await request(`/api/directories/managers/${managerId}`, 'DELETE', { version: 0 }, director.cookie)).status, 409);
    assert.equal((await request(path, 'DELETE', { version: 0 }, director.cookie)).status, 200);
    assert.equal((await request(path, 'DELETE', { version: 0 }, director.cookie)).status, 404);
    assert.ok(!(await runtime.snapshot()).directories!.products.some(row => row.id === created.body.entry.id));
    assert.equal((await request('/api/auth/users', 'POST', { name: 'Тестовый администратор', login: 'delete-admin', password, role: 'admin' }, director.cookie)).status, 201);
    const admin = await request('/api/auth/login', 'POST', { login: 'delete-admin', password });
    const forAdmin = await request('/api/directories', 'POST', { kind: 'paymentForms', name: 'Проверка прав администратора' }, director.cookie);
    assert.equal((await request(`/api/directories/paymentForms/${forAdmin.body.entry.id}`, 'DELETE', { version: 0 }, admin.cookie)).status, 200);
  } finally {
    await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
    await runtime.close();
  }
});

test('optimistic deletion rejects stale versions, duplicate requests and unknown input without rewriting storage', async () => {
  const runtime = await setup();
  try {
    const entry = (await runtime.snapshot()).directories!.products[0];
    await runtime.mutate((snapshot, data) => updateDirectoryEntry('products', entry.id, { version: 0, name: 'Версионный товар' }, snapshot, data));
    const before = await readFile(runtime.store.path, 'utf8');
    await assert.rejects(runtime.remove('products', entry.id, 0), /уже изменена/);
    await assert.rejects(runtime.mutate((snapshot, data) => deleteDirectoryEntry('products', entry.id, { version: 1, force: true }, snapshot, data)), /Неизвестное поле/);
    assert.equal(await readFile(runtime.store.path, 'utf8'), before);
    const results = await Promise.allSettled([runtime.remove('products', entry.id, 1), runtime.remove('products', entry.id, 1)]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(results.filter(result => result.status === 'rejected').length, 1);
    assert.ok(!(await runtime.snapshot()).directories!.products.some(row => row.id === entry.id));
  } finally { await runtime.close(); }
});

test('work company references block physical removal while a shared role may be removed safely', async () => {
  const runtime = await setup();
  try {
    const created = await runtime.mutate((snapshot, data) => saveCompany({ name: 'Компания рабочих записей', roles: ['customer', 'supplier'], addresses: [], managerId: null }, snapshot, data));
    await runtime.mutate((_, data) => { data.work = { notes: [], companyRecords: [], tasks: [{ id: 'work-task-test', version: 1, assigneeId: 'user-test', createdBy: 'user-test', updatedBy: 'user-test', createdAt: '2026-09-10T10:00:00.000Z', updatedAt: '2026-09-10T10:00:00.000Z', title: 'Связь с компанией', description: '', status: 'todo', companyId: created.entry.id, dueDate: null, reminderAt: null }] }; });
    await runtime.remove('customers', created.entry.id, created.entry.version);
    await assert.rejects(runtime.remove('suppliers', created.entry.id, 2), /рабочем пространстве/);
  } finally { await runtime.close(); }
});
