/** Explicit, one-off maintenance. Never run by build or application startup. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadSnapshot } from '../server/local-api';
import { OperationsStore, type OperationsData, type OperationsStorage } from '../server/operations-store';
import { BlobOperationsStore } from '../server/blob-operations-store';
import { prepareCompanyCleanup } from '../server/directory-cleanup';
import { currentSnapshot } from '../server/shipment-operations';

const [environment, mode = 'plan'] = process.argv.slice(2);
if (!['local', 'cloud'].includes(environment) || !['plan', 'apply'].includes(mode)) throw new Error('Use local|cloud plan|apply.');
if (environment === 'cloud') {
  if (process.env.ARTEL_MAINTENANCE_TARGET !== 'https://artel-crm.vercel.app' || process.env.VERCEL_ENV !== 'production' || !process.env.BLOB_READ_WRITE_TOKEN?.trim().startsWith('vercel_blob_rw_')) throw new Error('Set the verified production target, environment and Blob credential.');
  process.env.BLOB_READ_WRITE_TOKEN = process.env.BLOB_READ_WRITE_TOKEN.trim();
}
const base = await loadSnapshot(resolve('data/local-xlsx-final'));
const store: OperationsStorage = environment === 'cloud' ? new BlobOperationsStore() : new OperationsStore(resolve('data/local-operations'));
const retained = ({ companies: _companies, revision: _revision, ...data }: OperationsData) => data;
const verify = (before: OperationsData, after: OperationsData) => {
  assert.deepEqual(retained(after), retained(before), 'Every non-company collection must remain unchanged.');
  const oldSnapshot = currentSnapshot(base, before), nextSnapshot = currentSnapshot(base, after);
  for (const key of ['shipments', 'payments', 'stocks'] as const) assert.deepEqual(nextSnapshot[key], oldSnapshot[key], `Historical ${key} must remain unchanged.`);
  assert.equal(nextSnapshot.companies.filter(company => !company.directoryArchived && company.roles.some(role => ['customer', 'supplier'].includes(role))).length, 0);
};
const before = await store.read(base.provenance.sourceSha256);
const prepared = prepareCompanyCleanup(base, before);
verify(before, prepared.data);
if (mode === 'plan') console.log(JSON.stringify({ environment, counts: prepared.counts, revision: before.revision, preserved: true }));
else {
  let expected: OperationsData | undefined;
  const result = await store.mutate(base.provenance.sourceSha256, async data => {
    assert.equal(data.revision, before.revision, 'Data changed after planning. No cleanup performed.');
    const next = prepareCompanyCleanup(base, data);
    verify(data, next.data);
    if (!store.backup) throw new Error('A verified backup is required.');
    const backup = await store.backup(data);
    data.companies = next.data.companies;
    expected = structuredClone(data); expected.revision++;
    return { result: { environment, counts: next.counts, backup, revision: expected.revision }, changed: true };
  });
  const after = await store.read(base.provenance.sourceSha256);
  assert.deepEqual(after, expected, 'Post-write state differs; inspect before retrying.');
  verify(before, after);
  await mkdir(resolve('data/backups/apple-refresh'), { recursive: true, mode: 0o700 });
  await writeFile(resolve(`data/backups/apple-refresh/${environment}-cleanup-result.json`), JSON.stringify({ ...result, verified: true, checkedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ ...result, verified: true }));
}
