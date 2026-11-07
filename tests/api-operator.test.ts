import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import type {AddressInfo} from 'node:net';
import {dirname} from 'node:path';
import test from 'node:test';
import {createSnapshotMiddleware} from '../server/local-api';
import {OperationsStore,encodeOperations,decodeOperations} from '../server/operations-store';
import {integrationRuntime} from './helpers/trip-saby-integration';
import type { OperatorWorkspace } from '../web/src/operator-model';

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

async function operatorV2Fixture() {
  const f = await operatorFixture();
  const groupId = randomUUID();
  await f.store.mutate(f.source, state => {
    state.directories!.operatorGroups = [{ id: groupId, name: 'Синтетическая группа', version: 0 }];
    return { changed: true, result: null };
  });
  const workspace = (await f.request('/api/operator', 'GET', undefined, f.operator.cookie)).body as OperatorWorkspace;
  const service = workspace.services.find(row => row.name === 'Роснефть')!;
  assert.ok(service);
  const v2Body = () => ({
    schemaVersion: 2, date: '2026-10-19', name: 'Новый синтетический водитель',
    groupId, serviceId: service.id, serviceVersion: service.version ?? 0, discountPercent: '10',
    litres: '100', pricePerLitre: '78.45', amount: '7060.50', amountMode: 'auto',
    recipientText: 'Синтетический получатель\nТестовые реквизиты', comment: '', idempotencyKey: randomUUID(),
  });
  return { ...f, groupId, service, workspace, v2Body };
}

test('operator v2 accepts no group without selecting one and preserves old snapshots when omitted on edit', async () => {
  const f = await operatorV2Fixture();
  try {
    const { groupId: unused, ...noGroup } = f.v2Body(); void unused;
    const saved = await f.request('/api/operator/refuellings', 'POST', noGroup, f.operator.cookie);
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
    let row = (await f.store.read(f.source)).operator!.refuellings[saved.body.id];
    assert.equal(Object.hasOwn(row, 'groupId'), false); assert.equal(Object.hasOwn(row, 'groupName'), false);
    assert.equal((await f.request('/api/operator/refuellings', 'POST', noGroup, f.operator.cookie)).body.replayed, true);
    assert.equal((await f.request(`/api/operator/refuellings/${row.id}`, 'PATCH', { ...noGroup, version: 1, comment: 'Без группы', idempotencyKey: randomUUID() }, f.operator.cookie)).status, 200);
    row = (await f.store.read(f.source)).operator!.refuellings[saved.body.id];
    assert.equal(Object.hasOwn(row, 'groupId'), false);
    const historical = await f.request('/api/operator/refuellings', 'POST', f.v2Body(), f.operator.cookie);
    assert.equal(historical.status, 201);
    await f.store.mutate(f.source, data => {
      data.directories!.operatorGroups = [];
      const old = data.operator!.refuellings[historical.body.id];
      assert.ok(old.schemaVersion !== undefined);
      old.groupName = '  Исторический снимок группы  ';
      return { changed: true, result: null };
    });
    const historicalBefore = (await f.store.read(f.source)).operator!.refuellings[historical.body.id];
    assert.equal((await f.request(`/api/operator/refuellings/${historical.body.id}`, 'PATCH', { ...noGroup, version: 1, comment: 'Другое уточнение', idempotencyKey: randomUUID() }, f.operator.cookie)).status, 200);
    const persisted = await new OperationsStore(dirname(f.store.path)).read(f.source);
    const old = persisted.operator!.refuellings[historical.body.id];
    assert.ok(old.schemaVersion !== undefined && historicalBefore.schemaVersion !== undefined);
    assert.equal(old.groupId, historicalBefore.groupId); assert.equal(old.groupName, historicalBefore.groupName);
    assert.deepEqual(decodeOperations(encodeOperations(persisted), f.source).operator, persisted.operator);
    const bytes = await readFile(f.store.path, 'utf8');
    await f.request('/api/operator', 'GET', undefined, f.operator.cookie);
    assert.equal(await readFile(f.store.path, 'utf8'), bytes);
    for (const patch of [{ groupId: 'missing' }, { groupId: '' }, { groupId: null }, { groupName: 'Подставленная группа' }]) {
      assert.equal((await f.request('/api/operator/refuellings', 'POST', { ...noGroup, ...patch, idempotencyKey: randomUUID() }, f.operator.cookie)).status, 400);
    }
    for (const patch of [{ groupId: 'only-id' }, { groupName: 'only-name' }, { groupId: '', groupName: '' }]) {
      const invalid = structuredClone(persisted);
      Object.assign(invalid.operator!.refuellings[saved.body.id], patch);
      assert.throws(() => encodeOperations(invalid));
    }
    assert.equal(await readFile(f.store.path, 'utf8'), bytes);
  } finally { await f.close(); }
});

