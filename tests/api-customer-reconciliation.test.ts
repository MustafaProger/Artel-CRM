import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { BlobPreconditionFailedError } from '@vercel/blob';
import { loadSnapshot } from '../server/local-api';
import { OperationsStore, encodeOperations, decodeOperations, type OperationsData, type OperationsStorage } from '../server/operations-store';
import { BlobOperationsStore } from '../server/blob-operations-store';
import { planCustomerReconciliation, reconcileCustomers } from '../server/customer-reconciliation';
import { currentSnapshot } from '../server/shipment-operations';
import { saveUser } from '../server/auth';
import { legacyManagerSections } from '../web/src/auth-model';
import { randomUUID } from 'node:crypto';
const base = await loadSnapshot();
const source = base.shipments.find(row => row.customerId && row.supplierId)!;
const unrelated = base.companies.find(company => company.id !== source.customerId)!;
async function seed(store: OperationsStorage) {
  await store.mutate(base.provenance.sourceSha256, data => {
    data.sourceOperationsCleared = true;
    data.companies = [source.customerId, unrelated.id].map(id => ({ ...base.companies.find(c => c.id === id)!, directoryArchived: true }));
    data.shipments = { ['shipment-local-source-' + source.id]: { fields: { ...source.fields, customer_id: source.customerId, supplier_id: source.supplierId, carrier_id: source.carrierId }, version: 1, createdAt: '2026-09-16', updatedAt: '2026-09-16' } };
    return { result: null, changed: true };
  });
}
async function verifyRestoration(store: OperationsStorage) {
  await seed(store);
  const before = await store.read(base.provenance.sourceSha256);
  const snapshotBefore = currentSnapshot(base, before);
  const plan = planCustomerReconciliation(base, before);
  assert.deepEqual(plan.counts, { importedShipments: 1, referencedCustomers: 1, missingCustomerReferences: 0, active: 0, restore: 1, create: 0, unresolvedCustomers: 0 });
  const result = await reconcileCustomers(store, base, plan);
  assert.ok(result.backup); assert.equal(result.verified, true);
  const after = await store.read(base.provenance.sourceSha256);
  assert.deepEqual(after.shipments, before.shipments);
  assert.deepEqual(currentSnapshot(base, after).shipments, snapshotBefore.shipments);
  const expected = structuredClone(before); expected.revision++;
  expected.companies[0].directoryArchived = false; expected.companies[0].version = (expected.companies[0].version ?? 0) + 1;
  assert.deepEqual(after, expected);
  const second = await reconcileCustomers(store, base, result.after);
  assert.equal(second.changed, false); assert.equal(second.backup, null);
  assert.deepEqual(await store.read(base.provenance.sourceSha256), after);
  return { before, backup: result.backup! };
}

