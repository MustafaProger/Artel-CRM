import assert from 'node:assert/strict';
import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname } from 'node:path';
import test from 'node:test';
import { createSnapshotMiddleware } from '../server/local-api';
import { OperationsStore } from '../server/operations-store';
import { integrationRuntime } from './helpers/trip-saby-integration';
import type { OperatorWorkspace, OperatorAllocationInput, OperatorManagerId } from '../web/src/operator-model';

import { dispatchReminders, dispatchOperatorNotifications, type PushSender } from '../server/push';
const config = { publicKey: 'test-public', privateKey: 'test-private', subject: 'https://example.test', schedule: true };
async function fixture(sender: PushSender) {
  const rt = await integrationRuntime();
  const middleware = createSnapshotMiddleware(rt.snapshotDirectory, { operationsStore: rt.store, sabyWorkflowMonitoringEnabled: false, pushConfig: config, pushSender: sender });
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
  for (const cookie of [admin, operator]) {
    const key = createECDH('prime256v1'); key.generateKeys();
    const subscription = { endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`, keys: { p256dh: key.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
    assert.equal((await request('/api/push/subscription', 'POST', { subscription, explicit: true }, cookie)).status, 200);
  }
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
  return { ...rt, request, admin, adminId: setup.body.user.id as string, operator, operatorId: added.body.user.id as string, read, recipient, planBody, createPlan, operation, async close() { await new Promise<void>(done => server.close(() => done())); await rt.close(); } };
}
interface Notice { userId: string; body: string; tag: string; url: string; title: string }
const capture = (sent: Notice[]): PushSender => async (device, payload) => { sent.push({ ...JSON.parse(payload), userId: device.userId }); };
async function finish(f: Awaited<ReturnType<typeof fixture>>, plan: Awaited<ReturnType<Awaited<ReturnType<typeof fixture>>['createPlan']>>, cookie: string) {
  return f.request('/api/operator/refuellings', 'POST', f.operation(plan.id, plan.version, [{ kind: 'recipient', recipientId: plan.recipients[0].id, amount: '100' }], '100'), cookie);
}

test('operator notifications: create excludes author; completion goes to creator; replay, payment and restart do not duplicate', async () => {
  const sent: Notice[] = [], f = await fixture(capture(sent));
  try {
    assert.equal((await f.request('/api/push/config', 'GET', undefined, f.operator)).status, 200);
    assert.equal((await f.request('/api/work', 'GET', undefined, f.operator)).status, 403);
    assert.equal((await f.request('/api/push/config', 'GET', undefined, f.operator, { 'x-artel-account': 'another' })).status, 401);
    const plan = await f.createPlan(['100']);
    assert.deepEqual(sent.map(row => row.userId), [f.adminId]);
    assert.match(sent[0].body, /новое задание/i);
    assert.equal(sent[0].url, `/?operatorPlan=${plan.id}#operator`);
    const body = f.operation(plan.id, 1, [{ kind: 'recipient', recipientId: plan.recipients[0].id, amount: '100' }], '100');
    const saved = await f.request('/api/operator/refuellings', 'POST', body, f.admin);
    assert.equal(saved.status, 201);
    assert.deepEqual(sent.map(row => row.userId), [f.adminId, f.operatorId]);
    assert.match(sent[1].body, /выполнено оператором/i);
    assert.equal(sent[1].url, sent[0].url);
    assert.notEqual(sent[1].tag, sent[0].tag);
    assert.equal((await f.request('/api/operator/refuellings', 'POST', body, f.admin)).status, 200);
    assert.equal((await f.request(`/api/operator/refuellings/${saved.body.id}/payment`, 'PATCH', { idempotencyKey: randomUUID(), version: 1, paid: true }, f.admin)).status, 200);
    await dispatchReminders(new OperationsStore(dirname(f.store.path)), f.source, config, capture(sent));
    assert.equal(sent.length, 2);
  } finally { await f.close(); }
});

test('operator notifications: partial allocation and self completion are silent', async () => {
  const sent: Notice[] = [], f = await fixture(capture(sent));
  try {
    const plan = await f.createPlan(['100']); sent.length = 0;
    const partial = f.operation(plan.id, 1, [{ kind: 'recipient', recipientId: plan.recipients[0].id, amount: '40' }], '40');
    assert.equal((await f.request('/api/operator/refuellings', 'POST', partial, f.admin)).status, 201);
    assert.equal(sent.length, 0);
    assert.equal((await f.request('/api/operator/refuellings', 'POST', f.operation(plan.id, 2, [{ kind: 'recipient', recipientId: plan.recipients[0].id, amount: '60' }], '60'), f.operator)).status, 201);
    await dispatchReminders(f.store, f.source, config, capture(sent));
    assert.equal(sent.length, 0);
  } finally { await f.close(); }
});

