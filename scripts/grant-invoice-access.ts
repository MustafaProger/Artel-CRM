import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { OperationsStore, decodeOperations, encodeOperations } from '../server/operations-store';
import { grantInvoiceAccess } from '../server/invoice-permission-grant';

// Run only under the production entrypoint lifetime lock while CRM is stopped.
const args = process.argv.slice(2);
const option = (name: string) => args[args.indexOf(name) + 1];
if (!args.includes('--execute') || !args.includes('--mapping') || !args.includes('--expected-sha256')
    || process.env.ARTEL_INVOICES_MAINTENANCE !== 'true' || !process.env.ARTEL_STORE_DIR) throw new Error('Explicit locked invoice maintenance parameters are required');
const expected = option('--expected-sha256');
if (!/^[a-f0-9]{64}$/.test(expected)) throw new Error('Invalid expected store checksum');
const store = new OperationsStore(resolve(process.env.ARTEL_STORE_DIR));
const originalRaw = await readFile(store.path, 'utf8');
const originalEnvelope = JSON.parse(originalRaw);
const source = originalEnvelope.data?.sourceSha256 ?? originalEnvelope.sourceSha256;
const raw = originalEnvelope.format === 'artel-work-partition-v1' ? encodeOperations(await store.read(source), source) : originalRaw;
if (createHash('sha256').update(raw).digest('hex') !== expected) throw new Error('CRM store changed after review');
const before = decodeOperations(raw, source);
const mapping: unknown = JSON.parse(await readFile(option('--mapping'), 'utf8'));
const preview = structuredClone(before);
const plan = grantInvoiceAccess(preview, mapping);
await store.backup(before);
const result = await store.mutate(source, data => {
  // Revalidate the exact snapshot inside the transaction too.
  if (JSON.stringify(data) !== JSON.stringify(before)) throw new Error('CRM store changed before the grant');
  const changed = grantInvoiceAccess(data, mapping);
  return { result: changed, changed: changed.changed };
});
const after = await store.read(source);
const expectedData = { ...preview, revision: before.revision + (plan.changed ? 1 : 0) };
if (JSON.stringify(after) !== JSON.stringify(expectedData)) throw new Error('Unexpected CRM grant delta');
console.log(JSON.stringify({ ...result, exactAdditiveChangeVerified: true, sessionsPasswordsAndOtherDataPreserved: true }));
