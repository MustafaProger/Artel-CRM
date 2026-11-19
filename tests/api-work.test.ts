import { migrateWorkStorage } from '../server/work-partition';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { createSnapshotMiddleware, loadSnapshot } from '../server/local-api';
import { OperationsStore, StoreError, decodeOperations, encodeOperations } from '../server/operations-store';
import { currentSnapshot } from '../server/shipment-operations';
import { readWork, validateWorkData } from '../server/work-operations';
import { emptyWork, workToday, type WorkCompanyRecord, type WorkNote, type WorkResponse, type WorkTask } from '../web/src/work-model';
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
    const employee = await director('/api/directories', 'POST', { kind: 'managers', name });
    const result = await director('/api/auth/users', 'POST', { name, login, password, role: 'manager', managerId: employee.body.entry.id });
    assert.equal(result.status, 201); users.push(result.body.user);
    assert.equal((await request('/api/auth/login', 'POST', { login, password })).status, 200);
  }
  const snapshot = (await director('/api/snapshot')).body as Snapshot;
  assert.equal((await director('/api/directories', 'POST', { kind: 'customerManagers', companyId: snapshot.companies[0].id, managerId: users[1].managerId })).status, 201);
  if (process.env.ARTEL_TEST_WORK_PARTITION === '1') await migrateWorkStorage(directory, base.provenance.sourceSha256);
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
    // Older tasks have no priority; a status-only request must remain compatible.
    await runtime.store.mutate(base.provenance.sourceSha256, data => {
      delete data.work!.tasks.find(row => row.id === task.id)!.priority;
      return { changed: true, result: null };
    });
    assert.deepEqual((await runtime.alice('/api/work')).body.work.tasks.map((row: WorkTask) => row.id), [task.id]);
    assert.deepEqual((await runtime.bob('/api/work')).body.work.tasks, []);
    assert.equal((await runtime.bob(`/api/work/tasks/${task.id}`, 'PATCH', { version: 1, title: 'Чужая правка' })).status, 404);
    assert.equal((await runtime.bob(`/api/work/tasks/${task.id}`, 'DELETE', { version: 1 })).status, 404);
    const transferred = await runtime.alice(`/api/work/tasks/${task.id}`, 'PATCH', { version: task.version, assigneeId: runtime.users[2].id, status: 'doing' });
    assert.equal(transferred.status, 200); assert.equal(transferred.body.entry.version, 2);
    assert.equal(transferred.body.entry.priority, 4);
    assert.deepEqual((await runtime.alice('/api/work')).body.work.tasks, []);
    assert.deepEqual((await runtime.alice(`/api/work?assigneeId=${runtime.users[2].id}`)).body.work.tasks, []);
    assert.equal((await runtime.alice(`/api/work/tasks/${task.id}`, 'PATCH', { version: 2, assigneeId: runtime.users[1].id })).status, 404);
    assert.deepEqual((await runtime.bob('/api/work')).body.work.tasks.map((row: WorkTask) => row.id), [task.id]);
    assert.equal((await runtime.director('/api/work')).body.work.tasks.length, 1);
    assert.equal((await runtime.director('/api/work?assigneeId=mine')).body.work.tasks.length, 1);
    const stored = await new OperationsStore(runtime.directory).read(base.provenance.sourceSha256);
    const reloaded = readWork(stored, currentSnapshot(base, stored), new URLSearchParams(), runtime.users[2], runtime.users);
    assert.equal(reloaded.work.tasks[0].assigneeId, runtime.users[2].id); assert.equal(reloaded.work.tasks[0].reminderAt, task.reminderAt);
    const delegated = await runtime.alice('/api/work/tasks', 'POST', { title: 'Задача для коллеги', assigneeId: runtime.users[2].id, requestId: randomUUID() });
    assert.equal(delegated.status, 201);
    assert.equal(delegated.body.entry.createdBy, runtime.users[1].id);
    assert.deepEqual((await runtime.alice('/api/work')).body.work.tasks.map((row: WorkTask) => row.id), [delegated.body.entry.id]);
    assert.ok((await runtime.bob('/api/work')).body.work.tasks.some((row: WorkTask) => row.id === delegated.body.entry.id));
  } finally { await runtime.close(); }
});

