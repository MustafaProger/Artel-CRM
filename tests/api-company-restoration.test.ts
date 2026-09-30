import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { createSnapshotMiddleware, loadSnapshot } from '../server/local-api';
import { OperationsStore } from '../server/operations-store';
import { clearOperations } from '../server/reset-operations';
import { currentSnapshot } from '../server/shipment-operations';
import type { Company, Snapshot } from '../web/src/model';

const sourceDirectory = resolve('data/local-xlsx-final');
const base = await loadSnapshot(sourceDirectory);
const syntheticInn = '9999999998';

async function setup(roles: string[], archived: boolean, withInn: boolean) {
  const directory = await mkdtemp(resolve(tmpdir(), 'artel-company-restoration-'));
  const store = new OperationsStore(directory);
  const company: Company = {
    id: 'company-local-restoration-qa', name: 'Синтетическая компания восстановления',
    ...(withInn ? { inn: syntheticInn } : {}), roles, directoryArchived: archived, version: 3,
    managerLabels: [], shipmentIds: [], paymentIds: [], flags: [],
    phone: '+70000000000', address: 'Сохранённый юридический адрес QA', email: 'retained@example.invalid',
  };
  await store.mutate(base.provenance.sourceSha256, data => {
    clearOperations(base, data);
    data.companies.push(company);
    data.directories!.addresses.push({
      id: 'address-restoration-qa', companyId: company.id, name: 'Площадка QA', kind: 'delivery',
      address: 'Сохранённый адрес площадки QA', mapUrl: 'https://yandex.ru/maps/?ll=37.6%2C55.7', latitude: '55.7', longitude: '37.6', version: 2,
    });
    data.directories!.customerManagers!.push({ companyId: company.id, managerId: data.directories!.managers[0].id });
    return { result: null, changed: true };
  });
  let middleware = createSnapshotMiddleware(sourceDirectory, { operationsStore: store });
  const server = createServer((request, response) => middleware(request, response, () => { response.writeHead(404); response.end(); }));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let cookie = '';
  const request = async (path: string, method = 'GET', body?: unknown) => {
    const response = await fetch(url + path, { method, headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie')!.split(';')[0];
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await request('/api/auth/setup', 'POST', { name: 'QA директор восстановления', login: 'restore-director', password: randomUUID() })).status, 200);
  return {
    company, store, request,
    snapshot: async () => (await request('/api/snapshot')).body as Snapshot,
    reload: () => { middleware = createSnapshotMiddleware(sourceDirectory, { operationsStore: new OperationsStore(directory) }); },
    read: () => new OperationsStore(directory).read(base.provenance.sourceSha256),
    close: async () => { await new Promise<void>(done => server.close(() => done())); await rm(directory, { recursive: true, force: true }); },
  };
}

for (const withInn of [false, true]) test(`POST restores archived client ${withInn ? 'by INN' : 'by exact name'}, commits before responding and survives store/API reload`, async () => {
  const r = await setup(['payment_counterparty'], true, withInn);
  try {
    const before = await r.snapshot(), storedBefore = await r.read();
    const payload = { kind: 'companies', name: r.company.name, inn: r.company.inn, roles: ['customer'], addresses: [], managerId: null, phone: '', address: '', email: null };
    const result = await r.request('/api/directories', 'POST', payload);
    assert.equal(result.status, 200);
    assert.equal(result.body.created, false);
    assert.equal(result.body.entry.id, r.company.id);
    assert.equal(result.body.entry.directoryArchived, false);
    const storedAfter = await r.read();
    assert.equal(storedAfter.revision, storedBefore.revision + 1);
    const saved = storedAfter.companies.find(company => company.id === r.company.id)!;
    assert.equal(saved.directoryArchived, false);
    assert.deepEqual(saved.roles, ['customer', 'payment_counterparty']);
    assert.equal(saved.phone, r.company.phone);
    assert.equal(saved.address, r.company.address);
    assert.equal(saved.email, r.company.email);
    assert.deepEqual(storedAfter.directories!.customerManagers, storedBefore.directories!.customerManagers);
    assert.deepEqual(storedAfter.directories!.addresses, storedBefore.directories!.addresses);
    r.reload();
    const after = await r.snapshot();
    assert.equal(after.companies.filter(company => company.id === r.company.id && company.roles.includes('customer') && !company.directoryArchived).length, 1);
    assert.deepEqual(after.shipments, before.shipments);
    assert.deepEqual(after.payments, before.payments);
    assert.deepEqual(after.stocks, before.stocks);
    const persisted = await readFile(r.store.path, 'utf8');
    assert.equal((await r.request('/api/directories', 'POST', payload)).status, 409);
    assert.equal(await readFile(r.store.path, 'utf8'), persisted, 'Repeated add must not rewrite or duplicate the restored entity');
  } finally { await r.close(); }
});

for (const roles of [['supplier', 'carrier'], ['payment_counterparty']]) test(`POST adds missing customer role to retained ${roles.join('/')} identity`, async () => {
  const r = await setup(roles, false, false);
  try {
    const result = await r.request('/api/directories', 'POST', { kind: 'companies', name: r.company.name, roles: ['customer'], addresses: [] });
    assert.equal(result.status, 200);
    assert.equal(result.body.created, false);
    assert.equal(result.body.entry.id, r.company.id);
    r.reload();
    const companies = (await r.snapshot()).companies.filter(company => company.id === r.company.id);
    assert.equal(companies.length, 1);
    assert.deepEqual(new Set(companies[0].roles), new Set([...roles, 'customer']));
    assert.equal(companies[0].directoryArchived, false);
    assert.equal((await r.read()).companies.find(company => company.id === r.company.id)!.version, 4);
  } finally { await r.close(); }
});

for (const legacy of [
  { roles: ['payment_counterparty'], archived: false },
  { roles: ['customer'], archived: true },
  { roles: ['supplier', 'carrier'], archived: false },
]) test(`new customer with INN remains separate from same-name ${legacy.archived ? 'archived' : legacy.roles.join('/')} history`, async () => {
  const r = await setup(legacy.roles, legacy.archived, false);
  try {
    const before = await r.read();
    const payload = { kind: 'companies', name: r.company.name, inn: syntheticInn, roles: ['customer'], addresses: [], managerId: null };
    const result = await r.request('/api/directories', 'POST', payload);
    assert.equal(result.status, 201);
    assert.equal(result.body.created, true);
    assert.notEqual(result.body.entry.id, r.company.id);
    assert.equal(result.body.entry.inn, syntheticInn);
    assert.deepEqual(result.body.entry.roles, ['customer']);
    assert.equal(result.body.entry.phone, undefined);
    assert.equal(result.body.entry.address, undefined);
    assert.equal(result.body.entry.email, undefined);
    assert.deepEqual(result.body.entry.paymentIds, []);
    const after = await r.read();
    assert.deepEqual(after, { ...before, revision: before.revision + 1, companies: [...before.companies, result.body.entry] }, 'Creating a new INN identity must preserve every historical company, relationship and operation');
    r.reload();
    const sameName = (await r.snapshot()).companies.filter(company => company.name === r.company.name);
    assert.equal(sameName.length, 2);
    assert.equal(sameName.find(company => company.id === r.company.id)!.inn, undefined);
    assert.equal(sameName.find(company => company.id === result.body.entry.id)!.inn, syntheticInn);
    const persisted = await readFile(r.store.path, 'utf8');
    assert.equal((await r.request('/api/directories', 'POST', payload)).status, 409);
    assert.equal(await readFile(r.store.path, 'utf8'), persisted);
  } finally { await r.close(); }
});

for (const active of [
  { existing: ['customer', 'payment_counterparty'], requested: ['customer'] },
  { existing: ['supplier'], requested: ['customer', 'supplier'] },
]) test(`active ${active.existing.join('/')} name-only company blocks a separate same-name INN identity with overlapping requested roles`, async () => {
  const r = await setup(active.existing, false, false);
  try {
    const persisted = await readFile(r.store.path, 'utf8');
    assert.equal((await r.request('/api/directories', 'POST', { kind: 'companies', name: r.company.name, inn: syntheticInn, roles: active.requested, addresses: [] })).status, 409);
    assert.equal(await readFile(r.store.path, 'utf8'), persisted);
  } finally { await r.close(); }
});

test('PATCH still permits explicitly clearing existing company details', async () => {
  const r = await setup(['payment_counterparty'], true, false);
  try {
    const snapshot = currentSnapshot(base, await r.read());
    const addresses = snapshot.directories!.addresses.filter(address => address.companyId === r.company.id).map(({ id, name, kind }) => ({ id, name, kind }));
    const result = await r.request(`/api/directories/companies/${r.company.id}`, 'PATCH', { name: r.company.name, version: 3, roles: ['customer'], addresses, phone: '', email: null });
    assert.equal(result.status, 200);
    const saved = (await r.read()).companies.find(company => company.id === r.company.id)!;
    assert.equal(saved.phone, '');
    assert.equal(saved.email, null);
  } finally { await r.close(); }
});

test('restoration rejects malformed roles and matching address inputs without rewriting storage', async () => {
  const r = await setup(['supplier', 'carrier'], true, false);
  try {
    const persisted = await readFile(r.store.path, 'utf8');
    const address = { name: 'Площадка QA', kind: 'delivery' };
    for (const invalid of [
      { roles: [] }, { roles: ['unknown-role'] },
      { addresses: [{ ...address, mapUrl: 'https://example.invalid/map' }] },
      { addresses: [{ ...address, id: 'address-other-company' }] },
      { addresses: [{ ...address, unexpected: 'field' }] },
      { addresses: [address, address] },
    ]) {
      const response = await r.request('/api/directories', 'POST', { kind: 'companies', name: r.company.name, roles: ['customer'], addresses: [], ...invalid });
      assert.equal(response.status, 400);
      assert.equal(await readFile(r.store.path, 'utf8'), persisted);
    }
    const restored = await r.request('/api/directories', 'POST', { kind: 'companies', name: r.company.name, roles: ['customer'], addresses: [address] });
    assert.equal(restored.status, 200);
    const addresses = (await r.read()).directories!.addresses.filter(address => address.companyId === r.company.id);
    assert.equal(addresses.length, 1);
    assert.equal(addresses[0].id, 'address-restoration-qa');
    assert.equal(addresses[0].address, 'Сохранённый адрес площадки QA');
    assert.equal(addresses[0].latitude, '55.7');
    assert.equal(addresses[0].version, 2);
  } finally { await r.close(); }
});

test('ambiguous exact name among an archived and active company does not restore either identity', async () => {
  const r = await setup(['payment_counterparty'], true, false);
  try {
    await r.store.mutate(base.provenance.sourceSha256, data => {
      data.companies.push({ ...r.company, id: 'company-local-active-name-collision-qa', roles: ['customer'], directoryArchived: false });
      return { result: null, changed: true };
    });
    const persisted = await readFile(r.store.path, 'utf8');
    assert.equal((await r.request('/api/directories', 'POST', { kind: 'companies', name: r.company.name, roles: ['customer'], addresses: [] })).status, 409);
    assert.equal(await readFile(r.store.path, 'utf8'), persisted);
  } finally { await r.close(); }
});
