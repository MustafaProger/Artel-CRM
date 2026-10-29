import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { OperationsStore, LegacyOperationsStore, encodeOperations } from '../server/operations-store';
import { WorkPartition, migrateWorkStorage, mergeWorkStorage } from '../server/work-partition';
import { emptyWork } from '../web/src/work-model';
const source = 'a'.repeat(64);
const seal = (data: unknown) => JSON.stringify({ sha256: createHash('sha256').update(JSON.stringify(data)).digest('hex'), data });
const delay = (n: number) => new Promise(r => setTimeout(r, n));
async function fixture() {
  const directory = await mkdtemp(resolve(tmpdir(), 'work-partition-'));
  const store = new OperationsStore(directory);
  await store.mutate(source, data => {
    data.work = { ...emptyWork(), tasks: [{ id: 'task-1', title: 'Синтетическая задача', description: 'Описание', status: 'todo', companyId: null, dueDate: null, reminderAt: '2026-11-01T10:00:00Z', assigneeId: 'employee-1', createdBy: 'employee-1', updatedBy: 'employee-1', createdAt: '2026-10-01T10:00:00Z', updatedAt: '2026-10-01T10:00:00Z', version: 1, attachments: [{ id: 'file-1', name: 'example.txt', size: 3, data: 'YWJj', authorId: 'employee-1', createdAt: '2026-10-01T10:00:00Z' }], comments: [{ id: 'comment-1', text: 'Комментарий', authorId: 'employee-1', createdAt: '2026-10-01T10:00:00Z' }] }] };
    data.push = { devices: [], deliveries: {}, taskAssignments: { 'task-1': { version: 1, assigneeId: 'employee-1', at: Date.now() } } };
    return { result: null, changed: true };
  });
  return { directory, store, part: new WorkPartition(store.path), close: () => rm(directory, { recursive: true, force: true }) };
}
test('offline split is exact and idempotent; legacy binaries fail closed; fresh readers see one source', async () => {
  const f = await fixture(); try {
    const before = await f.store.read(source);
    assert.equal((await migrateWorkStorage(f.directory, source)).changed, true);
    assert.deepEqual(await new OperationsStore(f.directory).read(source), before);
    assert.equal((await migrateWorkStorage(f.directory, source)).changed, false);
    await assert.rejects(new LegacyOperationsStore(f.directory).read(source));
    const core = await f.part.core.read(source); assert.equal(core.work, undefined); assert.equal(core.push?.taskAssignments, undefined);
    const disk = JSON.parse(await readFile(f.part.workPath, 'utf8')).data;
    assert.deepEqual(disk.work, before.work); assert.deepEqual(disk.taskAssignments, before.push?.taskAssignments);
  } finally { await f.close(); }
});
test('Work commit changes only work.json; core/rights/directories bytes and inode stay exact', async () => {
  const f = await fixture(); try {
    await migrateWorkStorage(f.directory, source); const core = await readFile(f.part.core.path); const inode = (await stat(f.part.core.path)).ino;
    await f.store.mutateWork(source, data => { data.work!.tasks[0].status = 'done'; data.work!.tasks[0].version++; delete data.push!.taskAssignments!['task-1']; return { result: null, changed: true }; });
    assert.deepEqual(await readFile(f.part.core.path), core); assert.equal((await stat(f.part.core.path)).ino, inode);
    assert.equal((await f.store.read(source)).work!.tasks[0].status, 'done');
  } finally { await f.close(); }
});
test('Work domain guard rejects accidental writes to accounts/core and preserves both files', async () => {
  const f = await fixture(); try {
    await migrateWorkStorage(f.directory, source); const before = encodeOperations(await f.store.read(source));
    await assert.rejects(f.store.mutateWork(source, d => { d.sourceOperationsCleared = true; d.work!.tasks[0].status = 'done'; return { result: null, changed: true }; }), /another domain/);
    assert.equal(encodeOperations(await f.store.read(source)), before);
  } finally { await f.close(); }
});
test('mixed core/Work commit is visible atomically, advances revision and persists across instances', async () => {
  const f = await fixture(); try {
    await migrateWorkStorage(f.directory, source); const before = (await f.store.read(source)).revision;
    await f.store.mutate(source, d => { d.sourceOperationsCleared = true; d.work!.tasks[0].status = 'done'; return { result: null, changed: true }; });
    const result = await new OperationsStore(f.directory).read(source); assert.equal(result.sourceOperationsCleared, true); assert.equal(result.work!.tasks[0].status, 'done'); assert.ok(result.revision > before);
    await assert.rejects(stat(f.part.journalPath), { code: 'ENOENT' });
  } finally { await f.close(); }
});
test('validated redo journal recovers an interrupted two-file commit without losing new tasks', async () => {
  const f = await fixture(); try {
    await migrateWorkStorage(f.directory, source);
    const core = await f.part.core.read(source); core.sourceOperationsCleared = true; core.revision++;
    const work = JSON.parse(await readFile(f.part.workPath, 'utf8')).data; work.revision++; work.work.tasks[0].title = 'Новая подтверждённая запись';
    const coreBytes = encodeOperations(core), workBytes = seal(work);
    await writeFile(f.part.journalPath, seal({ sourceSha256: source, core: coreBytes, work: workBytes }));
    await writeFile(f.part.core.path, coreBytes); // crash after first rename
    const restored = await new OperationsStore(f.directory).read(source);
    assert.equal(restored.sourceOperationsCleared, true); assert.equal(restored.work!.tasks[0].title, 'Новая подтверждённая запись');
    await assert.rejects(stat(f.part.journalPath), { code: 'ENOENT' });
  } finally { await f.close(); }
});
test('damaged/missing Work, journal and wrong-source pointers fail closed instead of empty bootstrap', async () => {
  for (const target of ['work', 'journal', 'missing', 'source']) {
    const f = await fixture(); try {
      await migrateWorkStorage(f.directory, source); const core = await readFile(f.part.core.path);
      if (target === 'missing') await rm(f.part.workPath);
      else if (target === 'work') await writeFile(f.part.workPath, '{"data":{}}');
      else if (target === 'journal') await writeFile(f.part.journalPath, '{"data":{}}');
      await assert.rejects(f.store.read(target === 'source' ? 'b'.repeat(64) : source));
      await assert.rejects(f.store.mutateWork(target === 'source' ? 'b'.repeat(64) : source, d => { d.work = emptyWork(); return { result: null, changed: true }; }));
      assert.deepEqual(await readFile(f.part.core.path), core);
    } finally { await f.close(); }
  }
});
test('rollback merges CURRENT Work changes, not the premigration backup, and is idempotent', async () => {
  const f = await fixture(); try {
    await migrateWorkStorage(f.directory, source);
    await f.store.mutateWork(source, d => { d.work!.tasks[0].title = 'После переноса'; d.work!.tasks[0].version++; return { result: null, changed: true }; });
    const before = await f.store.read(source);
    assert.equal((await mergeWorkStorage(f.directory, source)).changed, true);
    assert.deepEqual(await new LegacyOperationsStore(f.directory).read(source), before);
    assert.equal((await mergeWorkStorage(f.directory, source)).changed, false);
  } finally { await f.close(); }
});
test('Work bypasses the queued core backlog but respects an in-flight shared transaction', async () => {
  const f = await fixture(); try {
    await migrateWorkStorage(f.directory, source); const order: string[] = []; let release!: () => void; let started!: () => void;
    const running = new Promise<void>(r => started = r); const gate = new Promise<void>(r => release = r);
    const first = f.store.mutate(source, async () => { started(); await gate; order.push('core-first'); return { result: null, changed: false }; }); await running;
    const backlog = Array.from({ length: 8 }, (_, i) => f.store.mutate(source, async () => { await delay(10); order.push(`core-${i}`); return { result: null, changed: false }; }));
    const work = f.store.mutateWork(source, d => { order.push('work'); d.work!.tasks[0].version++; return { result: null, changed: true }; });
    await delay(30); assert.deepEqual(order, []); release(); await Promise.all([first, work, ...backlog]);
    assert.ok(order.indexOf('work') < 3, order.join(',')); assert.equal((await f.store.read(source)).work!.tasks[0].version, 2);
  } finally { await f.close(); }
});
test('multiple instances serialize 20 Work updates without losing writes', async () => {
  const f = await fixture(); try {
    await migrateWorkStorage(f.directory, source);
    await Promise.all(Array.from({ length: 20 }, () => new OperationsStore(f.directory).mutateWork(source, d => { d.work!.tasks[0].version++; return { result: null, changed: true }; })));
    assert.equal((await f.store.read(source)).work!.tasks[0].version, 21);
  } finally { await f.close(); }
});
test('missing source cannot be migrated and orphan storage is never overwritten', async () => {
  const f = await fixture(); try {
    await rm(f.store.path); await assert.rejects(migrateWorkStorage(f.directory, source));
  } finally { await f.close(); }
});

