import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { partitionLock } from '../server/work-partition';

test('interactive admission preserves active exclusion, class FIFO, bounded background progress and cleanup on failure', async () => {
  const directory=await mkdtemp(resolve(tmpdir(),'partition-priority-')),path=resolve(directory,'transaction.lock');
  let unblock!:()=>void,entered!:()=>void;
  const ready=new Promise<void>(r=>{entered=r;});
  const gate=new Promise<void>(r=>{unblock=r;});
  const order:string[]=[];
  const first=partitionLock(path,async()=>{order.push('holder');entered();await gate;});
  await ready;
  let active=0;
  const work=(id:string)=>async()=>{assert.equal(active++,0);order.push(id);await new Promise(r=>setTimeout(r,1));active--;};
  const normal=[partitionLock(path,work('normal1')),partitionLock(path,work('normal2'))];
  const auth=Array.from({length:7},(_,i)=>partitionLock(path,work(`auth${i+1}`),'interactive'));
  assert.deepEqual(order,['holder']);unblock();
  try {
    await Promise.all([first,...normal,...auth]);
    assert.deepEqual(order,['holder','auth1','auth2','auth3','auth4','normal1','auth5','auth6','auth7','normal2']);
    const failed=partitionLock(path,async()=>{throw Error('expected');},'interactive');
    const next=partitionLock(path,async()=>42);
    await assert.rejects(failed,/expected/);assert.equal(await next,42);
  } finally {await rm(directory,{recursive:true,force:true});}
});
