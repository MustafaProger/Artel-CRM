import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname } from 'node:path';
import test from 'node:test';
import { createSnapshotMiddleware } from '../server/local-api';
import { OperationsStore, encodeOperations, decodeOperations } from '../server/operations-store';
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

test('operator plans: creator comes from authenticated account and stays unchanged when another account edits', async () => {
  const f = await fixture();
  try {
    const payload = f.planBody();
    const before = await f.store.read(f.source);
    for (const patch of [{ createdBy: 'spoof' }, { createdByName: 'Подмена' }]) {
      assert.equal((await f.request('/api/operator/plans', 'POST', { ...payload, ...patch }, f.operator)).status, 400);
      assert.deepEqual(await f.store.read(f.source), before);
    }
    const created = await f.request('/api/operator/plans', 'POST', payload, f.operator);
    assert.equal(created.status, 201);
    let plan = (await f.read()).plans.find(row => row.id === created.body.id)!;
    assert.equal(plan.createdBy, f.operatorId);
    assert.equal(plan.createdByName, 'Оператор тест');
    assert.equal(Object.hasOwn(plan, 'managerId'), false);
    const createdAt = plan.createdAt;
    const edit = { ...payload, clientName: 'Уточнённый клиент', version: 1, idempotencyKey: randomUUID() };
    assert.equal((await f.request(`/api/operator/plans/${plan.id}`, 'PATCH', edit, f.admin)).status, 200);
    await f.store.mutate(f.source, state => { state.accounts!.users.find(row => row.id === f.operatorId)!.name = 'Новое имя аккаунта'; return { changed: true, result: null }; });
    plan = (await f.read()).plans.find(row => row.id === created.body.id)!;
    assert.equal(plan.createdBy, f.operatorId);
    assert.equal(plan.createdByName, 'Оператор тест', 'creation snapshot survives account rename and another editor');
    assert.equal(plan.createdAt, createdAt);
    const administratorPlan = await f.request('/api/operator/plans', 'POST', f.planBody(), f.admin);
    assert.equal(administratorPlan.status, 201);
    assert.equal((await f.read()).plans.find(row => row.id === administratorPlan.body.id)!.createdByName, 'Синтетический директор');
    const persisted = await new OperationsStore(dirname(f.store.path)).read(f.source);
    assert.equal(persisted.operator!.plans![plan.id].createdByName, 'Оператор тест');
  } finally { await f.close(); }
});

test('operator plans: legacy manager and absent creator snapshot survive restart, exact account projection and original request replay', async () => {
  const f = await fixture();
  try {
    const payload = f.planBody(['10000'], 'eldar');
    const created = await f.request('/api/operator/plans', 'POST', payload, f.operator);
    assert.equal(created.status, 201);
    const id = created.body.id;
    await f.store.mutate(f.source, state => { delete state.operator!.plans![id].createdByName; return { changed: true, result: null }; });
    const before = await f.store.read(f.source);
    assert.equal((await f.read()).plans[0].createdByName, 'Оператор тест');
    assert.deepEqual(await f.store.read(f.source), before, 'legacy creator display is a read projection only');
    assert.equal((await f.request('/api/operator/plans', 'POST', payload, f.operator)).body.replayed, true);
    assert.deepEqual(await f.store.read(f.source), before, 'original legacy replay makes no migration');
    const { managerId: ignored, ...withoutManager } = payload;
    void ignored;
    assert.equal((await f.request(`/api/operator/plans/${id}`, 'PATCH', { ...withoutManager, clientName: 'Уточнено', version: 1, idempotencyKey: randomUUID() }, f.admin)).status, 200);
    const persisted = await new OperationsStore(dirname(f.store.path)).read(f.source);
    assert.equal(persisted.operator!.plans![id].managerId, 'eldar');
    assert.equal(Object.hasOwn(persisted.operator!.plans![id], 'createdByName'), false);
    assert.equal(persisted.operator!.plans![id].createdBy, f.operatorId);
    assert.deepEqual(decodeOperations(encodeOperations(persisted), f.source).operator, persisted.operator);
  } finally { await f.close(); }
});

