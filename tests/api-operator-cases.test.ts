import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { dirname } from 'node:path';
import test from 'node:test';
import { createSnapshotMiddleware } from '../server/local-api';
import { OperationsStore, encodeOperations, decodeOperations } from '../server/operations-store';
import { validateOperator, readOperator } from '../server/operator';
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

test('operator v3 without a group supports paid source, carryover and reload without changing older groups', async () => {
  const f = await fixture();
  try {
    const legacy = await f.save();
    const noGroup = await f.save({ groupId: undefined });
    assert.equal(Object.hasOwn(noGroup.row, 'groupId'), false); assert.equal(Object.hasOwn(noGroup.row, 'groupName'), false);
    const credit = await f.claim(noGroup.row);
    const task = await f.request(`/api/operator/cases/${credit.row.id}/task`, 'PATCH', { version: 1, dueDate: '2026-10-21', comment: 'Зачесть при следующей заправке', idempotencyKey: randomUUID() }, f.operator);
    assert.equal(task.status, 200); assert.equal(task.body.version, 2);
    const beforeStale = await readFile(f.store.path, 'utf8');
    const stale = await f.operation({ groupId: undefined, amount: '61200.00', carryovers: [{ caseId: credit.row.id, version: 1, litres: '50' }] });
    assert.equal((await f.request('/api/operator/refuellings', 'POST', stale, f.operator)).status, 409);
    assert.equal(await readFile(f.store.path, 'utf8'), beforeStale);
    const carried = await f.save({ groupId: undefined, amount: '61200.00', carryovers: [{ caseId: credit.row.id, version: 2, litres: '50' }] });
    assert.equal(carried.row.creditedAmount, '3600.00'); assert.equal(carried.row.amount, '61200.00');
    assert.equal(Object.hasOwn(carried.row, 'groupId'), false);
    const fulfilled = (await f.read()).cases.find(row => row.id === credit.row.id)!;
    assert.equal(fulfilled.status, 'completed'); assert.equal(fulfilled.version, 3);
    assert.equal(fulfilled.taskHistory?.length, 1); assert.equal(fulfilled.taskHistory![0].id, task.body.taskEventId);
    const stored = await new OperationsStore(dirname(f.store.path)).read(f.source);
    assert.deepEqual(stored.operator!.refuellings[legacy.row.id], legacy.row);
    assert.deepEqual(decodeOperations(encodeOperations(stored), f.source).operator, stored.operator);
    const bytes = await readFile(f.store.path, 'utf8');
    await f.read(); assert.equal(await readFile(f.store.path, 'utf8'), bytes);
  } finally { await f.close(); }
});

