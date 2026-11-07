import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname } from 'node:path';
import test from 'node:test';
import { createSnapshotMiddleware } from '../server/local-api';
import { OperationsStore } from '../server/operations-store';
import { integrationRuntime } from './helpers/trip-saby-integration';
import type { OperatorWorkspace, OperatorRefuellingV3 } from '../web/src/operator-model';

async function fixture() {
  const rt = await integrationRuntime();
  const middleware = createSnapshotMiddleware(rt.snapshotDirectory, { operationsStore: rt.store, sabyWorkflowMonitoringEnabled: false });
  const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end(); }));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = async (path: string, method = 'GET', body?: unknown, cookie?: string) => {
    const response = await fetch(origin + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const password = randomUUID();
  const setup = await request('/api/auth/setup', 'POST', { name: 'Синтетический директор', login: 'cases-admin', password });
  assert.equal(setup.status, 200);
  const admin = setup.cookie!, groupId = randomUUID();
  await rt.store.mutate(rt.source, state => {
    state.directories!.operatorGroups = [{ id: groupId, name: 'Синтетическая группа' }];
    state.directories!.managers.push({ id: 'case-operator', name: 'Оператор' }, { id: 'case-denied', name: 'Другой' });
    return { changed: true, result: null };
  });
  async function employee(login: string, sections: string[]) {
    assert.equal((await request('/api/auth/users', 'POST', { name: login, login, role: 'employee', managerId: login, password, sections }, admin)).status, 201);
    return (await request('/api/auth/login', 'POST', { login, password })).cookie!;
  }
  const operator = await employee('case-operator', ['operator']), denied = await employee('case-denied', []);
  const read = async () => (await request('/api/operator', 'GET', undefined, operator)).body as OperatorWorkspace;
  const service = (await read()).services.find(row => row.name === 'Лукойл')!;
  const recipient = { id: randomUUID(), name: 'Получатель', bank: 'Тестовый банк', card: '0000', phone: '', details: '', limit: '1000000' };
  const plan = await request('/api/operator/plans', 'POST', { clientName: 'Синтетический клиент', recipients: [recipient], idempotencyKey: randomUUID() }, operator);
  assert.equal(plan.status, 201);
  async function operation(overrides: Record<string, unknown> = {}) {
    const latest = (await read()).plans.find(row => row.id === plan.body.id)!;
    const amount = typeof overrides.amount === 'string' ? overrides.amount : '64800.00';
    return { schemaVersion: 3, date: '2026-10-21', name: 'Синтетический водитель', groupId, serviceId: service.id, serviceVersion: service.version ?? 0, discountPercent: '10', litres: '900', pricePerLitre: '80', amount, amountMode: 'auto', comment: '', planId: latest.id, planVersion: latest.version, allocations: [{ kind: 'recipient', recipientId: recipient.id, amount }], ...overrides, idempotencyKey: randomUUID() };
  }
  async function save(overrides: Record<string, unknown> = {}, paid = true) {
    const payload = await operation(overrides);
    const saved = await request('/api/operator/refuellings', 'POST', payload, operator);
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
    if (paid) assert.equal((await request(`/api/operator/refuellings/${saved.body.id}/payment`, 'PATCH', { version: 1, paid: true, idempotencyKey: randomUUID() }, operator)).status, 200);
    return { payload, row: (await read()).refuellings.find(row => row.id === saved.body.id)! as OperatorRefuellingV3 };
  }
  const claimBody = (row: OperatorRefuellingV3, kind = 'return', litres = '50') => ({ operationId: row.id, operationVersion: row.version, kind, ...(kind === 'return' ? { litres } : {}), idempotencyKey: randomUUID() });
  const claim = async (row: OperatorRefuellingV3, kind = 'return', litres = '50') => {
    const payload = claimBody(row, kind, litres), result = await request('/api/operator/cases', 'POST', payload, operator);
    assert.equal(result.status, 201, JSON.stringify(result.body));
    return { payload, result: result.body, row: (await read()).cases.find(item => item.id === result.body.id)! };
  };
  return { ...rt, request, admin, operator, denied, read, operation, save, claim, claimBody, async close() { await new Promise<void>(done => server.close(() => done())); await rt.close(); } };
}


test('audit A/E: exact 7200 credit at two prices/discounts, cents exhaustion, overdraw, history and protected financial fields', async()=>{
 const f=await fixture();try {
 assert.equal((await f.request('/api/directories','POST',{kind:'operatorServices',name:'Аудит 5%',discountPercent:'5'},f.admin)).status,201);
 for(const variant of [{price:'90',discount:'10',gross:'72900.00',due:'65700.00'},{price:'100',discount:'5',gross:'85500.00',due:'78300.00'}]) {
  const source=await f.save(),credit=await f.claim(source.row,'return','100');
  const svc=(await f.read()).services.find(x=>x.discountPercent===variant.discount)!;
  assert.ok(svc);
  const result=await f.save({serviceId:svc.id,serviceVersion:svc.version??0,pricePerLitre:variant.price,discountPercent:variant.discount,amount:variant.due,carryovers:[{caseId:credit.row.id,version:1,amount:'7200'}]});
  assert.equal(result.row.creditedAmount,'7200.00');
  assert.equal((await f.read()).cases.find(x=>x.id===credit.row.id)!.remainingAmount,'0.00');
 }
 const source=await f.save(),credit=await f.claim(source.row,'return','100');
 for(const [amount,remaining] of [['3000.00','4200.00'],['4199.99','0.01'],['0.01','0.00']]) {
  const c=(await f.read()).cases.find(x=>x.id===credit.row.id)!;
  const result=await f.save({pricePerLitre:'90',amount:(72900-Number(amount)).toFixed(2),carryovers:[{caseId:c.id,version:c.version,amount}]},false);
  assert.equal(result.row.creditedAmount,amount);assert.equal((await f.read()).cases.find(x=>x.id===c.id)!.remainingAmount,remaining);
 }
 const c=(await f.read()).cases.find(x=>x.id===credit.row.id)!;
 const before=await f.store.read(f.source);
 const excess=await f.operation({pricePerLitre:'90',amount:'72899.99',carryovers:[{caseId:c.id,version:c.version,amount:'0.01'}]});
 assert.equal((await f.request('/api/operator/refuellings','POST',excess,f.operator)).status,409);assert.deepEqual(await f.store.read(f.source),before);
 const immutable=(r: OperatorRefuellingV3)=>{const {paid,version,updatedAt,paymentHistory,...rest}=r;void paid;void version;void updatedAt;void paymentHistory;return rest};
 for(const paid of [false,true]) {
  const row=(await f.read()).refuellings.find(x=>x.id===source.row.id)! as OperatorRefuellingV3;
  const body={version:row.version,paid,idempotencyKey:randomUUID()};
  assert.equal((await f.request('/api/operator/refuellings/'+row.id+'/payment','PATCH',body,f.denied)).status,403);
  assert.equal((await f.request('/api/operator/refuellings/'+row.id+'/payment','PATCH',{...body,version:0},f.operator)).status,409);
  assert.equal((await f.request('/api/operator/refuellings/'+row.id+'/payment','PATCH',body,f.operator)).status,200);
  const next=(await f.read()).refuellings.find(x=>x.id===row.id)! as OperatorRefuellingV3;
  assert.deepEqual(immutable(next),immutable(row));assert.deepEqual((await f.store.read(f.source)).operator!.cases,before.operator!.cases);
  if(!paid){const edit=await f.operation({version:next.version,amount:'1',amountMode:'manual'});assert.equal((await f.request('/api/operator/refuellings/'+row.id,'PATCH',edit,f.operator)).status,409);}
 }
 assert.equal((await f.read()).refuellings.find(x=>x.id===source.row.id)!.paymentHistory.length,3);
 assert.deepEqual((await new OperationsStore(dirname(f.store.path)).read(f.source)).operator,(await f.store.read(f.source)).operator);
 }finally{await f.close()}
});
