import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { chmod, mkdtemp, readFile, rename, rm, stat, truncate, unlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { authenticate } from '../server/auth';
import { OperationsStore, StoreError, decodeOperations, encodeOperations, type OperationsData } from '../server/operations-store';

const source = 'read-cache-synthetic-source';
const shipmentId = 'synthetic-shipment';
const timestamp = '2026-01-01T00:00:00.000Z';

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), 'artel-read-cache-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new OperationsStore(directory);
  const initial: OperationsData = {
    schemaVersion: 1, sourceSha256: source, revision: 1, companies: [],
    shipments: { [shipmentId]: { fields: { note: 'first' }, version: 1, createdAt: timestamp, updatedAt: timestamp } },
  };
  const raw = encodeOperations(initial);
  await writeFile(store.path, raw, { mode: 0o600 });
  return { directory, store, raw, expected: decodeOperations(raw, source) };
}

test('first and cached reads isolate nested caller changes from later reads and disk', async t => {
  const f = await fixture(t);
  const first = await f.store.read(source);
  first.shipments[shipmentId].fields.note = 'caller-one';
  first.directories!.defaults.profit = 'simple';
  first.directories!.vehicles.length = 0;
  const second = await f.store.read(source);
  assert.deepEqual(second, f.expected);
  second.shipments[shipmentId].fields.note = 'caller-two';
  second.directories!.defaults.profit = 'excel-exact';
  assert.deepEqual(await f.store.read(source), f.expected);
  assert.equal(await readFile(f.store.path, 'utf8'), f.raw);
});

test('cold and cached reads apply exactly the normal schema 1 and schema 2 migrations', async t => {
  const f = await fixture(t);
  const schema2 = { ...f.expected, directories: { ...f.expected.directories!, fleetSeedApplied: false, vehicles: [], drivers: [] } };
  for (const raw of [f.raw, encodeOperations(schema2)]) {
    await writeFile(f.store.path, raw);
    const expected = decodeOperations(raw, source);
    const cold = await f.store.read(source), hot = await f.store.read(source);
    assert.deepEqual(cold, expected);
    assert.deepEqual(hot, expected);
    assert.notEqual(cold.directories, hot.directories);
    assert.notEqual(cold.directories!.vehicles, hot.directories!.vehicles);
  }
});

test('cached reads preserve negative zero and unrecognized fields from validated raw bytes', async t => {
  const f = await fixture(t);
  const raw = encodeOperations({ ...f.expected, syntheticMetadata: { negativeZero: 0, extra: ['retained'] } } as OperationsData)
    .replace('"negativeZero":0', '"negativeZero":-0');
  await writeFile(f.store.path, raw);
  const expected = decodeOperations(raw, source);
  for (let index = 0; index < 2; index++) {
    const data = await f.store.read(source);
    assert.deepEqual(data, expected);
    const metadata = (data as OperationsData & { syntheticMetadata: { negativeZero: number; extra: string[] } }).syntheticMetadata;
    assert.ok(Object.is(metadata.negativeZero, -0));
    assert.deepEqual(metadata.extra, ['retained']);
    metadata.extra.push('caller-change');
  }
});

test('declined and throwing mutations cannot change the cached canonical data', async t => {
  const f = await fixture(t);
  await f.store.read(source);
  const returned = await f.store.mutate(source, data => {
    data.shipments[shipmentId].fields.note = 'declined';
    data.directories!.defaults.profit = 'simple';
    return { changed: false, result: data.shipments[shipmentId] };
  });
  returned.fields.note = 'returned-reference';
  assert.deepEqual(await f.store.read(source), f.expected);
  await assert.rejects(f.store.mutate(source, data => {
    data.shipments[shipmentId].fields.note = 'thrown';
    throw new Error('synthetic failure');
  }), /synthetic failure/);
  assert.deepEqual(await f.store.read(source), f.expected);
  assert.equal(await readFile(f.store.path, 'utf8'), f.raw);
});

test('successful mutations become visible and their returned references remain isolated', async t => {
  const f = await fixture(t);
  await f.store.read(source);
  const returned = await f.store.mutate(source, data => {
    data.shipments[shipmentId].fields.note = 'saved';
    return { changed: true, result: data.shipments[shipmentId] };
  });
  returned.fields.note = 'after-save-caller';
  const saved = await f.store.read(source);
  assert.equal(saved.shipments[shipmentId].fields.note, 'saved');
  assert.equal(saved.revision, 2);
  assert.deepEqual(saved, decodeOperations(await readFile(f.store.path, 'utf8'), source));
});

