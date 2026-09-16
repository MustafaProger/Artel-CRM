import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { loadSnapshot } from '../server/local-api';
import { OperationsStore, encodeOperations, decodeOperations } from '../server/operations-store';
import { currentSnapshot } from '../server/shipment-operations';
import { planCustomerReconciliation, reconcileCustomers } from '../server/customer-reconciliation';
import { ownershipReport } from '../server/shipment-ownership';

// A diagnostic fixture only: never imports source shipments into the working store.
const base = await loadSnapshot();
const path = resolve('data/local-operations/operations.json');
const original = await readFile(path, 'utf8');
const working = decodeOperations(original, base.provenance.sourceSha256);
const latest = base.shipments.filter(row => row.date).sort((a, b) => b.date!.localeCompare(a.date!) || b.sourceRow - a.sourceRow || a.id.localeCompare(b.id)).slice(0, 100);
const directory = await mkdtemp(resolve(tmpdir(), 'artel-reconciliation-copy-'));
const report: Record<string, unknown> = { dataset: 'isolated copy of local mutable data with latest 100 immutable source shipments as a test fixture; not production', sourceShipments: base.shipments.length, sourceSelection: { shipments: latest.length, distinctLinkedCustomers: new Set(latest.flatMap(row => row.customerId ? [row.customerId] : [])).size, noCustomerReference: latest.filter(row => !row.customerId).length, from: latest.at(-1)?.date, to: latest[0].date }, localWorking: { revision: working.revision, shipments: currentSnapshot(base, working).shipments.length, plan: planCustomerReconciliation(base, working).counts }, liveDataChanged: false, deployed: false };
try {
  // Strip accounts/sessions from this non-authenticated diagnostic fixture.
  const copy = structuredClone(working); delete copy.accounts; delete copy.push;
  copy.sourceOperationsCleared = true; copy.shipments = {}; copy.paymentAllocations = [];
  for (const row of latest) copy.shipments['shipment-local-source-' + row.id] = { fields: { ...row.fields, customer_id: row.customerId, supplier_id: row.supplierId, carrier_id: row.carrierId }, version: 1, createdAt: '2026-09-16T00:00:00.000Z', updatedAt: '2026-09-16T00:00:00.000Z' };
  await writeFile(resolve(directory, 'operations.json'), encodeOperations(copy), { mode: 0o600, flag: 'wx' });
  const store = new OperationsStore(directory);
  const before = await store.read(base.provenance.sourceSha256), snapshotBefore = currentSnapshot(base, before);
  const plan = planCustomerReconciliation(base, before);
  const result = await reconcileCustomers(store, base, plan);
  assert.deepEqual(decodeOperations(await readFile(result.backup!, 'utf8'), base.provenance.sourceSha256), before);
  const after = await store.read(base.provenance.sourceSha256);
  assert.deepEqual(after.shipments, before.shipments);
  assert.deepEqual(currentSnapshot(base, after).shipments, snapshotBefore.shipments);
  const repeated = await reconcileCustomers(store, base, result.after);
  assert.equal(repeated.changed, false); assert.deepEqual(await store.read(base.provenance.sourceSha256), after);
  const ownership = ownershipReport(snapshotBefore);
  Object.assign(report, { testCopy: { before: plan.counts, after: result.after.counts, secondRunChanged: repeated.changed, unresolved: result.after.unresolved, restoredIds: plan.restoreIds, ownership: { resolved: ownership.filter(row => row.employeeId).length, unresolved: ownership.filter(row => !row.employeeId) }, backupVerified: true, shipmentsUnchanged: true }, localWorkingUnchanged: createHash('sha256').update(await readFile(path)).digest('hex') === createHash('sha256').update(original).digest('hex') });
  assert.equal(report.localWorkingUnchanged, true);
} finally { await rm(directory, { recursive: true, force: true }); }
await mkdir('qa/employee-access', { recursive: true });
await writeFile('qa/employee-access/reconciliation.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
