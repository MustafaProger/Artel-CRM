import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { OperationsStore } from '../server/operations-store';
import { migrateArchiveStorage } from '../server/auth-partition';
import { passwordFields } from '../server/auth';
import { createSnapshotMiddleware } from '../server/local-api';
import { withPerformanceTrace, type PerformanceTrace } from '../server/performance-trace';

// PRIVATE COPY ONLY. No provider services, real credentials, or external fetch.
const input = process.argv[2], output = process.argv[3];
assert.ok(input && output);
const root = await mkdtemp(resolve(tmpdir(), 'artel-phase-profile-'));
const traces: (PerformanceTrace & {scenario: string})[] = [];
let scenario = 'setup', external = 0;
const sink = (trace: PerformanceTrace) => traces.push({...trace, scenario});
const oldFetch = globalThis.fetch;
globalThis.fetch = async () => { external++; throw Error('External fetch forbidden'); };
await cp(resolve(input,'operations'), resolve(root,'operations'), {recursive:true});
const store = new OperationsStore(resolve(root,'operations'));
const pointer = JSON.parse(await readFile(store.path,'utf8'));
const source = pointer.sourceSha256;
const fields = await passwordFields('Synthetic-profile-password');
await store.mutateAuth(source, data => {
  data.accounts = {users:[{...fields,id:'profile-owner',name:'Synthetic profile',login:'profile-owner',role:'director',managerId:null,active:true,version:1}],sessions:[],attempts:{}};
  return {changed:true,result:null};
});
if (process.argv[4] === '--archive') await migrateArchiveStorage(resolve(root,'operations'),source);
const middleware = createSnapshotMiddleware(resolve(input,'snapshot'), {operationsStore:store,performanceSink:sink,secureCookies:false});
const server = createServer((req,res)=>middleware(req,res,()=>{res.writeHead(404);res.end();}));
await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
const address=server.address(); assert.ok(address && typeof address==='object');
const call=(path:string,method:string,body?:unknown,cookie?:string):Promise<{status:number;cookie?:string;ms:number;digest:string}>=>new Promise((accept,reject)=>{
  const start=performance.now(),payload=body===undefined?undefined:JSON.stringify(body);
  const req=request({host:'127.0.0.1',port:address.port,path,method,headers:{'content-type':'application/json',...(payload?{'content-length':Buffer.byteLength(payload)}:{}),...(cookie?{cookie}:{})}},res=>{
    const hash=createHash('sha256');res.on('data',chunk=>hash.update(chunk));res.on('end',()=>accept({status:res.statusCode!,cookie:res.headers['set-cookie']?.[0]?.split(';')[0],ms:performance.now()-start,digest:hash.digest('hex')}));res.on('error',reject);
  });req.on('error',reject);req.end(payload);
});
const samples:unknown[]=[];
try {
  await call('/api/auth/session','GET');
  for (scenario of ['quiet','mixed']) {
    for(let round=0;round<8;round++) {
      // Two full-domain operations overlap the auth request, reproducing the
      // scheduler's bounded admission; change only the COPY's revision.
      const background = scenario==='mixed' ? Promise.all([withPerformanceTrace('background-write',()=>store.mutate(source,()=>({changed:true,result:null})),sink),withPerformanceTrace('background-read',()=>store.read(source),sink)]) : Promise.resolve();
      const login=await call('/api/auth/login','POST',{login:'profile-owner',password:'Synthetic-profile-password'});
      assert.equal(login.status,200);assert.ok(login.cookie);
      try {
        const ready=await call('/api/settlements','GET',undefined,login.cookie);assert.equal(ready.status,200);
        await background;
        const logoutBackground=scenario==='mixed'?withPerformanceTrace('background-write',()=>store.mutate(source,()=>({changed:true,result:null})),sink):Promise.resolve();
        const logout=await call('/api/auth/logout','POST',{},login.cookie);assert.equal(logout.status,200);
        await logoutBackground;
        assert.equal((await call('/api/auth/session','GET',undefined,login.cookie)).status,200);
        samples.push({scenario,round,loginMs:login.ms,settlementsMs:ready.ms,settlementsDigest:ready.digest,logoutMs:logout.ms});
      } finally { await call('/api/auth/logout','POST',{},login.cookie); }
    }
  }
  assert.equal(external,0);
  const domains=JSON.parse(await readFile(resolve(input,'operations/auth-storage/core.json'),'utf8')).data;
  const domainBytes=Object.fromEntries(Object.entries(domains).map(([key,value])=>[key,Buffer.byteLength(JSON.stringify(value))]));
  await writeFile(output,JSON.stringify({passed:true,external,domainBytes,samples,traces,memory:process.memoryUsage()},null,2),{mode:0o600});
  console.log(JSON.stringify({passed:true,external,samples,traces:traces.length}));
} finally {
  server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));
  globalThis.fetch=oldFetch;await rm(root,{recursive:true,force:true});
}
