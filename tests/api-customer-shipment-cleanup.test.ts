import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { loadSnapshot } from '../server/local-api';
import { OperationsStore, encodeOperations, decodeOperations } from '../server/operations-store';
import { currentSnapshot } from '../server/shipment-operations';
import { prepareCustomerShipmentCleanup } from '../server/customer-shipment-cleanup';

const base = await loadSnapshot(resolve('data/local-xlsx-final'));
test('maintenance removes imported and local shipments and customer roles, retaining payment, supplier and address history after reload', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'artel-customer-cleanup-'));
  try {
    const store = new OperationsStore(directory);
    const original = await store.read(base.provenance.sourceSha256);
    const snapshot = currentSnapshot(base, original);
    original.directories = structuredClone(snapshot.directories!);
    const shared = snapshot.companies.find(c => c.roles.includes('customer'))!;
    original.companies.push({ ...shared, roles: ['customer', 'supplier'] });
    original.directories.addresses.push({ id: 'address-cleanup-test', name: 'Исторический адрес', companyId: shared.id, kind: 'delivery' });
    original.directories.customerManagers = [{ companyId: shared.id, managerId: original.directories.managers[0].id }];
    const source = snapshot.shipments[0];
    original.shipments['shipment-local-cleanup-test'] = { fields: { ...source.fields }, version: 1, createdAt: '2026-09-24T00:00:00Z', updatedAt: '2026-09-24T00:00:00Z' };
    const before = currentSnapshot(base, original);
    const raw = encodeOperations(original);
    const prepared = prepareCustomerShipmentCleanup(base, original);
    assert.equal(encodeOperations(original), raw, 'Planning cannot mutate the source');
    assert.equal(prepared.removed.shipments, before.shipments.length);
    assert.ok(prepared.removed.shipments > 0);
    const saved = decodeOperations(encodeOperations(prepared.data), base.provenance.sourceSha256);
    const after = currentSnapshot(base, saved);
    assert.equal(after.shipments.length, 0);
    assert.equal(after.companies.filter(c => c.roles.includes('customer')).length, 0);
    assert.deepEqual(after.companies.find(c => c.id === shared.id)!.roles, before.companies.find(c => c.id === shared.id)!.roles.filter(role => role !== 'customer'));
    assert.deepEqual(after.directories!.addresses, before.directories!.addresses);
    assert.deepEqual(after.directories!.customerManagers, []);
    assert.deepEqual(after.payments, before.payments);
    assert.deepEqual(after.stocks, before.stocks);
    assert.equal(saved.sourceOperationsCleared, original.sourceOperationsCleared);
    assert.deepEqual(prepareCustomerShipmentCleanup(base, saved).data, saved, 'Repeated cleanup cannot resurrect or alter data');
    await store.mutate(base.provenance.sourceSha256, data => { Object.assign(data, saved); return { result: null, changed: true }; });
    assert.equal(currentSnapshot(base, await new OperationsStore(directory).read(base.provenance.sourceSha256)).shipments.length, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
