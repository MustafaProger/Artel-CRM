// Synthetic v2 storage subprocess only; real fs boundaries, killed by parent.
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { basename } from 'node:path';
const [directory, action, boundary = 'none'] = process.argv.slice(2);
const source = 'a'.repeat(64), stamp = '2026-11-09T00:00:00Z';
const stop = async point => { if (boundary === point) { process.send?.({ boundary: point }); await new Promise(() => {}); } };
const rename = fs.rename.bind(fs), unlink = fs.unlink.bind(fs);
fs.rename = async (from, to) => { const name = basename(String(to)); await stop(`before-rename:${name}`); await rename(from, to); await stop(`after-rename:${name}`); };
fs.unlink = async path => { const name = basename(String(path)); await stop(`before-unlink:${name}`); await unlink(path); await stop(`after-unlink:${name}`); };
syncBuiltinESMExports();
const { OperationsStore } = await import('../server/operations-store.ts');
const { migrateArchiveStorage, mergeAuthStorage } = await import('../server/auth-partition.ts');
const store = new OperationsStore(directory);
if (action === 'migrate') await migrateArchiveStorage(directory, source);
else if (action === 'merge') await mergeAuthStorage(directory, source);
else if (action.startsWith('parts:')) {
  const parts = action.slice(6).split(',');
  await store.mutate(source, data => {
    if (parts.includes('auth')) data.accounts.users[0].active = false;
    if (parts.includes('core')) data.shipments.example.version++;
    if (parts.includes('archive')) data.documentArchive.categories[0].name = 'Updated';
    if (parts.includes('work')) data.work.notes.push({ id:'n',title:'Synthetic',content:'Synthetic',assigneeId:'owner',createdBy:'owner',updatedBy:'owner',createdAt:stamp,updatedAt:stamp,version:1 });
    return { changed:true,result:null };
  });
} else if (action.startsWith('concurrent:')) {
  const part = action.slice(11);
  for (let i=0;i<6;i++) await (part === 'auth' ? store.mutateAuth.bind(store) : store.mutate.bind(store))(source, data => {
    if (part === 'auth') data.accounts.users[0].version++;
    else if (part === 'core') data.shipments.example.version++;
    else data.documentArchive.categories[0].name += '!';
    return {changed:true,result:null};
  });
} else throw Error('Unknown synthetic action');
process.send?.({complete:true});
