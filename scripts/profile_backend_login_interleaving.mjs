// Isolated deterministic interleaving probe. Only synthetic stores and loopback HTTP.
import assert from 'node:assert/strict';
import crypto, {createHash,scryptSync} from 'node:crypto';
import {syncBuiltinESMExports} from 'node:module';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {createServer} from 'node:http';
const digest=value=>createHash('sha256').update(value).digest('hex'), password='Synthetic-interleaving-password',salt='c'.repeat(32),passwordHash=scryptSync(password,salt,64).toString('hex');
const original=crypto.scrypt;let holding=false,pending=[],derivations=0,waiters=[];
crypto.scrypt=(...args)=>{derivations++;if(!holding)return Reflect.apply(original,crypto,args);pending.push(()=>Reflect.apply(original,crypto,args));for(const waiter of waiters)waiter();};syncBuiltinESMExports();
const {createSnapshotMiddleware,loadSnapshot}=await import('../server/local-api.ts');
const {OperationsStore}=await import('../server/operations-store.ts');
const {emptyDirectories}=await import('../server/directory-operations.ts');
const {prepareLogin}=await import('../server/auth.ts');
const {writeTripsQaSnapshot}=await import('./qa-trips-runtime.mjs');
for(const key of Object.keys(process.env))if(/^(ARTEL_|SABY_|SBER_|BANK_|VAPID_|PUSH_|CHECKO_|CRON_|BLOB_|VERCEL_)/.test(key))delete process.env[key];
const temporary=await mkdtemp(resolve(tmpdir(),'artel-login-interleaving-')),snapshotDir=resolve(temporary,'snapshot'),store=new OperationsStore(resolve(temporary,'store'));
await writeTripsQaSnapshot(snapshotDir);const base=await loadSnapshot(snapshotDir),source=base.provenance.sourceSha256;
const instant='2026-10-28T00:00:00.000Z',token=digest('synthetic-owner-session');
const owner={id:'owner',name:'Synthetic Owner',login:'owner.user',role:'director',managerId:null,active:true,version:1,salt,passwordHash};
const target={...owner,id:'target',name:'Synthetic Target',login:'target.user',role:'employee',managerId:'manager',sections:['work','trips']};
const task={id:'task',version:1,assigneeId:owner.id,createdBy:owner.id,updatedBy:owner.id,createdAt:instant,updatedAt:instant,title:'Synthetic Task',description:'',status:'todo',companyId:null,dueDate:null,reminderAt:null};
const reset=async(driver=false)=>store.mutate(source,data=>{data.sourceOperationsCleared=true;data.accounts={users:[structuredClone(owner),driver?{...target,role:'driver',managerId:null,driverId:'driver',sections:[]}:structuredClone(target)],sessions:[{userId:owner.id,hash:digest(token),expiresAt:4102444800000}],attempts:{}};data.directories={...emptyDirectories(),fleetSeedApplied:true,managers:[{id:'manager',name:'Synthetic Manager'}],vehicles:[{id:'vehicle',plate:'Т000ЕЕ00'}],drivers:[{id:'driver',name:'Synthetic Driver',vehicleId:'vehicle'},{id:'driver-two',name:'Other Driver',vehicleId:'vehicle'}]};data.work={tasks:[structuredClone(task)],companyRecords:[],notes:[]};return{changed:true,result:null};});
const blocked=async()=>{throw new Error('No external provider allowed')};
const middleware=createSnapshotMiddleware(snapshotDir,{operationsStore:store,operationsDirectory:resolve(temporary,'store'),bankEnvironment:{ARTEL_BANK_REQUESTS_ENABLED:'false',ARTEL_BANK_SYNC_ENABLED:'false'},cabinetEnvironment:{},geocoderEnvironment:{},bankRequest:blocked,sberRequest:blocked,fetcher:blocked,pushConfig:{publicKey:'',privateKey:'',subject:'',schedule:false},sabyWorkflowMonitoringEnabled:false});
const server=createServer((req,res)=>middleware(req,res,()=>{res.writeHead(404);res.end()}));await new Promise(done=>server.listen(0,'127.0.0.1',done));const url=`http://127.0.0.1:${server.address().port}`;
const call=(path,method='GET',body)=>fetch(url+path,{method,signal:AbortSignal.timeout(5000),headers:{cookie:`artel_session=${token}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
const login=(name='target.user',candidate=password,logistics=false)=>call(logistics?'/api/logistics/auth/login':'/api/auth/login','POST',{login:name,password:candidate});
const waitPending=async(count)=>{if(pending.length>=count)return;await new Promise((done,reject)=>{const timer=setTimeout(()=>reject(new Error('KDF did not reach barrier')),4000);const check=()=>{if(pending.length>=count){clearTimeout(timer);waiters=waiters.filter(w=>w!==check);done();}};waiters.push(check);check();});};
const release=()=>{holding=false;const jobs=pending.splice(0);jobs.forEach(run=>run());};
const checks=[];
try{
 await reset();holding=true;const pendingLogins=Array.from({length:4},()=>login('target.user','wrong'));await waitPending(4);
 const before=performance.now();const work=await call('/api/work/tasks/task','PATCH',{version:1,status:'done'});assert.equal(work.status,200);const workMs=performance.now()-before;assert.equal(pending.length,4,'Work must finish while all KDFs remain held');
 assert.equal((await call('/api/auth/session')).status,200);assert.equal((await login('overflow.user')).status,429);assert.equal(pending.length,4);release();assert.deepEqual((await Promise.all(pendingLogins)).map(r=>r.status),[401,401,401,401]);
 let fresh=await store.read(source);assert.equal(fresh.accounts.attempts[digest('artel:auth:user:target.user')].count,4);assert.equal(fresh.work.tasks[0].status,'done');checks.push('held KDFs do not hold Work mutation; four-login gate retained');
 const next=await Promise.all([login('target.user','wrong'),login('target.user','wrong')]);assert.deepEqual(next.map(r=>r.status).sort(),[401,429]);fresh=await store.read(source);assert.equal(fresh.accounts.attempts[digest('artel:auth:user:target.user')].count,5);assert.equal((await login()).status,429);checks.push('parallel failed attempts serialize to5 and fresh limit blocks correct password');
 const mutations={password:row=>{row.passwordHash='0'.repeat(128)},salt:row=>{row.salt='d'.repeat(32)},version:row=>{row.version++},role:row=>{row.role='manager'},login:row=>{row.login='renamed.user'},id:row=>{row.id='replacement-target'},active:row=>{row.active=false},deleted:row=>{row.active=false;row.deletedAt=instant;row.deletedBy='owner'},sections:row=>{row.sections=[]}};
 for(const [name,mutate] of Object.entries(mutations)){await reset();holding=true;const attempt=login();await waitPending(1);await store.mutate(source,data=>{mutate(data.accounts.users[1]);return{changed:true,result:null};});release();const response=await attempt;assert.equal(response.status,401,name);assert.equal(response.headers.get('set-cookie'),null,name);assert.equal((await store.read(source)).accounts.sessions.length,1,name);checks.push(`fresh ${name} revocation rejects stale proof`);}
 for(const name of ['driver-binding','driver-archived']){await reset(true);holding=true;const attempt=login('target.user',password,true);await waitPending(1);await store.mutate(source,data=>{if(name==='driver-binding')data.accounts.users[1].driverId='driver-two';else data.directories.deletedEntries={drivers:['driver']};return{changed:true,result:null};});release();assert.equal((await attempt).status,401,name);assert.equal((await store.read(source)).accounts.sessions.length,1);checks.push(name+' checked fresh');}
 await reset();holding=true;const attempt=login();await waitPending(1);await store.mutate(source,data=>{data.accounts.attempts[digest('artel:auth:user:target.user')]={count:5,until:Date.now()+900000};return{changed:true,result:null};});release();assert.equal((await attempt).status,429);checks.push('attempt limit committed during derivation takes precedence');
 await reset();holding=true;const newlyCreated=login('new.user');await waitPending(1);await store.mutate(source,data=>{data.accounts.users.push({...target,id:'new-target',login:'new.user'});return{changed:true,result:null};});release();assert.equal((await newlyCreated).status,401);assert.equal((await store.read(source)).accounts.sessions.length,1);checks.push('unknown-to-created transition cannot adopt a dummy derivation');
 await reset();await store.mutate(source,data=>{data.accounts.users[1].sections=[];return{changed:true,result:null};});assert.equal((await login('target.user',password,true)).status,403);checks.push('logistics audience access rechecked at completion');
 await reset();for(const name of ['target.user','unknown.user']){const count=derivations;await login(name,'wrong');assert.equal(derivations-count,1);}checks.push('known and unknown HTTP credentials each perform exactly one KDF');
 await reset();const data=await store.read(source),finish=await prepareLogin(data,{login:'target.user',password});const abandoned=structuredClone(data),retry=structuredClone(data);assert.equal(finish(abandoned).status,200);assert.equal(finish(retry).status,200);assert.equal(retry.accounts.sessions.length,2);const revokedRetry=structuredClone(data);revokedRetry.accounts.users[1].role='manager';assert.equal(finish(revokedRetry).status,401);assert.equal(revokedRetry.accounts.sessions.length,1);checks.push('CAS callback retry discards abandoned session and checks identity anew');
 console.log(JSON.stringify({passed:true,syntheticOnly:true,workPatchWhileFourKdfsHeldMs:workMs,checks,derivations}));
}finally{release();server.closeAllConnections();await new Promise(done=>server.close(done));crypto.scrypt=original;syncBuiltinESMExports();await rm(temporary,{recursive:true,force:true});}
