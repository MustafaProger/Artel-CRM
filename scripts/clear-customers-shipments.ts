import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { loadSnapshot } from '../server/local-api';
import { OperationsStore } from '../server/operations-store';
import { prepareCustomerShipmentCleanup } from '../server/customer-shipment-cleanup';
import { currentSnapshot } from '../server/shipment-operations';

// No startup/build hooks: an operator must specify both directories and apply explicitly.
const [mode = 'plan'] = process.argv.slice(2);
assert.ok(['plan', 'apply'].includes(mode));
assert.ok(process.env.ARTEL_SNAPSHOT_DIR && process.env.ARTEL_STORE_DIR, 'Set explicit snapshot and store directories');
const base = await loadSnapshot(resolve(process.env.ARTEL_SNAPSHOT_DIR));
const store = new OperationsStore(resolve(process.env.ARTEL_STORE_DIR));
const prepare = (original: Awaited<ReturnType<typeof store.read>>) => {
  const prepared = prepareCustomerShipmentCleanup(base, original);
  const before = currentSnapshot(base, original), after = currentSnapshot(base, prepared.data);
  for (const key of Object.keys(original) as (keyof typeof original)[]) {
    if (!['shipments', 'companies', 'directories', 'paymentAllocations'].includes(key)) assert.deepEqual(prepared.data[key], original[key], `Unrelated collection changed: ${key}`);
  }
  for (const key of ['payments', 'stocks'] as const) assert.deepEqual(after[key], before[key]);
  for (const key of Object.keys(before.directories!) as (keyof NonNullable<typeof before.directories>)[]) {
    if (!['customerManagers', 'assignedCustomerIds'].includes(key)) assert.deepEqual(after.directories![key], before.directories![key]);
  }
  assert.deepEqual(after.companies.filter(c => c.roles.includes('supplier')).map(c => c.id), before.companies.filter(c => c.roles.includes('supplier')).map(c => c.id));
  return prepared;
};
if (mode === 'plan') {
  const original = await store.read(base.provenance.sourceSha256);
  console.log(JSON.stringify({ mode, revision: original.revision, removed: prepare(original).removed, unrelatedDataPreserved: true }));
} else {
  const result = await store.mutate(base.provenance.sourceSha256, async original => {
    const next = prepare(original);
    const backup = await store.backup(original);
    Object.assign(original, next.data);
    return { result: { removed: next.removed, backup, revision: original.revision + 1, unrelatedDataPreserved: true }, changed: true };
  });
  const saved = currentSnapshot(base, await store.read(base.provenance.sourceSha256));
  assert.equal(saved.shipments.length, 0);
  assert.equal(saved.companies.filter(c => c.roles.includes('customer')).length, 0);
  console.log(JSON.stringify({ mode, ...result, verified: true }));
}
