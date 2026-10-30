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
            if (result.entry) result.entry.updatedAt = 'ignored-clock';
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