test('operator case tasks are manual, keep financial facts and creator, audit transfers, and replay exact event results after settlement and restart', async () => {
  const f = await fixture();
  try {
    const source = await f.save({ groupId: undefined, amountMode: 'manual', amount: '63000.00' });
    const created = await f.claim(source.row), id = created.row.id;
    assert.equal(Object.hasOwn(created.row, 'task'), false); assert.equal(Object.hasOwn(created.row, 'taskHistory'), false);
    const oldBytes = await readFile(f.store.path, 'utf8');
    await f.read(); assert.equal(await readFile(f.store.path, 'utf8'), oldBytes);
    const before = await f.store.read(f.source), financial = (row: typeof created.row) => ({ source: row.source, litres: row.litres, amount: row.amount, settlements: row.settlements, remainingLitres: row.remainingLitres, remainingAmount: row.remainingAmount, status: row.status });
    const body = { version: 1, dueDate: '2026-10-21', comment: '  Согласовать возврат с водителем  ', idempotencyKey: randomUUID() };
    const replies = await Promise.all([1, 2].map(() => f.request(`/api/operator/cases/${id}/task`, 'PATCH', body, f.admin)));
    assert.ok(replies.every(row => row.status === 200));
    assert.equal(new Set(replies.map(row => row.body.taskEventId)).size, 1);
    const firstReply = replies.find(row => !row.body.replayed)!.body;
    assert.equal(firstReply.version, 2); assert.ok(firstReply.taskEventId);
    let row = (await f.read()).cases.find(row => row.id === id)!;
    assert.deepEqual(financial(row), financial(created.row));
    assert.equal(row.taskHistory?.length, 1); assert.equal(row.taskHistory![0].id, firstReply.taskEventId);
    const director = before.accounts!.users.find(row => row.role === 'director')!;
    assert.equal(row.task!.createdBy, director.id); assert.equal(row.task!.createdByName, director.name);
    assert.equal(row.task!.comment, body.comment.trim());
    const originalTask = structuredClone(row.task!);
    const move = { version: 2, dueDate: '2026-10-22', comment: 'Водитель подъедет завтра', idempotencyKey: randomUUID() };
    const moved = await f.request(`/api/operator/cases/${id}/task`, 'PATCH', move, f.operator);
    assert.equal(moved.status, 200); assert.equal(moved.body.version, 3);
    row = (await f.read()).cases.find(row => row.id === id)!;
    assert.equal(row.task!.createdBy, originalTask.createdBy); assert.equal(row.task!.createdAt, originalTask.createdAt); assert.equal(row.task!.createdByName, originalTask.createdByName);
    assert.notEqual(row.task!.updatedBy, row.task!.createdBy); assert.equal(row.task!.dueDate, move.dueDate);
    assert.deepEqual(financial(row), financial(created.row));
    const part = { version: 3, method: 'fuel', litres: '20', idempotencyKey: randomUUID() };
    const settled = await f.request(`/api/operator/cases/${id}/settle`, 'PATCH', part, f.operator);
    assert.equal(settled.status, 200); assert.equal(settled.body.version, 4);
    row = (await f.read()).cases.find(row => row.id === id)!;
    assert.equal(row.status, 'open'); assert.equal(row.remainingLitres, '30'); assert.equal(row.remainingAmount, '2160.00');
    assert.equal(row.task!.dueDate, move.dueDate);
    const nextMove = { version: 4, dueDate: '2026-10-23', comment: '', idempotencyKey: randomUUID() };
    assert.equal((await f.request(`/api/operator/cases/${id}/task`, 'PATCH', nextMove, f.operator)).status, 200);
    const complete = await f.request(`/api/operator/cases/${id}/settle`, 'PATCH', { version: 5, method: 'money', idempotencyKey: randomUUID() }, f.operator);
    assert.equal(complete.status, 200); assert.equal(complete.body.version, 6);
    row = (await f.read()).cases.find(row => row.id === id)!;
    assert.equal(row.status, 'completed'); assert.equal(row.taskHistory?.length, 3); assert.equal(row.settlements.length, 2);
    const closedBytes = await readFile(f.store.path, 'utf8');
    assert.equal((await f.request(`/api/operator/cases/${id}/task`, 'PATCH', { ...nextMove, version: 6, idempotencyKey: randomUUID() }, f.operator)).status, 409);
    assert.deepEqual((await f.request(`/api/operator/cases/${id}/task`, 'PATCH', body, f.admin)).body, { ...firstReply, replayed: true });
    assert.deepEqual((await f.request(`/api/operator/cases/${id}/task`, 'PATCH', move, f.operator)).body, { ...moved.body, replayed: true });
    assert.deepEqual((await f.request(`/api/operator/cases/${id}/settle`, 'PATCH', part, f.operator)).body, { ...settled.body, replayed: true });
    assert.deepEqual((await f.request('/api/operator/cases', 'POST', created.payload, f.operator)).body, { ...created.result, replayed: true });
    assert.equal(await readFile(f.store.path, 'utf8'), closedBytes);
    const persisted = await new OperationsStore(dirname(f.store.path)).read(f.source);
    assert.deepEqual(persisted.operator!.refuellings, before.operator!.refuellings); assert.deepEqual(persisted.operator!.plans, before.operator!.plans); assert.deepEqual(persisted.push, before.push);
    assert.deepEqual(decodeOperations(encodeOperations(persisted), f.source).operator, persisted.operator);
    for (const corrupt of [
      (state: typeof persisted) => { delete state.operator!.cases![id].taskHistory; },
      (state: typeof persisted) => { state.operator!.cases![id].taskHistory = []; },
      (state: typeof persisted) => { state.operator!.cases![id].task!.createdBy = 'forged'; },
      (state: typeof persisted) => { state.operator!.cases![id].task!.comment = 'forged'; },
      (state: typeof persisted) => { state.operator!.cases![id].taskHistory![0].dueDate = '2026-02-30'; },
      (state: typeof persisted) => { state.operator!.cases![id].taskHistory![0].id = state.operator!.cases![id].settlements[0].id; },
      (state: typeof persisted) => { state.operator!.cases![id].version++; },
      (state: typeof persisted) => { state.operator!.requests[body.idempotencyKey].taskEventId = randomUUID(); },
      (state: typeof persisted) => { state.operator!.requests[body.idempotencyKey].settlementId = row.settlements[0].id; },
    ]) { const damaged = structuredClone(persisted); corrupt(damaged); assert.throws(() => encodeOperations(damaged)); }
  } finally { await f.close(); }
});