test('operator plans: used plan edits preserve snapshots, allow unused recipients and valid limits, and reject underfunding atomically', async () => {
  const f = await fixture();
  try {
    const plan = await f.createPlan(['10000', '25000']);
    const saved = await f.request('/api/operator/refuellings', 'POST', f.operation(plan.id, 1, [card(plan.recipients[0].id, '5000')], '5000'), f.operator);
    assert.equal(saved.status, 201);
    const before = await f.store.read(f.source);
    const edit = { clientName: plan.clientName, recipients: plan.recipients, version: 2, idempotencyKey: randomUUID() };
    const invalid = [
      { clientName: 'Другой клиент' },
      { recipients: [plan.recipients[1]] },
      ...(['name', 'bank', 'card', 'phone', 'details'] as const).map(key => ({ recipients: [{ ...plan.recipients[0], [key]: 'Подмена' }, plan.recipients[1]] })),
      { managerId: 'aidar' }, { version: 1 },
    ];
    for (const patch of invalid) {
      const rejected = await f.request(`/api/operator/plans/${plan.id}`, 'PATCH', { ...edit, ...patch, idempotencyKey: randomUUID() }, f.operator);
      assert.equal(rejected.status, 409, JSON.stringify(rejected.body));
      assert.deepEqual(await f.store.read(f.source), before);
    }
    const replacement = f.recipient('7000');
    const valid = { ...edit, recipients: [{ ...plan.recipients[0], limit: '5000' }, replacement] };
    assert.equal((await f.request(`/api/operator/plans/${plan.id}`, 'PATCH', valid, f.operator)).status, 200);
    assert.equal((await f.request(`/api/operator/plans/${plan.id}`, 'PATCH', valid, f.operator)).body.replayed, true);
    const workspace = await f.read();
    assert.equal(workspace.plans[0].version, 3);
    assert.equal(workspace.plans[0].remaining, '7000.00');
    assert.deepEqual(workspace.plans[0].recipients.map(row => row.id), [plan.recipients[0].id, replacement.id]);
    const restarted = await new OperationsStore(dirname(f.store.path)).read(f.source);
    assert.deepEqual(restarted.operator!.refuellings, before.operator!.refuellings, 'editing the plan never rewrites operation snapshots');
  } finally { await f.close(); }
});

test('operator plans: limits remain editable after manager transfer', async () => {
  const f = await fixture();
  try {
    const plan = await f.createPlan(['10000']);
    assert.equal((await f.request('/api/operator/refuellings', 'POST', f.operation(plan.id, 1, [overflow('eldar', '35000')]), f.operator)).status, 201);
    const before = (await f.store.read(f.source)).operator!.refuellings;
    for (const [index, limit] of ['10001', '9999'].entries()) {
      const result = await f.request(`/api/operator/plans/${plan.id}`, 'PATCH', { clientName: plan.clientName, recipients: [{ ...plan.recipients[0], limit }], version: 2 + index, idempotencyKey: randomUUID() }, f.operator);
      assert.equal(result.status, 200);
      assert.deepEqual((await f.store.read(f.source)).operator!.refuellings, before);
    }
  } finally { await f.close(); }
});

