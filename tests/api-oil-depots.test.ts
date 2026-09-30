import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { createSnapshotMiddleware, loadSnapshot } from './test-api';
import { decodeOperations, encodeOperations, OperationsStore } from '../server/operations-store';
import type { Snapshot } from '../web/src/model';

import { migrateOilDepots } from '../server/migrations/003-oil-depots';

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

test('oil depot CRUD stores independent companies and addresses, rejects conflicts and preserves versions', async () => {
  const rt = await setup();
  try {
    const companies = [];
    for (const [name, address] of [['Поставщик нефтепродуктов', 'Юридический адрес поставщика'], ['Владелец нефтебазы', 'Юридический адрес владельца'], ['Погрузчик', 'Юридический адрес погрузчика'], ['Владелец инфраструктуры', 'Юридический адрес инфраструктуры']]) {
      const response = await rt.request('/api/directories', 'POST', { kind: 'companies', name, address, roles: ['other'], addresses: [] });
      assert.equal(response.status, 201, JSON.stringify(response.body)); companies.push(response.body.entry);
    }
    const [supplier, owner, loader, infrastructure] = companies;
    const input = { kind: 'oilDepots', name: 'Нефтебаза тестовая', address: 'Фактическая площадка погрузки', ownerCompanyId: owner.id, loadingActorCompanyId: loader.id, infrastructureOwnerCompanyId: infrastructure.id };
    const created = await rt.request('/api/directories', 'POST', input); assert.equal(created.status, 201);
    const id = created.body.entry.id;
    const repeated = await rt.request('/api/directories', 'POST', input); assert.equal(repeated.status, 200); assert.equal(repeated.body.entry.id, id);
    assert.equal((await rt.request('/api/directories', 'POST', { ...input, loadingActorCompanyId: owner.id })).status, 409);
    assert.equal((await rt.request('/api/directories', 'POST', { ...input, name: 'Вторая', loadingActorCompanyId: 'missing' })).status, 400);
    const snapshot = await rt.snapshot(); assert.equal(snapshot.directories!.oilDepots!.length, 1);
    assert.equal(snapshot.companies.find(row => row.id === supplier.id)!.address, supplier.address);
    assert.notEqual(snapshot.directories!.oilDepots![0].address, owner.address);
    const renamed = await rt.request(`/api/directories/oilDepots/${id}`, 'PATCH', { version: 0, name: 'Новое имя' }); assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    assert.equal(renamed.body.entry.loadingActorCompanyId, loader.id); assert.equal(renamed.body.entry.version, 1);
    assert.equal((await rt.request(`/api/directories/oilDepots/${id}`, 'PATCH', { version: 0, name: 'Конфликт' })).status, 409);
    assert.equal((await rt.request(`/api/directories/companies/${owner.id}`, 'DELETE', { version: owner.version ?? 0 })).status, 409);
    assert.equal((await rt.request(`/api/directories/oilDepots/${id}`, 'DELETE', { version: 1 })).status, 200);
    assert.equal((await rt.snapshot()).directories!.oilDepots!.length, 0);
  } finally { await rt.close(); }
});

test('oil depot migration retains historical loading addresses and dates without guessing company roles', async () => {
  const rt = await setup();
  try {
    const data = await rt.store.read(base.provenance.sourceSha256);
    delete data.directories!.oilDepots;
    const legacy = structuredClone(data);
    const decoded = decodeOperations(encodeOperations(data), base.provenance.sourceSha256);
    assert.deepEqual(decoded.directories!.oilDepots, []);
    const { oilDepots: _oilDepots, ...directories } = decoded.directories!;
    assert.deepEqual(directories, legacy.directories);
    assert.deepEqual(decoded.shipments, legacy.shipments);
    assert.deepEqual(migrateOilDepots(decoded), decoded);
  } finally { await rt.close(); }
});
