import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { OperationsStore, encodeOperations } from '../server/operations-store';
import { migrateWorkStorage, mergeWorkStorage } from '../server/work-partition';
const [action, directory, source, confirmation, output] = process.argv.slice(2);
if (!['split', 'merge', 'export'].includes(action) || !directory || !/^[a-f0-9]{64}$/.test(source ?? '')) throw new Error('Usage: tsx scripts/work-storage.ts split|merge|export DIRECTORY SOURCE_SHA --writers-stopped [EXPORT_PATH]');
if (confirmation !== '--writers-stopped') throw new Error('Stop all writers first; explicit --writers-stopped is required.');
if (action === 'export') {
  if (!output) throw new Error('Export path required');
  const data = await new OperationsStore(resolve(directory)).read(source);
  await writeFile(resolve(output), encodeOperations(data, source), { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ exported: true, revision: data.revision }));
} else console.log(JSON.stringify(await (action === 'split' ? migrateWorkStorage : mergeWorkStorage)(resolve(directory), source)));
