import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { createSnapshotMiddleware, loadSnapshot } from '../server/local-api';
import { OperationsStore, StoreError, decodeOperations } from '../server/operations-store';
import { currentSnapshot } from '../server/shipment-operations';
import { readWork, validateWorkData } from '../server/work-operations';
import { emptyWork, type WorkCompanyRecord, type WorkNote, type WorkResponse, type WorkTask } from '../web/src/work-model';
import type { AccountUser } from '../web/src/auth-model';
import type { Snapshot } from '../web/src/model';

const base = await loadSnapshot(resolve('data/local-xlsx-final'));
async function setup() {
  const directory = await mkdtemp(resolve(tmpdir(), 'artel-work-'));
  const store = new OperationsStore(directory);
  const middleware = createSnapshotMiddleware(resolve('data/local-xlsx-final'), { operationsDirectory: directory });
  const server = createServer((request, response) => middleware(request, response, () => { response.writeHead(404); response.end(); }));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = () => {
    let cookie = '';
    return async (path: string, method = 'GET', body?: unknown) => {
      const response = await fetch(url + path, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const received = response.headers.get('set-cookie'); if (received) cookie = received.split(';')[0];
      return { status: response.status, body: await response.json() };
    };
  };
  const director = client(), alice = client(), bob = client(), anonymous = client();
  // Temporary credentials are created only in the throwaway test store.
  const password = randomUUID();
  const initial = await director('/api/auth/setup', 'POST', { name: 'Директор теста', login: 'test-director', password });
  assert.equal(initial.status, 200);
  const users: AccountUser[] = [initial.body.user];
  for (const [name, login, request] of [['Сотрудник А', 'test-alice', alice], ['Сотрудник Б', 'test-bob', bob]] as const) {
    const result = await director('/api/auth/users', 'POST', { name, login, password, role: 'manager', managerId: null });
    assert.equal(result.status, 201); users.push(result.body.user);
    assert.equal((await request('/api/auth/login', 'POST', { login, password })).status, 200);
  }
  const snapshot = (await director('/api/snapshot')).body as Snapshot;
  return { directory, store, director, alice, bob, anonymous, users, snapshot, close: async () => { await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); await rm(directory, { recursive: true, force: true }); } };
}

test('work assignments transfer across authenticated accounts, remain scoped and persist through a new store instance', async () => {
  const runtime = await setup();
  try {
    assert.equal((await runtime.anonymous('/api/work')).status, 401);
    assert.deepEqual(((await runtime.alice('/api/work')).body as WorkResponse).work, emptyWork());
    const created = await runtime.director('/api/work/tasks', 'POST', { title: 'Обсудить поставку', assigneeId: runtime.users[1].id, dueDate: '2026-09-15', reminderAt: '2026-09-14T09:00:00.000Z' });
    assert.equal(created.status, 201);
    const task = created.body.entry as WorkTask;
    assert.equal(task.createdBy, runtime.users[0].id);
    assert.deepEqual((await runtime.alice('/api/work')).body.work.tasks.map((row: WorkTask) => row.id), [task.id]);
    assert.deepEqual((await runtime.bob('/api/work')).body.work.tasks, []);
    assert.equal((await runtime.bob(`/api/work/tasks/${task.id}`, 'PATCH', { version: 1, title: 'Чужая правка' })).status, 404);
    assert.equal((await runtime.bob(`/api/work/tasks/${task.id}`, 'DELETE', { version: 1 })).status, 404);
    const transferred = await runtime.alice(`/api/work/tasks/${task.id}`, 'PATCH', { version: task.version, assigneeId: runtime.users[2].id, status: 'doing' });
    assert.equal(transferred.status, 200); assert.equal(transferred.body.entry.version, 2);
    assert.deepEqual((await runtime.alice('/api/work')).body.work.tasks, []);
    assert.deepEqual((await runtime.alice(`/api/work?assigneeId=${runtime.users[2].id}`)).body.work.tasks, []);
    assert.equal((await runtime.alice(`/api/work/tasks/${task.id}`, 'PATCH', { version: 2, assigneeId: runtime.users[1].id })).status, 404);
    assert.deepEqual((await runtime.bob('/api/work')).body.work.tasks.map((row: WorkTask) => row.id), [task.id]);
    assert.equal((await runtime.director('/api/work')).body.work.tasks.length, 1);
    assert.equal((await runtime.director('/api/work?assigneeId=mine')).body.work.tasks.length, 0);
    const stored = await new OperationsStore(runtime.directory).read(base.provenance.sourceSha256);
    const reloaded = readWork(stored, currentSnapshot(base, stored), new URLSearchParams(), runtime.users[2], runtime.users);
    assert.equal(reloaded.work.tasks[0].assigneeId, runtime.users[2].id); assert.equal(reloaded.work.tasks[0].reminderAt, task.reminderAt);
  } finally { await runtime.close(); }
});