test('multiple assignees, authored comments, handoff from archive and active task count follow each account', async () => {
  const f = await setup();
  try {
    const [aidar, zhenya, egor] = f.users;
    const today = workToday();
    assert.equal(workToday(new Date('2026-11-10T21:00:00.000Z')), '2026-11-11');
    const myTasks = async (client: typeof f.alice) => ((await client('/api/work?assigneeId=mine')).body as WorkResponse).work.tasks;
    const count = async (client: typeof f.alice) => (await client('/api/navigation')).body.todayTaskCount;
    const personal = await f.alice('/api/work/tasks', 'POST', { title: 'Личная задача', assigneeIds: [] });
    assert.equal(personal.status, 201);
    assert.equal(personal.body.entry.assigneeId, zhenya.id);
    assert.equal(personal.body.todayTaskCount, 1);
    assert.equal((await myTasks(f.bob)).length, 0);
    assert.equal((await myTasks(f.director)).length, 0);
    const payload = { title: 'Оформить УПД', assigneeIds: [zhenya.id], dueDate: today, requestId: randomUUID() };
    const created = await f.director('/api/work/tasks', 'POST', payload);
    assert.equal(created.status, 201);
    assert.equal((await f.director('/api/work/tasks', 'POST', payload)).status, 200);
    assert.equal(created.body.entry.assigneeId, zhenya.id);
    assert.equal(await count(f.director), 1);
    assert.equal(await count(f.alice), 2);
    assert.equal(await count(f.bob), 0);
    assert.equal((await f.director(`/api/work?assigneeId=${zhenya.id}`)).body.work.tasks.length, 2);

    const { id } = created.body.entry;
    const path = `/api/work/tasks/${id}`;
    const completed = await f.alice(path, 'PATCH', { version: 1, status: 'done' });
    assert.equal(completed.status, 200);
    assert.equal(await count(f.director), 0);
    assert.equal(await count(f.alice), 1);
    assert.equal((await f.bob(path, 'PATCH', { version: 2, comment: 'Чужая задача' })).status, 404);
    const comment = await f.alice(path, 'PATCH', { version: 2, comment: 'УПД готов' });
    assert.equal(comment.status, 200);
    assert.equal(comment.body.entry.assigneeId, zhenya.id);
    assert.equal((await f.alice(path, 'PATCH', { version: 2, handoff: true, assigneeIds: [egor.id] })).status, 409);
    assert.equal((await f.alice(path, 'PATCH', { version: 3, handoff: true, assigneeIds: [] })).status, 400);
    const handoff = await f.alice(path, 'PATCH', { version: 3, handoff: true, assigneeIds: [egor.id], comment: 'Распечатай УПД' });
    assert.equal(handoff.status, 200);
    assert.equal(handoff.body.entry.status, 'todo');
    assert.equal(handoff.body.entry.archivedAt, null);
    assert.deepEqual((await myTasks(f.alice)).map(task => task.id).sort(), [personal.body.entry.id, id].sort());
    assert.deepEqual(new Set(handoff.body.entry.assigneeIds), new Set([aidar.id, zhenya.id, egor.id]));
    assert.equal(await count(f.alice), 2);
    assert.deepEqual((await myTasks(f.director)).map(task => task.id), [id]);
    const [received] = await myTasks(f.bob);
    assert.equal(received.id, id);
    assert.deepEqual(received.comments?.map(({ text, authorId, handoffTo }) => ({ text, authorId, handoffTo })), [
      { text: 'УПД готов', authorId: zhenya.id, handoffTo: undefined },
      { text: 'Распечатай УПД', authorId: zhenya.id, handoffTo: [egor.id] },
    ]);
    assert.ok(received.comments?.every(row => Number.isFinite(Date.parse(row.createdAt))));
    assert.equal(await count(f.bob), 1);
    assert.equal(await count(f.director), 1);
    const failed = await f.bob(path, 'PATCH', { version: 4, status: 'failed' });
    assert.equal(failed.status, 200);
    assert.equal(failed.body.entry.status, 'failed');
    assert.ok(failed.body.entry.archivedAt);
    assert.equal((await myTasks(f.director))[0].status, 'failed');
    assert.equal(await count(f.bob), 0);
    assert.equal(await count(f.director), 0);

    const restored = await f.bob(path, 'PATCH', { version: 5, archived: false });
    assert.equal(restored.status, 200);
    assert.equal(restored.body.entry.status, 'todo');
    assert.equal(restored.body.entry.archivedAt, null);
    assert.equal(await count(f.bob), 1);
  } finally { await f.close(); }
});

