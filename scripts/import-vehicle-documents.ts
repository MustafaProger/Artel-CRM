import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { Company } from '../web/src/model';
import { OperationsStore, type OperationsData } from '../server/operations-store';
import { importVehicleDocuments, type VehicleDocumentPayload } from '../server/vehicle-document-import';

/** Private inputs/reports only. Default is dry-run; --apply uses OperationsStore lock and verified backup. */
const args = process.argv.slice(2);
const option = (name: string) => { const index = args.indexOf(name); if (index < 0 || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Required option: ${name}`); return args[index + 1]; };
const store = new OperationsStore(option('--store-dir'));
const catalog = JSON.parse(await readFile(option('--catalog'), 'utf8')) as { sourceSha256: string; companies: Company[] };
const payload = JSON.parse(await readFile(option('--payload'), 'utf8')) as VehicleDocumentPayload;
const reportPath = resolve(option('--report'));
const companiesFor = (data: OperationsData) => [...catalog.companies.filter(company => !data.companies.some(row => row.id === company.id)), ...data.companies].filter(company => !data.directories?.deletedEntries?.companies?.includes(company.id));
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const withoutVehicles = (data: OperationsData) => {
  const copy = structuredClone(data);
  if (copy.directories) { copy.directories.vehicles = []; if (copy.directories.deletedEntries) copy.directories.deletedEntries.vehicles = []; }
  return copy;
};
function assertVehicleScope(before: OperationsData, after: OperationsData, changedIds: Set<string>) {
  // Absent tombstone metadata is equivalent to an empty list for this comparison.
  const left = withoutVehicles(before), right = withoutVehicles(after);
  assert.deepEqual(right, left, 'Import changed a non-vehicle collection.');
  const allowedRestores = new Set(payload.restoreVehicleIds ?? []);
  const beforeDeleted = before.directories?.deletedEntries?.vehicles ?? [], afterDeleted = after.directories?.deletedEntries?.vehicles ?? [];
  assert.ok(afterDeleted.every(id => beforeDeleted.includes(id)), 'Import added a deletion.');
  assert.ok(beforeDeleted.filter(id => !afterDeleted.includes(id)).every(id => allowedRestores.has(id)), 'Import restored an unauthorized vehicle.');
  for (const row of before.directories!.vehicles) if (!changedIds.has(row.id)) assert.deepEqual(after.directories!.vehicles.find(value => value.id === row.id), row, 'Import altered an unrelated vehicle.');
  for (const row of after.directories!.vehicles) assert.ok(changedIds.has(row.id) || before.directories!.vehicles.some(value => value.id === row.id), 'Import added an unreported vehicle.');
}
let output;
if (args.includes('--apply')) {
  output = await store.mutate(catalog.sourceSha256, async data => {
    const before = structuredClone(data), revisionBefore = data.revision;
    const report = importVehicleDocuments(data, companiesFor(data), payload);
    const changedIds = new Set(report.records.filter(record => ['created', 'updated', 'restored'].includes(record.action)).map(record => record.vehicleId!));
    assertVehicleScope(before, data, changedIds);
    const expectedVehicles = Object.fromEntries([...changedIds].map(id => [id, fingerprint(data.directories!.vehicles.find(row => row.id === id))]));
    const backup = report.changed ? await store.backup(before) : undefined;
    return { changed: report.changed, result: { mode: 'apply', revisionBefore, revisionAfter: revisionBefore + (report.changed ? 1 : 0), backup, expectedVehicles, ...report } };
  });
  Object.assign(output, { committed: true, verified: false, idempotent: false });
  await writeFile(reportPath, JSON.stringify(output, null, 2) + '\n', { mode: 0o600 });
  try {
    const readBack = await store.read(catalog.sourceSha256);
    for (const [id, expected] of Object.entries(output.expectedVehicles)) assert.equal(fingerprint(readBack.directories!.vehicles.find(row => row.id === id)), expected, 'Independent vehicle read-back differs.');
    const repeated = importVehicleDocuments(structuredClone(readBack), companiesFor(readBack), payload);
    assert.equal(repeated.changed, false, 'Repeated import is not idempotent.');
    Object.assign(output, { verified: true, idempotent: true });
  } catch (error) {
    Object.assign(output, { verificationError: (error as Error).message });
    await writeFile(reportPath, JSON.stringify(output, null, 2) + '\n', { mode: 0o600 });
    throw error;
  }
} else {
  const data = await store.read(catalog.sourceSha256);
  const before = structuredClone(data);
  const report = importVehicleDocuments(data, companiesFor(data), payload);
  assertVehicleScope(before, data, new Set(report.records.filter(record => ['created', 'updated', 'restored'].includes(record.action)).map(record => record.vehicleId!)));
  output = { mode: 'dry-run', revisionBefore: data.revision, ...report };
}
await writeFile(reportPath, JSON.stringify(output, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ mode: output.mode, changed: output.changed, changedFields: output.changedFields, records: output.records.map(record => ({ vehicleId: record.vehicleId, action: record.action, changedFields: record.changes.length, conflicts: record.conflicts.length, missing: record.missing.length })), reportPath }));