test('operator v2 exposes only its catalogs, saves free recipient text, replays and preserves payment history after restart', async () => {
  const f = await operatorV2Fixture();
  try {
    const before = await f.store.read(f.source);
    const workspace = (await f.request('/api/operator', 'GET', undefined, f.operator.cookie)).body as OperatorWorkspace;
    assert.deepEqual(Object.keys(workspace).sort(), ['cases', 'groups', 'plans', 'recipients', 'refuellings', 'services']);
    assert.deepEqual(workspace.services.map(row => row.name).sort(), ['ГПН', 'Лукойл', 'ННК', 'Роснефть', 'Яндекс'].sort());
    assert.ok(workspace.services.every(row => row.discountPercent === '10'));
    assert.deepEqual(await f.store.read(f.source), before, 'catalog projection must not write to storage');
    const payload = f.v2Body();
    const replies = await Promise.all(Array.from({ length: 3 }, () => f.request('/api/operator/refuellings', 'POST', payload, f.operator.cookie)));
    assert.deepEqual(replies.map(row => row.status).sort(), [200, 200, 201]);
    assert.equal(new Set(replies.map(row => row.body.id)).size, 1);
    const id = replies[0].body.id;
    let data = await f.store.read(f.source), row = data.operator!.refuellings[id];
    assert.equal(row.schemaVersion, 2);
    if (row.schemaVersion !== 2) throw new Error('Expected v2');
    assert.equal(row.recipientText, payload.recipientText);
    assert.equal(row.groupName, 'Синтетическая группа');
    assert.equal(row.amount, '7060.50');
    assert.equal(row.service, 'Роснефть');
    assert.deepEqual(data.operator!.recipients, before.operator!.recipients);
    assert.equal(Object.hasOwn(row, 'recipient'), false);
    const paid = { version: 1, paid: true, idempotencyKey: randomUUID() };
    assert.equal((await f.request(`/api/operator/refuellings/${id}/payment`, 'PATCH', paid, f.operator.cookie)).status, 200);
    assert.equal((await f.request(`/api/operator/refuellings/${id}/payment`, 'PATCH', paid, f.operator.cookie)).body.replayed, true);
    assert.equal((await f.request(`/api/operator/refuellings/${id}`, 'PATCH', { ...f.v2Body(), version: 2 }, f.operator.cookie)).status, 409);
    assert.equal((await f.request(`/api/operator/refuellings/${id}/payment`, 'PATCH', { version: 2, paid: false, idempotencyKey: randomUUID() }, f.operator.cookie)).status, 200);
    data = await new OperationsStore(dirname(f.store.path)).read(f.source);
    row = data.operator!.refuellings[id];
    assert.deepEqual(row.paymentHistory.map(event => event.paid), [true, false]);
    assert.equal(row.paymentHistory[0].actorId, f.operator.user.id);
    assert.deepEqual(decodeOperations(encodeOperations(data), f.source).operator, data.operator);
    const { operator: ignored, revision: ignoredRevision, ...rest } = data;
    const { operator: ignoredBefore, revision: ignoredBeforeRevision, ...prior } = before;
    void ignored; void ignoredRevision; void ignoredBefore; void ignoredBeforeRevision;
    assert.deepEqual(rest, prior);
  } finally { await f.close(); }
});