test('another store atomic same-size replacement is seen even when mtime is restored', async t => {
  const f = await fixture(t);
  // Normalize migrations once so the next serialized update keeps exactly its size.
  const second = new OperationsStore(f.directory);
  await second.mutate(source, data => ({ changed: true, result: data.revision }));
  await utimes(f.store.path, new Date(timestamp), new Date(timestamp));
  const before = await stat(f.store.path);
  assert.equal((await f.store.read(source)).shipments[shipmentId].fields.note, 'first');
  await second.mutate(source, data => {
    data.shipments[shipmentId].fields.note = 'other';
    return { changed: true, result: null };
  });
  await utimes(f.store.path, before.atime, before.mtime);
  const after = await stat(f.store.path);
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeMs, before.mtimeMs);
  const fresh = await f.store.read(source);
  assert.equal(fresh.shipments[shipmentId].fields.note, 'other');
  assert.equal(fresh.revision, 3);
});

test('same-size checksum corruption with restored mtime fails closed and cannot be overwritten', async t => {
  const f = await fixture(t);
  await utimes(f.store.path, new Date(timestamp), new Date(timestamp));
  await f.store.read(source);
  const before = await stat(f.store.path), corrupted = f.raw.replace('first', 'other');
  assert.notEqual(corrupted, f.raw);
  assert.equal(Buffer.byteLength(corrupted), Buffer.byteLength(f.raw));
  await writeFile(f.store.path, corrupted);
  await utimes(f.store.path, before.atime, before.mtime);
  assert.equal((await stat(f.store.path)).mtimeMs, before.mtimeMs);
  await assert.rejects(f.store.read(source), StoreError);
  let callbackReached = false;
  await assert.rejects(f.store.mutate(source, () => { callbackReached = true; return { changed: true, result: null }; }), StoreError);
  assert.equal(callbackReached, false);
  assert.equal(await readFile(f.store.path, 'utf8'), corrupted);
  await writeFile(f.store.path, f.raw);
  assert.deepEqual(await f.store.read(source), f.expected);
});

test('identical bytes with a different source never reuse validated data', async t => {
  const f = await fixture(t);
  await f.store.read(source);
  await assert.rejects(f.store.read('another-source'), StoreError);
  assert.deepEqual(await f.store.read(source), f.expected);
  const other = { ...f.expected, sourceSha256: 'another-source' };
  await writeFile(f.store.path, encodeOperations(other));
  assert.deepEqual(await f.store.read('another-source'), other);
  await assert.rejects(f.store.read(source), StoreError);
});

test('deletion returns fresh empty data without stale records; recreation is read again', async t => {
  const f = await fixture(t);
  await f.store.read(source);
  await unlink(f.store.path);
  const empty = await f.store.read(source);
  assert.equal(empty.revision, 0);
  assert.deepEqual(empty.shipments, {});
  empty.shipments[shipmentId] = f.expected.shipments[shipmentId];
  assert.deepEqual((await f.store.read(source)).shipments, {});
  await writeFile(f.store.path, f.raw, { mode: 0o600 });
  assert.deepEqual(await f.store.read(source), f.expected);
});

test('concurrent reads all return independent nested data', async t => {
  const f = await fixture(t);
  const copies = await Promise.all(Array.from({ length: 12 }, () => f.store.read(source)));
  copies.forEach((copy, index) => { copy.shipments[shipmentId].fields.note = `caller-${index}`; });
  copies.forEach((copy, index) => assert.equal(copy.shipments[shipmentId].fields.note, `caller-${index}`));
  assert.deepEqual(await f.store.read(source), f.expected);
});

test('newly oversized and unreadable files cannot fall back to a previous snapshot', async t => {
  const f = await fixture(t);
  await f.store.read(source);
  await truncate(f.store.path, 64 * 1024 * 1024 + 1);
  await assert.rejects(f.store.read(source), StoreError);
  await writeFile(f.store.path, f.raw);
  assert.deepEqual(await f.store.read(source), f.expected);
  if (process.getuid?.() === 0) { t.diagnostic('Permission refusal requires a non-root user; oversized-file refusal was checked.'); return; }
  await chmod(f.store.path, 0o000);
  try { await assert.rejects(f.store.read(source), StoreError); }
  finally { await chmod(f.store.path, 0o600); }
  assert.deepEqual(await f.store.read(source), f.expected);
});

test('session revocation through external atomic replacement is effective on the next read', async t => {
  const f = await fixture(t), token = 'a'.repeat(64);
  const data = f.expected;
  data.accounts = {
    users: [{ id: 'synthetic-user', name: 'Synthetic director', login: 'synthetic', role: 'director', managerId: null, active: true, version: 1, passwordHash: '0'.repeat(128), salt: '0'.repeat(32) }],
    sessions: [{ userId: 'synthetic-user', hash: createHash('sha256').update(token).digest('hex'), expiresAt: Date.now() + 60000 }], attempts: {},
  };
  await writeFile(f.store.path, encodeOperations(data));
  const request = { url: '/api/auth/session', headers: { cookie: `artel_session=${token}` } } as IncomingMessage;
  assert.equal(authenticate(await f.store.read(source), request)?.id, 'synthetic-user');
  data.accounts.sessions = [];
  const replacement = join(f.directory, 'replacement.json');
  await writeFile(replacement, encodeOperations(data), { mode: 0o600 });
  await rename(replacement, f.store.path);
  assert.equal(authenticate(await f.store.read(source), request), null);
});
