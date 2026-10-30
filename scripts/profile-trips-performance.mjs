// Synthetic HTTP acknowledgements; denies providers and never opens a live store.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {writeFile,stat} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {integrationRuntime} from '../tests/helpers/trip-saby-integration.ts';
import {createSnapshotMiddleware} from '../server/local-api.ts';
import {migrateWorkStorage} from '../server/work-partition.ts';
import {normalizeTbank} from '../server/banking/adapters.ts';
import {emptyBanking} from '../server/banking/domain.ts';
import {fixtureConfig,fixtureDay,accountNumber,tbankRow} from '../tests/banking-fixtures.ts';
const output=resolve(process.argv[2]??'qa/trips-performance.json'), rounds=Number(process.env.ROUNDS??10);
const f=await integrationRuntime(), report={synthetic:true,externalCalls:0,rounds,samples:[]};
const deny=async()=>{report.externalCalls++;throw Error('No external calls');};
try {
 await f.store.mutate(f.source,d=>{
  d.banking=emptyBanking(); const c=fixtureConfig();d.banking.operations=Array.from({length:3500},(_,i)=>normalizeTbank(c,{number:accountNumber,currency:'RUB'},fixtureDay,tbankRow(`perf-${i}`)));
  const rows=Object.values(d.shipments);for(let i=0;i<89;i++)for(const [j,r] of rows.entries()) d.shipments[`shipment-local-perf-${i}-${j}`]={...structuredClone(r),fields:{...r.fields,trip_id:`shipment-trip-abcdef-${i}`}};
  for(const a of d.directories.addresses){a.latitude='55.7';a.longitude='37.6';}return{changed:true,result:null};
 });
 const {currentSnapshot}=await import('../server/shipment-operations.ts');currentSnapshot(f.base,await f.store.read(f.source));
 const api=createSnapshotMiddleware(f.snapshotDirectory,{operationsStore:f.store,tripRequestGeocoder:deny,sabyWorkflowMonitoringEnabled:false,bankEnvironment:{ARTEL_BANK_REQUESTS_ENABLED:'false',ARTEL_BANK_SYNC_ENABLED:'false'},bankRequest:deny,sberRequest:deny,fetcher:deny,pushSender:deny,pushConfig:{publicKey:'',privateKey:'',subject:'',schedule:false}});
 const server=createServer((q,s)=>api(q,s,()=>{s.writeHead(404);s.end()}));await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}`;
 try {
 const setup=await fetch(url+'/api/auth/setup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'Synthetic',login:'qa.perf',password:randomUUID()})});assert.ok(setup.ok,await setup.text());const cookie=setup.headers.get('set-cookie').split(';')[0];await migrateWorkStorage(dirname(f.store.path),f.source);
 report.coreBytes=(await stat(resolve(dirname(f.store.path),'work-storage/core/operations.json'))).size;
 const originalRead=f.store.read.bind(f.store),originalMutate=f.store.mutate.bind(f.store);let trace;
 f.store.read=async(...a)=>{const t=performance.now();const r=await originalRead(...a);if(trace){trace.reads++;trace.readMs+=performance.now()-t;}return r;};
 const mutationMethod=f.store.mutateTripRequests?'mutateTripRequests':'mutate';
 const originalRequestMutate=f.store[mutationMethod].bind(f.store);
 f.store[mutationMethod]=async(source,fn)=>{const t=performance.now();let called,ended;const r=await originalRequestMutate(source,async d=>{called=performance.now();const result=await fn(d);ended=performance.now();return result;});if(trace){trace.admissionLoadMs=called-t;trace.callbackMs=ended-called;trace.commitMs=performance.now()-ended;}return r;};
 const call=async(path,method='GET',body)=>{const t=performance.now();trace={reads:0,readMs:0};const r=await fetch(url+path,{method,headers:{Cookie:cookie,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const data=await r.json();assert.ok(r.ok,JSON.stringify(data));const metrics={...trace,ms:performance.now()-t};trace=null;return{data,metrics};};
 const protectedBefore=JSON.stringify((await originalRead(f.source)).banking.operations.slice(1));
 for(const load of ['idle','six-background-writes'])for(let i=0;i<rounds;i++){
  const run=async(name,path,method,body)=>{const t=performance.now();const jobs=load==='idle'?[]:Array.from({length:6},(_,j)=>originalMutate(f.source,d=>{d.banking.operations[0].updatedAt=new Date(Date.now()+j).toISOString();return{changed:true,result:null}}));const r=await call(path,method,body);await Promise.all(jobs);report.samples.push({load,name,round:i,...r.metrics,batchMs:performance.now()-t});return r.data;};
  const r=(await run('create','/api/trip-requests','POST',{companyId:'customer',addressId:'delivery',quantityLitres:'1000',executionDate:'2026-10-29',comment:'Synthetic',idempotencyKey:randomUUID()})).request;
  await run('list','/api/trip-requests');
  await run('delete',`/api/trip-requests/${r.id}`,'DELETE',{version:r.version});
 }
 assert.equal(JSON.stringify((await originalRead(f.source)).banking.operations.slice(1)),protectedBefore);assert.equal(report.externalCalls,0);
 const pct=(a,p)=>a.sort((a,b)=>a-b)[Math.ceil(a.length*p)-1];report.summary=[];
 for(const load of ['idle','six-background-writes'])for(const name of ['create','list','delete']){const a=report.samples.filter(s=>s.load===load&&s.name===name);report.summary.push({load,name,count:a.length,medianMs:pct(a.map(s=>s.ms),.5),p95Ms:pct(a.map(s=>s.ms),.95),reads:a[0].reads,medianCallbackMs:pct(a.map(s=>s.callbackMs??0),.5),medianCommitMs:pct(a.map(s=>s.commitMs??0),.5)});}
 report.passed=true;await writeFile(output,JSON.stringify(report,null,2));console.log(JSON.stringify(report.summary,null,2));
 }finally{await new Promise(r=>server.close(r))}
}finally{await f.close()}
