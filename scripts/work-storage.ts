import { dirname, resolve } from 'node:path';
import { open } from 'node:fs/promises';
import { OperationsStore, encodeOperations } from '../server/operations-store';
import { migrateWorkStorage, mergeWorkStorage } from '../server/work-partition';
import { isAuthPartition, migrateAuthStorage, mergeAuthStorage } from '../server/auth-partition';
const [action, directory, source, confirmation, output] = process.argv.slice(2);
if (!['split', 'split-auth', 'merge', 'export'].includes(action) || !directory || !/^[a-f0-9]{64}$/.test(source ?? '')) throw new Error('Usage: tsx scripts/work-storage.ts split|split-auth|merge|export DIRECTORY SOURCE_SHA --writers-stopped [EXPORT_PATH]');
if (confirmation !== '--writers-stopped') throw new Error('Stop all writers first; explicit --writers-stopped is required.');
if (action === 'export') {
  if (!output) throw new Error('Export path required');
  const data = await new OperationsStore(resolve(directory)).read(source);
  const path = resolve(output), file = await open(path, 'wx', 0o600);
  try { await file.writeFile(encodeOperations(data, source)); await file.sync(); } finally { await file.close(); }
  const parent = await open(dirname(path), 'r');
  try { await parent.sync(); } finally { await parent.close(); }
  console.log(JSON.stringify({ exported: true, revision: data.revision }));
} else {
  const auth = await isAuthPartition(resolve(directory, 'operations.json'), source);
  if (action === 'split' && auth) throw new Error('Auth partition already includes Work; export current state before changing layout.');
  const change = action === 'split-auth' ? migrateAuthStorage : action === 'split' ? migrateWorkStorage : auth ? mergeAuthStorage : mergeWorkStorage;
  console.log(JSON.stringify(await change(resolve(directory), source)));
}
