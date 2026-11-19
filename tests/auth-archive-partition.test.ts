import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs, { open, readFile, writeFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import { OperationsStore, LegacyOperationsStore, type OperationsData } from '../server/operations-store';
import { authPartitionVersion, migrateArchiveStorage, mergeAuthStorage } from '../server/auth-partition';
import { archiveFixture } from './helpers/auth-archive-fixture';
import { validateWorkData } from '../server/work-operations';
const source = 'a'.repeat(64), stamp = '2026-11-09T00:00:00Z';
const seal = (data: unknown) => JSON.stringify({ sha256: createHash('sha256').update(JSON.stringify(data)).digest('hex'), data });
const edit = (data: OperationsData, parts: string[]) => {
  if (parts.includes('core')) data.shipments.example.version++;
  if (parts.includes('auth')) data.accounts!.users[0].version++;
  if (parts.includes('work')) data.work!.notes.push({ id: 'n', title: 'Synthetic', content: 'Synthetic', assigneeId: 'owner', createdBy: 'owner', updatedBy: 'owner', createdAt: stamp, updatedAt: stamp, version: 1 });
  if (parts.includes('archive')) data.documentArchive!.categories[0].name = 'Updated';
};
test('offline v2 split/current merge preserves exact logical state and historical v1 parts', async () => {
  const f = await archiveFixture(false); try {
    const before = await f.store.read(source), historical = await Promise.all(['core','auth','work'].map(part => readFile(resolve(f.directory, `auth-storage/${part}.json`))));
    assert.equal((await migrateArchiveStorage(f.directory, source)).changed, true);
    assert.equal(await authPartitionVersion(f.store.path, source), 2);
    assert.deepEqual(await f.store.read(source), before);
    assert.equal((await migrateArchiveStorage(f.directory, source)).changed, false);
    assert.deepEqual(await Promise.all(['core','auth','work'].map(part => readFile(resolve(f.directory, `auth-storage/${part}.json`)))), historical);
    assert.equal(Object.hasOwn(JSON.parse(await readFile(f.part.corePath, 'utf8')).data, 'documentArchive'), false);
    await assert.rejects(new LegacyOperationsStore(f.directory).read(source));
    await f.store.mutate(source, d => { edit(d, ['core','archive']); return { result: null, changed: true }; });
    const current = await f.store.read(source); await mergeAuthStorage(f.directory, source);
    assert.deepEqual(await new LegacyOperationsStore(f.directory).read(source), current);
  } finally { await f.close(); }
});
for (let mask = 1; mask < 16; mask++) {
  const parts = ['core','auth','work','archive'].filter((_, bit) => mask & (1 << bit));
  test(`v2 commits ${parts.join('+')} and preserves every unchanged file`, async () => {
    const f = await archiveFixture(); try {
      const before = await f.store.read(source), files = Object.fromEntries(await Promise.all(['core','auth','work','archive'].map(async part => [part, await readFile(resolve(f.part.directory, `${part}.json`))])));
      await f.store.mutate(source, d => { edit(d, parts); return { result: null, changed: true }; });
      const after = await new OperationsStore(f.directory).read(source);
      const expected = structuredClone(before); edit(expected, parts); expected.revision += parts.length;
      assert.deepEqual(after, expected);
      for (const part of ['core','auth','work','archive']) if (!parts.includes(part)) assert.deepEqual(await readFile(resolve(f.part.directory, `${part}.json`)), files[part]);
      await assert.rejects(stat(f.part.journalPath), { code: 'ENOENT' });
    } finally { await f.close(); }
  });
}
test('v2 auth/core changes do not rewrite archive and cached references cannot alter durable data', async () => {
  const f = await archiveFixture(); try {
    const bytes = await readFile(f.part.archivePath), inode = (await stat(f.part.archivePath)).ino;
    await f.store.mutateAuth(source, d => { d.accounts!.users[0].version++; return { result: null, changed: true }; });
    const view = await f.store.read(source); view.documentArchive!.documents[0].data = 'bGVhaw==';
    await assert.rejects(f.store.mutateWork(source, d => { d.documentArchive!.categories[0].name = 'illegal'; return { result: null, changed: true }; }), /another domain/);
    await f.store.mutate(source, d => { d.shipments.example.version++; return { result: d.documentArchive, changed: true }; });
    assert.deepEqual(await readFile(f.part.archivePath), bytes); assert.equal((await stat(f.part.archivePath)).ino, inode);
    assert.equal((await new OperationsStore(f.directory).read(source)).documentArchive!.documents[0].data, 'YWJj');
  } finally { await f.close(); }
});
test('v2 partial WAL recovers changed domains only; corrupted unchanged archive fails closed', async () => {
  const f = await archiveFixture(); try {
    const core = JSON.parse(await readFile(f.part.corePath, 'utf8')).data, auth = JSON.parse(await readFile(f.part.authPath, 'utf8')).data;
    core.shipments.example.version++; core.revision++; auth.accounts.users[0].active = false; auth.revision++;
    const journal = seal({ format: 'artel-auth-redo-v2', sourceSha256: source, parts: { core: seal(core), auth: seal(auth) } });
    assert.equal(journal.includes('YWJj'), false);
    await writeFile(f.part.journalPath, journal);
    const archive = await readFile(f.part.archivePath, 'utf8');
    await writeFile(f.part.archivePath, archive.replace('YWJj', 'YWJk'));
    await assert.rejects(f.store.readAuth(source));
    await writeFile(f.part.archivePath, archive);
    assert.equal((await f.store.readAuth(source)).accounts!.users[0].active, false);
    assert.equal((await f.store.read(source)).shipments.example.version, 2);
  } finally { await f.close(); }
});
test('v2 rejects malformed archive identity, duplicate core ownership and unknown journal parts', async () => {
  for (const which of ['archive-source','archive-field','duplicate','journal']) {
    const f = await archiveFixture(); try {
      await f.store.read(source);
      if (which === 'journal') await writeFile(f.part.journalPath, seal({ format:'artel-auth-redo-v2',sourceSha256:source,parts:{core:'bad',other:'bad'} }));
      else if (which === 'duplicate') { const core = JSON.parse(await readFile(f.part.corePath,'utf8')).data; core.documentArchive = {}; await writeFile(f.part.corePath,seal(core)); }
      else { const archive = JSON.parse(await readFile(f.part.archivePath,'utf8')).data; if(which==='archive-source') archive.sourceSha256='b'.repeat(64); else archive.unknown=true; await writeFile(f.part.archivePath,seal(archive)); }
      await assert.rejects(f.store.read(source));
    } finally { await f.close(); }
  }
});

test('v2 fresh reader reuses checksum serialization and preserves noncanonical-byte rewrite behavior', async () => {
  const f = await archiveFixture(); try {
    const { withPerformanceTrace } = await import('../server/performance-trace');
    const spans: string[] = [];
    await withPerformanceTrace('cold-read', () => new OperationsStore(f.directory).read(source), trace => { spans.push(...trace.spans.map(span => span.name)); });
    assert.equal(spans.includes('codec.canonical-copy'), false);
    assert.equal(spans.includes('codec.checksum-envelope'), false);
    const core = JSON.parse(await readFile(f.part.corePath, 'utf8'));
    await writeFile(f.part.corePath, JSON.stringify(core, null, 2));
    const current = await f.store.read(source);
    await f.store.mutate(source, () => ({ changed: true, result: null }));
    const raw = await readFile(f.part.corePath, 'utf8');
    assert.equal(raw, seal(JSON.parse(raw).data));
    assert.equal((await f.store.read(source)).revision, current.revision + 1);
  } finally { await f.close(); }
});

test('Work view preserves global revision across external changes and commits task + notification atomically', async () => {
  const f = await archiveFixture();
  try {
    const external = new OperationsStore(f.directory), before = await external.read(source);
    const archiveBytes = await readFile(f.part.archivePath);
    const updateWork = (d: OperationsData) => {
      d.work!.notes.push({ id: 'n', title: 'Work', content: 'Work', assigneeId: 'owner', createdBy: 'owner', updatedBy: 'owner', createdAt: stamp, updatedAt: stamp, version: 1 });
      d.push!.taskCompletions = { n: { version: 1, at: Date.now(), completedByName: 'Owner' } };
      return { result: null, changed: true };
    };
    const projected = await f.store.readWorkspace(source);
    const { documentArchive: _archive, ...business } = before;
    assert.deepEqual(projected, business);
    await f.store.mutateWork(source, updateWork, 'workspace');
    const after = await external.read(source);
    assert.equal(after.work!.notes.length, 1);
    assert.equal(after.push!.taskCompletions!.n.version, 1);
    assert.equal(after.revision, before.revision + 2);
    assert.deepEqual(await readFile(f.part.archivePath), archiveBytes);
    await external.mutate(source, d => { d.documentArchive!.categories[0].name = 'Externally updated'; d.accounts!.users[0].active = false; return { result: null, changed: true }; });
    assert.equal((await f.store.readWorkspace(source)).revision, after.revision + 2);
    assert.equal((await f.store.readBoards(source)).accounts!.users[0].active, false);
    for (const bad of [(d: OperationsData) => { d.accounts!.users[0].active = true; }, (d: OperationsData) => { d.sourceOperationsCleared = true; }, (d: OperationsData) => { d.documentArchive = before.documentArchive; }]) {
      await assert.rejects(f.store.mutateWork(source, d => { bad(d); return { result: null, changed: true }; }, 'workspace'), /another domain/);
    }
    assert.deepEqual((await external.read(source)).work, after.work);
  } finally { await f.close(); }
});

test('a warm workspace rejects invalid entries and outbox events without committing either partition', async () => {
  const f = await archiveFixture();
  try {
    const before = await f.store.read(source);
    for (const change of [
      (d: OperationsData) => { d.work!.notes.push({ id: 'invalid' } as never); },
      (d: OperationsData) => { d.push!.taskCompletions = { broken: { version: -1, at: 1, completedByName: 'Owner' } }; },
    ]) {
      await assert.rejects(f.store.mutateWork(source, data => { change(data); return { result: null, changed: true }; }, 'workspace'));
      assert.deepEqual(await f.store.read(source), before);
    }
  } finally { await f.close(); }
});

test('Work detects changed archive checksum, source, shape and invalid binary payload after a warm read', async () => {
  const f = await archiveFixture();
  try {
    const raw = await readFile(f.part.archivePath, 'utf8');
    const original = JSON.parse(raw).data;
    const workBytes = await readFile(f.part.workPath);
    const corrupt = structuredClone(original);
    corrupt.documentArchive.documents[0].size++;
    for (const bad of [raw.replace('YWJj', 'YWJk'), seal({ ...original, sourceSha256: 'b'.repeat(64) }), seal({ ...original, unknown: true }), seal(corrupt)]) {
      await f.store.readWorkspace(source);
      await writeFile(f.part.archivePath, bad);
      let called = false;
      await assert.rejects(f.store.mutateWork(source, () => { called = true; return { changed: true, result: null }; }, 'workspace'));
      assert.equal(called, false);
      assert.deepEqual(await readFile(f.part.workPath), workBytes);
      await writeFile(f.part.archivePath, raw);
    }
  } finally { await f.close(); }
});

test('Work projection counts actual on-disk archive bytes toward the combined backup limit', async () => {
  const f = await archiveFixture();
  try {
    const workBefore = await readFile(f.part.workPath);
    const archiveBefore = await readFile(f.part.archivePath, 'utf8');
    const buffer = Buffer.alloc(1024 * 1024, 32);
    const file = await open(f.part.archivePath, 'a');
    try {
      let left = 128 * 1024 * 1024 - 4096 - Buffer.byteLength(archiveBefore);
      while (left > 0) { const { bytesWritten } = await file.write(buffer, 0, Math.min(left, buffer.length)); left -= bytesWritten; }
    } finally { await file.close(); }
    await assert.rejects(f.store.mutateWork(source, d => { d.work!.boards = []; return { result: null, changed: true }; }, 'workspace'), /safe flat backup/);
    assert.deepEqual(await readFile(f.part.workPath), workBefore);
  } finally { await f.close(); }
});

test('Work outbox and entry recover together if the second file rename fails', async t => {
  const f = await archiveFixture();
  try {
    const before = await f.store.readWorkspace(source), rename = fs.rename;
    const fail = t.mock.method(fs, 'rename', async (from, to) => {
      if (to === f.part.workPath) throw new Error('Simulated interrupted commit');
      return rename(from, to);
    });
    syncBuiltinESMExports();
    try {
      await assert.rejects(f.store.mutateWork(source, d => {
        d.work!.notes.push({ id: 'notify', title: 'Saved', content: 'Saved', assigneeId: 'owner', createdBy: 'owner', updatedBy: 'owner', createdAt: stamp, updatedAt: stamp, version: 1 });
        d.push!.taskCompletions = { notify: { version: 1, at: 1, completedByName: 'Owner' } };
        return { result: null, changed: true };
      }, 'workspace'), /interrupted/);
    } finally { fail.mock.restore(); syncBuiltinESMExports(); }
    const recovered = await new OperationsStore(f.directory).readWorkspace(source);
    assert.equal(recovered.revision, before.revision + 2);
    assert.equal(recovered.work!.notes[0].id, 'notify');
    assert.equal(recovered.push!.taskCompletions!.notify.version, 1);
    await assert.rejects(stat(f.part.journalPath), { code: 'ENOENT' });
  } finally { await f.close(); }
});

test('Work payload cache requires exact content and length and always rechecks file metadata', () => {
  const file = { id: 'file', data: 'YWJj', size: 3, authorId: 'owner', createdAt: stamp, name: 'a.txt' };
  const entry = { id: 'task', createdBy: 'owner', updatedBy: 'owner', assigneeId: 'owner', createdAt: stamp, updatedAt: stamp, version: 1,
    title: 'Test', description: '', status: 'todo', companyId: null, dueDate: null, reminderAt: null, attachments: [file] };
  const work = { tasks: [entry], notes: [], companyRecords: [] };
  validateWorkData(work);
  for (const fields of [{ data: 'YWJ!' }, { size: 2 }, { name: '../file' }, { createdAt: 'invalid' }]) {
    const copy = structuredClone(work);
    Object.assign(copy.tasks[0].attachments[0], fields);
    assert.throws(() => validateWorkData(copy));
    validateWorkData(work);
  }
});

test('full reads reuse the sealed archive and see atomic replacement and same-size in-place corruption', async () => {
  const f = await archiveFixture();
  try {
    const { withPerformanceTrace } = await import('../server/performance-trace');
    const fresh = new OperationsStore(f.directory);
    async function readArchiveBytes() {
      let reads = 0;
      const data = await withPerformanceTrace('archive-cache', () => fresh.read(source), trace => {
        reads = trace.spans.filter(span => span.name === 'partition.read-archive-bytes').length;
      });
      return { reads, name: data.documentArchive!.categories[0].name };
    }
    assert.deepEqual(await readArchiveBytes(), { reads: 1, name: 'Synthetic' });
    assert.deepEqual(await readArchiveBytes(), { reads: 0, name: 'Synthetic' });
    // A different process may replace the archive without touching the pointer.
    const raw = await readFile(f.part.archivePath, 'utf8');
    const repaired = JSON.parse(raw).data;
    repaired.documentArchive.categories[0].name = 'Different';
    const path = f.part.archivePath + '.test';
    await writeFile(path, seal(repaired));
    const mtime = (await stat(f.part.archivePath)).mtime;
    await fs.utimes(path, mtime, mtime);
    await fs.rename(path, f.part.archivePath);
    assert.deepEqual(await readArchiveBytes(), { reads: 1, name: 'Different' });
    assert.deepEqual(await readArchiveBytes(), { reads: 0, name: 'Different' });
    await writeFile(f.part.archivePath, seal(repaired).replace('YWJj', 'YWJk'));
    await fs.utimes(f.part.archivePath, mtime, mtime);
    await assert.rejects(fresh.read(source), /checksum/);
    await assert.rejects(fresh.mutate(source, () => { throw Error('Unexpected write callback'); }), /checksum/);
    await assert.rejects(fresh.readDocuments(source), /checksum/);
  } finally { await f.close(); }
});

test('narrow core and document reads isolate returned references, see current rights and validate complete changed core', async () => {
  const f = await archiveFixture();
  try {
    const full = await f.store.read(source);
    const documentView = await f.store.readDocuments(source);
    assert.deepEqual(documentView.documentArchive, full.documentArchive);
    assert.deepEqual(documentView.shipments, {});
    assert.equal(documentView.work, undefined);
    documentView.documentArchive!.categories[0].name = 'Local mutation';
    assert.deepEqual((await f.store.readDocuments(source)).documentArchive, full.documentArchive);
    const workless = await f.store.readCoreFields(source, ['shipments', 'sourceOperationsCleared']);
    assert.deepEqual(workless.shipments, full.shipments);
    assert.equal(workless.work, undefined);
    assert.equal(workless.documentArchive, undefined);
    workless.shipments.example.version++;
    assert.deepEqual((await f.store.readCoreFields(source, ['shipments'])).shipments, full.shipments);
    assert.deepEqual((await f.store.readCoreFields(source, ['banking'])).shipments, {});
    await new OperationsStore(f.directory).mutateAuth(source, d => { d.accounts!.users[0].active = false; return { changed: true, result: null }; });
    assert.equal((await f.store.readDocuments(source)).accounts!.users[0].active, false);
    assert.equal((await f.store.readCoreFields(source, ['companies'])).accounts!.users[0].active, false);
    const core = JSON.parse(await readFile(f.part.corePath, 'utf8')).data;
    core.shipments.example.version = -1;
    await writeFile(f.part.corePath, seal(core));
    await assert.rejects(f.store.readCoreFields(source, ['companies']));
  } finally { await f.close(); }
});

test('mixed commit rejects malformed canonical images before publishing its WAL', async () => {
  const f = await archiveFixture();
  try {
    const before = await f.store.read(source);
    await assert.rejects(f.store.mutate(source, d => {
      d.shipments.example.version++;
      d.work!.notes = [];
      Object.assign(d.work!, { toJSON: () => ({ tasks: null }) });
      return { changed: true, result: null };
    }));
    await assert.rejects(stat(f.part.journalPath), { code: 'ENOENT' });
    assert.deepEqual(await new OperationsStore(f.directory).read(source), before);
  } finally { await f.close(); }
});