test('operator notifications: failed send persists, retries after restart and concurrent dispatch sends once', async () => {
  let fail = true; const sent: Notice[] = [];
  const sender: PushSender = async (device, payload) => { if (fail) throw new Error('Synthetic unavailable provider'); await capture(sent)(device, payload, config); };
  const f = await fixture(sender);
  try {
    const plan = await f.createPlan(['100']);
    assert.equal((await f.read()).plans.length, 1);
    assert.equal(Object.keys((await f.store.read(f.source)).push!.operatorPlanEvents!).length, 1);
    fail = false;
    const now = Date.now() + 180000;
    await Promise.all([dispatchOperatorNotifications(new OperationsStore(dirname(f.store.path)), f.source, config, sender, now), dispatchOperatorNotifications(f.store, f.source, config, sender, now)]);
    assert.equal(sent.length, 1); assert.equal(sent[0].url, `/?operatorPlan=${plan.id}#operator`);
    await dispatchReminders(f.store, f.source, config, sender, now + 60000);
    assert.equal(sent.length, 1);
  } finally { await f.close(); }
});

test('operator notifications: revoked access and expired sessions receive no queued events', async () => {
  const sent: Notice[] = [], f = await fixture(async () => { throw new Error('Synthetic failure'); });
  try {
    assert.equal((await f.request('/api/operator/plans', 'POST', f.planBody(['100']), f.admin)).status, 201);
    await f.store.mutate(f.source, state => {
      state.accounts!.users.find(user => user.id === f.operatorId)!.sections = [];
      return { changed: true, result: null };
    });
    await dispatchReminders(f.store, f.source, config, capture(sent), Date.now() + 180000);
    assert.equal(sent.length, 0);
    await f.store.mutate(f.source, state => {
      state.accounts!.users.find(user => user.id === f.operatorId)!.sections = ['operator'];
      state.accounts!.sessions = state.accounts!.sessions.filter(row => row.userId !== f.operatorId);
      return { changed: true, result: null };
    });
    await dispatchReminders(f.store, f.source, config, capture(sent), Date.now() + 240000);
    assert.equal(sent.length, 0);
  } finally { await f.close(); }
});

test('operator notifications: reopening cancels stale completion; completing again produces a distinct event', async () => {
  const sent: Notice[] = []; let fail = false;
  const f = await fixture(async (device, payload) => { if (fail) throw new Error('Synthetic failure'); await capture(sent)(device, payload, config); });
  try {
    const plan = await f.createPlan(['100']); fail = true;
    const done = await finish(f, plan, f.admin); assert.equal(done.status, 201);
    const first = (await f.store.read(f.source)).push!.operatorPlanEvents![`${plan.id}:completed`].token;
    assert.equal((await f.request(`/api/operator/refuellings/${done.body.id}/delete`, 'PATCH', { version: 1, idempotencyKey: randomUUID() }, f.admin)).status, 200);
    assert.equal((await f.store.read(f.source)).push!.operatorPlanEvents?.[`${plan.id}:completed`], undefined);
    fail = false;
    await dispatchReminders(f.store, f.source, config, capture(sent), Date.now() + 180000);
    assert.equal(sent.length, 1);
    const again = await finish(f, { ...plan, version: 3 }, f.admin); assert.equal(again.status, 201);
    assert.equal(sent.length, 2);
    assert.notEqual((await f.store.read(f.source)).push!.operatorPlanEvents![`${plan.id}:completed`].token, first);
  } finally { await f.close(); }
});

test('operation form receives durable result while provider is still pending',async()=>{
 let hold=false, release!:()=>void, finished!:()=>void;
 const gate=new Promise<void>(resolve=>{release=resolve}),sent=new Promise<void>(resolve=>{finished=resolve});
 const f=await fixture(async()=>{if(hold){await gate;finished()}});
 try{
  const plan=await f.createPlan(['100']);hold=true;
  const body=f.operation(plan.id,plan.version,[{kind:'recipient',recipientId:plan.recipients[0].id,amount:'100'}],'100');
  const result=await Promise.race([f.request('/api/operator/refuellings','POST',body,f.admin,{Prefer:'respond-async'}),new Promise<never>((_,reject)=>setTimeout(()=>reject(new Error('operation waited for push provider')),2000))]);
  assert.equal(result.status,201);assert.ok((await f.read()).refuellings.some(row=>row.id===result.body.id));
  release();await sent;
  for(let i=0;i<50;i++){const data=await f.store.read(f.source);if(Object.values(data.push?.deliveries??{}).every(row=>!row.lease))break;await new Promise(resolve=>setTimeout(resolve,20))}
 }finally{release();await new Promise(resolve=>setTimeout(resolve,150));await f.close()}
});