test('the Work badge counts all open personal tasks regardless of deadline and list filters', async () => {
  const f = await setup();
  try {
    const assigneeId = f.users[1].id;
    const create = (title: string, dueDate: string | null) => f.director('/api/work/tasks', 'POST', { title, assigneeId, dueDate });
    const undated = await create('Без срока', null);
    assert.equal(undated.status, 201);
    assert.equal((await create('Просрочена', '2000-01-01')).status, 201);
    assert.equal((await create('На будущее', '2099-01-01')).status, 201);
    assert.equal((await f.alice('/api/navigation')).body.todayTaskCount, 3);
    const mine = await f.alice('/api/work?assigneeId=mine');
    assert.equal(mine.body.work.tasks.length, 3);
    assert.equal(mine.body.todayTaskCount, 3);
    assert.equal((await f.alice(`/api/work?assigneeId=${f.users[2].id}`)).body.todayTaskCount, 3);
    assert.equal((await f.bob('/api/navigation')).body.todayTaskCount, 0);

    const path = `/api/work/tasks/${undated.body.entry.id}`;
    const completed = await f.alice(path, 'PATCH', { version: undated.body.entry.version, status: 'done' });
    assert.equal(completed.status, 200);
    assert.equal(completed.body.todayTaskCount, 2);
    assert.equal((await f.alice('/api/navigation')).body.todayTaskCount, 2);
    const reopened = await f.alice(path, 'PATCH', { version: completed.body.entry.version, archived: false });
    assert.equal(reopened.status, 200);
    assert.equal(reopened.body.todayTaskCount, 3);
  } finally { await f.close(); }
});

test('work versions, server validation and idempotency prevent lost edits, invalid references and duplicate tasks', async () => {
  const runtime = await setup();
  try {
    const payload = { title: 'Проверить договор', requestId: randomUUID() };
    const created = await runtime.alice('/api/work/tasks', 'POST', payload); assert.equal(created.status, 201);
    const task = created.body.entry as WorkTask;
    assert.equal(task.assigneeId, runtime.users[1].id);
    const original = encodeOperations(await runtime.store.read(base.provenance.sourceSha256));
    const duplicate = await runtime.alice('/api/work/tasks', 'POST', payload); assert.equal(duplicate.status, 200); assert.equal(duplicate.body.entry.id, task.id);
    assert.equal(encodeOperations(await runtime.store.read(base.provenance.sourceSha256)), original);
    assert.equal((await runtime.alice('/api/work/tasks', 'POST', { ...payload, title: 'Другие данные' })).status, 409);
    for (const fields of [{ title: '' }, { title: 'x'.repeat(201) }, { status: 'imagined-stage' }, { dueDate: '2026-02-30' }, { reminderAt: '2026-09-10T25:00:00Z' }, { reminderAt: '2026-09-10T10:00' }, { companyId: 'missing-company' }, { assigneeId: 'missing-user' }, { createdBy: runtime.users[0].id }]) {
      const response = await runtime.alice(`/api/work/tasks/${task.id}`, 'PATCH', { version: 1, ...fields });
      assert.equal(response.status, 400, JSON.stringify(fields));
    }
    assert.equal((await runtime.alice(`/api/work/tasks/${task.id}`, 'PATCH', { title: 'Без версии' })).status, 400);
    assert.equal((await runtime.alice(`/api/work/tasks/${task.id}`, 'DELETE', {})).status, 400);
    assert.equal(encodeOperations(await runtime.store.read(base.provenance.sourceSha256)), original);
    const result = await runtime.alice(`/api/work/tasks/${task.id}`, 'PATCH', { version: 1, status: 'done', dueDate: null, reminderAt: null }); assert.equal(result.status, 200);
    const changed = encodeOperations(await runtime.store.read(base.provenance.sourceSha256));
    assert.ok(result.body.entry.archivedAt, 'Completing a task archives it atomically');
    assert.equal((await runtime.alice(`/api/work/tasks/${task.id}`, 'PATCH', { version: 1, status: 'doing' })).status, 409);
    assert.equal((await runtime.alice(`/api/work/tasks/${task.id}`, 'DELETE', { version: 1 })).status, 409);
    assert.equal(encodeOperations(await runtime.store.read(base.provenance.sourceSha256)), changed);
    assert.equal((await runtime.alice(`/api/work/tasks/${task.id}`, 'PATCH', { version: 2, archived: true })).status, 200);
    const archived = (await new OperationsStore(runtime.directory).read(base.provenance.sourceSha256)).work!.tasks[0];
    assert.ok(archived.archivedAt);
    assert.equal(archived.title, payload.title);
    assert.equal((await runtime.alice(`/api/work/tasks/${task.id}`, 'DELETE', { version: 3 })).status, 200);
    assert.equal((await new OperationsStore(runtime.directory).read(base.provenance.sourceSha256)).work!.tasks.length, 0);
  } finally { await runtime.close(); }
});

