import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname } from 'node:path';
import test from 'node:test';
import { createSnapshotMiddleware } from '../server/local-api';
import { OperationsStore } from '../server/operations-store';
import { integrationRuntime } from './helpers/trip-saby-integration';
import type { OperatorWorkspace, OperatorAllocationInput, OperatorManagerId, OperatorRefuellingV3 } from '../web/src/operator-model';

async function fixture() {
  const rt = await integrationRuntime();
  const middleware = createSnapshotMiddleware(rt.snapshotDirectory, { operationsStore: rt.store, sabyWorkflowMonitoringEnabled: false });
  const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end(); }));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = async (path: string, method = 'GET', body?: unknown, cookie?: string, headers: Record<string, string> = {}) => {
    const response = await fetch(origin + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const password = randomUUID();
  const setup = await request('/api/auth/setup', 'POST', { name: 'Синтетический директор', login: 'plans-admin', password });
  assert.equal(setup.status, 200);
  const admin = setup.cookie!;
  const groupId = randomUUID();
  await rt.store.mutate(rt.source, state => {
    state.directories!.operatorGroups = [{ id: groupId, name: 'Тестовая группа', version: 0 }];
    state.directories!.managers.push({ id: 'plans-test', name: 'Оператор тест' });
    return { changed: true, result: null };
  });
  const added = await request('/api/auth/users', 'POST', { name: 'Оператор тест', login: 'plans-test', password, role: 'employee', managerId: 'plans-test', sections: ['operator'] }, admin);
  assert.equal(added.status, 201);
  const operator = (await request('/api/auth/login', 'POST', { login: 'plans-test', password })).cookie!;
  const read = async () => (await request('/api/operator', 'GET', undefined, operator)).body as OperatorWorkspace;
  const service = (await read()).services.find(row => row.name === 'Роснефть')!;
  const recipient = (limit = '10000') => ({ id: randomUUID(), name: 'Синтетический получатель', bank: 'Тестовый банк', card: '0000 0000 0000 0000', phone: '', details: 'Только синтетические данные', limit });
  const planBody = (limits = ['10000', '25000'], managerId?: OperatorManagerId) => ({ clientName: 'ООО СИНТЕТИКА', ...(managerId ? { managerId } : {}), recipients: limits.map(limit => recipient(limit)), idempotencyKey: randomUUID() });
  const createPlan = async (limits?: string[], managerId?: OperatorManagerId) => {
    const payload = planBody(limits, managerId);
    const response = await request('/api/operator/plans', 'POST', payload, operator);
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return { ...payload, id: response.body.id as string, version: 1 };
  };
  const operation = (planId: string, planVersion: number, allocations: OperatorAllocationInput[], amount = '35000') => ({
    schemaVersion: 3, date: '2026-10-19', name: 'Синтетический водитель', groupId, serviceId: service.id, serviceVersion: service.version ?? 0, discountPercent: '10',
    litres: '100', pricePerLitre: '78.45', amount, amountMode: 'manual', comment: '', planId, planVersion, allocations, idempotencyKey: randomUUID(),
  });
  return { ...rt, request, admin, operator, operatorId: added.body.user.id as string, read, recipient, planBody, createPlan, operation, async close() { await new Promise<void>(done => server.close(() => done())); await rt.close(); } };
}
const card = (recipientId: string, amount: string): OperatorAllocationInput => ({ kind: 'recipient', recipientId, amount });
const overflow = (managerId: OperatorManagerId, amount: string): OperatorAllocationInput => ({ kind: 'manager', managerId, amount });


test('audit B/D: both split scenarios, stale secondary plan atomicity, editing and deletion recalculate every task', async () => {
  for (const used of [230000, 240000]) {
    const f = await fixture();
    try {
      const a = await f.createPlan(['250000']), b = await f.createPlan(['250000']);
      const post = (payload: unknown) => f.request('/api/operator/refuellings', 'POST', payload, f.operator);
      assert.equal((await post(f.operation(a.id, 1, [card(a.recipients[0].id, String(used))], String(used)))).status, 201);
      const split = 250000 - used;
      const payload = f.operation(a.id, 2, [card(a.recipients[0].id, String(split)), { ...card(b.recipients[0].id, String(30000-split)), planId: b.id, planVersion: 1 }], '30000');
      const before = await f.store.read(f.source);
      assert.equal((await post({...payload, allocations: [payload.allocations[0], {...payload.allocations[1], planVersion: 0}]})).status, 409);
      assert.deepEqual(await f.store.read(f.source), before);
      const result = await post(payload); assert.equal(result.status, 201);
      let work = await f.read(); const row = work.refuellings.find(x => x.id === result.body.id) as OperatorRefuellingV3;
      assert.deepEqual(row.allocations.map(x => [x.planId, x.planClientName, x.amount]), [[a.id, a.clientName, split.toFixed(2)], [b.id, b.clientName, (30000-split).toFixed(2)]]);
      assert.equal(work.plans.find(x=>x.id===a.id)!.allocated, '250000.00');
      assert.equal(work.plans.find(x=>x.id===b.id)!.allocated, (30000-split).toFixed(2));
      const edit = {...f.operation(a.id, 3, [card(a.recipients[0].id,'5000'), {...card(b.recipients[0].id,'25000'),planId:b.id,planVersion:2}], '30000'), version:row.version};
      assert.equal((await f.request('/api/operator/refuellings/'+row.id,'PATCH',edit,f.operator)).status,200);
      work=await f.read(); assert.equal(work.plans.find(x=>x.id===a.id)!.allocated,(used+5000).toFixed(2)); assert.equal(work.plans.find(x=>x.id===b.id)!.allocated,'25000.00');
      assert.equal((await f.request('/api/operator/refuellings/'+row.id+'/delete','PATCH',{version:2,idempotencyKey:randomUUID()},f.operator)).status,200);
      work=await f.read(); assert.equal(work.plans.find(x=>x.id===a.id)!.allocated,used.toFixed(2));assert.equal(work.plans.find(x=>x.id===b.id)!.allocated,'0.00');
      assert.equal((await post(f.operation(a.id,5,[card(a.recipients[0].id,String(270000-used))],String(270000-used)))).status,201);
      work=await f.read();assert.equal(work.plans.find(x=>x.id===a.id)!.remaining,'-20000.00');
      assert.equal((await post(f.operation(a.id,6,[card(a.recipients[0].id,'1')],'1'))).status,201);
      assert.deepEqual((await new OperationsStore(dirname(f.store.path)).read(f.source)).operator,(await f.store.read(f.source)).operator);
    } finally { await f.close(); }
  }
});

test('audit C: manager first, middle, last, alone; four recipients; cents and negative amounts rejected atomically', async () => {
 const f=await fixture(); try {
 const a=await f.createPlan(['100','100','100','100']),b=await f.createPlan(['100']);
 for(const position of [0,1,2,3]) {
   const work=await f.read(),av=work.plans.find(x=>x.id===a.id)!.version,bv=work.plans.find(x=>x.id===b.id)!.version;
   const lines: OperatorAllocationInput[]=position===3?[]:[card(a.recipients[0].id,'10.01'),{...card(b.recipients[0].id,'10.02'),planId:b.id,planVersion:bv}];
   lines.splice(position===3?0:position,0,overflow('aidar',position===3?'30.03':'10.00'));
   const body=f.operation(a.id,av,lines,'30.03');
   for(const invalid of [{...body,amount:'30.04'},{...body,allocations:lines.map((x,i)=>i?x:{...x,amount:'-1'})}]) {
    const before=await f.store.read(f.source);assert.equal((await f.request('/api/operator/refuellings','POST',invalid,f.operator)).status,400);assert.deepEqual(await f.store.read(f.source),before);
   }
   assert.equal((await f.request('/api/operator/refuellings','POST',body,f.operator)).status,201);
 }
 const av=(await f.read()).plans.find(x=>x.id===a.id)!.version;
 const firstTwo=f.operation(a.id,av,[card(a.recipients[0].id,'10'),card(a.recipients[1].id,'20'),overflow('eldar','30')],'60');
 assert.equal((await f.request('/api/operator/refuellings','POST',firstTwo,f.operator)).status,201);
 const work=await f.read();assert.equal(work.plans.find(x=>x.id===a.id)!.allocated,'60.03');assert.equal(work.plans.find(x=>x.id===b.id)!.allocated,'30.06');
 assert.equal(work.plans.find(x=>x.id===a.id)!.recipients[2].used,'0.00');assert.equal(work.plans.find(x=>x.id===a.id)!.recipients[3].used,'0.00');
 } finally {await f.close()}
});

test('audit B: dropping a secondary allocation still checks that removed plan version', async()=>{
 const f=await fixture();try {
 const a=await f.createPlan(['100']),b=await f.createPlan(['100']);
 const created=await f.request('/api/operator/refuellings','POST',f.operation(a.id,1,[card(a.recipients[0].id,'10'),{...card(b.recipients[0].id,'20'),planId:b.id,planVersion:1}],'30'),f.operator);assert.equal(created.status,201);
 assert.equal((await f.request('/api/operator/refuellings','POST',f.operation(b.id,2,[card(b.recipients[0].id,'1')],'1'),f.operator)).status,201);
 const body={...f.operation(a.id,2,[card(a.recipients[0].id,'30')],'30'),version:1,planVersions:{[a.id]:2,[b.id]:2}};
 const before=await f.store.read(f.source);
 const {planVersions: omitted, ...missing}=body; void omitted;
 assert.equal((await f.request('/api/operator/refuellings/'+created.body.id,'PATCH',missing,f.operator)).status,409);assert.deepEqual(await f.store.read(f.source),before);
 assert.equal((await f.request('/api/operator/refuellings/'+created.body.id,'PATCH',body,f.operator)).status,409);assert.deepEqual(await f.store.read(f.source),before);
 assert.equal((await f.request('/api/operator/refuellings/'+created.body.id,'PATCH',{...body,planVersions:{[a.id]:2,[b.id]:3}},f.operator)).status,200);
 assert.equal((await f.read()).plans.find(p=>p.id===b.id)!.allocated,'1.00');
 }finally{await f.close()}
});
