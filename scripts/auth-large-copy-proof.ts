// Isolated Linux memory/correctness exercise. Inputs are a PRIVATE COPY only.
// The live business/document payload stays exact; accounts are replaced with a
// synthetic identity BEFORE the temporary store starts. No real credentials.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { request } from 'node:http';
import { OperationsStore, encodeOperations, type OperationsData } from '../server/operations-store';
import { migrateAuthStorage } from '../server/auth-partition';
import { passwordFields } from '../server/auth';
const input = process.env.ARTEL_LARGE_COPY_INPUT;
assert.equal(input, '/compat/operations.json', 'Only the isolated read-only copy mount is accepted');
const raw = await readFile(input);
const before = JSON.parse(raw.toString()).data as OperationsData;
const password = randomUUID(), id = 'synthetic-memory-director';
before.accounts = { users: [{ id, name: 'Synthetic memory director', login: 'synthetic-memory', role: 'director', managerId: null, active: true, version: 1, ...await passwordFields(password, undefined) }], sessions: [], attempts: {} };
const root = await mkdtemp(resolve(tmpdir(), 'artel-large-copy-'));
const directory = resolve(root, 'operations');await mkdir(directory);
await writeFile(resolve(directory, 'operations.json'), encodeOperations(before, before.sourceSha256));
const source = before.sourceSha256, origin = 'https://memory.example.test';
const bundle = '/app/server-render/production.mjs';
const { createProductionRuntime } = await import(bundle);
let runtime: Awaited<ReturnType<typeof createProductionRuntime>> | undefined;
let external = 0;const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { external++;throw new Error('External request forbidden in private copy exercise'); };
const durations: Record<string,number> = {};
const timed = async <T>(name:string, run:()=>Promise<T>):Promise<T> => { const start=performance.now();const result=await run();durations[name]=performance.now()-start;return result; };
const call = (path:string,method:string,body?:unknown,cookie?:string):Promise<{status:number;cookie?:string}> => new Promise((accept,reject)=>{
  const payload=body===undefined?undefined:JSON.stringify(body);
  const req=request({hostname:'127.0.0.1',port:runtime!.server.address().port,path,method,headers:{host:'memory.example.test',origin,'content-type':'application/json',...(payload?{'content-length':Buffer.byteLength(payload)}:{}),...(cookie?{cookie}:{})}}, response=>{
    response.resume();response.once('end',()=>accept({status:response.statusCode!,cookie:response.headers['set-cookie']?.[0]?.split(';')[0]}));response.once('error',reject);
  });req.once('error',reject);req.end(payload);
});
try {
  await timed('migrationMs',()=>migrateAuthStorage(directory,source));
  const store=new OperationsStore(directory);assert.deepEqual(await store.read(source),before);
  runtime=await createProductionRuntime({ARTEL_PUBLIC_ORIGIN:origin,ARTEL_STORE_DIR:directory,ARTEL_SNAPSHOT_DIR:'/compat/snapshot',PORT:'0',ARTEL_BANK_REQUESTS_ENABLED:'false',ARTEL_BANK_SYNC_ENABLED:'false',ARTEL_CABINET_SYNC_ENABLED:'false',ARTEL_GEOCODER_ENABLED:'false',SABY_WORKFLOW_ENABLED:'false',PUSH_SCHEDULE_ENABLED:'false'});
  await runtime.start();
  const login=await timed('httpLoginMs',()=>call('/api/auth/login','POST',{login:'synthetic-memory',password}));assert.equal(login.status,200);assert.ok(login.cookie);
  assert.equal((await timed('fullAuthenticatedReadMs',()=>call('/api/settlements','GET',undefined,login.cookie))).status,200);
  assert.equal((await timed('httpLogoutMs',()=>call('/api/auth/logout','POST',{},login.cookie))).status,200);
  assert.equal((await call('/api/settlements','GET',undefined,login.cookie)).status,401);
  await runtime.stop();runtime=undefined;
  const ownHash=createHash('sha256').update(login.cookie.split('=')[1]).digest('hex');
  const afterLogout=await store.read(source);assert.equal(afterLogout.accounts!.sessions.length,0);assert.ok(afterLogout.push?.invoiceRevocations?.[ownHash]);
  const expected=structuredClone(before);
  expected.push ??= {devices:[],deliveries:{}};expected.push.invoiceRevocations ??= {};
  expected.push.invoiceRevocations[ownHash]=afterLogout.push!.invoiceRevocations![ownHash];
  expected.revision=afterLogout.revision;assert.deepEqual(afterLogout,expected);
  const note={id:randomUUID(),title:'Synthetic memory exercise',content:'Synthetic private copy only',assigneeId:id,createdBy:id,updatedBy:id,createdAt:'2026-11-09T00:00:00Z',updatedAt:'2026-11-09T00:00:00Z',version:1};
  await timed('mixedAuthWorkWalMs',()=>store.mutate(source,data=>{
    data.accounts!.users[0].version++;data.work ??= {tasks:[],companyRecords:[],notes:[]};data.work.notes.push(note);return {changed:true,result:null};
  }));
  expected.accounts!.users[0].version++;expected.work ??= {tasks:[],companyRecords:[],notes:[]};expected.work.notes.push(note);
  const after=await timed('fullReadMs',()=>new OperationsStore(directory).read(source));expected.revision=after.revision;assert.deepEqual(after,expected);
  assert.equal(external,0);
  const cgroup:Record<string,string|null>={};for(const key of ['memory.current','memory.peak','memory.max','memory.events']){try{cgroup[key]=(await readFile('/sys/fs/cgroup/'+key,'utf8')).trim()}catch{cgroup[key]=null}}
  assert.ok(cgroup['memory.events']?.includes('oom_kill 0'));assert.ok(cgroup['memory.events']?.includes('oom 0'));
  console.log(JSON.stringify({passed:true,modifiedPrivateCopy:true,productionMountsUsed:false,initialReplacement:'accounts only with synthetic identity',sourceBytes:raw.length,documentArchiveBytes:Buffer.byteLength(JSON.stringify(before.documentArchive??null)),fullDataExactExceptExplicitSyntheticChanges:true,mixedAuthWorkWalVerified:true,serverLogout401:true,externalRequests:external,durations,cgroup}));
}finally{await runtime?.stop();globalThis.fetch=originalFetch;await rm(root,{recursive:true,force:true});}
