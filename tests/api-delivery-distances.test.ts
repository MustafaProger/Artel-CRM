import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { createSnapshotMiddleware, loadSnapshot } from './test-api';
import { OperationsStore, validate } from '../server/operations-store';
import { currentSnapshot } from '../server/shipment-operations';
import type { ShipmentAddress, Snapshot } from '../web/src/model';

const base = await loadSnapshot(resolve('data/local-xlsx-final'));
async function setup() {
  const directory = await mkdtemp(resolve(tmpdir(), 'artel-delivery-distances-'));
  const store = new OperationsStore(directory);
  const middleware = createSnapshotMiddleware(resolve('data/local-xlsx-final'), { operationsDirectory: directory, tripRequestGeocoder: async () => ({ status: 'unavailable', message: 'Test only' }) });
  const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end(); }));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = async (path: string, method = 'GET', body?: unknown) => {
    const response = await fetch(url + path, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  const snapshot = async () => (await request('/api/snapshot')).body as Snapshot;
  const depots: string[] = [];
  for (const name of ['QA База расстояний А', 'QA База расстояний Б']) {
    const response = await request('/api/directories', 'POST', { kind: 'oilDepots', name });
    assert.equal(response.status, 201); depots.push(response.body.entry.id);
  }
  const response = await request('/api/directories', 'POST', {
    kind: 'companies', name: 'QA Клиент с километражем', roles: ['customer', 'supplier'],
    addresses: [
      { name: 'QA Адрес 1', kind: 'delivery', oilDepotDistancesKm: { [depots[0]]: ' 0012,500 ', [depots[1]]: '0' } },
      { name: 'QA Адрес 2', kind: 'delivery', oilDepotDistancesKm: { [depots[0]]: 80.25, [depots[1]]: '' } },
      { name: 'QA Старый адрес без расстояний', kind: 'delivery' },
    ],
  });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  const companyId = response.body.entry.id;
  const companyState = async () => {
    const current = await snapshot();
    return { company: current.companies.find(row => row.id === companyId)!, addresses: current.directories!.addresses.filter(row => row.companyId === companyId) };
  };
  return { directory, store, request, snapshot, depots, companyId, companyState, close: async () => { await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); await rm(directory, { recursive: true, force: true }); } };
}
const addressInput = (address: ShipmentAddress) => ({ version: address.version ?? 0, name: address.name, companyId: address.companyId, addressKind: address.kind });

test('manual distances are independent for each site and depot, survive restart and unrelated legacy edits', async () => {
  const runtime = await setup();
  try {
    const { company, addresses } = await runtime.companyState();
    assert.deepEqual(addresses[0].oilDepotDistancesKm, { [runtime.depots[0]]: '12.5', [runtime.depots[1]]: '0' });
    assert.deepEqual(addresses[1].oilDepotDistancesKm, { [runtime.depots[0]]: '80.25' });
    assert.equal(addresses[2].oilDepotDistancesKm, undefined);
    const stored = await new OperationsStore(runtime.directory).read(base.provenance.sourceSha256);
    const reloaded = currentSnapshot(base, stored);
    assert.deepEqual(reloaded.directories!.addresses.filter(row => row.companyId === company.id), addresses);
    const operationsBefore = structuredClone(stored.shipments);
    const result = await runtime.request(`/api/directories/companies/${company.id}`, 'PATCH', { version: company.version, name: company.name, roles: company.roles, phone: '+7 900 000-00-00', addresses: addresses.map(({ id, name, kind, version }) => ({ id, name, kind, version: version ?? 0 })) });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.deepEqual((await runtime.companyState()).addresses, addresses.map(address => ({ ...address, version: address.version ?? 0 })));
    assert.equal((await runtime.request(`/api/directories/addresses/${addresses[0].id}`, 'PATCH', { ...addressInput(addresses[0]), receiverName: 'QA Приёмщик' })).status, 200);
    const updated = await runtime.companyState();
    assert.equal(updated.addresses[0].receiverName, 'QA Приёмщик');
    assert.deepEqual(updated.addresses[0].oilDepotDistancesKm, addresses[0].oilDepotDistancesKm);
    assert.deepEqual(updated.addresses[1].oilDepotDistancesKm, addresses[1].oilDepotDistancesKm);
    assert.deepEqual((await runtime.store.read(base.provenance.sourceSha256)).shipments, operationsBefore);
  } finally { await runtime.close(); }
});

