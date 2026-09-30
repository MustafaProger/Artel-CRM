import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { createSnapshotMiddleware, loadSnapshot } from './test-api';
import { OperationsStore } from '../server/operations-store';
import { currentSnapshot } from '../server/shipment-operations';
import type { Snapshot } from '../web/src/model';

const base = await loadSnapshot(resolve('data/local-xlsx-final'));
async function setup() {
  const directory = await mkdtemp(resolve(tmpdir(), 'artel-directory-transport-'));
  const store = new OperationsStore(directory);
  const middleware = createSnapshotMiddleware(resolve('data/local-xlsx-final'), { operationsDirectory: directory });
  const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end(); }));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = async (path: string, method = 'GET', body?: unknown) => {
    const response = await fetch(url + path, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  return { directory, store, request, snapshot: async () => (await request('/api/snapshot')).body as Snapshot,
    close: async () => { await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); await rm(directory, { recursive: true, force: true }); } };
}

test('product transport profile is explicit, optional, editable and persists independently of short names', async () => {
  const runtime = await setup();
  try {
    const original = await runtime.snapshot();
    const plain = await runtime.request('/api/directories', 'POST', { kind: 'products', name: 'Тест ДТ без подтверждения' });
    assert.equal(plain.status, 201);
    assert.equal(plain.body.entry.transportProductKind, undefined);
    assert.equal(plain.body.entry.dangerousGoodsUnNumber, undefined);
    const profile = { documentName: ' Полное тестовое наименование груза ', transportProductKind: 'diesel', dangerousGoodsUnNumber: '0000', dangerousGoodsShippingName: 'Тестовая позиция', dangerousGoodsClass: 'Тест', dangerousGoodsClassificationCode: 'Тест', dangerousGoodsPackingGroup: 'Тест', dangerousGoodsHazardSign: 'Тест', dangerousGoodsTunnelCode: 'Тест', dangerousGoodsSource: 'Синтетический справочник' };
    const created = await runtime.request('/api/directories', 'POST', { kind: 'products', name: 'QA дизель', ...profile });
    assert.equal(created.status, 201);
    const id = created.body.entry.id;
    let snapshot = currentSnapshot(base, await new OperationsStore(runtime.directory).read(base.provenance.sourceSha256));
    assert.equal(snapshot.directories!.products.find(row => row.id === id)?.documentName, profile.documentName.trim());
    assert.deepEqual(snapshot.directories!.drivers, original.directories!.drivers);
    const renamed = await runtime.request(`/api/directories/products/${id}`, 'PATCH', { version: 0, name: 'QA дизель переименован' });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.entry.dangerousGoodsSource, profile.dangerousGoodsSource);
    assert.equal((await runtime.request(`/api/directories/products/${id}`, 'PATCH', { version: 0, name: 'stale' })).status, 409);
    const before = await readFile(runtime.store.path, 'utf8');
    for (const invalid of [{ transportProductKind: 'petrol' }, { dangerousGoodsUnNumber: '120' }, { documentName: { name: 'invalid' } }]) {
      assert.equal((await runtime.request(`/api/directories/products/${id}`, 'PATCH', { version: 1, name: 'QA дизель переименован', ...invalid })).status, 400);
    }
    assert.equal(await readFile(runtime.store.path, 'utf8'), before);
    assert.equal((await runtime.request(`/api/directories/products/${id}`, 'PATCH', { version: 1, name: 'QA дизель переименован', transportProductKind: '', dangerousGoodsUnNumber: '' })).status, 200);
    snapshot = await runtime.snapshot();
    assert.equal(snapshot.directories!.products.find(row => row.id === id)?.transportProductKind, undefined);
    assert.equal(snapshot.directories!.products.find(row => row.id === id)?.dangerousGoodsUnNumber, undefined);
  } finally { await runtime.close(); }
});