test('operator case tasks share a stale-write guard with fulfillment, enforce access and reject invalid dates or financial payloads without mutations', async () => {
  const f = await fixture();
  try {
    const source = await f.save(), created = await f.claim(source.row, 'deferred'), id = created.row.id;
    const task = { version: 1, dueDate: '2026-10-21', comment: '', idempotencyKey: randomUUID() }, path = `/api/operator/cases/${id}/task`;
    const before = await readFile(f.store.path, 'utf8');
    assert.equal((await f.request(path, 'PATCH', task)).status, 401);
    assert.equal((await f.request(path, 'PATCH', task, f.denied)).status, 403);
    for (const patch of [{ dueDate: '' }, { dueDate: '2026-02-30' }, { dueDate: '21.10.2026' }, { comment: 'x'.repeat(2001) }, { comment: null }, { comment: '\0' }, { createdBy: 'forged' }, { litres: '1' }, { amount: '1' }, { method: 'money' }]) {
      assert.equal((await f.request(path, 'PATCH', { ...task, ...patch, idempotencyKey: randomUUID() }, f.operator)).status, 400);
    }
    assert.equal((await f.request(`/api/operator/cases/${randomUUID()}/task`, 'PATCH', task, f.operator)).status, 404);
    assert.equal(await readFile(f.store.path, 'utf8'), before);
    const race = await Promise.all([
      f.request(path, 'PATCH', task, f.operator),
      f.request(`/api/operator/cases/${id}/settle`, 'PATCH', { version: 1, method: 'fuel', litres: '800', idempotencyKey: randomUUID() }, f.operator),
    ]);
    assert.deepEqual(race.map(row => row.status).sort(), [200, 409]);
    const current = (await f.read()).cases.find(row => row.id === id)!;
    assert.equal(current.version, 2); assert.equal(current.settlements.length + (current.taskHistory?.length ?? 0), 1);
    assert.equal(current.remainingLitres, race[0].status === 200 ? '900' : '100'); assert.equal(current.status, 'open');
    const newTask = { ...task, version: current.version, dueDate: '2028-02-29', idempotencyKey: randomUUID() };
    const accepted = await f.request(path, 'PATCH', newTask, f.operator); assert.equal(accepted.status, 200);
    const after = await readFile(f.store.path, 'utf8');
    assert.equal((await f.request(path, 'PATCH', newTask, f.admin)).status, 409);
    assert.equal((await f.request(path, 'PATCH', { ...newTask, comment: 'different' }, f.operator)).status, 409);
    assert.equal((await f.request(path, 'PATCH', { ...newTask, idempotencyKey: randomUUID() }, f.operator)).status, 409);
    assert.equal(await readFile(f.store.path, 'utf8'), after);
  } finally { await f.close(); }
});

test('operator cases: read accepts old bytes, manual amount does not change original discounted refund, replay and cash preserve source and limits', async () => {
  const f = await fixture();
  try {
    const { row } = await f.save({ amount: '63000.00', amountMode: 'manual' });
    const before = await f.store.read(f.source), bytes = JSON.stringify(before.operator);
    validateOperator(before.operator);
    const actor = before.accounts!.users.find(item => item.role === 'director')!;
    assert.deepEqual(readOperator(before, actor).cases, []);
    assert.equal(JSON.stringify(before.operator), bytes);
    assert.equal(before.operator!.cases, undefined);
    const created = await f.claim(row);
    assert.equal(created.row.amount, '3600.00');
    assert.equal(created.row.source.amount, '63000.00');
    assert.equal(created.row.source.driverName, row.name);
    const after = await f.store.read(f.source);
    assert.deepEqual(after.operator!.refuellings, before.operator!.refuellings);
    assert.deepEqual(after.operator!.plans, before.operator!.plans);
    assert.deepEqual(after.push, before.push);
    const paid = { version: 1, method: 'money', idempotencyKey: randomUUID() };
    const settlement = await f.request(`/api/operator/cases/${created.row.id}/settle`, 'PATCH', paid, f.operator);
    assert.equal(settlement.status, 200);
    assert.equal(settlement.body.version, 2);
    assert.ok(settlement.body.settlementId);
    assert.deepEqual((await f.request(`/api/operator/cases/${created.row.id}/settle`, 'PATCH', paid, f.operator)).body, { ...settlement.body, replayed: true });
    const replay = await f.request('/api/operator/cases', 'POST', created.payload, f.operator);
    assert.equal(replay.status, 200);
    assert.equal(replay.body.version, 1);
    const result = (await f.read()).cases[0];
    assert.equal(result.remainingLitres, '0'); assert.equal(result.remainingAmount, '0.00');
    assert.equal(result.settlements[0].amount, '3600.00'); assert.equal(result.status, 'completed');
    const persisted = await new OperationsStore(dirname(f.store.path)).read(f.source);
    assert.deepEqual(persisted.operator!.cases![created.row.id], result && (await f.store.read(f.source)).operator!.cases![created.row.id]);
    assert.deepEqual(decodeOperations(encodeOperations(persisted), f.source).operator, persisted.operator);
    assert.equal((await f.request('/api/operator/cases', 'POST', f.claimBody(row, 'return', '851'), f.operator)).status, 409);
  } finally { await f.close(); }
});

