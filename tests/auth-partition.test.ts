import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { LegacyOperationsStore, OperationsStore, type OperationsData } from '../server/operations-store';
import { isWorkPartition, migrateWorkStorage } from '../server/work-partition';
import { AuthPartition, isAuthPartition, migrateAuthStorage, mergeAuthStorage } from '../server/auth-partition';
import { authenticate, login, logout, passwordFields } from '../server/auth';
import { emptyWork } from '../web/src/work-model';
import type { IncomingMessage } from 'node:http';
const source = 'a'.repeat(64), password = 'Synthetic-auth-partition-password';
const seal = (data: unknown) => JSON.stringify({ sha256: createHash('sha256').update(JSON.stringify(data)).digest('hex'), data });
const cookie = (token: string) => ({ headers: { cookie: `artel_session=${token}` }, url: '/api/auth/session' }) as IncomingMessage;
async function fixture() {
  const directory = await mkdtemp(resolve(tmpdir(), 'auth-partition-')), store = new OperationsStore(directory), fields = await passwordFields(password);
  await store.mutate(source, data => {
    data.accounts = { users: [{ ...fields, id: 'owner', login: 'owner', name: 'Synthetic owner', role: 'director', active: true, version: 1, managerId: null }, { ...fields, id: 'reserve', login: 'reserve', name: 'Synthetic reserve', role: 'director', active: true, version: 1, managerId: null }], sessions: [], attempts: {} };
    data.work = emptyWork(); data.push = { devices: [], deliveries: {} };
    data.shipments.example = { version: 1, fields: { note: 'preserve business data' }, createdAt: '2026-11-09T00:00:00Z', updatedAt: '2026-11-09T00:00:00Z' };
    return { changed: true, result: null };
  });
  return { directory, store, part: new AuthPartition(store.path), close: () => rm(directory, { recursive: true, force: true }) };
}
for (const workFirst of [false, true]) test(`offline migration/current-state merge preserves every field and old readers fail closed (${workFirst ? 'Work' : 'legacy'})`, async () => {
  const f = await fixture(); try {
    if (workFirst) await migrateWorkStorage(f.directory, source);
    const before = await f.store.read(source);
    assert.equal((await migrateAuthStorage(f.directory, source)).changed, true);
    assert.deepEqual(await new OperationsStore(f.directory).read(source), before);
    assert.equal(await isAuthPartition(f.store.path, source), true);
    assert.equal(await isWorkPartition(f.store.path, source), false);
    await assert.rejects(new LegacyOperationsStore(f.directory).read(source));
    assert.equal((await migrateAuthStorage(f.directory, source)).changed, false);
    await f.store.mutateAuth(source, d => { d.accounts!.users[0].name = 'After split'; return { changed: true, result: null }; });
    const current = await f.store.read(source);
    await mergeAuthStorage(f.directory, source);
    assert.deepEqual(await new LegacyOperationsStore(f.directory).read(source), current);
    assert.notEqual(current.accounts!.users[0].name, before.accounts!.users[0].name);
  } finally { await f.close(); }
});
test('auth commit touches only small auth file and durably couples session revocation with worker outbox', async () => {
  const f = await fixture(); try {
    await migrateAuthStorage(f.directory, source);
    const core = await readFile(f.part.corePath), work = await readFile(f.part.workPath), inode = (await stat(f.part.corePath)).ino;
    const result = await f.store.mutateAuth(source, async d => ({ result: await login(d, { login: 'owner', password }), changed: true }));
    assert.equal(result.status, 200); assert.ok(result.token);
    const request = cookie(result.token!);
    assert.equal(authenticate(await f.store.readAuth(source), request)?.id, 'owner');
    await f.store.mutateAuth(source, d => { logout(d, request); return { changed: true, result: null }; });
    const after = await new OperationsStore(f.directory).read(source);
    assert.equal(authenticate(after, request), null);
    assert.ok(after.push!.invoiceRevocations![createHash('sha256').update(result.token!).digest('hex')]);
    assert.deepEqual(await readFile(f.part.corePath), core); assert.deepEqual(await readFile(f.part.workPath), work); assert.equal((await stat(f.part.corePath)).ino, inode);
  } finally { await f.close(); }
});
test('auth projection cannot mutate business, directory rights or task assignments, and returned references stay isolated', async () => {
  const f = await fixture(); try {
    await migrateAuthStorage(f.directory, source); const before = await f.store.read(source);
    for (const edit of [(d: OperationsData) => { d.shipments.injected = before.shipments.example; }, (d: OperationsData) => { d.directories!.managers.push({ id: 'bad', name: 'bad' }); }, (d: OperationsData) => { d.sourceSha256 = 'other'; }]) {
      await assert.rejects(f.store.mutateAuth(source, d => { edit(d); return { changed: true, result: null }; }), /another domain/);
      assert.deepEqual(await f.store.read(source), before);
    }
    const view = await f.store.readAuth(source); view.accounts!.users[0].active = false;
    assert.equal((await f.store.readAuth(source)).accounts!.users[0].active, true);
  } finally { await f.close(); }
});
test('mixed three-domain redo recovers before auth read, including a crash after only core rename', async () => {
  const f = await fixture(); try {
    await migrateAuthStorage(f.directory, source);
    const core = JSON.parse(await readFile(f.part.corePath, 'utf8')).data, auth = JSON.parse(await readFile(f.part.authPath, 'utf8')).data, work = JSON.parse(await readFile(f.part.workPath, 'utf8')).data;
    core.sourceOperationsCleared = true; core.revision++; auth.accounts.users[0].active = false; auth.revision++; work.work.notes.push({ id: 'n', title: 'Synthetic', content: 'Synthetic', assigneeId: 'owner', createdBy: 'owner', updatedBy: 'owner', createdAt: '2026-11-09T00:00:00Z', updatedAt: '2026-11-09T00:00:00Z', version: 1 }); work.revision++;
    const images = { core: seal(core), auth: seal(auth), work: seal(work) };
    await writeFile(f.part.journalPath, seal({ sourceSha256: source, ...images })); await writeFile(f.part.corePath, images.core);
    const view = await new OperationsStore(f.directory).readAuth(source); assert.equal(view.accounts!.users[0].active, false);
    const all = await f.store.read(source); assert.equal(all.sourceOperationsCleared, true); assert.deepEqual(all.work, work.work);
    await assert.rejects(stat(f.part.journalPath), { code: 'ENOENT' });
  } finally { await f.close(); }
});
test('fresh account revocation and concurrent auth/business writes preserve both domains across instances', async () => {
  const f = await fixture(); try {
    await migrateAuthStorage(f.directory, source);
    await Promise.all(Array.from({ length: 12 }, (_, i) => i % 2 ? new OperationsStore(f.directory).mutateAuth(source, d => { d.accounts!.users[0].version++; return { changed: true, result: null }; }) : new OperationsStore(f.directory).mutate(source, d => { d.shipments.example.version++; return { changed: true, result: null }; })));
    const all = await f.store.read(source); assert.equal(all.accounts!.users[0].version, 7); assert.equal(all.shipments.example.version, 7);
    await f.store.mutate(source, d => { d.accounts!.users[0].active = false; return { changed: true, result: null }; });
    const result = await f.store.mutateAuth(source, async d => ({ result: await login(d, { login: 'owner', password }), changed: true })); assert.equal(result.status, 401);
  } finally { await f.close(); }
});
test('corrupt auth bytes, wrong-source pointer and malformed redo fail closed without altering core', async () => {
  for (const which of ['auth', 'journal', 'source']) {
    const f = await fixture(); try {
      await migrateAuthStorage(f.directory, source); await f.store.readAuth(source); const core = await readFile(f.part.corePath);
      if (which === 'auth') await writeFile(f.part.authPath, '{"data":{}}');
      if (which === 'journal') await writeFile(f.part.journalPath, '{"data":{}}');
      await assert.rejects(f.store.readAuth(which === 'source' ? 'b'.repeat(64) : source));
      await assert.rejects(f.store.mutateAuth(which === 'source' ? 'b'.repeat(64) : source, () => ({ changed: true, result: null })));
      assert.deepEqual(await readFile(f.part.corePath), core);
    } finally { await f.close(); }
  }
});
test('Work guard rejects rights changes and permits normal Work-only edits without rewriting core', async () => {
  const f = await fixture(); try {
    await migrateAuthStorage(f.directory, source); const core = await readFile(f.part.corePath), before = await f.store.read(source);
    await assert.rejects(f.store.mutateWork(source, d => { d.accounts!.users[0].active = false; return { changed: true, result: null }; }), /another domain/);
    assert.deepEqual(await f.store.read(source), before);
    await f.store.mutateWork(source, d => { d.work!.notes.push({ id: 'n', title: 'Synthetic', content: 'Synthetic', assigneeId: 'owner', createdBy: 'owner', updatedBy: 'owner', createdAt: '2026-11-09T00:00:00Z', updatedAt: '2026-11-09T00:00:00Z', version: 1 }); return { changed: true, result: null }; });
    assert.deepEqual(await readFile(f.part.corePath), core);
  } finally { await f.close(); }
});