test('vehicle payload and lease facts are independent of gross mass, validated and retained on legacy edits', async () => {
  const runtime = await setup();
  try {
    const input = { kind: 'vehicles', plate: 'QA транспорт 990', vehicleType: 'Автоцистерна', maxWeight: '27000', capacityLitres: '10000', compartmentsLitres: ['5000', '5000'], transportVehicleType: 'Тестовый тип', bodyType: 'Цистерна', loadingMethod: 'Налив', payloadTonnes: ' 8,50 ', payloadSource: 'Синтетический ПТС', ownershipType: '3', leaseDocumentName: 'Тестовый договор аренды', leaseDocumentNumber: 'QA-1', leaseDocumentDate: '30.09.2026', leaseDocumentIssuerInn: '990000000041', cargoDistributable: '0' };
    const created = await runtime.request('/api/directories', 'POST', input);
    assert.equal(created.status, 201);
    assert.equal(created.body.entry.payloadTonnes, '8.5');
    assert.equal(created.body.entry.leaseDocumentDate, '2026-09-30');
    const id = created.body.entry.id;
    const legacy = await runtime.request(`/api/directories/vehicles/${id}`, 'PATCH', { version: 0, plate: input.plate, maxWeight: '28000', capacityLitres: '10000', compartmentsLitres: ['5000', '5000'] });
    assert.equal(legacy.status, 200);
    assert.equal(legacy.body.entry.payloadTonnes, '8.5');
    assert.equal(legacy.body.entry.leaseDocumentNumber, 'QA-1');
    assert.equal(legacy.body.entry.cargoDistributable, '0');
    const before = await readFile(runtime.store.path, 'utf8');
    for (const invalid of [{ payloadTonnes: '-1' }, { payloadTonnes: '0' }, { payloadTonnes: '5.001' }, { ownershipType: '6' }, { leaseDocumentDate: '31.02.2026' }, { leaseDocumentIssuerInn: '123' }, { cargoDistributable: '2' }, { cargoDistributable: 0 }]) {
      assert.equal((await runtime.request(`/api/directories/vehicles/${id}`, 'PATCH', { version: 1, plate: input.plate, ...invalid })).status, 400);
    }
    assert.equal(await readFile(runtime.store.path, 'utf8'), before);
    const snapshot = currentSnapshot(base, await new OperationsStore(runtime.directory).read(base.provenance.sourceSha256));
    const vehicle = snapshot.directories!.vehicles.find(row => row.id === id)!;
    assert.equal(vehicle.payloadTonnes, '8.5');
    assert.equal(vehicle.maxWeight, '28000');
    assert.equal(vehicle.cargoDistributable, '0');
    assert.deepEqual(vehicle.compartmentsLitres, ['5000', '5000']);
    const plain = await runtime.request('/api/directories', 'POST', { kind: 'vehicles', plate: 'QA транспорт без профиля', maxWeight: '31000' });
    assert.equal(plain.status, 201);
    assert.equal(plain.body.entry.payloadTonnes, undefined);
    assert.equal(plain.body.entry.leaseDocumentNumber, undefined);
    assert.equal(plain.body.entry.cargoDistributable, undefined);
    assert.equal((await runtime.request(`/api/directories/vehicles/${id}`, 'PATCH', { version: 1, plate: input.plate, cargoDistributable: '' })).status, 200);
    assert.equal((await runtime.snapshot()).directories!.vehicles.find(row => row.id === id)?.cargoDistributable, undefined);
  } finally { await runtime.close(); }
});

test('loading roles are optional stable company selections, persist through both editors and reject new archived choices', async () => {
  const runtime = await setup();
  try {
    const actor = await runtime.request('/api/directories', 'POST', { kind: 'companies', name: 'QA отдельный погрузчик', roles: ['supplier'], addresses: [] });
    assert.equal(actor.status, 201); const actorId = actor.body.entry.id;
    const created = await runtime.request('/api/directories', 'POST', { kind: 'companies', name: 'QA владелец площадки', roles: ['supplier'], addresses: [{ name: 'QA погрузка с ролями', kind: 'loading', loadingActorCompanyId: actorId, infrastructureOwnerCompanyId: actorId }] });
    assert.equal(created.status, 201); const companyId = created.body.entry.id;
    let address = (await runtime.snapshot()).directories!.addresses.find(row => row.companyId === companyId)!;
    assert.equal(address.loadingActorCompanyId, actorId); assert.equal(address.infrastructureOwnerCompanyId, actorId);
    const rename = await runtime.request(`/api/directories/companies/${companyId}`, 'PATCH', { version: 1, name: 'QA владелец площадки', roles: ['supplier'], addresses: [{ id: address.id, name: 'QA погрузка после изменения', kind: 'loading' }] });
    assert.equal(rename.status, 200);
    address = (await runtime.snapshot()).directories!.addresses.find(row => row.id === address.id)!;
    assert.equal(address.loadingActorCompanyId, actorId);
    const input = { version: address.version ?? 0, name: address.name, companyId, addressKind: 'loading' };
    const before = await readFile(runtime.store.path, 'utf8');
    for (const invalid of [{ loadingActorCompanyId: 'missing-company' }, { infrastructureOwnerCompanyId: { id: actorId } }]) {
      assert.equal((await runtime.request(`/api/directories/addresses/${address.id}`, 'PATCH', { ...input, ...invalid })).status, 400);
    }
    assert.equal(await readFile(runtime.store.path, 'utf8'), before);
    await runtime.store.mutate(base.provenance.sourceSha256, data => { data.companies.find(row => row.id === actorId)!.directoryArchived = true; return { result: null, changed: true }; });
    assert.equal((await runtime.request(`/api/directories/addresses/${address.id}`, 'PATCH', input)).status, 200);
    const persisted = currentSnapshot(base, await new OperationsStore(runtime.directory).read(base.provenance.sourceSha256));
    assert.equal(persisted.directories!.addresses.find(row => row.id === address.id)?.loadingActorCompanyId, actorId);
    const plain = await runtime.request('/api/directories', 'POST', { kind: 'addresses', name: 'QA погрузка без ролей', companyId, addressKind: 'loading' });
    assert.equal(plain.status, 201); assert.equal(plain.body.entry.loadingActorCompanyId, undefined);
    assert.equal((await runtime.request(`/api/directories/addresses/${plain.body.entry.id}`, 'PATCH', { version: 0, name: plain.body.entry.name, companyId, addressKind: 'loading', loadingActorCompanyId: actorId })).status, 400);
    assert.equal((await runtime.request('/api/directories', 'POST', { kind: 'companies', name: 'QA новый с архивной ролью', roles: ['supplier'], addresses: [{ name: 'QA погрузка', kind: 'loading', infrastructureOwnerCompanyId: actorId }] })).status, 400);
    address = (await runtime.snapshot()).directories!.addresses.find(row => row.id === address.id)!;
    assert.equal((await runtime.request(`/api/directories/addresses/${address.id}`, 'PATCH', { ...input, version: address.version, loadingActorCompanyId: '', infrastructureOwnerCompanyId: '' })).status, 200);
    assert.equal((await runtime.snapshot()).directories!.addresses.find(row => row.id === address.id)?.loadingActorCompanyId, undefined);
  } finally { await runtime.close(); }
});

