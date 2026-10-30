// Synthetic loopback comparison; no live store, integration credentials or provider calls.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {writeTripsQaSnapshot} from './qa-trips-runtime.mjs';
import {bootstrapQaAuth} from './qa-auth.mjs';
import {createSnapshotMiddleware} from '../server/local-api.ts';
import {OperationsStore,LegacyOperationsStore,encodeOperations} from '../server/operations-store.ts';
import {migrateWorkStorage} from '../server/work-partition.ts';
import {normalizeTbank} from '../server/banking/adapters.ts';
import {emptyBanking} from '../server/banking/domain.ts';
import {fixtureConfig,fixtureDay,accountNumber,tbankRow} from '../tests/banking-fixtures.ts';
const output=resolve(process.argv[2]??'../benchmark.json');
const rounds=15;const operations=3500;
const root=await mkdtemp(resolve(tmpdir(),'work-perf-'));const snapshot=resolve(root,'snapshot');const source=await writeTripsQaSnapshot(snapshot);
const report={synthetic:true,rounds,bankOperations:operations,externalCalls:0,models:[],results:[]};
const deny=async()=>{report.externalCalls++;throw Error('No external calls');};
const percentile=(a,p)=>[...a].sort((a,b)=>a-b)[Math.ceil(a.length*p)-1];
try {
 for(const mode of ['legacy','partitioned','partitioned','legacy']) {
  const directory=resolve(root,randomUUID());await mkdir(directory);const store=mode==='legacy'?new LegacyOperationsStore(directory):new OperationsStore(directory);
  await store.mutate(source,d=>{d.banking=emptyBanking();const c=fixtureConfig();d.banking.operations=Array.from({length:operations},(_,i)=>normalizeTbank(c,{number:accountNumber,currency:'RUB'},fixtureDay,tbankRow(`perf-${i}`)));return{result:null,changed:true}});
  const api=createSnapshotMiddleware(snapshot,{operationsStore:store,bankEnvironment:{ARTEL_BANK_REQUESTS_ENABLED:'false',ARTEL_BANK_SYNC_ENABLED:'false'},bankRequest:deny,sberRequest:deny,fetcher:deny,pushSender:deny,pushConfig:{publicKey:'',privateKey:'',subject:'',schedule:false}});
  const server=createServer((q,s)=>api(q,s,()=>{s.writeHead(404);s.end()}));await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}`;const {cookie}=await bootstrapQaAuth(url);
  const request=async(path,method='GET',body)=>{const t=performance.now();const r=await fetch(url+path,{method,headers:{Cookie:cookie,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const data=await r.json();assert.ok(r.ok,JSON.stringify(data));return{ms:performance.now()-t,data}};
  for(let i=0;i<4;i++)await request('/api/work/tasks','POST',{requestId:randomUUID(),title:`Task ${i}`});
  await request('/api/work/notes','POST',{title:'Note',content:'Synthetic'});
  const logical=await store.read(source);report.models.push({mode,storeBytes:Buffer.byteLength(encodeOperations(logical)),workBytes:Buffer.byteLength(JSON.stringify(logical.work))});
  if(mode==='partitioned')await migrateWorkStorage(directory,source);
  const protectedBefore=JSON.stringify((await store.read(source)).banking.operations.slice(1));
  const samples=[];
  try{
   for(const load of ['idle','six-background-writes']) {
    for(let i=0;i<rounds;i++) {
     const run=async(name,path,method,body)=>{
      const start=performance.now();
      const jobs=load==='idle'?[]:Array.from({length:6},(_,j)=>store.mutate(source,d=>{d.banking.operations[0].updatedAt=new Date(Date.now()+j).toISOString();return{result:null,changed:true}}));
      const r=await request(path,method,body);await Promise.all(jobs);samples.push({load,name,round:i,ms:r.ms,batchMs:performance.now()-start});return r.data;
     };
     let task=(await run('create','/api/work/tasks','POST',{requestId:randomUUID(),title:`Round ${i}`})).entry;
     task=(await run('done',`/api/work/tasks/${task.id}`,'PATCH',{version:task.version,status:'done'})).entry;
     task=(await run('todo',`/api/work/tasks/${task.id}`,'PATCH',{version:task.version,status:'todo'})).entry;
     task=(await run('edit',`/api/work/tasks/${task.id}`,'PATCH',{version:task.version,title:`Edited ${i}`})).entry;
     await run('delete',`/api/work/tasks/${task.id}`,'DELETE',{version:task.version});
    }
   }
   assert.equal(JSON.stringify((await store.read(source)).banking.operations.slice(1)),protectedBefore);
   report.results.push({mode,samples});await writeFile(output,JSON.stringify(report,null,2));console.log('finished',mode);
  }finally{await new Promise(r=>server.close(r))}
 }
 report.summary=[];
 for(const mode of ['legacy','partitioned'])for(const load of ['idle','six-background-writes'])for(const name of ['create','done','todo','edit','delete']){
  const values=report.results.filter(r=>r.mode===mode).flatMap(r=>r.samples).filter(s=>s.load===load&&s.name===name).map(s=>s.ms);
  report.summary.push({mode,load,name,count:values.length,medianMs:percentile(values,.5),p95Ms:percentile(values,.95),maxMs:Math.max(...values)});
 }
 report.backgroundSummary=['legacy','partitioned'].map(mode=>{const values=report.results.filter(r=>r.mode===mode).flatMap(r=>r.samples).filter(s=>s.load==='six-background-writes').map(s=>s.batchMs);return {mode,count:values.length,medianBatchMs:percentile(values,.5),p95BatchMs:percentile(values,.95)}});
 assert.equal(report.externalCalls,0);report.passed=true;await writeFile(output,JSON.stringify(report,null,2));console.log(JSON.stringify(report.summary,null,2));
}finally{await rm(root,{recursive:true,force:true})}
