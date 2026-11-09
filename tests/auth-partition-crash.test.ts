import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { mkdtemp, readdir, rename, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { OperationsStore } from '../server/operations-store';
import { migrateAuthStorage, isAuthPartition } from '../server/auth-partition';
import { emptyWork } from '../web/src/work-model';

const source = 'a'.repeat(64);
async function fixture(partitioned = true) {
  const directory = await mkdtemp(resolve(tmpdir(), 'auth-sigkill-')), store = new OperationsStore(directory);
  await store.mutate(source, data => {
    data.accounts = { users: ['owner', 'reserve'].map(id => ({ id, login: id, name: id, role: 'director', active: true, version: 1, managerId: null, salt: 'a'.repeat(32), passwordHash: 'b'.repeat(128) })), sessions: [], attempts: {} };
    data.work = emptyWork();
    data.shipments.example = { version: 1, fields: { note: 'Synthetic' }, createdAt: '2026-11-09T00:00:00Z', updatedAt: '2026-11-09T00:00:00Z' };
    return { changed: true, result: null };
  });
  if (partitioned) await migrateAuthStorage(directory, source);
  return { directory, store, close: () => rm(directory, { recursive: true, force: true }) };
}
async function child(directory: string, action: string, boundary = 'none') {
  await new Promise<void>((done, reject) => {
    const bundledChild = globalThis.process.env.ARTEL_AUTH_CRASH_CHILD;
    const process = fork(bundledChild || resolve('scripts/profile-auth-crash.mjs'), [directory, action, boundary], { execArgv: bundledChild ? [] : ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    let reached = false, errors = '';
    process.stderr!.on('data', value => { errors += value; });
    const timeout = setTimeout(() => { process.kill('SIGKILL'); reject(new Error(`Child timeout ${action} ${boundary}: ${errors}`)); }, 15000);
    process.on('message', value => {
      if ((value as {boundary?: string}).boundary === boundary) { reached = true; process.kill('SIGKILL'); }
    });
    process.on('error', reject);
    process.on('exit', (code, signal) => {
      clearTimeout(timeout);
      if (boundary === 'none' ? code === 0 : reached && signal === 'SIGKILL') done();
      else reject(new Error(`Child exited ${code}/${signal}, boundary=${boundary}, reached=${reached}: ${errors}`));
    });
  });
}
// Deliberately only after child exit: locks are never stolen from live writers.
async function stoppedWriterRecovery(directory: string) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await stoppedWriterRecovery(path);
    else if (entry.name.endsWith('.lock')) await unlink(path);
  }
}
for (const boundary of ['before-rename:commit.json', 'after-rename:commit.json', 'after-rename:core.json', 'after-rename:auth.json', 'after-rename:work.json', 'before-unlink:commit.json', 'after-unlink:commit.json']) {
  test(`SIGKILL mixed transaction: ${boundary} recovers one complete logical state`, async () => {
    const f = await fixture(); try {
      const before = await f.store.read(source);
      await child(f.directory, 'mixed', boundary); await stoppedWriterRecovery(f.directory);
      const auth = await new OperationsStore(f.directory).readAuth(source);
      const after = await new OperationsStore(f.directory).read(source);
      if (boundary === 'before-rename:commit.json') assert.deepEqual(after, before);
      else {
        assert.equal(auth.accounts!.users[0].active, false);
        assert.equal(after.accounts!.users[0].active, false);
        assert.equal(after.shipments.example.version, 2);
        assert.equal(after.work!.notes.length, 1);
      }
      assert.deepEqual(await new OperationsStore(f.directory).read(source), after);
    } finally { await f.close(); }
  });
}
for (const boundary of ['before-rename:auth.json', 'after-rename:auth.json']) test(`SIGKILL auth commit: ${boundary}`, async () => {
  const f = await fixture(); try {
    const before = await f.store.read(source);
    await child(f.directory, 'auth', boundary); await stoppedWriterRecovery(f.directory);
    const after = await new OperationsStore(f.directory).read(source);
    assert.equal(after.accounts!.users[0].active, boundary === 'before-rename:auth.json');
    assert.deepEqual(after.shipments, before.shipments); assert.deepEqual(after.work, before.work);
  } finally { await f.close(); }
});
for (const boundary of ['after-rename:core.json', 'after-rename:auth.json', 'after-rename:work.json', 'before-rename:operations.json', 'after-rename:operations.json']) test(`SIGKILL offline migration: ${boundary} preserves source or complete partition`, async () => {
  const f = await fixture(false); try {
    const before = await f.store.read(source);
    await child(f.directory, 'migrate', boundary); await stoppedWriterRecovery(f.directory);
    assert.deepEqual(await new OperationsStore(f.directory).read(source), before);
    assert.equal(await isAuthPartition(f.store.path, source), boundary === 'after-rename:operations.json');
    if (boundary !== 'after-rename:operations.json') {
      await assert.rejects(migrateAuthStorage(f.directory, source), { code: 'EEXIST' });
      // Explicit offline recovery preserves the abandoned attempt as evidence.
      // A write made to the still-authoritative legacy layout must survive retry.
      await f.store.mutate(source, data => { data.shipments.example.version++; return { changed: true, result: null }; });
      const current = await f.store.read(source);
      await rename(resolve(f.directory, 'auth-storage'), resolve(f.directory, 'abandoned-auth-storage'));
      await migrateAuthStorage(f.directory, source);
      assert.deepEqual(await new OperationsStore(f.directory).read(source), current);
    }
  } finally { await f.close(); }
});
for (const boundary of ['before-rename:operations.json', 'after-rename:operations.json']) test(`SIGKILL merge current state: ${boundary} preserves latest writes`, async () => {
  const f = await fixture(); try {
    await f.store.mutateAuth(source, data => { data.accounts!.users[0].version++; return { changed: true, result: null }; });
    const current = await f.store.read(source);
    await child(f.directory, 'merge', boundary); await stoppedWriterRecovery(f.directory);
    assert.deepEqual(await new OperationsStore(f.directory).read(source), current);
  } finally { await f.close(); }
});
test('separate OS writers preserve concurrent auth/core updates through the common latch', async () => {
  const f = await fixture(); try {
    await Promise.all([child(f.directory, 'concurrent-auth'), child(f.directory, 'concurrent-core'), child(f.directory, 'concurrent-auth')]);
    const after = await f.store.read(source);
    assert.equal(after.accounts!.users[0].version, 13); assert.equal(after.shipments.example.version, 7);
  } finally { await f.close(); }
});
