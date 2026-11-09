import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { OperationsStore, LegacyOperationsStore, type OperationsData } from '../server/operations-store';
import { authPartitionVersion, migrateArchiveStorage, mergeAuthStorage } from '../server/auth-partition';
import { archiveFixture } from './helpers/auth-archive-fixture';
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