test('both editing routes reject malformed, unknown, negative and excessive distances atomically', async () => {
  const runtime = await setup();
  try {
    const { company, addresses } = await runtime.companyState();
    const rawBefore = await readFile(runtime.store.path, 'utf8');
    const invalid = [null, [], '12', { unknown: '12' }, ...[-1, 100001, null, true, {}, 'NaN', 'Infinity', '1e3', '-0', '12 km', '9'.repeat(40)].map(value => ({ [runtime.depots[0]]: value }))];
    for (const oilDepotDistancesKm of invalid) {
      const direct = await runtime.request(`/api/directories/addresses/${addresses[0].id}`, 'PATCH', { ...addressInput(addresses[0]), oilDepotDistancesKm });
      assert.equal(direct.status, 400, JSON.stringify({ oilDepotDistancesKm, body: direct.body }));
      const nested = await runtime.request(`/api/directories/companies/${company.id}`, 'PATCH', { version: company.version, name: company.name, roles: company.roles, addresses: addresses.map(({ companyId: _companyId, ...address }, index) => ({ ...address, ...(index === 0 ? { oilDepotDistancesKm } : {}) })) });
      assert.equal(nested.status, 400, JSON.stringify({ oilDepotDistancesKm, body: nested.body }));
    }
    assert.equal(await readFile(runtime.store.path, 'utf8'), rawBefore);
  } finally { await runtime.close(); }
});

test('distance edits advance address versions; stale address and company writes cannot overwrite them', async () => {
  const runtime = await setup();
  try {
    const original = await runtime.companyState();
    const nested = await runtime.request(`/api/directories/companies/${original.company.id}`, 'PATCH', {
      version: original.company.version, name: original.company.name, roles: original.company.roles,
      addresses: original.addresses.map(({ companyId: _companyId, ...address }, index) => ({ ...address, version: address.version ?? 0, ...(index === 0 ? { oilDepotDistancesKm: { [runtime.depots[0]]: '31', [runtime.depots[1]]: '' } } : {}) })),
    });
    assert.equal(nested.status, 200, JSON.stringify(nested.body));
    const after = await runtime.companyState();
    assert.equal(after.addresses[0].version, (original.addresses[0].version ?? 0) + 1);
    assert.equal(after.addresses[1].version ?? 0, original.addresses[1].version ?? 0);
    assert.deepEqual(after.addresses[0].oilDepotDistancesKm, { [runtime.depots[0]]: '31' });
    const raw = await readFile(runtime.store.path, 'utf8');
    assert.equal((await runtime.request(`/api/directories/addresses/${after.addresses[0].id}`, 'PATCH', { ...addressInput(original.addresses[0]), oilDepotDistancesKm: { [runtime.depots[0]]: '17' } })).status, 409);
    assert.equal((await runtime.request(`/api/directories/companies/${after.company.id}`, 'PATCH', { version: after.company.version, name: after.company.name, roles: after.company.roles, addresses: original.addresses.map(({ companyId: _companyId, ...address }) => ({ ...address, version: address.version ?? 0 })) })).status, 409);
    assert.equal(await readFile(runtime.store.path, 'utf8'), raw);
    assert.equal((await runtime.request(`/api/directories/addresses/${after.addresses[0].id}`, 'PATCH', { ...addressInput(after.addresses[0]), oilDepotDistancesKm: {} })).status, 200);
    assert.equal((await runtime.companyState()).addresses[0].oilDepotDistancesKm, undefined);
  } finally { await runtime.close(); }
});

test('depot removal and role changes preserve previously saved distances and reject invented historical references', async () => {
  const runtime = await setup();
  try {
    const { company, addresses } = await runtime.companyState();
    assert.equal((await runtime.request(`/api/directories/oilDepots/${runtime.depots[0]}`, 'DELETE', { version: 0 })).status, 200);
    const result = await runtime.request(`/api/directories/companies/${company.id}`, 'PATCH', { version: company.version, name: company.name, roles: ['supplier'], addresses: addresses.map(({ companyId: _companyId, ...address }) => ({ ...address, version: address.version ?? 0 })) });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.deepEqual((await runtime.companyState()).addresses.map(address => address.oilDepotDistancesKm), addresses.map(address => address.oilDepotDistancesKm));
    assert.equal((await runtime.request(`/api/directories/addresses/${addresses[0].id}`, 'PATCH', { ...addressInput(addresses[0]), oilDepotDistancesKm: { [runtime.depots[1]]: '43' } })).status, 200);
    const address = (await runtime.companyState()).addresses[0];
    assert.deepEqual(address.oilDepotDistancesKm, { [runtime.depots[0]]: '12.5', [runtime.depots[1]]: '43' });
    assert.equal((await runtime.request(`/api/directories/addresses/${address.id}`, 'PATCH', { ...addressInput(address), oilDepotDistancesKm: { [runtime.depots[0]]: '999' } })).status, 400);
    const stored = await runtime.store.read(base.provenance.sourceSha256);
    assert.doesNotThrow(() => validate(stored, base.provenance.sourceSha256));
    for (const value of [null, [], { [runtime.depots[1]]: '-1' }, { [runtime.depots[1]]: 12 }, { [runtime.depots[1]]: '100001' }]) {
      const corrupted = structuredClone(stored);
      (corrupted.directories!.addresses.find(row => row.id === address.id)! as unknown as Record<string, unknown>).oilDepotDistancesKm = value;
      assert.throws(() => validate(corrupted, base.provenance.sourceSha256), /Invalid location details/);
    }
  } finally { await runtime.close(); }
});