test('operator deletes legacy and v2 operations without losing snapshots or reviving old requests', async () => {
  const f = await operatorV2Fixture();
  try {
    for (const payload of [f.fuelBody(), f.v2Body()]) {
      const saved = await f.request('/api/operator/refuellings', 'POST', payload, f.operator.cookie);
      assert.equal(saved.status, 201);
      const id = saved.body.id;
      const before = await f.store.read(f.source);
      const deletion = { version: 1, idempotencyKey: randomUUID() };
      const deleted = await f.request(`/api/operator/refuellings/${id}/delete`, 'PATCH', deletion, f.operator.cookie);
      assert.equal(deleted.status, 200);
      assert.equal(deleted.body.deleted, true);
      assert.equal((await f.request(`/api/operator/refuellings/${id}/delete`, 'PATCH', deletion, f.operator.cookie)).body.replayed, true);
      const replay = await f.request('/api/operator/refuellings', 'POST', payload, f.operator.cookie);
      assert.equal(replay.body.replayed, true);
      assert.equal(replay.body.deleted, true);
      const workspace = (await f.request('/api/operator', 'GET', undefined, f.operator.cookie)).body as OperatorWorkspace;
      assert.ok(workspace.refuellings.every(row => row.id !== id));
      const persisted = await new OperationsStore(dirname(f.store.path)).read(f.source);
      const tombstone = persisted.operator!.refuellings[id];
      assert.equal(tombstone.deletedBy, f.operator.user.id);
      assert.equal(tombstone.amount, before.operator!.refuellings[id].amount);
      assert.deepEqual(tombstone.paymentHistory, before.operator!.refuellings[id].paymentHistory);
      for (const patch of [{ deletedAt: 'invalid' }, { deletedBy: '' }, { deletedByName: '' }, { paid: true }]) {
        const draft = structuredClone(persisted);
        Object.assign(draft.operator!.refuellings[id], patch);
        assert.throws(() => encodeOperations(draft));
      }
    }
  } finally { await f.close(); }
});

test('operator v2 keeps historical rate and manual sum during edits and uses current rate only when changing service', async () => {
  const f = await operatorV2Fixture();
  try {
    const payload = { ...f.v2Body(), amountMode: 'manual', amount: '7000.17' };
    const saved = await f.request('/api/operator/refuellings', 'POST', payload, f.operator.cookie);
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
    const id = saved.body.id;
    await f.store.mutate(f.source, state => {
      state.directories!.operatorServices = f.workspace.services.map(service => ({ ...service, version: 1, discountPercent: service.id === f.service.id ? '8' : '12' }));
      state.directories!.operatorGroups![0] = { id: f.groupId, name: 'Новое имя синтетической группы', version: 1 };
      return { changed: true, result: null };
    });
    assert.equal((await f.request('/api/operator/refuellings', 'POST', payload, f.operator.cookie)).body.replayed, true);
    const corrected = { ...payload, version: 1, name: 'Исправленное имя', recipientText: 'Другой синтетический получатель', comment: 'Уточнение', idempotencyKey: randomUUID() };
    assert.equal((await f.request(`/api/operator/refuellings/${id}`, 'PATCH', corrected, f.operator.cookie)).status, 200);
    let row = (await f.store.read(f.source)).operator!.refuellings[id];
    assert.equal(row.amount, '7000.17');
    assert.equal(row.discountPercent, '10');
    assert.equal(row.schemaVersion === 2 && row.groupName, 'Синтетическая группа');
    const recalculated = { ...corrected, version: 2, litres: '200', amountMode: 'auto', amount: '14121.00', idempotencyKey: randomUUID() };
    assert.equal((await f.request(`/api/operator/refuellings/${id}`, 'PATCH', recalculated, f.operator.cookie)).status, 200);
    row = (await f.store.read(f.source)).operator!.refuellings[id];
    assert.equal(row.discountPercent, '10');
    assert.equal(row.amount, '14121.00');
    const otherService = f.workspace.services.find(service => service.id !== f.service.id)!;
    const switched = { ...recalculated, version: 3, serviceId: otherService.id, serviceVersion: 1, discountPercent: '12', amount: '13807.20', idempotencyKey: randomUUID() };
    assert.equal((await f.request(`/api/operator/refuellings/${id}`, 'PATCH', switched, f.operator.cookie)).status, 200);
    row = (await f.store.read(f.source)).operator!.refuellings[id];
    assert.equal(row.discountPercent, '12');
    assert.equal(row.service, otherService.name);
    assert.equal(row.amount, '13807.20');
    assert.equal((await f.request(`/api/operator/refuellings/${id}`, 'PATCH', { ...switched, idempotencyKey: randomUUID() }, f.operator.cookie)).status, 409);
  } finally { await f.close(); }
});