test('operator plans: deleting operations restores limits once, keeps history and retries, and permits removing now-unused recipient', async () => {
  const f = await fixture();
  try {
    const plan = await f.createPlan(['10000']);
    const payload = f.operation(plan.id, 1, [card(plan.recipients[0].id, '10000')], '10000');
    const saved = await f.request('/api/operator/refuellings', 'POST', payload, f.operator);
    assert.equal(saved.status, 201);
    const id = saved.body.id;
    const paid = { version: 1, paid: true, idempotencyKey: randomUUID() };
    assert.equal((await f.request(`/api/operator/refuellings/${id}/payment`, 'PATCH', paid, f.operator)).status, 200);
    const beforePaidDelete = await f.store.read(f.source);
    assert.equal((await f.request(`/api/operator/refuellings/${id}/delete`, 'PATCH', { version: 2, idempotencyKey: randomUUID() }, f.operator)).status, 409);
    assert.deepEqual(await f.store.read(f.source), beforePaidDelete);
    const unpaid = { version: 2, paid: false, idempotencyKey: randomUUID() };
    assert.equal((await f.request(`/api/operator/refuellings/${id}/payment`, 'PATCH', unpaid, f.operator)).status, 200);
    const corrected = { ...payload, comment: 'Уточнено', version: 3, planVersion: 2, idempotencyKey: randomUUID() };
    assert.equal((await f.request(`/api/operator/refuellings/${id}`, 'PATCH', corrected, f.operator)).status, 200);
    const before = await f.store.read(f.source);
    const deletion = { version: 4, idempotencyKey: randomUUID() };
    const deleted = await Promise.all(Array.from({ length: 3 }, () => f.request(`/api/operator/refuellings/${id}/delete`, 'PATCH', deletion, f.operator)));
    assert.deepEqual(deleted.map(row => row.status), [200, 200, 200]);
    assert.equal(deleted.filter(row => !row.body.replayed).length, 1);
    assert.ok(deleted.every(row => row.body.deleted));
    let workspace = await f.read();
    assert.deepEqual(workspace.refuellings, []);
    assert.equal(workspace.plans[0].remaining, '10000.00');
    assert.equal(workspace.plans[0].status, 'active');
    assert.equal(workspace.plans[0].version, 4);
    const tombstones = await f.store.read(f.source);
    const tombstone = tombstones.operator!.refuellings[id];
    assert.equal(tombstone.deletedBy, f.operatorId);
    assert.equal(tombstone.deletedByName, 'Оператор тест');
    assert.deepEqual(tombstone.paymentHistory, before.operator!.refuellings[id].paymentHistory);
    for (const [path, method, body] of [
      ['/api/operator/refuellings', 'POST', payload],
      [`/api/operator/refuellings/${id}`, 'PATCH', corrected],
      [`/api/operator/refuellings/${id}/payment`, 'PATCH', paid],
      [`/api/operator/refuellings/${id}/payment`, 'PATCH', unpaid],
    ] as const) {
      const replay = await f.request(path, method, body, f.operator);
      assert.equal(replay.body.replayed, true);
      assert.equal(replay.body.deleted, true);
      assert.deepEqual(await f.store.read(f.source), tombstones, 'old creation/edit/payment retry must never resurrect deleted operation');
    }
    assert.equal((await f.request(`/api/operator/refuellings/${id}/payment`, 'PATCH', { version: 5, paid: true, idempotencyKey: randomUUID() }, f.operator)).status, 409);
    assert.equal((await f.request(`/api/operator/refuellings/${id}`, 'PATCH', { ...corrected, version: 5, idempotencyKey: randomUUID() }, f.operator)).status, 409);
    const editPlan = { clientName: 'Исправленный клиент', recipients: [f.recipient('20000')], version: 4, idempotencyKey: randomUUID() };
    assert.equal((await f.request(`/api/operator/plans/${plan.id}`, 'PATCH', editPlan, f.operator)).status, 200);
    workspace = await f.read();
    assert.equal(workspace.plans[0].remaining, '20000.00');
    const restarted = await new OperationsStore(dirname(f.store.path)).read(f.source);
    assert.deepEqual(restarted.operator!.refuellings[id], tombstone);
    assert.deepEqual(decodeOperations(encodeOperations(restarted), f.source).operator, restarted.operator);
  } finally { await f.close(); }
});