test('operator cases: deferred 900 partially fulfilled 800 leaves 100, versions prevent races and source mutations are rejected', async () => {
  const f = await fixture();
  try {
    const { row, payload } = await f.save();
    const created = await f.claim(row, 'deferred');
    assert.equal((await f.request(`/api/operator/cases/${created.row.id}/settle`, 'PATCH', { version: 1, method: 'money', idempotencyKey: randomUUID() }, f.operator)).status, 400);
    const settle = { version: 1, method: 'fuel', litres: '800', idempotencyKey: randomUUID() };
    const results = await Promise.all([settle, { ...settle, idempotencyKey: randomUUID() }].map(body => f.request(`/api/operator/cases/${created.row.id}/settle`, 'PATCH', body, f.operator)));
    assert.deepEqual(results.map(item => item.status).sort(), [200, 409]);
    const current = (await f.read()).cases[0];
    assert.equal(current.remainingLitres, '100'); assert.equal(current.remainingAmount, '7200.00'); assert.equal(current.settlements.length, 1);
    for (const [suffix, body] of [
      ['/delete', {}], ['', { ...payload, comment: 'Изменено' }],
    ] as const) assert.equal((await f.request(`/api/operator/refuellings/${row.id}${suffix}`, 'PATCH', { ...body, version: row.version, idempotencyKey: randomUUID() }, f.operator)).status, 409);
    assert.equal((await f.request('/api/operator/cases', 'POST', f.claimBody(row, 'deferred'), f.operator)).status, 409);
    const complete = await f.request(`/api/operator/cases/${created.row.id}/settle`, 'PATCH', { version: current.version, method: 'fuel', litres: '100', idempotencyKey: randomUUID() }, f.operator);
    assert.equal(complete.status, 200); assert.equal((await f.read()).cases[0].status, 'completed');
    assert.equal((await f.request('/api/operator/cases', 'POST', f.claimBody(row, 'return', '1'), f.operator)).status, 409);
  } finally { await f.close(); }
});

