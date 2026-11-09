// Synthetic-only subprocess harness. Real filesystem calls are paused at a
// selected boundary; the parent sends SIGKILL. No production hooks are needed.
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { basename } from 'node:path';

const [directory, action, boundary = 'none'] = process.argv.slice(2);
const source = 'a'.repeat(64);
const stop = async point => {
  if (boundary !== point) return;
  process.send?.({ boundary: point });
  await new Promise(() => {});
};
const rename = fs.rename.bind(fs), unlink = fs.unlink.bind(fs);
fs.rename = async (from, to) => {
  const name = basename(String(to));
  await stop(`before-rename:${name}`);
  await rename(from, to);
  await stop(`after-rename:${name}`);
};
fs.unlink = async path => {
  const name = basename(String(path));
  await stop(`before-unlink:${name}`);
  await unlink(path);
  await stop(`after-unlink:${name}`);
};
syncBuiltinESMExports();
const { OperationsStore } = await import('../server/operations-store.ts');
const { migrateAuthStorage, mergeAuthStorage } = await import('../server/auth-partition.ts');
const store = new OperationsStore(directory);
if (action === 'migrate') await migrateAuthStorage(directory, source);
else if (action === 'merge') await mergeAuthStorage(directory, source);
else if (action === 'auth') await store.mutateAuth(source, data => {
  data.accounts.users[0].active = false;
  return { changed: true, result: null };
});
else if (action === 'mixed') await store.mutate(source, data => {
  data.accounts.users[0].active = false;
  data.shipments.example.version++;
  data.work.notes.push({ id: 'n', title: 'Synthetic', content: 'Synthetic', assigneeId: 'owner', createdBy: 'owner', updatedBy: 'owner', createdAt: '2026-11-09T00:00:00Z', updatedAt: '2026-11-09T00:00:00Z', version: 1 });
  return { changed: true, result: null };
});
else if (action === 'concurrent-auth' || action === 'concurrent-core') {
  for (let index = 0; index < 6; index++) await (action === 'concurrent-auth' ? store.mutateAuth.bind(store) : store.mutate.bind(store))(source, data => {
    if (action === 'concurrent-auth') data.accounts.users[0].version++;
    else data.shipments.example.version++;
    return { changed: true, result: null };
  });
} else throw new Error('Unknown synthetic crash action');
process.send?.({ complete: true });