test('operator plans: deletion leaves independent manager transfers intact, rejects stale or unauthorized requests and has no plan delete route', async () => {
  const f = await fixture();
  try {
    const plan = await f.createPlan(['20000']);
    const first = await f.request('/api/operator/refuellings', 'POST', f.operation(plan.id, 1, [card(plan.recipients[0].id, '10000')], '10000'), f.operator);
    const last = await f.request('/api/operator/refuellings', 'POST', f.operation(plan.id, 2, [card(plan.recipients[0].id, '10000'), overflow('eldar', '25000')]), f.operator);
    assert.equal(first.status, 201); assert.equal(last.status, 201);
    const before = await f.store.read(f.source);
    const deletion = { version: 1, idempotencyKey: randomUUID() };
    assert.equal((await f.request(`/api/operator/refuellings/${last.body.id}/delete`, 'PATCH', deletion)).status, 401);
    assert.equal((await f.request(`/api/operator/refuellings/${last.body.id}/delete`, 'PATCH', deletion, f.operator, { Origin: 'https://untrusted.example' })).status, 403);
    assert.equal((await f.request(`/api/operator/refuellings/${last.body.id}/delete`, 'PATCH', { ...deletion, version: 9 }, f.operator)).status, 409);
    assert.equal((await f.request(`/api/operator/plans/${plan.id}/delete`, 'PATCH', { ...deletion, version: 3 }, f.operator)).status, 404);
    const dependent = await f.request(`/api/operator/refuellings/${first.body.id}/delete`, 'PATCH', deletion, f.operator);
    assert.equal(dependent.status, 200);
    assert.deepEqual((await f.store.read(f.source)).operator!.refuellings[last.body.id], before.operator!.refuellings[last.body.id]);
    assert.equal((await f.request(`/api/operator/refuellings/${last.body.id}/delete`, 'PATCH', { ...deletion, idempotencyKey: randomUUID() }, f.operator)).status, 200);
    assert.equal((await f.read()).plans[0].remaining, '20000.00');
    await f.store.mutate(f.source, state => { state.accounts!.users.find(row => row.id === f.operatorId)!.sections = []; return { changed: true, result: null }; });
    assert.equal((await f.request(`/api/operator/refuellings/${last.body.id}/delete`, 'PATCH', deletion, f.operator)).status, 403, 'revoked access cannot even replay deletion');
  } finally { await f.close(); }
});

test('operator plans: 10,000 + 25,000 card split reserves on save, completes, concurrent replay is debit-free and restart keeps snapshots', async () => {
  const f = await fixture();
  try {
    const before = await f.store.read(f.source);
    assert.deepEqual((await f.read()).plans, []);
    assert.equal(before.operator, undefined, 'reading empty plans must not migrate old storage');
    const plan = await f.createPlan();
    const request = f.operation(plan.id, 1, [card(plan.recipients[0].id, '10000'), card(plan.recipients[1].id, '25000')]);
    const saved = await Promise.all(Array.from({ length: 4 }, () => f.request('/api/operator/refuellings', 'POST', request, f.operator)));
    assert.deepEqual(saved.map(row => row.status).sort(), [200, 200, 200, 201]);
    assert.equal(new Set(saved.map(row => row.body.id)).size, 1);
    const workspace = await f.read();
    const result = workspace.plans[0];
    assert.equal(result.version, 2);
    assert.deepEqual(result.recipients.map(row => [row.used, row.remaining]), [['10000.00', '0.00'], ['25000.00', '0.00']]);
    assert.equal(result.status, 'completed');
    assert.equal(result.totalLimit, '35000.00');
    assert.equal(result.allocated, '35000.00');
    assert.equal(result.remaining, '0.00');
    const operation = workspace.refuellings[0] as OperatorRefuellingV3;
    assert.equal(operation.paid, false);
    assert.equal(operation.planClientName, 'ООО СИНТЕТИКА');
    assert.equal(operation.allocations[0].kind, 'recipient');
    assert.match(operation.recipientText, /Тестовый банк/);
    const paid = { version: 1, paid: true, idempotencyKey: randomUUID() };
    assert.equal((await f.request(`/api/operator/refuellings/${operation.id}/payment`, 'PATCH', paid, f.operator)).status, 200);
    assert.deepEqual((await f.read()).plans, workspace.plans, 'payment is not a second allocation');
    assert.equal((await f.request('/api/operator/refuellings', 'POST', request, f.operator)).body.replayed, true);
    assert.equal((await f.request(`/api/operator/refuellings/${operation.id}`, 'PATCH', { ...request, version: 2, planVersion: 2, idempotencyKey: randomUUID() }, f.operator)).status, 409);
    const restarted = await new OperationsStore(dirname(f.store.path)).read(f.source);
    assert.deepEqual(decodeOperations(encodeOperations(restarted), f.source).operator, restarted.operator);
    assert.deepEqual(restarted.operator!.refuellings[operation.id].paymentHistory.map(event => event.paid), [true]);
    const { operator: ignored, revision: ignoredRevision, ...rest } = restarted;
    const { operator: ignoredBefore, revision: ignoredBeforeRevision, ...prior } = before;
    void ignored; void ignoredRevision; void ignoredBefore; void ignoredBeforeRevision;
    assert.deepEqual(rest, prior, 'all unrelated records are preserved');
  } finally { await f.close(); }
});

