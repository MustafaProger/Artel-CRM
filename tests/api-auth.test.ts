import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { createSnapshotMiddleware, loadSnapshot } from '../server/local-api';
import { OperationsStore } from '../server/operations-store';
import { BlobOperationsStore } from '../server/blob-operations-store';
import { clearOperations } from '../server/reset-operations';
import { sameOrigin } from '../server/cloud-auth';
import { scopeSnapshot } from '../server/auth-scope';
import { encodeOperations } from '../server/operations-store';
import type { AccountUser } from '../web/src/auth-model';

async function runtime(cloud=false){
  const directory=await mkdtemp(resolve(tmpdir(),'artel-auth-'));
  const middleware=createSnapshotMiddleware(resolve('data/local-xlsx-final'),{operationsDirectory:directory,...(cloud?{authorizeRequest:request=>sameOrigin({method:request.method,headers:{...request.headers,host:'crm.example'}}),secureCookies:true,setupToken:'test-only-cloud-setup'}:{})});
  const server=createServer((req,res)=>middleware(req,res,()=>{res.writeHead(404);res.end();}));
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
  const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request=async(path:string,method='GET',body?:unknown,cookie?:string)=>{
    const r=await fetch(url+path,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),...(cloud?{host:'crm.example',origin:'https://crm.example'}:{}),...(cookie?{cookie}:{})},...(body?{body:JSON.stringify(body)}:{})});
    return {status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')};
  };
  return {directory,request,store:new OperationsStore(directory),close:async()=>{await new Promise<void>(done=>server.close(()=>done()));await rm(directory,{recursive:true,force:true});}};
}

test('login uses server sessions; credentials never returned; logout, password changes, last director and brute-force limits enforced',async()=>{
  const r=await runtime();try{
    assert.equal((await r.request('/api/snapshot')).status,401);
    assert.equal((await r.request('/api/auth/session')).body.needsSetup,true);
    const password=randomBytes(20).toString('hex');
    const setup=await r.request('/api/auth/setup','POST',{name:'Директор',login:'owner',password});
    assert.equal(setup.status,200);assert.ok(setup.cookie?.includes('HttpOnly'));assert.ok(setup.cookie?.includes('SameSite=Strict'));
    assert.ok(!JSON.stringify(setup.body).includes(password));assert.ok(!JSON.stringify(setup.body).includes('passwordHash'));assert.ok(!('token' in setup.body));
    const cookie=setup.cookie!.split(';')[0];
    assert.equal((await r.request('/api/auth/setup','POST',{name:'Other',login:'other',password})).status,409);
    const user=setup.body.user;
    assert.equal((await r.request(`/api/auth/users/${user.id}`,'PATCH',{...user,active:false},cookie)).status,400); // unknown fields rejected
    assert.equal((await r.request(`/api/auth/users/${user.id}`,'PATCH',{name:user.name,login:user.login,role:'manager',managerId:null,version:1},cookie)).status,409);
    const persisted=await readFile(r.store.path,'utf8');assert.ok(!persisted.includes(password));assert.ok(!persisted.includes(cookie.split('=')[1]));
    assert.equal((await r.request('/api/auth/logout','POST',{},cookie)).status,200);
    assert.equal((await r.request('/api/snapshot','GET',undefined,cookie)).status,401);
    for(let i=0;i<5;i++)assert.equal((await r.request('/api/auth/login','POST',{login:'owner',password:'incorrect'})).status,401);
    assert.equal((await r.request('/api/auth/login','POST',{login:'owner',password})).status,429);
  }finally{await r.close();}
});

test('cloud bootstrap requires an explicit server token and produces secure cookies',async()=>{
  const r=await runtime(true);try{
    const input={name:'Director',login:'director',password:randomBytes(20).toString('hex')};
    assert.equal((await r.request('/api/auth/setup','POST',input)).status,403);
    assert.equal((await r.request('/api/auth/setup','POST',{...input,setupToken:'wrong'})).status,403);
    const created=await r.request('/api/auth/setup','POST',{...input,setupToken:'test-only-cloud-setup'});
    assert.equal(created.status,200);assert.ok(created.cookie?.includes('; Secure'));
  }finally{await r.close();}
});

test('manager financial scope does not leak global aggregates or other shipment IDs and cannot alter assignments',async()=>{
  const r=await runtime();try{
    const base=await loadSnapshot();
    const password=randomBytes(20).toString('hex');
    const setup=await r.request('/api/auth/setup','POST',{name:'Director',login:'director',password});const cookie=setup.cookie!.split(';')[0];
    const snap=(await r.request('/api/snapshot','GET',undefined,cookie)).body;
    const managerId=snap.directories.managers[0].id;
    const account=await r.request('/api/auth/users','POST',{name:'Manager',login:'manager',password,role:'manager',managerId},cookie);assert.equal(account.status,201);
    const signed=await r.request('/api/auth/login','POST',{login:'manager',password});const managerCookie=signed.cookie!.split(';')[0];
    const scoped=(await r.request('/api/snapshot','GET',undefined,managerCookie)).body;
    assert.equal(scoped.payments.length,0);assert.equal(scoped.stocks.length,0);assert.equal(scoped.overview.incoming.total,null);
    assert.equal((await r.request('/api/auth/users','POST',{name:'Intruder',login:'intruder',password,role:'director'},managerCookie)).status,403);
    assert.equal((await r.request('/api/directories','POST',{kind:'products',name:'forbidden'},managerCookie)).status,403);
    assert.equal((await r.request('/api/shipments/'+base.shipments[0].id,'GET',undefined,managerCookie)).status,404);
    const record=structuredClone(base.shipments[0]);record.fields.manager_id=managerId;
    const visible=scopeSnapshot({...base,shipments:[record]},account.body.user as AccountUser);
    assert.equal(visible.shipments.length,1);assert.equal(visible.overview.revenue.total,record.revenue);assert.equal(visible.overview.shipmentCount,1);
    const saved=await r.store.read(base.provenance.sourceSha256);
    const beforeAccounts=structuredClone(saved.accounts);
    clearOperations(base,saved);assert.deepEqual(saved.accounts,beforeAccounts);
    const encoded=encodeOperations(saved);assert.ok(encoded.includes('passwordHash'));
    // A password change revokes every old session for that account.
    const user=account.body.user;
    assert.equal((await r.request('/api/auth/users/'+user.id,'PATCH',{name:user.name,login:user.login,role:user.role,managerId,version:user.version,password:randomBytes(20).toString('hex')},cookie)).status,200);
    assert.equal((await r.request('/api/snapshot','GET',undefined,managerCookie)).status,401);
  }finally{await r.close();}
});

test('a fresh cloud store instance retains users and sessions in the same protected envelope',async()=>{
  const base=await loadSnapshot();const local=await runtime();try{
    await local.request('/api/auth/setup','POST',{name:'Cloud user',login:'clouduser',password:randomBytes(20).toString('hex')});
    const data=await local.store.read(base.provenance.sourceSha256);let raw=encodeOperations(data);
    const client={get:async()=>({statusCode:200,stream:new Response(raw).body,blob:{etag:'1'}}),put:async(_p:string,body:unknown)=>{raw=String(body);return{etag:'2'};}};
    const first=new BlobOperationsStore('test',client as never);const next=new BlobOperationsStore('test',client as never);
    assert.deepEqual((await first.read(base.provenance.sourceSha256)).accounts,(await next.read(base.provenance.sourceSha256)).accounts);
  }finally{await local.close();}
});
