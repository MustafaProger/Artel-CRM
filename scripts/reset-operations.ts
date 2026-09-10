import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadSnapshot } from '../server/local-api';
import { encodeOperations, OperationsStore } from '../server/operations-store';
import { clearOperations } from '../server/reset-operations';

if (!process.argv.includes('--confirm')) throw new Error('Pass --confirm to clear operations while retaining every directory.');
const base = await loadSnapshot(resolve('data/local-xlsx-final'));
const store = new OperationsStore(process.env.ARTEL_STORE_DIR || resolve('data/local-operations'));
const backupDirectory = resolve('qa', `operations-reset-${new Date().toISOString().replace(/[:.]/g, '-')}`);
await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
const result = await store.mutate(base.provenance.sourceSha256, async data => {
  await writeFile(resolve(backupDirectory, 'operations-before.json'), encodeOperations(data), { mode: 0o600, flag: 'wx' });
  const result = clearOperations(base, data);
  return { result, changed: true };
});
await writeFile(resolve(backupDirectory, 'report.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
console.log(JSON.stringify({ ...result, backupDirectory }, null, 2));