test('operator plans: last card 10,000 and 25,000 manager remainder persists for either selected manager', async () => {
  const f = await fixture();
  try {
    for (const managerId of ['aidar', 'eldar'] as const) {
      const plan = await f.createPlan(['10000']);
      const saved = await f.request('/api/operator/refuellings', 'POST', f.operation(plan.id, 1, [card(plan.recipients[0].id, '10000'), overflow(managerId, '25000')]), f.operator);
      assert.equal(saved.status, 201, JSON.stringify(saved.body));
      const workspace = await f.read();
      const current = workspace.plans.find(row => row.id === plan.id)!;
      assert.equal(current.status, 'completed');
      assert.equal(current.allocated, '10000.00', 'manager overflow does not inflate card allocation');
      const row = workspace.refuellings.find(row => row.id === saved.body.id) as OperatorRefuellingV3;
      assert.deepEqual(row.allocations[1], { planId: plan.id, planClientName: plan.clientName, kind: 'manager', managerId, amount: '25000.00' });
      assert.match(row.recipientText, managerId === 'aidar' ? /Айдар/ : /Эльдар/);
      assert.deepEqual((await new OperationsStore(dirname(f.store.path)).read(f.source)).operator!.refuellings[row.id], row);
    }
  } finally { await f.close(); }
});

test('operator plans: exact cents, atomic stale concurrent saves, no double reservation and safe edit/reopen', async () => {
  const f = await fixture();
  try {
    const plan = await f.createPlan(['0.10', '0.20']);
    const first = f.operation(plan.id, 1, [card(plan.recipients[0].id, '0.10')], '0.10');
    const replies = await Promise.all([f.request('/api/operator/refuellings', 'POST', first, f.operator), f.request('/api/operator/refuellings', 'POST', { ...first, idempotencyKey: randomUUID() }, f.operator)]);
    assert.deepEqual(replies.map(row => row.status).sort(), [201, 409]);
    const firstId = replies.find(row => row.status === 201)!.body.id;
    let workspace = await f.read();
    assert.equal(workspace.plans[0].remaining, '0.20');
    const second = await f.request('/api/operator/refuellings', 'POST', f.operation(plan.id, 2, [card(plan.recipients[1].id, '0.20')], '0.20'), f.operator);
    assert.equal(second.status, 201);
    assert.equal((await f.read()).plans[0].status, 'completed');
    const edit = { ...f.operation(plan.id, 3, [card(plan.recipients[0].id, '0.05')], '0.05'), version: 1 };
    assert.equal((await f.request(`/api/operator/refuellings/${firstId}`, 'PATCH', edit, f.operator)).status, 200);
    workspace = await f.read();
    assert.equal(workspace.plans[0].remaining, '0.05');
    assert.equal(workspace.plans[0].status, 'active');
    assert.equal(workspace.plans[0].version, 4);
    assert.equal((await f.request(`/api/operator/refuellings/${firstId}`, 'PATCH', edit, f.operator)).body.replayed, true);
    assert.equal((await f.read()).plans[0].version, 4);
    const close = { ...f.operation(plan.id, 4, [card(plan.recipients[0].id, '0.10')], '0.10'), version: 2 };
    assert.equal((await f.request(`/api/operator/refuellings/${firstId}`, 'PATCH', close, f.operator)).status, 200, 'editing releases its own original allocation first');
    assert.equal((await f.read()).plans[0].allocated, '0.30');
    assert.equal((await f.read()).plans[0].status, 'completed');
  } finally { await f.close(); }
});