test('work versions, server validation and idempotency prevent lost edits, invalid references and duplicate tasks', async () => {
  const runtime = await setup();
  try {
    const payload = { title: 'Проверить договор', requestId: randomUUID() };
    const created = await runtime.alice('/api/work/tasks', 'POST', payload); assert.equal(created.status, 201);
    const task = created.body.entry as WorkTask;
    assert.equal(task.assigneeId, runtime.users[1].id);
    const original = await readFile(runtime.store.path, 'utf8');
    const duplicate = await runtime.alice('/api/work/tasks', 'POST', payload); assert.equal(duplicate.status, 200); assert.equal(duplicate.body.entry.id, task.id);
    assert.equal(await readFile(runtime.store.path, 'utf8'), original);
    assert.equal((await runtime.alice('/api/work/tasks', 'POST', { ...payload, title: 'Другие данные' })).status, 409);
    for (const fields of [{ title: '' }, { title: 'x'.repeat(201) }, { status: 'imagined-stage' }, { dueDate: '2026-02-30' }, { reminderAt: '2026-09-10T25:00:00Z' }, { reminderAt: '2026-09-10T10:00' }, { companyId: 'missing-company' }, { assigneeId: 'missing-user' }, { createdBy: runtime.users[0].id }]) {
      const response = await runtime.alice(`/api/work/tasks/${task.id}`, 'PATCH', { version: 1, ...fields });
      assert.equal(response.status, 400, JSON.stringify(fields));
    }
    assert.equal((await runtime.alice(`/api/work/tasks/${task.id}`, 'PATCH', { title: 'Без версии' })).status, 400);
    assert.equal((await runtime.alice(`/api/work/tasks/${task.id}`, 'DELETE', {})).status, 400);
    assert.equal(await readFile(runtime.store.path, 'utf8'), original);
    const result = await runtime.alice(`/api/work/tasks/${task.id}`, 'PATCH', { version: 1, status: 'done', dueDate: null, reminderAt: null }); assert.equal(result.status, 200);
    const changed = await readFile(runtime.store.path, 'utf8');
    assert.equal((await runtime.alice(`/api/work/tasks/${task.id}`, 'PATCH', { version: 1, status: 'doing' })).status, 409);
    assert.equal((await runtime.alice(`/api/work/tasks/${task.id}`, 'DELETE', { version: 1 })).status, 409);
    assert.equal(await readFile(runtime.store.path, 'utf8'), changed);
    assert.equal((await runtime.alice(`/api/work/tasks/${task.id}`, 'DELETE', { version: 2 })).status, 405);
    assert.equal((await runtime.alice(`/api/work/tasks/${task.id}`, 'PATCH', { version: 2, archived: true })).status, 200);
    const archived = (await new OperationsStore(runtime.directory).read(base.provenance.sourceSha256)).work!.tasks[0];
    assert.ok(archived.archivedAt);
    assert.equal(archived.title, payload.title);
  } finally { await runtime.close(); }
});

test('company questions, append-only authored comments, reminders and separate notes share account-aware persistence', async () => {
  const runtime = await setup();
  try {
    const companyId = runtime.snapshot.companies[0].id;
    const payload = { companyId, question: 'Согласовать окно доставки', comment: ' Первый комментарий ', reminderAt: '2026-09-11T08:00:00.000Z', requestId: randomUUID() };
    const created = await runtime.alice('/api/work/companies', 'POST', payload); assert.equal(created.status, 201);
    const row = created.body.entry as WorkCompanyRecord;
    assert.equal((await runtime.alice('/api/work/companies', 'POST', payload)).status, 200);
    assert.equal(row.comments.length, 1); assert.equal(row.comments[0].authorId, runtime.users[1].id);
    assert.equal((await runtime.bob('/api/work')).body.work.companyRecords.length, 0);
    const updated = await runtime.alice(`/api/work/companies/${row.id}`, 'PATCH', { version: 1, comment: 'Передано коллеге', assigneeId: runtime.users[2].id }); assert.equal(updated.status, 200);
    const response = (await runtime.bob('/api/work')).body as WorkResponse;
    assert.equal(response.work.companyRecords[0].comments.length, 2); assert.equal(response.work.companyRecords[0].reminderAt, payload.reminderAt);
    assert.equal((await runtime.bob(`/api/work/companies/${row.id}`, 'PATCH', { version: 2, comments: [] })).status, 400);
    assert.equal((await runtime.bob(`/api/work/companies/${row.id}`, 'PATCH', { version: 2, comment: 'Окно подтверждено', reminderAt: null })).status, 200);
    const savedNote = await runtime.alice('/api/work/notes', 'POST', { title: 'Позвонить после встречи', content: 'Обсудить документы' }); assert.equal(savedNote.status, 201);
    const note = savedNote.body.entry as WorkNote;
    assert.equal((await runtime.bob(`/api/work/notes/${note.id}`, 'PATCH', { version: 1, content: 'Чужая заметка' })).status, 404);
    assert.equal((await runtime.director('/api/work')).body.work.notes.length, 1);
    const persisted = await new OperationsStore(runtime.directory).read(base.provenance.sourceSha256);
    assert.equal(persisted.work!.companyRecords[0].comments[2].authorId, runtime.users[2].id);
    assert.equal(persisted.work!.companyRecords[0].reminderAt, null);
    assert.equal(persisted.work!.notes[0].content, 'Обсудить документы');
    assert.equal((await runtime.bob(`/api/work/companies/${row.id}`, 'DELETE', { version: 3 })).status, 200);
    assert.equal((await runtime.director('/api/snapshot')).body.companies.length, runtime.snapshot.companies.length);
  } finally { await runtime.close(); }
});

test('work decoder accepts old stores and refuses malformed persisted task data without overwriting files', () => {
  assert.doesNotThrow(() => validateWorkData(undefined));
  assert.doesNotThrow(() => validateWorkData(emptyWork()));
  for (const value of [null, {}, { tasks: [], companyRecords: [], notes: [{}] }, { tasks: null, companyRecords: [], notes: [] }]) assert.throws(() => validateWorkData(value), StoreError);
  assert.throws(() => decodeOperations('{"data":{"work":{"tasks":[{}]}}}', base.provenance.sourceSha256), StoreError);
});