test('operator cases: total 900 credits the original value of old 50, commits once, and can transfer the full new 900 without duplicating the old debt', async () => {
  const f = await fixture();
  try {
    const original = await f.save(), credit = await f.claim(original.row);
    const body = await f.operation({ amount: '61200.00', carryovers: [{ caseId: credit.row.id, version: 1, litres: '50' }] });
    const results = await Promise.all([f.request('/api/operator/refuellings', 'POST', body, f.operator), f.request('/api/operator/refuellings', 'POST', body, f.operator)]);
    assert.deepEqual(results.map(item => item.status).sort(), [200, 201]);
    const id = results[0].body.id;
    let workspace = await f.read();
    const saved = workspace.refuellings.find(row => row.id === id)! as OperatorRefuellingV3;
    assert.equal(saved.litres, '900'); assert.equal(saved.creditedAmount, '3600.00'); assert.equal(saved.amount, '61200.00');
    assert.equal(saved.allocations[0].amount, '61200.00'); assert.equal(saved.carryovers!.length, 1);
    assert.equal(workspace.cases.find(row => row.id === credit.row.id)!.remainingLitres, '0');
    assert.equal(workspace.cases.find(row => row.id === credit.row.id)!.settlements.length, 1);
    assert.equal((await f.request(`/api/operator/refuellings/${id}/delete`, 'PATCH', { version: 1, idempotencyKey: randomUUID() }, f.operator)).status, 409);
    assert.equal((await f.request(`/api/operator/refuellings/${id}/payment`, 'PATCH', { version: 1, paid: true, idempotencyKey: randomUUID() }, f.operator)).status, 200);
    const paid = (await f.read()).refuellings.find(row => row.id === id)! as OperatorRefuellingV3;
    const deferred = await f.claim(paid, 'deferred');
    assert.equal(deferred.row.litres, '900');
    workspace = await f.read();
    assert.deepEqual(workspace.cases.filter(row => row.status === 'open').map(row => row.remainingLitres), ['900']);
    const before = JSON.stringify((await f.store.read(f.source)).operator);
    const stale = await f.operation({ amount: '61200.00', carryovers: [{ caseId: credit.row.id, version: 1, litres: '50' }] });
    assert.equal((await f.request('/api/operator/refuellings', 'POST', stale, f.operator)).status, 409);
    assert.equal(JSON.stringify((await f.store.read(f.source)).operator), before);
    const persisted = await new OperationsStore(dirname(f.store.path)).read(f.source);
    assert.deepEqual(persisted.operator!.refuellings[id], paid);
    assert.equal((await f.request(`/api/operator/cases/${deferred.row.id}/settle`, 'PATCH', { version: 1, method: 'fuel', litres: '800', idempotencyKey: randomUUID() }, f.operator)).status, 200);
    assert.equal((await f.read()).cases.find(row => row.id === deferred.row.id)!.remainingLitres, '100');
  } finally { await f.close(); }
});

test('operator cases: permissions, unpaid sources, invalid references, overflow and zero-purchase carryovers do not mutate accounting', async () => {
  const f = await fixture();
  try {
    const unpaid = await f.save({}, false);
    const before = JSON.stringify((await f.store.read(f.source)).operator);
    assert.equal((await f.request('/api/operator/cases', 'POST', f.claimBody(unpaid.row), f.operator)).status, 409);
    assert.equal((await f.request('/api/operator/cases', 'POST', f.claimBody(unpaid.row), f.denied)).status, 403);
    assert.equal((await f.request('/api/operator/cases', 'POST', f.claimBody(unpaid.row))).status, 401);
    assert.equal((await f.request('/api/operator/cases', 'POST', { ...f.claimBody(unpaid.row), operationId: randomUUID() }, f.operator)).status, 404);
    assert.equal(JSON.stringify((await f.store.read(f.source)).operator), before);
    const paid = await f.save(), credit = await f.claim(paid.row);
    for (const litres of ['0', '-1', '901', '1.0000001']) {
      const response = await f.request('/api/operator/cases', 'POST', f.claimBody(paid.row, 'return', litres), f.operator);
      assert.ok([400, 409].includes(response.status));
    }
    const unchanged = JSON.stringify((await f.store.read(f.source)).operator);
    for (const overrides of [
      { litres: '50', amount: '1', amountMode: 'manual', carryovers: [{ caseId: credit.row.id, version: 1, litres: '50' }] },
      { name: 'Другой водитель', amount: '61200.00', carryovers: [{ caseId: credit.row.id, version: 1, litres: '50' }] },
      { amount: '61200.00', carryovers: [{ caseId: 'constructor', version: 1, litres: '50' }] },
      { amount: '61200.00', carryovers: [{ caseId: credit.row.id, version: 1, litres: '51' }] },
      { amount: '64800.00', carryovers: [{ caseId: credit.row.id, version: 1, litres: '50' }] },
    ]) assert.ok([400, 409].includes((await f.request('/api/operator/refuellings', 'POST', await f.operation(overrides), f.operator)).status));
    assert.equal(JSON.stringify((await f.store.read(f.source)).operator), unchanged);
  } finally { await f.close(); }
});