test('core access change wins before a waiting Work mutation rechecks fresh authority', async () => {
  const f=await fixture();try {
    await migrateWorkStorage(f.directory,source);let started!:()=>void,release!:()=>void;
    const gate=new Promise<void>(r=>release=r),ready=new Promise<void>(r=>started=r);
    const revoke=f.store.mutate(source,async d=>{started();await gate;d.sourceOperationsCleared=true;return{result:null,changed:true}});await ready;
    const work=f.store.mutateWork(source,d=>{if(d.sourceOperationsCleared)throw new Error('authority revoked');d.work!.tasks[0].status='done';return{result:null,changed:true}});
    const refused=assert.rejects(work,/authority revoked/);await delay(20);release();await Promise.all([revoke,refused]);assert.equal((await f.store.read(source)).work!.tasks[0].status,'todo');
  }finally{await f.close();}
});

test('split and merge preserve an explicitly empty push shell as well as absent optional data', async () => {
  for (const present of [false, true]) {
    const f = await fixture(); try {
      await f.store.mutate(source, d => { delete d.work; if (present) d.push = { devices: [], deliveries: {} }; else delete d.push; return { result: null, changed: true }; });
      const before = await f.store.read(source);
      await migrateWorkStorage(f.directory, source);
      assert.deepEqual(await f.store.read(source), before);
      await mergeWorkStorage(f.directory, source);
      assert.deepEqual(await f.store.read(source), before);
    } finally { await f.close(); }
  }
});