test('operator v2 rejects stale catalog selection and invalid new format without changing saved data', async () => {
  const f = await operatorV2Fixture();
  try {
    const before = await f.store.read(f.source);
    for (const patch of [
      { groupId: '' }, { groupId: '__proto__' }, { serviceId: '__proto__' }, { recipientText: '  ' },
      { litres: '1.001' }, { pricePerLitre: '78.451' }, { amountMode: 'unknown' }, { amount: '7060.51' },
      { serviceVersion: 5 }, { discountPercent: '8', amount: '7217.40' }, { schemaVersion: 3 },
      { recipientId: f.recipient.body.id }, { paid: true }, { service: 'Непроверенное имя' }, { groupName: 'Непроверенное имя' },
      { amountMode: 'manual', amount: '0' },
      { litres: '100.123456', legacyPrecision: { litres: '100.123456' } },
    ]) {
      const result = await f.request('/api/operator/refuellings', 'POST', { ...f.v2Body(), ...patch }, f.operator.cookie);
      assert.ok([400, 409].includes(result.status), JSON.stringify({ patch, result }));
    }
    assert.deepEqual(await f.store.read(f.source), before);
    await f.store.mutate(f.source, state => {
      state.directories!.operatorServices = f.workspace.services.map(service => ({ ...service, discountPercent: '8', version: 1 }));
      return { changed: true, result: null };
    });
    const changed = await f.store.read(f.source);
    assert.equal((await f.request('/api/operator/refuellings', 'POST', f.v2Body(), f.operator.cookie)).status, 409);
    assert.deepEqual(await f.store.read(f.source), changed);
    const current = { ...f.v2Body(), serviceVersion: 1, discountPercent: '8', amount: '7217.40' };
    const saved = await f.request('/api/operator/refuellings', 'POST', current, f.operator.cookie);
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
    const damaged = await f.store.read(f.source);
    damaged.operator!.refuellings[saved.body.id].amount = '1.00';
    assert.throws(() => encodeOperations(damaged));
    assert.equal((await f.request(`/api/operator/refuellings/${saved.body.id}`, 'PATCH', { ...f.fuelBody(), version: 1 }, f.operator.cookie)).status, 400);
    const tiny = await f.request('/api/operator/refuellings', 'POST', { ...current, litres: '0.01', pricePerLitre: '0.01', amount: '0.00', idempotencyKey: randomUUID() }, f.operator.cookie);
    assert.equal(tiny.status, 201, JSON.stringify(tiny.body));
  } finally { await f.close(); }
});

test('operator legacy stays unchanged on read and explicit v2 conversion retains its historical discount and manual amount', async () => {
  const f = await operatorV2Fixture();
  try {
    const old = { ...f.fuelBody(), service: 'Роснефть', litres: '100', pricePerLitre: '78.45', discountPercent: '5', amount: '7001.23' };
    const saved = await f.request('/api/operator/refuellings', 'POST', old, f.operator.cookie);
    assert.equal(saved.status, 201);
    const before = await f.store.read(f.source);
    const read = (await f.request('/api/operator', 'GET', undefined, f.operator.cookie)).body as OperatorWorkspace;
    assert.deepEqual(read.refuellings[0], before.operator!.refuellings[saved.body.id]);
    assert.deepEqual(await f.store.read(f.source), before);
    const converted = { ...f.v2Body(), version: 1, discountPercent: '5', amountMode: 'manual', amount: '7001.23', comment: 'Уточнение старой записи' };
    const result = await f.request(`/api/operator/refuellings/${saved.body.id}`, 'PATCH', converted, f.operator.cookie);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    const after = await f.store.read(f.source), row = after.operator!.refuellings[saved.body.id];
    assert.equal(row.schemaVersion, 2);
    assert.equal(row.discountPercent, '5');
    assert.equal(row.amount, '7001.23');
    assert.deepEqual(after.operator!.recipients, before.operator!.recipients);
    assert.equal(row.createdAt, before.operator!.refuellings[saved.body.id].createdAt);
    assert.equal(row.createdBy, before.operator!.refuellings[saved.body.id].createdBy);
  } finally { await f.close(); }
});