test('validated cache still rejects changed core bytes and Work can initialize its assignment outbox', async () => {
  const f = await fixture(); try {
    await f.store.mutate(source, d => { delete d.push; return { changed: true, result: null }; });
    await migrateAuthStorage(f.directory, source);
    await f.store.mutateWork(source, d => { d.push = { devices: [], deliveries: {}, taskAssignments: {} }; return { changed: true, result: null }; });
    assert.deepEqual((await f.store.read(source)).push, { devices: [], deliveries: {}, taskAssignments: {} });
    await f.store.read(source);
    const old = await readFile(f.part.corePath, 'utf8');
    await writeFile(f.part.corePath, old.replace('preserve business data', 'modified business data'));
    await assert.rejects(f.store.read(source), /checksum/);
  } finally { await f.close(); }
});

test('parsed core cache isolates nested reads, failed mutations and returned commit references', async () => {
  const f = await fixture(); try {
    await migrateAuthStorage(f.directory, source);
    const initial = await f.store.read(source), disk = await readFile(f.part.corePath);
    initial.shipments.example.fields.note = 'read leak';
    const unchanged = await f.store.read(source);
    assert.equal(unchanged.shipments.example.fields.note, 'preserve business data');
    await assert.rejects(f.store.mutate(source, d => { d.shipments.example.fields.note = 'failed leak'; throw Error('synthetic'); }));
    assert.deepEqual(await readFile(f.part.corePath), disk);
    assert.equal((await f.store.read(source)).shipments.example.fields.note, 'preserve business data');
    const returned = await f.store.mutate(source, d => { d.shipments.example.fields.note = 'committed'; return { changed: true, result: d.shipments.example }; });
    returned.fields.note = 'returned leak';
    assert.equal((await f.store.read(source)).shipments.example.fields.note, 'committed');
    assert.equal((await new OperationsStore(f.directory).read(source)).shipments.example.fields.note, 'committed');
    await new OperationsStore(f.directory).mutate(source, d => { d.shipments.example.fields.note = 'external'; return { changed: true, result: null }; });
    assert.equal((await f.store.read(source)).shipments.example.fields.note, 'external');
  } finally { await f.close(); }
});

test('cached core commit preserves JSON omission and field order before and after restart', async () => {
  const f = await fixture(); try {
    await migrateAuthStorage(f.directory, source);
    await f.store.read(source);
    await f.store.mutate(source, d => {
      d.shipments.example.fields = { second: 'new', ...d.shipments.example.fields };
      d.shipments.example.deleted = undefined;
      const shipment = d.shipments.example; delete d.shipments.example; d.shipments.example = shipment;
      return { changed: true, result: null };
    });
    const raw = await readFile(f.part.corePath, 'utf8'), parsed = JSON.parse(raw).data;
    assert.equal(raw, seal(parsed));
    assert.equal(Object.hasOwn(parsed.shipments.example, 'deleted'), false);
    assert.deepEqual(await f.store.read(source), await new OperationsStore(f.directory).read(source));
  } finally { await f.close(); }
});