test('operator plans: validation failures leave storage unchanged and manager transfers are unrestricted', async () => {
  const f = await fixture();
  try {
    const plan = await f.createPlan(['10000', '25000']);
    const base = f.operation(plan.id, 1, [card(plan.recipients[0].id, '10000'), card(plan.recipients[1].id, '25000')]);
    const before = await f.store.read(f.source);
    const invalid = [
      { allocations: [card(plan.recipients[0].id, '5000')] },
      { allocations: [card(randomUUID(), '35000')] },
      { allocations: [card(plan.recipients[0].id, '5000'), card(plan.recipients[0].id, '5000'), card(plan.recipients[1].id, '25000')] },
      { allocations: [card(plan.recipients[0].id, '10000.001'), card(plan.recipients[1].id, '24999.999')] },
      { allocations: [card(plan.recipients[0].id, '-1'), card(plan.recipients[1].id, '35001')] },
      { allocations: [card(plan.recipients[0].id, '0'), card(plan.recipients[1].id, '35000')] },
      { allocations: [{ ...card(plan.recipients[0].id, '10000'), recipient: { name: 'Подмена' } }, card(plan.recipients[1].id, '25000')] },
      { planVersion: 0 }, { planId: '__proto__' }, { recipientText: 'Подмена' },
      { amount: '0.00', amountMode: 'auto', litres: '0.01', pricePerLitre: '0.01' },
    ];
    for (const patch of invalid) {
      const rejected = await f.request('/api/operator/refuellings', 'POST', { ...base, ...patch, idempotencyKey: randomUUID() }, f.operator);
      assert.ok([400, 409].includes(rejected.status), JSON.stringify({ patch, rejected }));
      assert.deepEqual(await f.store.read(f.source), before, 'failed allocation changes no persisted data');
    }
    const success = await f.request('/api/operator/refuellings', 'POST', base, f.operator);
    assert.equal(success.status, 201);
    assert.equal((await f.request('/api/operator/refuellings', 'POST', { ...base, planVersion: 2, allocations: [overflow('eldar', '35000')], idempotencyKey: randomUUID() }, f.operator)).status, 201, 'manager-only operations are allowed at any stage');
  } finally { await f.close(); }
});

test('operator plans: edits can reopen despite another manager transfer', async () => {
  const f = await fixture();
  try {
    const plan = await f.createPlan(['20000']);
    const first = await f.request('/api/operator/refuellings', 'POST', f.operation(plan.id, 1, [card(plan.recipients[0].id, '10000')], '10000'), f.operator);
    const last = await f.request('/api/operator/refuellings', 'POST', f.operation(plan.id, 2, [card(plan.recipients[0].id, '10000'), overflow('eldar', '25000')]), f.operator);
    assert.equal(first.status, 201); assert.equal(last.status, 201);
    const before = await f.store.read(f.source);
    const editEarlier = { ...f.operation(plan.id, 3, [card(plan.recipients[0].id, '5000')], '5000'), version: 1 };
    assert.equal((await f.request(`/api/operator/refuellings/${first.body.id}`, 'PATCH', editEarlier, f.operator)).status, 200);
    assert.deepEqual((await f.store.read(f.source)).operator!.refuellings[last.body.id], before.operator!.refuellings[last.body.id]);
    const editLast = { ...f.operation(plan.id, 4, [card(plan.recipients[0].id, '5000')], '5000'), version: 1 };
    assert.equal((await f.request(`/api/operator/refuellings/${last.body.id}`, 'PATCH', editLast, f.operator)).status, 200);
    assert.equal((await f.read()).plans[0].remaining, '10000.00');
    assert.equal((await f.read()).plans[0].status, 'active');
  } finally { await f.close(); }
});

test('operator plans: idempotent creation, pre-use editing, used client protection and no operation detach or movement', async () => {
  const f = await fixture();
  try {
    const payload = f.planBody();
    const created = await Promise.all(Array.from({ length: 3 }, () => f.request('/api/operator/plans', 'POST', payload, f.operator)));
    assert.deepEqual(created.map(row => row.status).sort(), [200, 200, 201]);
    const id = created[0].body.id;
    assert.equal((await f.request('/api/operator/plans', 'POST', payload, f.admin)).status, 409);
    assert.equal((await f.request('/api/operator/plans', 'POST', { ...payload, clientName: 'Другая компания' }, f.operator)).status, 409);
    const edit = { ...payload, clientName: 'Уточнённый клиент', version: 1, idempotencyKey: randomUUID() };
    assert.equal((await f.request(`/api/operator/plans/${id}`, 'PATCH', edit, f.operator)).status, 200);
    const operation = f.operation(id, 2, [card(payload.recipients[0].id, '10000'), card(payload.recipients[1].id, '25000')]);
    const saved = await f.request('/api/operator/refuellings', 'POST', operation, f.operator);
    assert.equal(saved.status, 201);
    assert.equal((await f.request(`/api/operator/plans/${id}`, 'PATCH', { ...edit, clientName: 'Другой клиент после операции', version: 3, idempotencyKey: randomUUID() }, f.operator)).status, 409);
    const second = await f.createPlan();
    assert.equal((await f.request(`/api/operator/refuellings/${saved.body.id}`, 'PATCH', { ...f.operation(second.id, 1, [card(second.recipients[0].id, '10000'), card(second.recipients[1].id, '25000')]), version: 1 }, f.operator)).status, 400);
    const { planId: omittedPlan, planVersion: omittedVersion, allocations: omittedAllocations, ...v2 } = operation;
    void omittedPlan; void omittedVersion; void omittedAllocations;
    assert.equal((await f.request(`/api/operator/refuellings/${saved.body.id}`, 'PATCH', { ...v2, schemaVersion: 2, recipientText: 'Свободный получатель', version: 1, idempotencyKey: randomUUID() }, f.operator)).status, 400);
    assert.equal((await f.read()).refuellings[0].schemaVersion, 3);
  } finally { await f.close(); }
});