test('operator cases: partial fuel followed by money reconciles rounding and manual carryover charges remain supported', async () => {
  const f = await fixture();
  try {
    const source = await f.save({ litres: '3', pricePerLitre: '0.05', amount: '0.14' });
    const claim = await f.claim(source.row, 'return', '3');
    assert.equal(claim.row.amount, '0.14');
    assert.equal((await f.request(`/api/operator/cases/${claim.row.id}/settle`, 'PATCH', { version: 1, method: 'fuel', litres: '1', idempotencyKey: randomUUID() }, f.operator)).status, 200);
    const partial = (await f.read()).cases.find(row => row.id === claim.row.id)!;
    assert.equal(partial.remainingLitres, '2'); assert.equal(partial.remainingAmount, '0.09');
    assert.equal((await f.request(`/api/operator/cases/${claim.row.id}/settle`, 'PATCH', { version: 2, method: 'money', idempotencyKey: randomUUID() }, f.operator)).status, 200);
    const complete = (await f.read()).cases.find(row => row.id === claim.row.id)!;
    assert.deepEqual(complete.settlements.map(row => row.amount), ['0.05', '0.09']);
    const second = await f.save(), credit = await f.claim(second.row);
    const manual = await f.save({ amount: '60000.00', amountMode: 'manual', carryovers: [{ caseId: credit.row.id, version: 1, litres: '50' }] });
    assert.equal(manual.row.creditedAmount, '3600.00'); assert.equal(manual.row.amount, '60000.00');
    const newReturn = await f.claim(manual.row, 'return', '50');
    assert.equal(newReturn.row.amount, '3600.00');
  } finally { await f.close(); }
});

test('operator cases: stored validation rejects broken source snapshots, settlements and carryover links', async () => {
  const f = await fixture();
  try {
    const source = await f.save(), credit = await f.claim(source.row);
    const operation = await f.save({ amount: '61200.00', carryovers: [{ caseId: credit.row.id, version: 1, litres: '50' }] });
    const baseline = (await f.store.read(f.source)).operator!;
    for (const mutate of [
      (state: typeof baseline) => { state.cases![credit.row.id].source.pricePerLitre = '81'; },
      (state: typeof baseline) => { state.cases![credit.row.id].settlements[0].amount = '1.00'; },
      (state: typeof baseline) => { (state.refuellings[operation.row.id] as OperatorRefuellingV3).payableLitres = '900'; },
      (state: typeof baseline) => { (state.refuellings[operation.row.id] as OperatorRefuellingV3).carryovers![0].settlementId = randomUUID(); },
    ]) { const invalid = structuredClone(baseline); mutate(invalid); assert.throws(() => validateOperator(invalid)); }
    validateOperator(baseline);
  } finally { await f.close(); }
});

test('money carryover: source value survives a changed price, partial use, replay, payment toggles and restart', async () => {
  const f = await fixture();
  try {
    const original = await f.save(), credit = await f.claim(original.row, 'return', '100');
    const before = (await f.store.read(f.source)).operator!.refuellings[original.row.id];
    const first = await f.operation({ pricePerLitre: '90', amount: '69900.00', carryovers: [{ caseId: credit.row.id, version: 1, amount: '3000.00' }] });
    const response = await f.request('/api/operator/refuellings', 'POST', first, f.operator);
    assert.equal(response.status, 201, JSON.stringify(response.body));
    assert.equal((await f.request('/api/operator/refuellings', 'POST', first, f.operator)).body.replayed, true);
    let workspace = await f.read(), remainder = workspace.cases.find(row => row.id === credit.row.id)!;
    assert.equal(remainder.remainingAmount, '4200.00');
    assert.equal(remainder.settlements.length, 1);
    const second = await f.save({ pricePerLitre: '100', amount: '76800.00', carryovers: [{ caseId: remainder.id, version: remainder.version, amount: '4200' }] });
    assert.equal(second.row.creditedAmount, '4200.00');
    workspace = await f.read(); remainder = workspace.cases.find(row => row.id === credit.row.id)!;
    assert.equal(remainder.remainingAmount, '0.00'); assert.equal(remainder.remainingLitres, '0');
    assert.deepEqual((await f.store.read(f.source)).operator!.refuellings[original.row.id], before);
    for (const [index, paid] of [false, true].entries()) {
      const result = await f.request(`/api/operator/refuellings/${original.row.id}/payment`, 'PATCH', { version: original.row.version + index, paid, idempotencyKey: randomUUID() }, f.operator);
      assert.equal(result.status, 200, JSON.stringify(result.body));
    }
    const stored = await f.store.read(f.source);
    assert.deepEqual((await new OperationsStore(dirname(f.store.path)).read(f.source)).operator, stored.operator);
    assert.equal(stored.operator!.cases![remainder.id].source.operationVersion, original.row.version);
    assert.equal(stored.operator!.refuellings[original.row.id].paymentHistory.length, 3);
  } finally { await f.close(); }
});