test('task priority is validated, persisted and preserved by unrelated edits', async () => {
  const runtime = await setup();
  try {
    const created = await runtime.alice('/api/work/tasks', 'POST', { title: 'Срочная задача', priority: 1 });
    assert.equal(created.status, 201);
    const task = created.body.entry as WorkTask;
    assert.equal(task.priority, 1);
    for (const priority of [0, 5, '1', null]) {
      const invalid = await runtime.alice(`/api/work/tasks/${task.id}`, 'PATCH', { version: 1, priority });
      assert.equal(invalid.status, 400, String(priority));
    }
    const changed = await runtime.alice(`/api/work/tasks/${task.id}`, 'PATCH', { version: 1, description: 'Проверено' });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.entry.priority, 1);
    const saved = (await new OperationsStore(runtime.directory).read(base.provenance.sourceSha256)).work!.tasks.find(row => row.id === task.id);
    assert.equal(saved?.priority, 1);
  } finally { await runtime.close(); }
});

test('active tasks and notes can be deleted only with access and a current version, without affecting other records', async () => {
  const runtime = await setup();
  try {
    for (const kind of ['tasks', 'notes'] as const) {
      const created = await runtime.alice(`/api/work/${kind}`, 'POST', { title: 'Удалить свою запись' });
      const other = await runtime.bob(`/api/work/${kind}`, 'POST', { title: 'Сохранить чужую запись' });
      const { id, version } = created.body.entry;
      const path = `/api/work/${kind}/${id}`;
      assert.equal((await runtime.bob(path, 'DELETE', { version })).status, 404);
      assert.equal((await runtime.anonymous(path, 'DELETE', { version })).status, 401);
      assert.equal((await runtime.alice(path, 'DELETE', {})).status, 400);
      assert.equal((await runtime.alice(path, 'DELETE', { version, title: 'Неожиданное поле' })).status, 400);
      assert.equal((await runtime.alice(path, 'PATCH', { version, title: 'Обновлённая запись' })).status, 200);
      assert.equal((await runtime.alice(path, 'DELETE', { version })).status, 409);
      assert.equal((await runtime.alice(path, 'DELETE', { version: version + 1 })).status, 200);
      assert.equal((await runtime.alice(path, 'DELETE', { version: version + 1 })).status, 404);
      const stored = await new OperationsStore(runtime.directory).read(base.provenance.sourceSha256);
      assert.deepEqual(stored.work![kind].map(row => row.id), [other.body.entry.id]);
      assert.equal((await runtime.director(`/api/work/${kind}/${other.body.entry.id}`, 'DELETE', { version: other.body.entry.version })).status, 200);
    }
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
    assert.ok(response.companies.some(company => company.id === companyId));
    assert.ok(!response.companies.find(company => company.id === companyId)!.inn);
    assert.ok(!(await runtime.bob('/api/settlements')).body.companies.some((company: { companyIds: string[] }) => company.companyIds.includes(companyId)), 'Work handoff never grants a financial portfolio');
    assert.equal(response.work.companyRecords[0].comments.length, 2); assert.equal(response.work.companyRecords[0].reminderAt, payload.reminderAt);
    assert.equal((await runtime.bob(`/api/work/companies/${row.id}`, 'PATCH', { version: 2, comments: [] })).status, 400);
    assert.equal((await runtime.bob(`/api/work/companies/${row.id}`, 'PATCH', { version: 2, comment: 'Окно подтверждено', reminderAt: null })).status, 200);
    const savedNote = await runtime.alice('/api/work/notes', 'POST', { title: 'Позвонить после встречи', content: 'Обсудить документы', assigneeId: runtime.users[2].id }); assert.equal(savedNote.status, 201);
    const note = savedNote.body.entry as WorkNote;
    assert.equal(note.assigneeId, runtime.users[1].id);
    assert.equal((await runtime.bob(`/api/work/notes/${note.id}`, 'PATCH', { version: 1, content: 'Чужая заметка' })).status, 404);
    const editedNote = await runtime.director(`/api/work/notes/${note.id}`, 'PATCH', { version: 1, assigneeId: runtime.users[2].id });
    assert.equal(editedNote.status, 200);
    assert.equal(editedNote.body.entry.assigneeId, note.assigneeId);
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

test('employee deletion requires handover of open work, keeps authored history and forbids new assignments to deleted accounts', async () => {
  const f = await setup();
  try {
    const alice = f.users[1], deletion = { version: alice.version, confirmationName: alice.name };
    const task = (await f.alice('/api/work/tasks', 'POST', { title: 'History stays', comment: 'Written by Alice', addAttachments: [{ name: 'memo.txt', data: Buffer.from('history').toString('base64') }] })).body.entry as WorkTask;
    const company = (await f.alice('/api/work/companies', 'POST', { companyId: f.snapshot.companies[0].id, question: 'Open question' })).body.entry as WorkCompanyRecord;
    const note = (await f.alice('/api/work/notes', 'POST', { title: 'Keep note', content: 'History' })).body.entry as WorkNote;
    const blocked = await f.director(`/api/auth/users/${alice.id}`, 'DELETE', deletion);
    assert.equal(blocked.status, 409); assert.match(blocked.body.error, /задачи — 1, работа с компаниями — 1/);
    assert.equal((await f.alice(`/api/work/tasks/${task.id}`, 'PATCH', { version: task.version, status: 'done' })).status, 200);
    assert.equal((await f.director(`/api/auth/users/${alice.id}`, 'DELETE', deletion)).status, 409);
    assert.equal((await f.alice(`/api/work/companies/${company.id}`, 'PATCH', { version: company.version, assigneeId: f.users[2].id })).status, 200);
    const before = (await f.store.read(base.provenance.sourceSha256)).work;
    assert.equal((await f.director(`/api/auth/users/${alice.id}`, 'DELETE', deletion)).status, 200);
    const after = await new OperationsStore(f.directory).read(base.provenance.sourceSha256);
    assert.deepEqual(after.work, before);
    const response = (await f.bob('/api/work')).body as WorkResponse;
    assert.equal(response.users.some(user => user.id === alice.id), false);
    assert.deepEqual(response.historicalUsers, [{ id: alice.id, name: alice.name }]);
    const directorWork = (await f.director(`/api/work?assigneeId=${alice.id}`)).body as WorkResponse;
    assert.equal(directorWork.work.tasks[0].comments![0].authorId, alice.id);
    assert.equal(directorWork.work.tasks[0].attachments![0].authorId, alice.id);
    assert.equal(directorWork.work.notes[0].id, note.id);
    assert.equal((await f.director('/api/work/tasks', 'POST', { title: 'Invalid assignment', assigneeId: alice.id })).status, 400);
    assert.equal((await f.director(`/api/work/tasks/${task.id}`, 'PATCH', { version: 2, comment: 'History still editable' })).status, 200);
    assert.equal((await f.director(`/api/work/tasks/${task.id}`, 'PATCH', { version: 3, status: 'doing' })).status, 400);
    assert.equal((await f.director(`/api/work/tasks/${task.id}`, 'PATCH', { version: 3, status: 'doing', assigneeId: f.users[2].id })).status, 200);
  } finally { await f.close(); }
});

test('Work selects only active clients/suppliers, preserves old references and does not broaden employee access', async () => {
  const f = await setup();
  try {
    const cases = [
      ['client', ['customer'], false], ['supplier', ['supplier'], false],
      ['both', ['customer', 'supplier'], false], ['bank', ['payment_counterparty'], false],
      ['carrier', ['carrier'], false], ['other', ['other'], false],
      ['archived', ['customer'], true], ['empty', [], false],
    ] as const;
    await f.store.mutate(base.provenance.sourceSha256, data => {
      for (const [key, roles, directoryArchived] of cases) data.companies.push({ id: `scope-${key}`, name: `Scope ${key}`, roles: [...roles], directoryArchived, managerLabels: [], shipmentIds: [], paymentIds: [], flags: [] });
      return { changed: true, result: null };
    });
    const visible = (await f.director('/api/work')).body as WorkResponse;
    assert.deepEqual(visible.companies.filter(c => c.id.startsWith('scope-')).map(c => c.id).sort(), ['scope-both', 'scope-client', 'scope-supplier']);
    assert.equal(visible.companies.filter(c => c.id === 'scope-both').length, 1);
    assert.equal((await f.bob('/api/work')).body.companies.some((c: {id: string}) => c.id === 'scope-client'), false);
    for (const kind of ['tasks', 'companies']) {
      const content = kind === 'tasks' ? { title: 'Scope check' } : { question: 'Scope check' };
      for (const [key] of cases) {
        const allowed = ['client', 'supplier', 'both'].includes(key);
        const before = encodeOperations(await f.store.read(base.provenance.sourceSha256));
        const result = await f.director(`/api/work/${kind}`, 'POST', { ...content, companyId: `scope-${key}` });
        assert.equal(result.status, allowed ? 201 : 400, `${kind}/${key}`);
        if (!allowed) assert.equal(encodeOperations(await f.store.read(base.provenance.sourceSha256)), before);
      }
    }
    const legacy = (await f.director('/api/work/tasks', 'POST', { title: 'Legacy scope', companyId: 'scope-client', assigneeId: f.users[1].id })).body.entry as WorkTask;
    await f.store.mutate(base.provenance.sourceSha256, data => {
      data.companies.find(c => c.id === 'scope-client')!.roles = ['payment_counterparty'];
      return { changed: true, result: null };
    });
    const oldWork = (await f.alice('/api/work')).body as WorkResponse;
    assert.equal(oldWork.companies.find(c => c.id === 'scope-client')?.name, 'Scope client');
    assert.equal((await f.alice('/api/work/tasks', 'POST', { title: 'Cannot reuse old reference', companyId: 'scope-client' })).status, 400);
    assert.equal((await f.alice(`/api/work/tasks/${legacy.id}`, 'PATCH', { version: 1, comment: 'Keep history', companyId: 'scope-client', assigneeId: f.users[2].id })).status, 200);
    assert.equal((await f.alice('/api/work')).body.companies.some((c: {id: string}) => c.id === 'scope-client'), false);
    assert.equal((await f.bob(`/api/work/tasks/${legacy.id}`, 'PATCH', { version: 2, title: 'History editable' })).status, 200);
    assert.equal((await f.bob(`/api/work/tasks/${legacy.id}`, 'PATCH', { version: 3, companyId: 'scope-bank' })).status, 400);
    assert.equal((await f.bob(`/api/work/tasks/${legacy.id}`, 'PATCH', { version: 3, companyId: 'scope-supplier' })).status, 200);
    assert.equal((await f.bob('/api/work')).body.companies.some((c: {id: string}) => c.id === 'scope-client'), false);
  } finally { await f.close(); }
});

test('lean Work projection exactly preserves visible company choices, scope and mutations', async () => {
  const { currentWorkSnapshot } = await import('../server/shipment-operations');
  const { scopeSnapshot } = await import('../server/auth-scope');
  const { workCompanyIds, mutateWork } = await import('../server/work-operations');
  const f = await setup();
  try {
    await f.director('/api/work/tasks', 'POST', { title: 'Parity task', assigneeId: f.users[1].id, companyId: f.snapshot.companies[0].id });
    const data = await f.store.read(base.provenance.sourceSha256);
    const before = JSON.stringify(data);
    for (const actor of [f.users[0], ...f.users.slice(1), { ...f.users[1], managerId: 'missing-manager' }, { ...f.users[0], role: 'admin' as const }]) {
      const ids = workCompanyIds(data, actor);
      const slow = scopeSnapshot(currentSnapshot(base, data), actor, 'work', ids);
      const fast = scopeSnapshot(currentWorkSnapshot(base, data), actor, 'work', ids);
      for (const filter of ['', 'mine', f.users[1].id]) {
        const params = new URLSearchParams(filter ? { assigneeId: filter } : {});
        assert.deepEqual(readWork(data, fast, params, actor, f.users), readWork(data, slow, params, actor, f.users));
      }
      const task = data.work!.tasks[0];
      for (const body of [{ version: task.version, status: 'done' }, { version: task.version - 1, status: 'todo' }, { version: task.version, companyId: 'missing-company' }]) {
        const evaluate = (snapshot: Snapshot) => {
          try {
            const result = mutateWork(structuredClone(data), snapshot, 'tasks', body, task.id, 'PATCH', actor, f.users);
            if (result.entry) {
              if ('archivedAt' in result.entry && result.entry.archivedAt) {
                assert.equal(result.entry.archivedAt, result.entry.updatedAt);
                result.entry.archivedAt = 'ignored-clock';
              }
              result.entry.updatedAt = 'ignored-clock';
            }
            return result;
          } catch (e) { return { status: (e as {status:number}).status, message: (e as Error).message }; }
        };
        assert.deepEqual(evaluate(fast), evaluate(slow));
      }
    }
    assert.equal(JSON.stringify(data), before);
    const measure = (fn: () => unknown) => { const values = []; for (let i=0;i<21;i++) { const start=performance.now(); fn(); if(i)values.push(performance.now()-start); } values.sort((a,b)=>a-b); return { medianMs: values[10], p95Ms: values[18] }; };
    const slow = measure(()=>scopeSnapshot(currentSnapshot(base,data),f.users[0],'work'));
    const fast = measure(()=>scopeSnapshot(currentWorkSnapshot(base,data),f.users[0],'work'));
    console.log('WORK_PROJECTION_BENCH', JSON.stringify({ slow, fast, equal:true, sourceShipments:base.shipments.length, isolated:true }));
  } finally { await f.close(); }
});

test('partitioned Work retains shared company labels and does not change trips/directories business responses', async () => {
  const f = await setup();
  try {
    const paths = ['/api/directories', '/api/shipment-trips'];
    const before = await Promise.all(paths.map(path => f.director(path)));
    const company = f.snapshot.companies.find(row => row.roles.includes('customer'))!;
    const task = await f.director('/api/work/tasks', 'POST', {title:'Связь со справочником',companyId:company.id}); assert.equal(task.status,201);
    assert.equal((await f.director(`/api/work/tasks/${task.body.entry.id}`,'PATCH',{version:1,status:'done'})).status,200);
    const normalize = (value: unknown): unknown => Array.isArray(value) ? value.map(normalize) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([key])=>key!=='revision').map(([key,v])=>[key,normalize(v)])) : value;
    for(let i=0;i<paths.length;i++) assert.deepEqual(normalize(await f.director(paths[i])), normalize(before[i]));
    await f.store.mutate(base.provenance.sourceSha256, d=>{const updated={...company,name:'Общее новое название'};const index=d.companies.findIndex(row=>row.id===company.id);if(index<0)d.companies.push(updated);else d.companies[index]=updated;return{result:null,changed:true}});
    const work=(await f.director('/api/work')).body as WorkResponse;
    assert.equal(work.companies.find(row=>row.id===company.id)?.name,'Общее новое название');assert.equal(work.work.tasks.find(row=>row.id===task.body.entry.id)?.companyId,company.id);
  } finally {await f.close();}
});

test('project membership protects rich tasks and files and the common board synchronizes task status', async () => {
  const f = await setup();
  try {
    const path = '/api/work/boards', tasks = '/api/work/tasks';
    const list = async (client: typeof f.alice) => (await client(path)).body.boards;
    const create = { title: 'Учёба', group: 'Развитие', memberIds: [], requestId: randomUUID() };
    assert.equal((await f.anonymous(path)).status, 401);
    const project = (await f.alice(path, 'POST', create)).body.board;
    assert.equal((await f.alice(path, 'POST', create)).body.board.id, project.id);
    const projectPath = path + '/' + project.id;
    assert.equal((await list(f.director)).length, 1);
    assert.equal((await f.director(projectPath, 'DELETE', { version: 1 })).status, 404);
    const shared = await f.alice(projectPath, 'PATCH', { version: 1, action: 'rename', title: 'Учёба', group: 'Развитие', memberIds: [f.users[2].id] });
    assert.equal(shared.status, 200);
    assert.equal((await list(f.bob)).length, 2);
    assert.equal((await f.bob(projectPath, 'PATCH', { version: 2, action: 'rename', title: 'Другое' })).status, 403);
    const placement = { boardId: project.id, columnId: project.columns[0].id, version: 2 };
    const rich = { title: 'Расписание', description: 'Первая неделя', priority: 2, comment: 'Начинаем',
      subtasks: [{ id: 'first', title: 'Уточнить время', done: false }], requestId: randomUUID(), placement,
      assigneeIds: [f.users[2].id], addAttachments: [{ name: 'plan.txt', data: 'WA==' }] };
    const created = await f.bob(tasks, 'POST', rich);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.board.version, 3);
    const replayed = await f.bob(tasks, 'POST', rich);
    assert.equal(replayed.status, 200);
    assert.deepEqual(replayed.body.board, created.body.board);
    const task = created.body.entry;
    const card = tasks + '/' + task.id;
    assert.equal((await f.alice(path)).body.tasks[0].subtasks[0].title, 'Уточнить время');
    assert.equal((await f.director(path)).body.tasks.length, 0);
    assert.equal((await f.director('/api/work')).body.work.tasks.length, 0);
    assert.equal((await f.director(card, 'PATCH', { version: 1, comment: 'нет' })).status, 404);
    assert.equal((await f.director(card + '/files/' + task.attachments[0].id)).status, 404);
    const current = (await f.alice(path)).body.boards.find((b: {id:string}) => b.id === project.id);
    const move = {action: 'moveCard', columnId: project.columns[1].id, cardId: task.id, version: current.version};
    const concurrent = await Promise.all([f.alice(projectPath, 'PATCH', move), f.bob(projectPath, 'PATCH', move)]);
    assert.deepEqual(concurrent.map(r => r.status).sort(), [200,409]);
    assert.equal((await f.alice(projectPath, 'PATCH', {version:current.version+1, action:'deleteColumn', columnId:move.columnId})).status,409);
    assert.equal((await f.alice(projectPath, 'PATCH', {version:current.version+1, action:'rename', title:'Учёба', memberIds:[]})).status,200);
    assert.equal((await f.bob('/api/work')).body.work.tasks.length,0);
    assert.equal((await f.bob(card + '/files/' + task.attachments[0].id)).status,404);
    assert.equal((await f.bob(card, 'PATCH', {version:1,comment:'нет'})).status,404);

    const ordinary = (await f.alice(tasks, 'POST', {title:'Обычная задача', assigneeIds:[f.users[2].id]})).body.entry;
    const common = (await list(f.director))[0];
    assert.equal(common.id, 'work-common');
    assert.equal(common.columns[0].cards.length,0);
    const ordinaryPath = tasks + '/' + ordinary.id;
    const publish = {version:1, placement:{boardId:common.id, columnId:'todo', version:common.version}};
    assert.equal((await f.bob(ordinaryPath,'PATCH',publish)).status,403);
    assert.equal((await f.alice(ordinaryPath,'PATCH',publish)).body.entry.id,ordinary.id);
    const complete = await f.bob(ordinaryPath,'PATCH',{version:2,status:'done'});
    assert.equal(complete.body.entry.status,'done');
    assert.equal(complete.body.board.id,common.id);
    assert.ok(complete.body.entry.archivedAt);
    const updated = (await list(f.bob))[0];
    assert.equal(updated.columns.find((c:{id:string}) => c.id === 'done').cards[0].id,ordinary.id);
    assert.equal((await f.director(ordinaryPath,'PATCH',{version:3,placement:{boardId:common.id,columnId:'doing',version:updated.version}})).body.entry.archivedAt,null);
    assert.equal((await f.director(path+'/'+common.id,'DELETE',{version:4})).status,403);
    const draft = { title: 'Из формы задач', requestId: randomUUID(), placement: { boardId: common.id, columnId: 'todo' } };
    const fromList = (await f.alice(tasks, 'POST', draft)).body.entry;
    assert.equal(fromList.boardId, common.id);
    assert.equal((await f.alice(tasks, 'POST', draft)).body.entry.id, fromList.id);
    const firstColumn = (await list(f.bob))[0].columns[0];
    assert.deepEqual(firstColumn.cards.map((row: {id: string}) => row.id), [fromList.id]);
    const changed = await f.bob(tasks+'/'+fromList.id, 'PATCH', { version: fromList.version, status: 'doing' });
    assert.equal(changed.status, 200);
    assert.ok((await list(f.alice))[0].columns[1].cards.some((row: {id: string}) => row.id === fromList.id));
  } finally { await f.close(); }
});