test('operator preserves unchanged legacy precision without allowing new or edited high precision values', async () => {
  const f = await operatorV2Fixture();
  try {
    const old = { ...f.fuelBody(), service: 'Роснефть', litres: '100.123456', pricePerLitre: '65.123456', discountPercent: '5', amount: '6000.25' };
    const saved = await f.request('/api/operator/refuellings', 'POST', old, f.operator.cookie);
    assert.equal(saved.status, 201);
    const id = saved.body.id;
    const converted = { ...f.v2Body(), version: 1, litres: old.litres, pricePerLitre: old.pricePerLitre, discountPercent: old.discountPercent, amountMode: 'manual', amount: old.amount, comment: 'Уточнён только комментарий' };
    const result = await f.request(`/api/operator/refuellings/${id}`, 'PATCH', converted, f.operator.cookie);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    let data = await new OperationsStore(dirname(f.store.path)).read(f.source), row = data.operator!.refuellings[id];
    assert.equal(row.litres, old.litres);
    assert.equal(row.pricePerLitre, old.pricePerLitre);
    assert.equal(row.amount, old.amount);
    assert.equal(row.discountPercent, old.discountPercent);
    assert.equal(row.schemaVersion, 2);
    if (row.schemaVersion !== 2) throw new Error('Expected v2');
    assert.deepEqual(row.legacyPrecision, { litres: old.litres, pricePerLitre: old.pricePerLitre });
    const beforeRejected = structuredClone(data);
    for (const patch of [{ litres: '100.123457' }, { pricePerLitre: '65.123457' }, { legacyPrecision: { litres: '100.123457' } }]) {
      const rejected = await f.request(`/api/operator/refuellings/${id}`, 'PATCH', { ...converted, version: 2, ...patch, idempotencyKey: randomUUID() }, f.operator.cookie);
      assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
    }
    assert.deepEqual(await f.store.read(f.source), beforeRejected);
    const corrupted = structuredClone(data), broken = corrupted.operator!.refuellings[id];
    if (broken.schemaVersion !== 2) throw new Error('Expected v2');
    broken.legacyPrecision!.pricePerLitre = '65.123455';
    assert.throws(() => encodeOperations(corrupted));
    const recalculated = { ...converted, version: 2, litres: '200', amountMode: 'auto', amount: '12373.46', idempotencyKey: randomUUID() };
    assert.equal((await f.request(`/api/operator/refuellings/${id}`, 'PATCH', recalculated, f.operator.cookie)).status, 200);
    data = await f.store.read(f.source); row = data.operator!.refuellings[id];
    assert.equal(row.amount, '12373.46');
    assert.equal(row.discountPercent, '5');
    assert.deepEqual(row.schemaVersion === 2 && row.legacyPrecision, { pricePerLitre: old.pricePerLitre });
    const normalPrecision = { ...recalculated, version: 3, pricePerLitre: '65.12', amount: '12372.80', idempotencyKey: randomUUID() };
    assert.equal((await f.request(`/api/operator/refuellings/${id}`, 'PATCH', normalPrecision, f.operator.cookie)).status, 200);
    row = (await f.store.read(f.source)).operator!.refuellings[id];
    assert.equal(row.amount, '12372.80');
    assert.equal(Object.hasOwn(row, 'legacyPrecision'), false);
    const restoredHighPrecision = { ...recalculated, version: 4, idempotencyKey: randomUUID() };
    assert.equal((await f.request(`/api/operator/refuellings/${id}`, 'PATCH', restoredHighPrecision, f.operator.cookie)).status, 400);
  } finally { await f.close(); }
});
