import assert from 'node:assert/strict';
import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { createSnapshotMiddleware, loadSnapshot } from '../server/local-api';
import { OperationsStore } from '../server/operations-store';
import { dispatchReminders, dispatchTaskAssignments, type PushConfig, type PushSender } from '../server/push';
import type { AccountUser } from '../web/src/auth-model';
import type { WorkTask } from '../web/src/work-model';

const base = await loadSnapshot();
const source = base.provenance.sourceSha256;
const config: PushConfig = { publicKey: 'test-public', privateKey: 'test-private', subject: 'https://artel-crm.vercel.app', schedule: true };
interface Notification { userId: string; body: string; tag: string; url: string }
function capture(sent: Notification[]): PushSender {
  return async (device, payload) => { sent.push({ ...JSON.parse(payload), userId: device.userId }); };
}
async function fixture(sender: PushSender) {
  const folder = await mkdtemp(resolve(tmpdir(), 'artel-task-notifications-'));
  const store = new OperationsStore(folder);
  const middleware = createSnapshotMiddleware(undefined, { operationsStore: store, pushConfig: config, pushSender: sender });
  const server = createServer((request, response) => middleware(request, response, () => { response.writeHead(404); response.end(); }));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  function client() {
    let cookie = '';
    return async (path: string, method = 'GET', body?: unknown) => {
      const response = await fetch(url + path, { method, headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const received = response.headers.get('set-cookie'); if (received) cookie = received.split(';')[0];
      return { status: response.status, body: await response.json() };
    };
  }
  const director = client(), alice = client(), bob = client();
  const password = randomUUID();
  const setup = await director('/api/auth/setup', 'POST', { login: 'notify-director', name: 'Директор теста', password });
  assert.equal(setup.status, 200);
  const users: AccountUser[] = [setup.body.user];
  for (const [name, login, request] of [['Сотрудник А', 'notify-alice', alice], ['Сотрудник Б', 'notify-bob', bob]] as const) {
    const employee = await director('/api/directories', 'POST', { kind: 'managers', name });
    assert.equal(employee.status, 201);
    const created = await director('/api/auth/users', 'POST', { login, name, password, role: 'manager', managerId: employee.body.entry.id });
    assert.equal(created.status, 201); users.push(created.body.user);
    assert.equal((await request('/api/auth/login', 'POST', { login, password })).status, 200);
  }
  for (const request of [director, alice, bob]) {
    const key = createECDH('prime256v1'); key.generateKeys();
    const subscription = { endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`, keys: { p256dh: key.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
    assert.equal((await request('/api/push/subscription', 'POST', { subscription })).status, 200);
  }
  return { store, folder, director, alice, bob, users,
    close: async () => { await new Promise<void>(done => server.close(() => done())); await rm(folder, { recursive: true, force: true }); } };
}

test('assigning another employee sends immediately, with or without a reminder; the due reminder is separate', async () => {
  const sent: Notification[] = [];
  const f = await fixture(capture(sent));
  try {
    const due = Date.now() + 3600000;
    const assigned = await f.director('/api/work/tasks', 'POST', { title: 'Обсудить поставку', assigneeId: f.users[1].id, reminderAt: new Date(due).toISOString() });
    assert.equal(assigned.status, 201);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].userId, f.users[1].id);
    assert.match(sent[0].body, /назнач/i);
    assert.match(sent[0].url, new RegExp(`workId=${assigned.body.entry.id}`));
    assert.equal((await f.store.read(source)).push!.lastRunAt, undefined, 'An immediate assignment must not masquerade as a scheduler run');
    const assignment = sent[0];
    const withoutReminder = await f.director('/api/work/tasks', 'POST', { title: 'Проверить договор', assigneeId: f.users[1].id });
    assert.equal(withoutReminder.status, 201);
    assert.equal(withoutReminder.body.entry.reminderAt, null);
    assert.deepEqual(sent.map(row => row.userId), [f.users[1].id, f.users[1].id]);
    assert.match(sent[1].body, /назнач/i);
    await dispatchReminders(f.store, source, config, capture(sent), due - 1);
    assert.equal(sent.length, 2, 'A future reminder must not be sent early');
    await dispatchReminders(new OperationsStore(f.folder), source, config, capture(sent), due);
    assert.equal(sent.length, 3);
    assert.equal(sent[2].userId, f.users[1].id);
    assert.match(sent[2].body, /напомин/i);
    assert.equal(sent[2].url, assignment.url);
    assert.notEqual(sent[2].tag, assignment.tag, 'The reminder must not replace the assignment notification');
    await dispatchReminders(new OperationsStore(f.folder), source, config, capture(sent), due + 60000);
    assert.equal(sent.length, 3, 'Successful assignment and reminder deliveries survive a store reload');
  } finally { await f.close(); }
});

test('a director or manager assigning a task to themselves receives only one due reminder', async () => {
  const sent: Notification[] = [];
  const f = await fixture(capture(sent));
  try {
    const due = Date.now() + 3600000;
    for (const [request, user] of [[f.director, f.users[0]], [f.alice, f.users[1]]] as const) {
      const created = await request('/api/work/tasks', 'POST', { title: 'Своя задача', assigneeId: user.id, reminderAt: new Date(due).toISOString() });
      assert.equal(created.status, 201);
      assert.equal(created.body.entry.assigneeId, user.id);
    }
    assert.equal(sent.length, 0, 'Self-assignment has no immediate notification');
    await dispatchReminders(f.store, source, config, capture(sent), due - 1);
    assert.equal(sent.length, 0);
    await dispatchReminders(f.store, source, config, capture(sent), due);
    assert.deepEqual(sent.map(row => row.userId).sort(), [f.users[0].id, f.users[1].id].sort());
    assert.ok(sent.every(row => /напомин/i.test(row.body)));
    await dispatchReminders(new OperationsStore(f.folder), source, config, capture(sent), due + 60000);
    assert.equal(sent.length, 2);
  } finally { await f.close(); }
});

test('employee transfer sends to the new assignee; edits, repeated requests and assigning to oneself do not duplicate it', async () => {
  const sent: Notification[] = [];
  const f = await fixture(capture(sent));
  try {
    const payload = { title: 'Передать коллеге', assigneeId: f.users[1].id, requestId: randomUUID() };
    const created = await f.director('/api/work/tasks', 'POST', payload);
    assert.equal(created.status, 201);
    const task = created.body.entry as WorkTask;
    assert.equal(sent.length, 1);
    const duplicate = await f.director('/api/work/tasks', 'POST', payload);
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.entry.id, task.id);
    assert.equal(sent.length, 1);
    const edited = await f.alice(`/api/work/tasks/${task.id}`, 'PATCH', { version: task.version, title: 'Уточнённая задача' });
    assert.equal(edited.status, 200);
    assert.equal(sent.length, 1);
    const transferred = await f.alice(`/api/work/tasks/${task.id}`, 'PATCH', { version: edited.body.entry.version, assigneeId: f.users[2].id });
    assert.equal(transferred.status, 200);
    assert.deepEqual(sent.map(row => row.userId), [f.users[1].id, f.users[2].id]);
    assert.notEqual(sent[0].tag, sent[1].tag);
    const sameAssignee = await f.bob(`/api/work/tasks/${task.id}`, 'PATCH', { version: transferred.body.entry.version, assigneeId: f.users[2].id });
    assert.equal(sameAssignee.status, 200);
    const takeOwn = await f.director(`/api/work/tasks/${task.id}`, 'PATCH', { version: sameAssignee.body.entry.version, assigneeId: f.users[0].id });
    assert.equal(takeOwn.status, 200);
    await dispatchReminders(new OperationsStore(f.folder), source, config, capture(sent), Date.now() + 180000);
    assert.equal(sent.length, 2);
  } finally { await f.close(); }
});

test('an immediate provider failure does not roll back the task; the scheduler retries the persisted assignment once', async () => {
  const attempts: Notification[] = [];
  const failing: PushSender = async (device, payload, pushConfig) => { await capture(attempts)(device, payload, pushConfig); throw Object.assign(new Error('Temporary provider failure'), { statusCode: 503 }); };
  const f = await fixture(failing);
  try {
    const created = await f.director('/api/work/tasks', 'POST', { title: 'Сохранить при сбое уведомлений', assigneeId: f.users[1].id });
    assert.equal(created.status, 201);
    assert.equal(attempts.length, 1);
    assert.deepEqual((await f.alice('/api/work')).body.work.tasks.map((row: WorkTask) => row.id), [created.body.entry.id]);
    assert.equal((await new OperationsStore(f.folder).read(source)).work!.tasks.length, 1);
    const edited = await f.director(`/api/work/tasks/${created.body.entry.id}`, 'PATCH', { version: created.body.entry.version, title: 'Уточнено после сбоя' });
    assert.equal(edited.status, 200);
    assert.equal(attempts.length, 1, 'An ordinary edit preserves the pending event and its retry delay');
    const sent: Notification[] = [];
    await dispatchReminders(new OperationsStore(f.folder), source, config, capture(sent), Date.now());
    assert.equal(sent.length, 0, 'A provider failure keeps the retry delay');
    const retryAt = Date.now() + 121000;
    await dispatchReminders(new OperationsStore(f.folder), source, config, capture(sent), retryAt);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].userId, f.users[1].id);
    assert.equal(sent[0].tag, attempts[0].tag);
    await dispatchReminders(new OperationsStore(f.folder), source, config, capture(sent), retryAt + 121000);
    assert.equal(sent.length, 1);
  } finally { await f.close(); }
});

test('pending assignment and due reminder deliveries are cancelled for completed, archived or deleted tasks and follow transfers', async () => {
  const f = await fixture(async () => { throw Object.assign(new Error('Temporary provider failure'), { statusCode: 503 }); });
  try {
    const due = Date.now() + 60000;
    for (const change of ['done', 'archive', 'delete'] as const) {
      const created = await f.director('/api/work/tasks', 'POST', { title: change, assigneeId: f.users[1].id, reminderAt: new Date(due).toISOString() });
      assert.equal(created.status, 201);
      const update = await f.alice(`/api/work/tasks/${created.body.entry.id}`, change === 'delete' ? 'DELETE' : 'PATCH', { version: created.body.entry.version, ...(change === 'done' ? { status: 'done' } : change === 'archive' ? { archived: true } : {}) });
      assert.equal(update.status, 200);
    }
    const created = await f.director('/api/work/tasks', 'POST', { title: 'Только текущему исполнителю', assigneeId: f.users[1].id, reminderAt: new Date(due).toISOString() });
    assert.equal(created.status, 201);
    const transfer = await f.alice(`/api/work/tasks/${created.body.entry.id}`, 'PATCH', { version: created.body.entry.version, assigneeId: f.users[2].id });
    assert.equal(transfer.status, 200);
    const sent: Notification[] = [];
    await dispatchReminders(new OperationsStore(f.folder), source, config, capture(sent), Date.now() + 121000);
    assert.equal(sent.length, 2, 'Only the current task assignment and its due reminder remain eligible');
    assert.ok(sent.every(row => row.userId === f.users[2].id && row.url.includes(created.body.entry.id)));
    assert.equal(sent.filter(row => /назнач/i.test(row.body)).length, 1);
    assert.equal(sent.filter(row => /напомин/i.test(row.body)).length, 1);
    assert.notEqual(sent[0].tag, sent[1].tag);
  } finally { await f.close(); }
});

test('pending notifications cannot reach inactive users or users without work access even if a device remains saved', async () => {
  const f = await fixture(async () => { throw Object.assign(new Error('Temporary provider failure'), { statusCode: 503 }); });
  try {
    const due = Date.now() + 60000;
    for (const user of f.users.slice(1)) {
      const created = await f.director('/api/work/tasks', 'POST', { title: 'Проверить актуальные права', assigneeId: user.id, reminderAt: new Date(due).toISOString() });
      assert.equal(created.status, 201);
    }
    // Keep devices deliberately: the dispatcher must independently enforce current account access.
    await f.store.mutate(source, data => {
      data.accounts!.users.find(user => user.id === f.users[1].id)!.sections = [];
      data.accounts!.users.find(user => user.id === f.users[2].id)!.active = false;
      return { result: null, changed: true };
    });
    assert.equal((await f.store.read(source)).push!.devices.length, 3);
    const sent: Notification[] = [];
    await dispatchReminders(new OperationsStore(f.folder), source, config, capture(sent), Date.now() + 121000);
    assert.equal(sent.length, 0);
  } finally { await f.close(); }
});

test('concurrent request dispatch and scheduler dispatch claim a pending assignment only once', async () => {
  const f = await fixture(async () => { throw Object.assign(new Error('Temporary provider failure'), { statusCode: 503 }); });
  try {
    const created = await f.director('/api/work/tasks', 'POST', { title: 'Не дублировать назначение', assigneeId: f.users[1].id });
    assert.equal(created.status, 201);
    const sent: Notification[] = [];
    const sender: PushSender = async (device, payload, pushConfig) => { await capture(sent)(device, payload, pushConfig); await new Promise(done => setTimeout(done, 30)); };
    const retryAt = Date.now() + 121000;
    await Promise.all([
      dispatchReminders(new OperationsStore(f.folder), source, config, sender, retryAt),
      dispatchTaskAssignments(new OperationsStore(f.folder), source, config, sender, retryAt, created.body.entry.id),
      dispatchReminders(new OperationsStore(f.folder), source, config, sender, retryAt),
    ]);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].userId, f.users[1].id);
    await dispatchReminders(new OperationsStore(f.folder), source, config, sender, retryAt + 121000);
    assert.equal(sent.length, 1);
  } finally { await f.close(); }
});