test('operator plans: reject invalid plans and revoked access, including replay; preserve optional storage', async () => {
  const f = await fixture();
  try {
    const payload = f.planBody();
    assert.equal((await f.request('/api/operator/plans', 'POST', payload)).status, 401);
    assert.equal((await f.request('/api/operator/plans', 'POST', payload, f.operator, { Origin: 'https://untrusted.example' })).status, 403);
    const before = await f.store.read(f.source);
    for (const patch of [{ clientName: '' }, { managerId: 'unknown' }, { recipients: [] }, { recipients: [payload.recipients[0], payload.recipients[0]] }, { recipients: [{ ...payload.recipients[0], limit: '0' }] }, { recipients: [{ ...payload.recipients[0], limit: '1.001' }] }, { recipients: [{ ...payload.recipients[0], id: '__proto__' }] }, { status: 'completed' }]) {
      assert.equal((await f.request('/api/operator/plans', 'POST', { ...payload, ...patch, idempotencyKey: randomUUID() }, f.operator)).status, 400);
      assert.deepEqual(await f.store.read(f.source), before);
    }
    const saved = await f.request('/api/operator/plans', 'POST', payload, f.operator);
    assert.equal(saved.status, 201);
    await f.store.mutate(f.source, state => { state.accounts!.users.find(row => row.id === f.operatorId)!.sections = []; return { changed: true, result: null }; });
    assert.equal((await f.request('/api/operator/plans', 'POST', payload, f.operator)).status, 403);
    assert.equal((await f.request('/api/operator', 'GET', undefined, f.operator)).status, 403);
    const legacy = await f.store.read(f.source);
    delete legacy.operator;
    assert.equal(decodeOperations(encodeOperations(legacy), f.source).operator, undefined);
  } finally { await f.close(); }
});

test('operator plans: persisted corruption of sums, links, snapshots, balance and computed status is rejected', async () => {
  const f = await fixture();
  try {
    const plan = await f.createPlan(['10000']);
    const saved = await f.request('/api/operator/refuellings', 'POST', f.operation(plan.id, 1, [card(plan.recipients[0].id, '10000'), overflow('eldar', '25000')]), f.operator);
    assert.equal(saved.status, 201);
    const data = await f.store.read(f.source);
    const damage = (change: (row: OperatorRefuellingV3, draft: typeof data) => void) => {
      const draft = structuredClone(data);
      change(draft.operator!.refuellings[saved.body.id] as OperatorRefuellingV3, draft);
      assert.throws(() => encodeOperations(draft));
    };
    damage(row => { row.amount = '1.00'; });
    damage(row => { row.planId = randomUUID(); });
    damage(row => { row.planClientName = 'Подмена'; });
    damage(row => { row.recipientText = 'Подмена'; });
    damage(row => { if (row.allocations[0].kind === 'recipient') row.allocations[0].recipient.bank = 'Подмена'; });
    damage(row => { if (row.allocations[0].kind === 'recipient') row.allocations[0].recipientId = randomUUID(); });
    damage(row => { row.allocations.push(row.allocations[0]); });
    damage((_row, draft) => { Object.assign(draft.operator!.plans![plan.id], { status: 'active' }); });
    damage(row => { row.allocations[1] = { kind: 'manager', managerId: 'invalid' as OperatorManagerId, amount: '25000.00' }; });
    assert.deepEqual(decodeOperations(encodeOperations(data), f.source).operator, data.operator);
  } finally { await f.close(); }
});

