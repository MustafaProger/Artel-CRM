// Synthetic loopback HTTP measurements. Never opens production data or contacts providers.
// Usage: ROUNDS=10 SOURCE_ROOT=/path/to/source node --import tsx scripts/profile-auth-performance.mjs report.json
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {syncBuiltinESMExports} from 'node:module';
import {AsyncLocalStorage} from 'node:async_hooks';
import {createServer} from 'node:http';
import {readFile,writeFile,stat,mkdir} from 'node:fs/promises';
import {resolve,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
const root=resolve(process.env.SOURCE_ROOT??resolve(dirname(fileURLToPath(import.meta.url)),'..'));
const output=resolve(process.argv[2]??'auth-performance.json'),rounds=Number(process.env.ROUNDS??10);
assert.ok(Number.isSafeInteger(rounds)&&rounds>0&&rounds<=100);
for(const key of Object.keys(process.env))if(/^(ARTEL_|SABY_|SBER_|BANK_|VAPID_|PUSH_|CHECKO_|CRON_|BLOB_|VERCEL_)/.test(key))delete process.env[key];
const scope=new AsyncLocalStorage(),originalScrypt=crypto.scrypt;
crypto.scrypt=(...args)=>{const trace=scope.getStore(),start=performance.now(),callback=args.pop();return Reflect.apply(originalScrypt,crypto,[...args,(...result)=>{if(trace){trace.kdfCount++;trace.kdfMs+=performance.now()-start;}callback(...result);}]);};syncBuiltinESMExports();
const moduleAt=path=>import(pathToFileURL(resolve(root,path)).href);
const [{integrationRuntime},{createSnapshotMiddleware},{OperationsStore},{migrateWorkStorage},{normalizeTbank},{emptyBanking},fixtures,{passwordFields},{syncInvoiceEvents}]=await Promise.all([
 moduleAt('tests/helpers/trip-saby-integration.ts'),moduleAt('server/local-api.ts'),moduleAt('server/operations-store.ts'),moduleAt('server/work-partition.ts'),moduleAt('server/banking/adapters.ts'),moduleAt('server/banking/domain.ts'),moduleAt('tests/banking-fixtures.ts'),moduleAt('server/auth.ts'),moduleAt('server/invoice-bridge.ts'),
]);
const harnessSha256=crypto.createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex');
const f=await integrationRuntime(),password='Synthetic-auth-performance-password-only',loginName='qa.auth.perf';
const report={syntheticOnly:true,sourceRoot:root,harnessSha256,rounds,externalCalls:0,coreLoad:'3500 synthetic bank operations and 180 synthetic shipment records',backgroundModel:'6 concurrent full-core bank metadata writes; models common queue contention, not provider network time or complete bank/Saby jobs',samples:[],workerSamples:[],coldSamples:[]};
const deny=async()=>{report.externalCalls++;throw Error('External providers disabled');};
const emptyTrace=()=>({reads:[],mutations:[],kdfCount:0,kdfMs:0});
const percentile=(a,p)=>[...a].sort((a,b)=>a-b)[Math.ceil(a.length*p)-1];
const save=async()=>{await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2));};
let server;
try{
 const credentials=await passwordFields(password);
 await f.store.mutate(f.source,d=>{
  d.accounts={users:[{id:'synthetic-auth-user',name:'Synthetic auth user',login:loginName,role:'director',managerId:null,active:true,version:1,...credentials}],sessions:[],attempts:{}};
  d.banking=emptyBanking();const c=fixtures.fixtureConfig();d.banking.operations=Array.from({length:3500},(_,i)=>normalizeTbank(c,{number:fixtures.accountNumber,currency:'RUB'},fixtures.fixtureDay,fixtures.tbankRow(`auth-perf-${i}`)));
  const rows=Object.values(d.shipments);for(let i=0;i<89;i++)for(const [j,r] of rows.entries())d.shipments[`shipment-local-auth-${i}-${j}`]={...structuredClone(r),fields:{...r.fields,trip_id:`shipment-trip-abcdef-${i}`}};
  return{changed:true,result:null};
 });
 await migrateWorkStorage(dirname(f.store.path),f.source);
 report.coreBytes=(await stat(resolve(dirname(f.store.path),'work-storage/core/operations.json'))).size;
 const store=new OperationsStore(dirname(f.store.path));
 const originalRead=store.read.bind(store),originalMutate=store.mutate.bind(store);
 for(const name of ['read','readAuth','readSession','readAuthContext'])if(typeof store[name]==='function'){
  const original=store[name].bind(store);store[name]=async(...a)=>{const trace=scope.getStore(),start=performance.now();try{return await original(...a);}finally{if(trace)trace.reads.push({method:name,ms:performance.now()-start});}};
 }
 for(const name of ['mutate','mutateAuth','mutateAuthentication'])if(typeof store[name]==='function'){
  const original=store[name].bind(store);store[name]=async(source,update)=>{const trace=scope.getStore(),start=performance.now();let entered,finished;try{return await original(source,async d=>{entered=performance.now();try{return await update(d);}finally{finished=performance.now();}});}finally{if(trace)trace.mutations.push({method:name,admissionLoadMs:entered===undefined?null:entered-start,callbackMs:finished===undefined?null:finished-entered,commitMs:finished===undefined?null:performance.now()-finished,totalMs:performance.now()-start});}};
 }
 const traces=new Map();let sequence=0;
 const api=createSnapshotMiddleware(f.snapshotDirectory,{operationsStore:store,operationsDirectory:dirname(f.store.path),sabyWorkflowMonitoringEnabled:false,cabinetEnvironment:{},geocoderEnvironment:{},bankEnvironment:{ARTEL_BANK_REQUESTS_ENABLED:'false',ARTEL_BANK_SYNC_ENABLED:'false'},bankRequest:deny,sberRequest:deny,fetcher:deny,pushSender:deny,tripRequestGeocoder:deny,pushConfig:{publicKey:'',privateKey:'',subject:'',schedule:false}});
 server=createServer((req,res)=>{const trace=emptyTrace();trace.serverStart=performance.now();res.on('finish',()=>{trace.serverMs=performance.now()-trace.serverStart;delete trace.serverStart;});traces.set(req.headers['x-synthetic-trace'],trace);scope.run(trace,()=>api(req,res,()=>{res.writeHead(404);res.end()}));});
 await new Promise(done=>server.listen(0,'127.0.0.1',done));const origin=`http://127.0.0.1:${server.address().port}`;
 let cookie='';
 const call=async(path,method='GET',body,expected=200)=>{
  const key=String(++sequence),start=performance.now();const response=await fetch(origin+path,{method,signal:AbortSignal.timeout(20000),headers:{cookie,'Content-Type':'application/json','x-synthetic-trace':key},...(body?{body:JSON.stringify(body)}:{})});const data=await response.json();
  assert.equal(response.status,expected,JSON.stringify(data));const setCookie=response.headers.get('set-cookie');if(setCookie)cookie=setCookie.split(';')[0];
  const metrics={httpMs:performance.now()-start,...traces.get(key)};traces.delete(key);return{data,metrics};
 };
 const coldLogin=await call('/api/auth/login','POST',{login:loginName,password});report.coldSamples.push({name:'first-login-after-new-store-and-new-HTTP-runtime',...coldLogin.metrics});
 const coldSession=await call('/api/auth/session');assert.equal(coldSession.data.user.id,'synthetic-auth-user');report.coldSamples.push({name:'first-session-read-after-login',...coldSession.metrics});
 await call('/api/auth/logout','POST',{});
 const protectedBefore=JSON.stringify((await originalRead(f.source)).banking.operations.map(({updatedAt,...business})=>business));
 const bridgeCalls=[];
 const bridge={service:async(path,body)=>{bridgeCalls.push({path,at:performance.now(),sessionHash:body?.sessionHash});if(path==='/internal/crm/sessions/revoke')return{ok:true};assert.equal(path,'/internal/crm/events');return{events:[],hasMore:false};}};
 const propagate=async()=>{const start=performance.now(),trace=emptyTrace(),pending=Object.keys((await originalRead(f.source)).push?.invoiceRevocations??{});await scope.run(trace,()=>syncInvoiceEvents(bridge,store,f.source));const fresh=await originalRead(f.source);assert.equal(Object.keys(fresh.push?.invoiceRevocations??{}).length,0);for(const hash of pending)assert.ok(bridgeCalls.some(c=>c.sessionHash===hash));return{dispatchAndCleanupMs:performance.now()-start,revocations:pending.length,...trace};};
 await propagate();
 // Warm preparation is excluded from controlled samples. The two explicit cold rows remain separately reported.
 for(const load of ['idle','six-background-writes'])for(let round=0;round<rounds;round++){
  const run=async(name,path,method='GET',body)=>{
   const start=performance.now();
   const jobs=load==='idle'?[]:Array.from({length:6},(_,j)=>originalMutate(f.source,d=>{d.banking.operations[0].updatedAt=new Date(Date.now()+j).toISOString();return{changed:true,result:null};}));
   const result=await call(path,method,body);await Promise.all(jobs);report.samples.push({load,name,round,...result.metrics,batchMs:performance.now()-start});return result;
  };
  const login=await run('login','/api/auth/login','POST',{login:loginName,password});assert.equal(login.data.user.id,'synthetic-auth-user');
  const session=await run('session','/api/auth/session');assert.equal(session.data.user.id,'synthetic-auth-user');
  const oldCookie=cookie;await run('logout','/api/auth/logout','POST',{});cookie=oldCookie;
  const denied=await call('/api/work','GET',undefined,401);assert.equal(denied.data.user,undefined);
  cookie='';
  report.workerSamples.push({load,round,...await propagate()});
  await save();
 }
 assert.equal(JSON.stringify((await originalRead(f.source)).banking.operations.map(({updatedAt,...business})=>business)),protectedBefore);assert.equal(report.externalCalls,0);
 report.summary=[];
 for(const load of ['idle','six-background-writes'])for(const name of ['login','session','logout']){
  const rows=report.samples.filter(s=>s.load===load&&s.name===name),values=key=>rows.map(s=>s[key]);
  report.summary.push({load,name,count:rows.length,medianHttpMs:percentile(values('httpMs'),.5),p95HttpMs:percentile(values('httpMs'),.95),medianServerMs:percentile(values('serverMs'),.5),medianKdfMs:percentile(values('kdfMs'),.5),medianReadMs:percentile(rows.map(s=>s.reads.reduce((sum,r)=>sum+r.ms,0)),.5),medianAdmissionLoadMs:percentile(rows.map(s=>s.mutations.reduce((sum,r)=>sum+(r.admissionLoadMs??0),0)),.5),medianCommitMs:percentile(rows.map(s=>s.mutations.reduce((sum,r)=>sum+(r.commitMs??0),0)),.5),medianBatchMs:percentile(values('batchMs'),.5),readMethods:[...new Set(rows.flatMap(s=>s.reads.map(r=>r.method)))],mutationMethods:[...new Set(rows.flatMap(s=>s.mutations.map(r=>r.method)))]});
 }
 report.workerStub={calls:bridgeCalls.length,revocations:bridgeCalls.filter(c=>c.path==='/internal/crm/sessions/revoke').length,medianDispatchAndCleanupMs:percentile(report.workerSamples.map(s=>s.dispatchAndCleanupMs),.5),productionPollingIntervalNotMeasured:true};
 report.passed=true;await save();console.log(JSON.stringify({coreBytes:report.coreBytes,coldSamples:report.coldSamples,summary:report.summary,workerStub:report.workerStub},null,2));
}finally{if(server){server.closeAllConnections();await new Promise(done=>server.close(done));}await f.close();crypto.scrypt=originalScrypt;syncBuiltinESMExports();}
