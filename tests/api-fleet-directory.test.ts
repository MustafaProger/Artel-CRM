import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { createSnapshotMiddleware, loadSnapshot } from './test-api';
import { emptyDirectories } from '../server/directory-operations';
import { OperationsStore, type OperationsData } from '../server/operations-store';
import type { Directories } from '../web/src/model';

const base = await loadSnapshot(resolve('data/local-xlsx-final'));
async function close(server: Server) { await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); }
const envelope = (data: OperationsData) => JSON.stringify({ sha256: createHash('sha256').update(JSON.stringify(data)).digest('hex'), data });

test('supplied fleet is available in a fresh store with exact volumes, phones and shared vehicles', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'artel-fleet-fresh-'));
  try {
    const store = new OperationsStore(directory);
    const data = await store.read(base.provenance.sourceSha256);
    const catalog = data.directories!;
    assert.equal(catalog.vehicles.length, 5);
    assert.equal(catalog.drivers.length, 7);
    const expected = [
      ['Вова', '+7 (925) 607-09-59', 'Hyundai 489', '10228', ['5700', '4528']],
      ['Стас', '+7 (966) 025-39-19', 'МАЗ 063', '16813', ['8500', '8313']],
      ['Гена', '+7 (967) 137-68-28', 'МАЗ 700', '15048', ['4954', '4976', '5118']],
      ['Саша', '+7 (915) 688-21-69', 'МАЗ 700', '15048', ['4954', '4976', '5118']],
      ['Петр', '+7 (960) 330-27-66', 'Hyundai 442', '17500', ['8000', '5500', '4000']],
      ['Олег', '+7 (977) 151-21-39', 'Hyundai 442', '17500', ['8000', '5500', '4000']],
      ['Денис', '+7 (977) 554-94-03', 'Газель РПЗ', undefined, undefined],
    ];
    for (const [name, phone, label, capacity, compartments] of expected) {
      const driver = catalog.drivers.find(row => row.name === name)!;
      const vehicle = catalog.vehicles.find(row => row.id === driver.vehicleId)!;
      assert.equal(driver.phone, phone);
      assert.equal(vehicle.name, label);
      assert.equal(vehicle.plate, label);
      assert.equal(vehicle.capacityLitres, capacity);
      assert.deepEqual(vehicle.compartmentsLitres, compartments);
    }
    assert.equal(catalog.drivers.find(row => row.name === 'Гена')!.vehicleId, catalog.drivers.find(row => row.name === 'Саша')!.vehicleId);
    assert.equal(catalog.drivers.find(row => row.name === 'Петр')!.vehicleId, catalog.drivers.find(row => row.name === 'Олег')!.vehicleId);
    assert.deepEqual((await store.read(base.provenance.sourceSha256)).directories, catalog);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('existing v2 fleet records stay intact and seed additions persist once without duplicates', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'artel-fleet-existing-'));
  try {
    const directories = emptyDirectories();
    const vehicle = { id: 'existing-maz', plate: 'МАЗ 700', name: 'Моя машина', capacityLitres: '16000' };
    const driver = { id: 'existing-gena', name: 'Гена', phone: '+7 (999) 123-45-67', vehicleId: vehicle.id };
    directories.vehicles.push(vehicle);
    directories.drivers.push(driver);
    const data: OperationsData = { schemaVersion: 2, revision: 4, sourceSha256: base.provenance.sourceSha256, companies: [], shipments: {}, directories, paymentAllocations: [] };
    const store = new OperationsStore(directory), raw = envelope(data);
    await writeFile(store.path, raw);
    const loaded = await store.read(data.sourceSha256);
    assert.equal(await readFile(store.path, 'utf8'), raw);
    assert.deepEqual(loaded.directories!.vehicles.find(row => row.id === vehicle.id), vehicle);
    assert.deepEqual(loaded.directories!.drivers.find(row => row.id === driver.id), driver);
    assert.equal(loaded.directories!.vehicles.length, 5);
    assert.equal(loaded.directories!.drivers.length, 7);
    assert.equal(loaded.directories!.drivers.find(row => row.name === 'Саша')!.vehicleId, vehicle.id);
    await store.mutate(data.sourceSha256, saved => {
      saved.directories!.products.push({ id: 'fleet-test-product', name: 'Тестовый продукт' });
      return { changed: true, result: null };
    });
    const restarted = await new OperationsStore(directory).read(data.sourceSha256);
    assert.equal(restarted.revision, 5);
    assert.equal(restarted.directories!.vehicles.length, 5);
    assert.equal(restarted.directories!.drivers.length, 7);
    assert.deepEqual(restarted.directories!.vehicles.find(row => row.id === vehicle.id), vehicle);
    assert.deepEqual(restarted.directories!.drivers.find(row => row.id === driver.id), driver);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('directory API exposes fleet and validates custom volume breakdowns and driver phones', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'artel-fleet-api-'));
  const middleware = createSnapshotMiddleware(resolve('data/local-xlsx-final'), { operationsDirectory: directory });
  const server = createServer((request, response) => middleware(request, response, () => response.end()));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (body: unknown) => {
    const response = await fetch(`${url}/api/directories`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  };
  try {
    const initial = await (await fetch(`${url}/api/directories`)).json() as { directories: Directories };
    assert.equal(initial.directories.vehicles.length, 5);
    assert.equal(initial.directories.drivers.length, 7);
    const duplicate = await post({ kind: 'vehicles', plate: 'Hyundai 489' });
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.data.entry.name, 'Hyundai 489');
    const vehicle = await post({ kind: 'vehicles', plate: 'Hyundai 777', capacityLitres: '10 500,5', compartmentsLitres: ['5000', '5500,5'] });
    assert.equal(vehicle.status, 201);
    assert.equal(vehicle.data.entry.plate, 'Hyundai 777');
    assert.equal(vehicle.data.entry.capacityLitres, '10500.5');
    assert.deepEqual(vehicle.data.entry.compartmentsLitres, ['5000', '5500.5']);
    for (const invalid of [
      { capacityLitres: '-1' },
      { capacityLitres: '100', compartmentsLitres: ['60', '50'] },
      { compartmentsLitres: ['0'] },
      { compartmentsLitres: '100 + 200' },
    ]) assert.equal((await post({ kind: 'vehicles', plate: 'Test 999', ...invalid })).status, 400);
    assert.equal((await post({ kind: 'drivers', name: 'Новый водитель', phone: 'не телефон', vehicleId: vehicle.data.entry.id })).status, 400);
    const driver = await post({ kind: 'drivers', name: 'Новый водитель', phone: '+7 (999) 111-22-33', vehicleId: vehicle.data.entry.id });
    assert.equal(driver.status, 201);
    assert.equal(driver.data.entry.phone, '+7 (999) 111-22-33');
    const saved = await new OperationsStore(directory).read(base.provenance.sourceSha256);
    assert.deepEqual(saved.directories!.vehicles.find(row => row.id === vehicle.data.entry.id), vehicle.data.entry);
    assert.deepEqual(saved.directories!.drivers.find(row => row.id === driver.data.entry.id), driver.data.entry);
  } finally { await close(server); await rm(directory, { recursive: true, force: true }); }
});