test('cached committed core never hides a later corrupted on-disk file', async () => {
  const f = await fixture(); try {
    await migrateWorkStorage(f.directory, source);
    await f.store.mutate(source, d => { d.sourceOperationsCleared = true; return { result: null, changed: true }; });
    assert.equal((await f.store.read(source)).sourceOperationsCleared, true);
    await writeFile(f.part.core.path, '{}');
    await assert.rejects(f.store.read(source));
    await assert.rejects(f.store.mutateWork(source, d => { d.work!.tasks[0].version++; return { result: null, changed: true }; }));
  } finally { await f.close(); }
});

test('Work refuses growth beyond the flat backup size bound before replacing either file', async () => {
  const f = await fixture(); try {
    await migrateWorkStorage(f.directory, source);
    const raw = await readFile(f.part.core.path, 'utf8');
    // Valid JSON whitespace creates a near-limit physical core without fake entities.
    await writeFile(f.part.core.path, raw + ' '.repeat(64 * 1024 * 1024 - 4096 - Buffer.byteLength(raw)));
    const before = await readFile(f.part.workPath);
    await assert.rejects(f.store.mutateWork(source, d => { d.work!.tasks[0].description = 'x'.repeat(10000); return { result: null, changed: true }; }), /safe backup/);
    assert.deepEqual(await readFile(f.part.workPath), before);
    assert.equal((await stat(f.part.core.path)).size, 64 * 1024 * 1024 - 4096);
  } finally { await f.close(); }
});