test('existing company project keeps its audience and upgrades an old card in place', async () => {
  const f = await setup();
  try {
    const [owner, participant] = f.users;
    const card = { id: randomUUID(), title: 'Разобрать материалы', description: 'Первая глава' };
    const column = { id: randomUUID(), title: 'Продвижение', cards: [card] };
    const board = { id: randomUUID(), version: 1, title: 'Обучение', ownerId: owner.id,
      companyId: f.snapshot.companies[0].id, columns: [column] };
    await f.store.mutate(base.provenance.sourceSha256, data => {
      (data.work ??= emptyWork()).boards = [board];
      return { changed: true, result: null };
    });
    const findBoard = async (client: typeof f.alice) =>
      (await client('/api/work/boards')).body.boards.find((row: {id: string}) => row.id === board.id);
    const converted = await findBoard(f.alice);
    assert.deepEqual(converted.memberIds, [participant.id]);
    assert.equal(converted.companyId, undefined);
    assert.equal(await findBoard(f.bob), undefined);
    const updated = await f.alice('/api/work/tasks/'+card.id, 'PATCH', {
      version: 1, status: 'done', archived: true, placement: { boardId: board.id, columnId: column.id, version: converted.version }
    });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.equal(updated.body.entry.id, card.id);
    assert.equal(updated.body.entry.description, card.description);
    assert.equal(updated.body.entry.status, 'done');
    assert.ok(updated.body.entry.archivedAt);
    assert.deepEqual((await findBoard(f.alice)).columns[0].cards, [card]);
    const reopened = await f.alice('/api/work/tasks/'+card.id, 'PATCH', { version: updated.body.entry.version, status: 'todo', archived: false });
    assert.equal(reopened.status, 200);
    assert.equal(reopened.body.entry.status, 'todo');
    assert.equal(reopened.body.entry.archivedAt, null);
  } finally { await f.close(); }
});