test('operator plans: all 50 valid maximum-length recipients produce a restart-safe derived snapshot', async () => {
  const f = await fixture();
  try {
    const payload = f.planBody();
    payload.recipients = Array.from({ length: 50 }, () => ({ ...f.recipient('1'), name: 'N'.repeat(500), bank: 'B'.repeat(500), card: 'C'.repeat(500), phone: 'P'.repeat(500), details: 'D'.repeat(2000) }));
    assert.ok(Buffer.byteLength(JSON.stringify(payload)) < 262144);
    const created = await f.request('/api/operator/plans', 'POST', payload, f.operator);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const saved = await f.request('/api/operator/refuellings', 'POST', f.operation(created.body.id, 1, payload.recipients.map(row => card(row.id, '1')), '50'), f.operator);
    assert.equal(saved.status, 201, JSON.stringify(saved.body));
    const workspace = await f.read();
    assert.equal(workspace.plans[0].status, 'completed');
    const row = workspace.refuellings[0] as OperatorRefuellingV3;
    assert.ok(row.recipientText.length > 200000);
    assert.deepEqual((await new OperationsStore(dirname(f.store.path)).read(f.source)).operator!.refuellings[row.id], row);
  } finally { await f.close(); }
});

test('one operation splits 20000/10000 across tasks, permits early manager and over-limit allocation, and versions every affected task', async () => {
  const f = await fixture();
  try {
    const north = await f.createPlan(['250000']), volga = await f.createPlan(['50000']);
    const initial = await f.request('/api/operator/refuellings', 'POST', f.operation(north.id, 1, [card(north.recipients[0].id, '230000')], '230000'), f.operator);
    assert.equal(initial.status, 201);
    const payload = f.operation(north.id, 2, [card(north.recipients[0].id, '20000'), { ...card(volga.recipients[0].id, '10000'), planId: volga.id, planVersion: 1 }], '30000');
    const attempts = [payload, { ...payload, idempotencyKey: randomUUID() }];
    const results = await Promise.all(attempts.map(body => f.request('/api/operator/refuellings', 'POST', body, f.operator)));
    assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
    const winner = results.findIndex(r => r.status === 201), created = results[winner];
    assert.equal((await f.request('/api/operator/refuellings', 'POST', attempts[winner], f.operator)).body.replayed, true);
    assert.equal((await f.request('/api/operator/refuellings', 'POST', attempts[1 - winner], f.operator)).status, 409);
    let work = await f.read();
    assert.equal(work.plans.find(p => p.id === north.id)!.allocated, '250000.00');
    assert.equal(work.plans.find(p => p.id === volga.id)!.allocated, '10000.00');
    const early = await f.request('/api/operator/refuellings', 'POST', f.operation(volga.id, 2, [overflow('aidar', '5000')], '5000'), f.operator);
    assert.equal(early.status, 201);
    const over = await f.request('/api/operator/refuellings', 'POST', f.operation(north.id, 3, [card(north.recipients[0].id, '20000')], '20000'), f.operator);
    assert.equal(over.status, 201);
    work = await f.read();
    assert.equal(work.plans.find(p => p.id === north.id)!.allocated, '270000.00');
    assert.equal(work.plans.find(p => p.id === north.id)!.remaining, '-20000.00');
    assert.equal(work.plans.find(p => p.id === north.id)!.status, 'completed');
    const row = work.refuellings.find(r => r.id === created.body.id) as OperatorRefuellingV3;
    assert.equal(row.allocations[1].planId, volga.id);
    const removal = await f.request(`/api/operator/refuellings/${row.id}/delete`, 'PATCH', { version: row.version, idempotencyKey: randomUUID() }, f.operator);
    assert.equal(removal.status, 200);
    work = await f.read();
    assert.equal(work.plans.find(p => p.id === north.id)!.allocated, '250000.00');
    assert.equal(work.plans.find(p => p.id === volga.id)!.allocated, '0.00');
    assert.deepEqual((await new OperationsStore(dirname(f.store.path)).read(f.source)).operator, (await f.store.read(f.source)).operator);
  } finally { await f.close(); }
});