test('one receiver contact belongs to each delivery address and survives company and address edits', async () => {
  const runtime = await setup();
  try {
    const company = { name: 'QA клиент контактов', roles: ['customer'], addresses: [
      { name: 'QA адрес 1', kind: 'delivery', receiverName: ' Тестовый Приёмщик Один ', receiverPhone: '+7 (900) 000-00-01' },
      { name: 'QA адрес 2', kind: 'delivery', receiverName: 'Тестовый Приёмщик Два', receiverPhone: '+7 (900) 000-00-02' },
    ] };
    const created = await runtime.request('/api/directories', 'POST', { kind: 'companies', ...company });
    assert.equal(created.status, 201);
    const id = created.body.entry.id;
    let addresses = (await runtime.snapshot()).directories!.addresses.filter(row => row.companyId === id);
    assert.equal(addresses[0].receiverName, 'Тестовый Приёмщик Один');
    assert.equal(addresses[1].receiverPhone, '+7 (900) 000-00-02');
    const updated = await runtime.request(`/api/directories/companies/${id}`, 'PATCH', { ...company, version: 1, addresses: addresses.map(({ id, name, kind }) => ({ id, name, kind })) });
    assert.equal(updated.status, 200);
    const edited = await runtime.request(`/api/directories/addresses/${addresses[0].id}`, 'PATCH', { version: 0, name: addresses[0].name, companyId: id, addressKind: 'delivery', receiverName: 'Новый тестовый приёмщик', receiverPhone: '+7 (900) 000-00-03' });
    assert.equal(edited.status, 200);
    const staleContacts = await runtime.request(`/api/directories/companies/${id}`, 'PATCH', { ...company, version: 2, addresses: addresses.map(({ id, name, kind, receiverName, receiverPhone }) => ({ id, name, kind, receiverName, receiverPhone, version: 0 })) });
    assert.equal(staleContacts.status, 409);
    addresses = currentSnapshot(base, await new OperationsStore(runtime.directory).read(base.provenance.sourceSha256)).directories!.addresses.filter(row => row.companyId === id);
    assert.equal(addresses[0].receiverName, 'Новый тестовый приёмщик');
    assert.equal(addresses[1].receiverName, 'Тестовый Приёмщик Два');
    const before = await readFile(runtime.store.path, 'utf8');
    assert.equal((await runtime.request(`/api/directories/addresses/${addresses[0].id}`, 'PATCH', { version: 1, name: addresses[0].name, companyId: id, addressKind: 'delivery', receiverPhone: 'не телефон' })).status, 400);
    assert.equal(await readFile(runtime.store.path, 'utf8'), before);
    await runtime.store.mutate(base.provenance.sourceSha256, data => { data.companies.find(row => row.id === id)!.directoryArchived = true; return { changed: true, result: null }; });
    const restored = await runtime.request('/api/directories', 'POST', { kind: 'companies', ...company, addresses: addresses.map(({ name, kind }) => ({ name, kind, receiverName: '', receiverPhone: '' })) });
    assert.equal(restored.status, 200);
    assert.equal(restored.body.entry.id, id);
    assert.equal((await runtime.snapshot()).directories!.addresses.find(row => row.id === addresses[0].id)?.receiverPhone, '+7 (900) 000-00-03');
    assert.equal((await runtime.request(`/api/directories/addresses/${addresses[0].id}`, 'PATCH', { version: 1, name: addresses[0].name, companyId: id, addressKind: 'delivery', receiverName: '', receiverPhone: '' })).status, 200);
    assert.equal((await runtime.snapshot()).directories!.addresses.find(row => row.id === addresses[0].id)?.receiverPhone, undefined);
  } finally { await runtime.close(); }
});
