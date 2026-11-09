import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { readdir, rename, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { OperationsStore } from '../server/operations-store';
import { authPartitionVersion, migrateArchiveStorage } from '../server/auth-partition';
import { archiveFixture } from './helpers/auth-archive-fixture';
const source = 'a'.repeat(64);
async function child(directory: string, action: string, boundary = 'none') {
  await new Promise<void>((done, reject) => {
    const bundled = process.env.ARTEL_AUTH_ARCHIVE_CRASH_CHILD;
    const worker = fork(bundled || resolve('scripts/profile-auth-archive-crash.mjs'), [directory,action,boundary], { execArgv: bundled ? [] : ['--import','tsx'], stdio:['ignore','pipe','pipe','ipc'] });
    let reached = false, errors = '';
    worker.stderr!.on('data', value => { errors += value; });
    const timeout = setTimeout(() => { worker.kill('SIGKILL'); reject(Error(`Child timeout ${action}/${boundary}: ${errors}`)); },15000);
    worker.on('message', value => { if ((value as {boundary?:string}).boundary === boundary) { reached = true; worker.kill('SIGKILL'); } });
    worker.on('error', reject);
    worker.on('exit',(code,signal) => { clearTimeout(timeout); if (boundary === 'none' ? code === 0 : reached && signal === 'SIGKILL') done(); else reject(Error(`Child ${code}/${signal} ${action}/${boundary} ${errors}`)); });
  });
}
// Stale lock removal is allowed ONLY after the writer has exited.
async function recoverStopped(directory: string) {
  for (const item of await readdir(directory,{withFileTypes:true})) {
    const path = resolve(directory,item.name);
    if(item.isDirectory()) await recoverStopped(path);
    else if(item.name.endsWith('.lock')) await unlink(path);
  }
}
const all = ['core','auth','work','archive'];
for (let mask = 1; mask < 16; mask++) {
  const parts = all.filter((_,bit) => mask & 1<<bit);
  const boundaries = parts.length === 1 ? [`before-rename:${parts[0]}.json`,`after-rename:${parts[0]}.json`]
    : mask === 15 ? ['before-rename:commit.json','after-rename:commit.json',...parts.map(part=>`after-rename:${part}.json`),'before-unlink:commit.json','after-unlink:commit.json']
    : [`after-rename:${parts[0]}.json`];
  for(const boundary of boundaries) test(`v2 SIGKILL ${parts.join('+')} ${boundary} recovers atomic logical state`,async()=>{
    const f = await archiveFixture(); try {
      const before = await f.store.read(source);
      await child(f.directory,`parts:${parts.join(',')}`,boundary); await recoverStopped(f.directory);
      const after = await new OperationsStore(f.directory).read(source);
      if(boundary.startsWith('before-rename:')) assert.deepEqual(after,before);
      else {
        assert.equal(after.shipments.example.version,parts.includes('core')?2:1);
        assert.equal(after.accounts!.users[0].active,!parts.includes('auth'));
        assert.equal(after.work!.notes.length,parts.includes('work')?1:0);
        assert.equal(after.documentArchive!.categories[0].name,parts.includes('archive')?'Updated':'Synthetic');
        assert.equal(after.revision,before.revision+parts.length);
      }
      assert.deepEqual(await new OperationsStore(f.directory).read(source),after);
    } finally { await f.close(); }
  });
}
for(const boundary of ['after-rename:core.json','after-rename:auth.json','after-rename:work.json','after-rename:archive.json','before-rename:operations.json','after-rename:operations.json']) test(`v2 SIGKILL offline migration ${boundary} retains current source or complete v2`,async()=>{
  const f = await archiveFixture(false); try {
    const before = await f.store.read(source);
    await child(f.directory,'migrate',boundary); await recoverStopped(f.directory);
    assert.deepEqual(await new OperationsStore(f.directory).read(source),before);
    assert.equal(await authPartitionVersion(f.store.path,source),boundary==='after-rename:operations.json'?2:1);
    if(boundary!=='after-rename:operations.json') {
      await assert.rejects(migrateArchiveStorage(f.directory,source),{code:'EEXIST'});
      await f.store.mutate(source,d=>{d.shipments.example.version++;return{changed:true,result:null};});
      const current = await f.store.read(source);
      await rename(f.part.directory,resolve(f.directory,'abandoned-auth-storage-v2'));
      await migrateArchiveStorage(f.directory,source);
      assert.deepEqual(await new OperationsStore(f.directory).read(source),current);
    }
  } finally { await f.close(); }
});
for(const boundary of ['before-rename:operations.json','after-rename:operations.json']) test(`v2 SIGKILL merge current ${boundary}`,async()=>{
  const f=await archiveFixture(); try {
    await f.store.mutate(source,d=>{d.documentArchive!.categories[0].name='Latest';return{changed:true,result:null};});
    const before=await f.store.read(source);
    await child(f.directory,'merge',boundary);await recoverStopped(f.directory);
    assert.deepEqual(await new OperationsStore(f.directory).read(source),before);
  } finally {await f.close();}
});
test('v2 separate OS writers preserve concurrent auth/core/archive changes',async()=>{
  const f=await archiveFixture();try {
    await Promise.all(['auth','core','archive'].map(part=>child(f.directory,`concurrent:${part}`)));
    const after=await f.store.read(source);
    assert.equal(after.accounts!.users[0].version,7);assert.equal(after.shipments.example.version,7);assert.equal(after.documentArchive!.categories[0].name,'Synthetic!!!!!!');
  }finally{await f.close();}
});
