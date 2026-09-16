import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadSnapshot } from '../server/local-api';
import { OperationsStore } from '../server/operations-store';
import { BlobOperationsStore } from '../server/blob-operations-store';
import { planCustomerReconciliation, reconcileCustomers, type CustomerReconciliationPlan } from '../server/customer-reconciliation';

// No default mutable target and no automatic environment-file loading.
const [mode, target, planPath] = process.argv.slice(2);
if (!['plan', 'apply'].includes(mode) || !target || !planPath) throw new Error('Usage: npx tsx scripts/reconcile-customers.ts plan|apply <local-directory|blob:pathname> <plan.json>');
const base = await loadSnapshot();
const store = target.startsWith('blob:') ? new BlobOperationsStore(target.slice(5)) : new OperationsStore(resolve(target));
if (mode === 'plan') {
  const plan = planCustomerReconciliation(base, await store.read(base.provenance.sourceSha256));
  await writeFile(planPath, JSON.stringify({ target, sourceSha256: base.provenance.sourceSha256, plan }, null, 2), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ target, mode, counts: plan.counts, unresolved: plan.unresolved }, null, 2));
} else {
  const saved = JSON.parse(await readFile(planPath, 'utf8')) as { target: string; sourceSha256: string; plan: CustomerReconciliationPlan };
  if (saved.target !== target || saved.sourceSha256 !== base.provenance.sourceSha256) throw new Error('Plan belongs to a different dataset');
  console.log(JSON.stringify({ target, mode, ...await reconcileCustomers(store, base, saved.plan) }, null, 2));
}
