import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {dirname} from 'node:path';
import test from 'node:test';
import {createSnapshotMiddleware} from '../server/local-api';
import {OperationsStore,encodeOperations,decodeOperations} from '../server/operations-store';
import {integrationRuntime} from './helpers/trip-saby-integration';

export async function operatorFixture() {
  const rt=await integrationRuntime();
  const middleware=createSnapshotMiddleware(rt.snapshotDirectory,{operationsStore:rt.store,sabyWorkflowMonitoringEnabled:false});
  const server=createServer((req,res)=>middleware(req,res,()=>{res.writeHead(404);res.end()}));
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
  const origin=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request=async(path:string,method='GET',body?:unknown,cookie?:string,headers:Record<string,string>={})=>{
    const r=await fetch(origin+path,{method,headers:{'Content-Type':'application/json',...(cookie?{cookie}:{}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
    return {status:r.status,body:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};
  };
  const password=randomUUID();
  const setup=await request('/api/auth/setup','POST',{name:'Тестовый директор',login:'operator-admin',password});assert.equal(setup.status,200);
  const admin=setup.cookie!;
  const employee=async(login:string,sections:string[])=>{
    await rt.store.mutate(rt.source,state=>{state.directories!.managers.push({id:login,name:login});return{changed:true,result:null}});
    const added=await request('/api/auth/users','POST',{name:login,login,password,role:'employee',managerId:login,sections},admin);assert.equal(added.status,201,JSON.stringify(added.body));
    const session=await request('/api/auth/login','POST',{login,password});return {cookie:session.cookie!,user:added.body.user};
  };
  const operator=await employee('synthetic-operator',['operator']),denied=await employee('synthetic-denied',[]);
  const recipientBody=()=>({name:'Синтетический получатель',bank:'Тестовый банк',card:'0000 0000 0000 0000',phone:'',details:'Синтетические реквизиты',idempotencyKey:randomUUID()});
  const recipient=await request('/api/operator/recipients','POST',recipientBody(),operator.cookie);assert.equal(recipient.status,201);
  const fuelBody=()=>({date:'2026-10-19',name:'Синтетический водитель',service:'Газпромнефть',discountPercent:'5',litres:'100,5',pricePerLitre:'65,123456',amount:'6000,25',comment:'Синтетическая запись',recipientId:recipient.body.id,recipientVersion:1,idempotencyKey:randomUUID()});
  return {...rt,origin,request,admin,operator,denied,recipient,recipientBody,fuelBody,password,employee,async close(){await new Promise<void>(done=>server.close(()=>done()));await rt.close()}};
}

test('operator persists exact entered values, concurrent replay, manual payment and reversal with audit; restart reads same data',async()=>{
 const f=await operatorFixture();try{
  const before=await f.store.read(f.source),payload=f.fuelBody();
  const saved=await Promise.all(Array.from({length:4},()=>f.request('/api/operator/refuellings','POST',payload,f.operator.cookie)));
  assert.deepEqual(saved.map(r=>r.status).sort(),[200,200,200,201]);assert.equal(new Set(saved.map(r=>r.body.id)).size,1);
  let workspace=(await f.request('/api/operator','GET',undefined,f.operator.cookie)).body;const id=saved[0].body.id;
  assert.equal(workspace.refuellings.length,1);assert.equal(workspace.refuellings[0].amount,'6000.25');assert.equal(workspace.refuellings[0].litres,'100.5');assert.equal(workspace.refuellings[0].paid,false);
  const payment={version:1,paid:true,idempotencyKey:randomUUID()};
  assert.equal((await f.request(`/api/operator/refuellings/${id}/payment`,'PATCH',payment,f.operator.cookie)).status,200);
  assert.equal((await f.request(`/api/operator/refuellings/${id}/payment`,'PATCH',payment,f.operator.cookie)).body.replayed,true);
  assert.equal((await f.request(`/api/operator/refuellings/${id}`,'PATCH',{...f.fuelBody(),version:2},f.operator.cookie)).status,409);
  assert.equal((await f.request(`/api/operator/refuellings/${id}/payment`,'PATCH',{version:2,paid:false,idempotencyKey:randomUUID()},f.operator.cookie)).status,200);
  const edited={...f.fuelBody(),version:3,amount:'999.99'};
  assert.equal((await f.request(`/api/operator/refuellings/${id}`,'PATCH',edited,f.operator.cookie)).status,200);
  assert.equal((await f.request(`/api/operator/refuellings/${id}`,'PATCH',edited,f.operator.cookie)).body.replayed,true);
  assert.equal((await f.request(`/api/operator/refuellings/${id}`,'PATCH',{...edited,idempotencyKey:randomUUID()},f.operator.cookie)).status,409);
  workspace=(await f.request('/api/operator','GET',undefined,f.operator.cookie)).body;
  assert.deepEqual(workspace.refuellings[0].paymentHistory.map((v:{paid:boolean})=>v.paid),[true,false]);assert.equal(workspace.refuellings[0].paymentHistory[0].actorId,f.operator.user.id);
  const after=await new OperationsStore(dirname(f.store.path)).read(f.source);
  assert.equal(after.operator!.refuellings[id].amount,'999.99');
  const {operator:unused,revision:rev,...rest}=after;void unused;void rev;
  const {operator:unused2,revision:rev2,...prior}=before;void unused2;void rev2;assert.deepEqual(rest,prior);
  assert.deepEqual(decodeOperations(encodeOperations(after),f.source).operator,after.operator);
 }finally{await f.close()}
});

test('operator enforces section, session, CSRF, replay ownership, validation and recipient snapshots',async()=>{
 const f=await operatorFixture();try{
  assert.equal((await f.request('/api/operator')).status,401);
  for(const [path,method,body] of [['/api/operator','GET',undefined],['/api/operator/refuellings','POST',f.fuelBody()],['/api/operator/recipients','POST',f.recipientBody()]] as const)assert.equal((await f.request(path,method,body,f.denied.cookie)).status,403);
  assert.equal((await f.request('/api/operator/recipients','POST',f.recipientBody(),f.operator.cookie,{Origin:'https://untrusted.example'})).status,403);
  const payload=f.fuelBody(),saved=await f.request('/api/operator/refuellings','POST',payload,f.operator.cookie);assert.equal(saved.status,201);
  assert.equal((await f.request('/api/operator/refuellings','POST',payload,f.admin)).status,409);
  assert.equal((await f.request('/api/operator/refuellings','POST',{...payload,amount:'1'},f.operator.cookie)).status,409);
  for(const patch of [{date:'2026-02-30'},{amount:'NaN'},{amount:'1.001'},{litres:'-1'},{discountPercent:'101'},{recipientId:'__proto__'},{paid:true},{recipientVersion:0}]) {
    const result=await f.request('/api/operator/refuellings','POST',{...f.fuelBody(),...patch},f.operator.cookie);assert.ok([400,409].includes(result.status),JSON.stringify(result));
  }
  const edit={...f.recipientBody(),version:1,bank:'Новый тестовый банк'};
  assert.equal((await f.request(`/api/operator/recipients/${f.recipient.body.id}`,'PATCH',edit,f.operator.cookie)).status,200);
  let data=(await f.request('/api/operator','GET',undefined,f.operator.cookie)).body;assert.equal(data.refuellings[0].recipient.bank,'Тестовый банк');
  assert.equal((await f.request(`/api/operator/recipients/${f.recipient.body.id}/archive`,'PATCH',{version:2,archived:true,idempotencyKey:randomUUID()},f.operator.cookie)).status,200);
  assert.equal((await f.request('/api/operator/refuellings','POST',{...f.fuelBody(),recipientVersion:3},f.operator.cookie)).status,400);
  data=(await f.request('/api/operator','GET',undefined,f.operator.cookie)).body;assert.equal(data.refuellings.length,1);assert.equal(data.recipients[0].archived,true);
  await f.store.mutate(f.source,state=>{state.accounts!.users.find(u=>u.id===f.operator.user.id)!.sections=[];return{changed:true,result:null}});
  assert.equal((await f.request('/api/operator/refuellings','POST',payload,f.operator.cookie)).status,403);
  assert.equal((await f.request('/api/operator','GET',undefined,f.operator.cookie)).status,403);
 }finally{await f.close()}
});

test('operator rejects corrupt saved payment history and does not add a section to old storage',async()=>{
 const f=await operatorFixture();try{
  const saved=await f.request('/api/operator/refuellings','POST',f.fuelBody(),f.operator.cookie);const data=await f.store.read(f.source);
  const damaged=structuredClone(data);damaged.operator!.refuellings[saved.body.id].paid=true;assert.throws(()=>encodeOperations(damaged));
  delete data.operator;assert.equal(decodeOperations(encodeOperations(data),f.source).operator,undefined);
 }finally{await f.close()}
});