test('local reconciliation restores only referenced archived customers; verified backup, stable IDs, exact preservation and repeat no-op', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'artel-reconcile-'));
  try {
    const store = new OperationsStore(directory);
    const { before, backup } = await verifyRestoration(store);
    assert.deepEqual(decodeOperations(await readFile(backup, 'utf8'), base.provenance.sourceSha256), before);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

function blobFixture(initial: OperationsData) {
  const blobs = new Map<string, string>([['test-operations', encodeOperations(initial)]]);
  let version = 0, conflict = false, corruptBackup = false;
  const client = {
    get: async (path: string) => ({ statusCode: 200, stream: new Response(corruptBackup && path !== 'test-operations' ? 'broken' : blobs.get(path)).body, blob: { etag: String(version) } }),
    put: async (path: string, body: unknown, options: { ifMatch?: string }) => {
      if (path === 'test-operations') { if (conflict || options.ifMatch !== String(version)) throw new BlobPreconditionFailedError(); version++; }
      blobs.set(path, String(body)); return { etag: String(version) };
    },
  };
  return { store: new BlobOperationsStore('test-operations', client as never), blobs, conflict: () => { conflict = true; }, corruptBackup: () => { corruptBackup = true; } };
}
async function freshData() {
  const directory = await mkdtemp(resolve(tmpdir(), 'artel-empty-'));
  try { return await new OperationsStore(directory).read(base.provenance.sourceSha256); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('Blob reconciliation preserves IDs and stores permissions; ETag conflict and failed backup leave the original untouched', async () => {
  const initial = await freshData();
  const cloud = blobFixture(initial);
  const { before, backup } = await verifyRestoration(cloud.store);
  assert.deepEqual(decodeOperations(cloud.blobs.get(backup)!, base.provenance.sourceSha256), before);
  await cloud.store.mutate(base.provenance.sourceSha256, async data => {
    const snapshot = currentSnapshot(base, data);
    await saveUser(data, snapshot, { name: 'Director test', login: 'director', password: randomUUID() }, undefined, true);
    await saveUser(data, snapshot, { name: 'Employee test', login: 'employee', password: randomUUID(), role: 'manager', managerId: snapshot.directories!.managers[0].id, sections: ['work'] });
    return { result: null, changed: true };
  });
  assert.deepEqual((await cloud.store.read(base.provenance.sourceSha256)).accounts!.users[1].sections, ['work']);
  for (const failure of ['conflict', 'corruptBackup'] as const) {
    const f = blobFixture(initial); await seed(f.store);
    const before = f.blobs.get('test-operations');
    const plan = planCustomerReconciliation(base, await f.store.read(base.provenance.sourceSha256));
    f[failure](); await assert.rejects(reconcileCustomers(f.store, base, plan));
    assert.equal(f.blobs.get('test-operations'), before);
  }
  assert.ok(!legacyManagerSections.includes('china')); assert.ok(!legacyManagerSections.includes('payments'));
});

test('stale reconciliation plans reject concurrency; unknown references are reported without name-merging or shipment edits', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'artel-reconcile-cases-'));
  try {
    const store = new OperationsStore(directory); await seed(store);
    const data = await store.read(base.provenance.sourceSha256);
    const plan = planCustomerReconciliation(base, data);
    await store.mutate(base.provenance.sourceSha256, current => { current.directories!.managers.push({ id: 'test-person', name: 'Test person' }); return { changed: true, result: null }; });
    await assert.rejects(reconcileCustomers(store, base, plan), { status: 409 });
    const missing = structuredClone(data);
    const row = Object.values(missing.shipments)[0]; row.fields.customer_id = 'unresolved-customer';
    const report = planCustomerReconciliation(base, missing);
    assert.equal(report.counts.restore, 0); assert.equal(report.counts.create, 0); assert.equal(report.unresolved[0].customerId, 'unresolved-customer');
    row.fields.customer_id = null;
    assert.equal(planCustomerReconciliation(base, missing).counts.missingCustomerReferences, 1);
    missing.directories!.deletedEntries = { companies: [source.customerId!] }; row.fields.customer_id = source.customerId;
    assert.equal(planCustomerReconciliation(base, missing).unresolved[0].reason, 'deleted-card-requires-review');
    const sourceWithoutCard = { ...base, companies: base.companies.filter(company => company.id !== source.customerId) };
    const genuinelyMissing = structuredClone(data); genuinelyMissing.companies = genuinelyMissing.companies.filter(company => company.id !== source.customerId);
    const createPlan = planCustomerReconciliation(sourceWithoutCard, genuinelyMissing);
    assert.equal(createPlan.counts.create, 1); assert.equal(createPlan.createCards[0].id, source.customerId); assert.equal(createPlan.createCards[0].name, source.customer);
    const collision = { ...sourceWithoutCard, shipments: [...sourceWithoutCard.shipments, { ...source, id: 'conflicting-source', customer: 'Different unverified name' }] };
    assert.equal(planCustomerReconciliation(collision, genuinelyMissing).counts.create, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
